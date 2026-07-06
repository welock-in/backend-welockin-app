import { Router } from "express";
import { prisma } from "../lib/prisma";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Readiness probe: pings MongoDB and surfaces the real connection error
// (the central error handler otherwise masks DB failures as a generic 500).
healthRouter.get("/db", async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.json({ db: "ok" });
  } catch (err) {
    res.status(500).json({
      db: "error",
      name: err instanceof Error ? err.name : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
