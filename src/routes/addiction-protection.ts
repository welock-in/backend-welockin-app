import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { protectionLockSchema, protectionUnlockSchema } from "../validation/schemas";
import { badRequest, forbidden, unauthorized } from "../lib/http-error";
import { sendOtpEmail } from "../lib/resend";

export const addictionProtectionRouter = Router();

// Wrong-code attempts allowed against one OTP before it is invalidated (forcing a
// resend, which re-emails the partner). Caps brute-force of the 6-digit code.
const MAX_OTP_ATTEMPTS = 5;

function genOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * The curated protection list the client fetches on launch. Active entries only,
 * grouped by category into { sites, apps }. `updatedAt` lets a client skip work
 * when nothing changed.
 */
addictionProtectionRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const entries = await prisma.protectionEntry.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { value: "asc" }],
    });
    const categories: Record<string, { sites: string[]; apps: string[] }> = {};
    let updatedAt: Date | null = null;
    for (const e of entries) {
      const c = (categories[e.category] ??= { sites: [], apps: [] });
      (e.kind === "app" ? c.apps : c.sites).push(e.value);
      if (!updatedAt || e.updatedAt > updatedAt) updatedAt = e.updatedAt;
    }
    res.json({ updatedAt, count: entries.length, categories });
  }),
);

/** The caller's own protection lock state (never exposes the OTP to the user). */
addictionProtectionRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const lock = await prisma.protectionLock.findUnique({ where: { userId: req.user!.id } });
    res.json({
      // The desktop enforcer binds the always-on block to this id so a status from
      // a DIFFERENT account can never lift it (no account-switch bypass).
      userId: req.user!.id,
      active: lock?.active ?? false,
      method: lock?.method ?? null,
      categories: lock?.categories ?? [],
      partnerContact: lock?.partnerContact ?? null,
      lockedUntil: lock?.lockedUntil ?? null,
    });
  }),
);

/** Turn protection ON. Partner method mails a one-time code to the partner. */
addictionProtectionRouter.post(
  "/lock",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = protectionLockSchema.parse(req.body);
    const userId = req.user!.id;
    const now = new Date();
    const isPartner = input.method === "partner";
    const otp = isPartner ? genOtp() : null;

    const data = {
      active: true,
      method: input.method,
      categories: input.categories,
      partnerContact: isPartner ? (input.partnerContact ?? null) : null,
      otp,
      otpSentAt: otp ? now : null,
      otpAttempts: 0,
      lockedUntil: input.method === "date" ? (input.lockedUntil ?? null) : null,
    };
    const lock = await prisma.protectionLock.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    let emailed: string | null = null;
    if (isPartner && input.partnerContact && otp) {
      const r = await sendOtpEmail(input.partnerContact, otp);
      emailed = r.ok ? "sent" : r.skipped ? "skipped" : "failed";
    }

    res.json({
      active: lock.active,
      method: lock.method,
      categories: lock.categories,
      partnerContact: lock.partnerContact,
      lockedUntil: lock.lockedUntil,
      emailed,
    });
  }),
);

/** Re-generate + re-send the partner OTP ("Send it again"). */
addictionProtectionRouter.post(
  "/resend",
  requireAuth,
  asyncHandler(async (req, res) => {
    const lock = await prisma.protectionLock.findUnique({ where: { userId: req.user!.id } });
    if (!lock || !lock.active) throw badRequest("Protection is not active");
    if (lock.method !== "partner") throw badRequest("Resend only applies to the partner method");
    if (!lock.partnerContact) throw badRequest("No partner contact on file");

    const otp = genOtp();
    await prisma.protectionLock.update({
      where: { userId: req.user!.id },
      data: { otp, otpSentAt: new Date(), otpAttempts: 0 },
    });
    const r = await sendOtpEmail(lock.partnerContact, otp);
    res.json({ emailed: r.ok ? "sent" : r.skipped ? "skipped" : "failed", error: r.error ?? null });
  }),
);

/** Turn protection OFF (partner code, or after the dated lock elapses). */
addictionProtectionRouter.post(
  "/unlock",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = protectionUnlockSchema.parse(req.body);
    const userId = req.user!.id;
    const lock = await prisma.protectionLock.findUnique({ where: { userId } });
    if (!lock || !lock.active) {
      res.json({ active: false });
      return;
    }
    if (lock.method === "date") {
      if (lock.lockedUntil && new Date() < lock.lockedUntil) {
        throw forbidden("Protection is locked until the chosen date");
      }
      await prisma.protectionLock.update({ where: { userId }, data: { active: false } });
      res.json({ active: false });
      return;
    }
    // partner
    if (!lock.otp || code.trim() !== lock.otp) {
      const attempts = (lock.otpAttempts ?? 0) + 1;
      const exhausted = attempts >= MAX_OTP_ATTEMPTS;
      await prisma.protectionLock.update({
        where: { userId },
        // Past the cap, invalidate the code so it can't be brute-forced — the user
        // must request a new one (which re-emails the partner).
        data: exhausted ? { otpAttempts: attempts, otp: null } : { otpAttempts: attempts },
      });
      throw unauthorized(
        exhausted ? "Too many attempts — ask your partner for a new code" : "Incorrect or expired code",
      );
    }
    await prisma.protectionLock.update({
      where: { userId },
      data: { active: false, otp: null, otpAttempts: 0 },
    });
    res.json({ active: false });
  }),
);
