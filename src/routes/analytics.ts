import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/async-handler";
import { computeSummary } from "../services/analytics";

export const analyticsRouter = Router();

analyticsRouter.get(
  "/summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    const summary = await computeSummary(req.user!.id);
    res.json(summary);
  }),
);
