import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireAttest } from "../middleware/attest";
import { asyncHandler } from "../middleware/async-handler";
import { focusEventInputSchema, focusEventsV2Schema } from "../validation/schemas";
import { upsertFocusEvent, upsertFocusEventsV2 } from "../services/focus-events";

export const focusEventsRouter = Router();

focusEventsRouter.post("/v2", requireAuth, requireAttest, asyncHandler(async (req, res) => {
  const input = focusEventsV2Schema.parse(req.body);
  res.json(await upsertFocusEventsV2(req.user!.id, input.events));
}));

/**
 * Ingest a single focus event — the mobile app emits one when a focus ends.
 * Idempotent: replaying the same `clientEventId` stores it only once (returns
 * 200 + `deduped:true`), so the offline queue can retry safely.
 *
 * Events are attributed by the `deviceId` in the payload; one from a deviceId
 * with no Device row on the account is stored but quarantined (see
 * services/focus-events.ts). requireAttest is the (env-gated) anti-forge layer.
 * Desktop events come via /api/sync and are unaffected.
 */
focusEventsRouter.post(
  "/",
  requireAuth,
  requireAttest,
  asyncHandler(async (req, res) => {
    const input = focusEventInputSchema.parse(req.body);
    const userId = req.user!.id;
    const { event, deduped } = await upsertFocusEvent(userId, input);
    res.status(deduped ? 200 : 201).json({ event, deduped });
  }),
);
