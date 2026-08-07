import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env, paymentConfig } from "../lib/env";
import { receiptsEnabled } from "../lib/entitlement-receipt";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * Which configuration this DEPLOYMENT actually sees.
 *
 * Exists because of a Vercel property that has burned this project before:
 * setting an environment variable does nothing to the running deployment — it
 * only applies to the NEXT one. So "I added the variable" and "the server sees
 * it" are different states, and without this endpoint the only way to tell them
 * apart is a customer-facing failure.
 *
 * BOOLEANS ONLY for anything secret. The two ids reported verbatim are not
 * secrets — the store id rides in every webhook payload and the variant ids in
 * every checkout page — and seeing the actual number is what catches a paste of
 * the wrong one. `commit` is stamped by Vercel at build time and answers the
 * other half of the question: WHICH code is live.
 */
healthRouter.get("/config", (_req, res) => {
  res.json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    lemonSqueezy: {
      // DEGRADED FIRST, because everything under it lies while it is true.
      // A half-configured storefront is deliberately BLANKED in env.ts so the
      // deploy cannot sell — which means this endpoint would otherwise report
      // "no API key" for a deploy whose API key is perfectly fine and whose
      // real problem is one empty variant id. That is the exact wrong answer
      // to give someone mid-way through swapping test ids for live ones.
      degraded: paymentConfig.degraded,
      problems: paymentConfig.problems,
      apiKey: Boolean(env.lemonSqueezyApiKey),
      webhookSecret: Boolean(env.lemonSqueezyWebhookSecret),
      storeId: env.lemonSqueezyStoreId || null,
      variantLifetime: env.lemonSqueezyVariantId || null,
      variantMonthly: env.lemonSqueezyVariantMonthly || null,
      variantYearly: env.lemonSqueezyVariantYearly || null,
      allowTestMode: env.lemonSqueezyAllowTestMode,
    },
    entitlement: {
      // False here = no receipts are being signed = every desktop client runs
      // on Access::Unknown and GRANTS. The paywall does not bite without it.
      receiptsEnabled: receiptsEnabled(),
      // Present-but-not-enabled is the diagnosis that matters: the variable is
      // set and its VALUE cannot be parsed as a key — a mangled paste, not a
      // missing paste. Telling those apart used to take reading server logs.
      signingKeyPresent: Boolean(env.entitlementSigningKey),
      enforced: env.entitlementEnforced,
    },
    email: {
      resend: Boolean(env.resendApiKey),
      verificationEnforced: env.emailVerificationEnforced,
    },
    deviceBindingEnforced: env.deviceBindingEnforced,
  });
});

// Readiness probe: pings MongoDB. Returns { db: "ok" } when reachable, else a
// 503 without leaking connection details (the real error goes to the logs).
healthRouter.get("/db", async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.json({ db: "ok" });
  } catch (err) {
    console.error("DB readiness check failed:", err);
    // Keep the { error } shape every other endpoint uses, plus the db flag.
    res.status(503).json({ error: "Database unreachable", db: "error" });
  }
});
