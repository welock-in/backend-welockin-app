import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./lib/env";
import { healthRouter } from "./routes/health";
import { updatesRouter } from "./routes/updates";
import { authRouter } from "./routes/auth";
import { authEmailRouter } from "./routes/auth-email";
import { contactRouter } from "./routes/contact";
import { meRouter } from "./routes/me";
import { devicesRouter } from "./routes/devices";
import { focusInvitesRouter } from "./routes/focus-invites";
import { syncRouter } from "./routes/sync";
import { focusEventsRouter } from "./routes/focus-events";
import { analyticsRouter } from "./routes/analytics";
import { feedbackRouter } from "./routes/feedback";
import { attestRouter } from "./routes/attest";
import { breaksRouter } from "./routes/breaks";
import { notificationsRouter } from "./routes/notifications";
import { onboardingRouter } from "./routes/onboarding";
import { checkoutRouter } from "./routes/checkout";
import { subscriptionRouter } from "./routes/subscription";
import { lemonSqueezyWebhookRouter } from "./routes/webhooks-lemonsqueezy";
import { entitlementRouter } from "./routes/entitlement";
import { purchasesRouter } from "./routes/purchases";
import { adminPageHtml } from "./admin/page";
import { sessionsRouter } from "./routes/sessions";
import { adminRouter } from "./routes/admin";
import { addictionProtectionRouter } from "./routes/addiction-protection";
import { adminProtectionRouter } from "./routes/admin-protection";
import { adminReleasesRouter } from "./routes/admin-releases";
import { adminNotificationsRouter } from "./routes/admin-notifications";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { requireAuth, requireCurrentSession, requireVerifiedAccount } from "./middleware/auth";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
      // Non-simple custom headers must be allow-listed for a future web/PC client's
      // CORS preflight (the RN app is not a browser, so this is only for the web).
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-WeLockIn-Device-Id",
        "X-WeLockIn-Attest",
        // Composite hardware fingerprint (desktop only) — see lib/fingerprint.ts.
        "X-WeLockIn-Fingerprint",
      ],
    }),
  );
  app.use(
    express.json({
      limit: "5mb",
      // Keep the exact bytes received, for webhook signatures. An HMAC is over the
      // body AS SENT, and parse -> re-serialise is not byte-identical, so verifying
      // against the parsed object rejects every genuine delivery — and the tempting
      // fix for that is to stop verifying, which turns a payment endpoint into an
      // open one. Costs one retained reference per request; nothing is copied.
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  if (env.nodeEnv !== "test") {
    app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));
  }

  // Routes — everything under /api.
  app.use("/api/health", healthRouter);
  // Desktop auto-update manifest. PUBLIC like /api/health: a signed-out machine
  // must still be able to receive a fix.
  app.use("/api/updates", updatesRouter);
  app.use("/api/auth", authRouter);
  // Email verification + password reset. Same mount point, its own file: these
  // are the routes an UNVERIFIED account must still be able to reach, so they
  // can never sit behind the gate they exist to open.
  app.use("/api/auth", authEmailRouter);
  // The site's contact form. PUBLIC like the reset routes above it: the people
  // most likely to write in are locked out or have no account, so a bearer
  // token is the one thing they cannot supply. Abuse is handled by rate limits
  // inside the route, not by auth.
  app.use("/api/contact", contactRouter);
  // Every router below is authenticated on EVERY route, so the guard can be
  // mounted here rather than threaded through each one. `requireAuth` runs again
  // inside them; that is a signature check with no database read, and paying it
  // twice is cheaper than thirteen files drifting apart.
  //
  // `requireVerifiedAccount` = the session is current AND the address is proved
  // (the latter only while EMAIL_VERIFICATION_ENFORCED is on).
  // `requireCurrentSession` = the session is current, nothing more — for the
  // routes an unverified account must still reach. See middleware/auth.ts.
  const gated = [requireAuth, requireVerifiedAccount];

  app.use("/api/me", gated, meRouter);
  app.use("/api/devices", gated, devicesRouter);
  // Cross-device focus: invite the account's other devices to join a session.
  app.use("/api/focus-invites", gated, focusInvitesRouter);
  app.use("/api/sync", gated, syncRouter);
  app.use("/api/focus-events", gated, focusEventsRouter);
  app.use("/api/analytics", gated, analyticsRouter);
  app.use("/api/feedback", gated, feedbackRouter);
  app.use("/api/attest", attestRouter);
  app.use("/api/breaks", gated, breaksRouter);
  app.use("/api/notifications", gated, notificationsRouter);
  // Live-session heartbeats, reported by the client while a focus runs.
  app.use("/api/sessions", gated, sessionsRouter);
  // The admin console API — distinct from the feedback-board /admin HTML page
  // below; a JSON API for the separate admin-dashboard app, gated by an env-cred
  // admin JWT rather than User.isAdmin, hence no `gated` here.
  app.use("/api/admin", adminRouter);
  // Addiction protection: the curated list + partner-OTP / dated lock (client),
  // and the admin CRUD + active-protection panel.
  app.use("/api/addiction-protection", addictionProtectionRouter);
  app.use("/api/admin/addiction-protection", adminProtectionRouter);
  app.use("/api/admin/releases", adminReleasesRouter);
  app.use("/api/admin/notifications", adminNotificationsRouter);
  // Session-freshness only: the funnel pushes its answers immediately after
  // creating the account and BEFORE the code screen, so requiring verification
  // here would break registration itself.
  app.use("/api/onboarding", requireAuth, requireCurrentSession, onboardingRouter);
  app.use("/api/checkout", gated, checkoutRouter);
  // "Pay now" during a trial. Same gate as the checkout: this takes money, so
  // it may not be reached by an account that has not proved its address.
  app.use("/api/subscription", gated, subscriptionRouter);
  // Authenticated by the SENDER'S SIGNATURE, not by a bearer token —
  // deliberately outside the requireAuth surface. (This comment used to sit one
  // line higher, over the checkout mount, which it never described.)
  app.use("/api/webhooks/lemonsqueezy", lemonSqueezyWebhookRouter);
  // Session-freshness only: a locked-out client must always be able to read WHY
  // it is locked. A paywall that cannot fetch its own reason is a blank screen.
  app.use("/api/entitlement", requireAuth, requireCurrentSession, entitlementRouter);
  // Recording a purchase that Apple has ALREADY taken money for must never be
  // refused for want of a verified email: the payment happened, and the only
  // effect of blocking it is a customer who paid and got nothing. iOS has no
  // code screen yet either, so the verified gate would break it outright the day
  // the flag flips. Session-freshness still applies — a reset must end sessions
  // here as everywhere.
  app.use("/api/purchases", requireAuth, requireCurrentSession, purchasesRouter);

  // Same-origin admin dashboard for the feedback board (gated by admin login;
  // all data/actions require User.isAdmin). Route-scoped CSP relaxes helmet's
  // default to allow this page's inline script/style + same-origin fetch.
  app.get("/admin", (_req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
    );
    res.type("html").send(adminPageHtml);
  });

  // Fallbacks.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
