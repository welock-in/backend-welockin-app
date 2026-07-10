import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireBoundDevice } from "../middleware/bound-device";
import { requireAttest } from "../middleware/attest";
import { asyncHandler } from "../middleware/async-handler";
import { focusEventInputSchema } from "../validation/schemas";
import { upsertFocusEvent } from "../services/focus-events";

export const focusEventsRouter = Router();

/**
 * Ingest a single focus event — the mobile app emits one when a focus ends.
 * Idempotent: replaying the same `clientEventId` stores it only once (returns
 * 200 + `deduped:true`), so the offline queue can retry safely.
 *
 * requireBoundDevice attributes the event to the caller's active phone (and 403s
 * a superseded/revoked one); a superseded phone flushing legit backlog inside the
 * grace window still gets through and is credited by the service. requireAttest is
 * the (env-gated) anti-forge layer. Desktop events come via /api/sync (requireAuth
 * only) and are unaffected.
 */
focusEventsRouter.post(
  "/",
  requireAuth,
  requireBoundDevice,
  requireAttest,
  asyncHandler(async (req, res) => {
    const input = focusEventInputSchema.parse(req.body);
    const userId = req.user!.id;
    const { event, deduped } = await upsertFocusEvent(userId, input);
    res.status(deduped ? 200 : 201).json({ event, deduped });
  }),
);
