import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { focusEventInputSchema } from "../validation/schemas";
import { upsertFocusEvent } from "../services/focus-events";

export const focusEventsRouter = Router();

/**
 * Ingest a single focus event — the mobile app emits one when a focus ends.
 * Idempotent: replaying the same `clientEventId` stores it only once (returns
 * 200 + `deduped:true`), so the offline queue can retry safely.
 */
focusEventsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = focusEventInputSchema.parse(req.body);
    const userId = req.user!.id;
    const { event, deduped } = await upsertFocusEvent(userId, input);
    res.status(deduped ? 200 : 201).json({ event, deduped });
  }),
);
