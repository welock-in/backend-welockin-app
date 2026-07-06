import { Router } from "express";
import { prisma } from "../lib/prisma";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Readiness probe: pings MongoDB. Returns { db: "ok" } when reachable, else a
// 503 without leaking connection details (the real error goes to the logs).
healthRouter.get("/db", async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.json({ db: "ok" });
  } catch (err) {
    console.error("DB readiness check failed:", err);
    res.status(503).json({ db: "error" });
  }
});
