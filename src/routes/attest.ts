import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { attestRegisterSchema } from "../validation/schemas";
import { attestVerifierReady, issueChallenge, verifyChallenge, CHALLENGE_TTL_MS } from "../lib/attest";
import { badRequest, HttpError } from "../lib/http-error";

export const attestRouter = Router();

/** Short-lived challenge the client folds into its App Attest clientDataHash. */
attestRouter.get(
  "/challenge",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ challenge: issueChallenge(), ttlSeconds: Math.floor(CHALLENGE_TTL_MS / 1000) });
  }),
);

/**
 * Register a device's App Attest key. Verifies the challenge, then (once the
 * verifier is wired) validates the attestation object against Apple's App Attest
 * root for env.appAttestEnv / env.appAttestAppId, extracts the P-256 public key,
 * and stores it on the device. Fails closed until the verifier is implemented.
 */
attestRouter.post(
  "/register",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { keyId, attestation, challenge } = attestRegisterSchema.parse(req.body);
    const userId = req.user!.id;
    if (!verifyChallenge(challenge)) throw badRequest("Invalid or expired challenge");

    if (!attestVerifierReady()) {
      throw new HttpError(501, "Attestation verification not configured");
    }

    // Reached only once the verifier is wired: verify `attestation`, extract the
    // public key, and persist it against the caller's device.
    const deviceId = (req.header("x-welockin-device-id") ?? "").trim();
    const device = await prisma.device.findFirst({ where: { userId, deviceId } });
    if (!device) throw badRequest("Unknown device");
    await prisma.device.update({
      where: { id: device.id },
      data: { attestKeyId: keyId /* attestPubKey: <extracted> */ },
    });
    res.json({ ok: true, keyId });
  }),
);
