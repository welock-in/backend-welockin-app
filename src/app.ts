import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./lib/env";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth";
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
import { adminPageHtml } from "./admin/page";
import { sessionsRouter } from "./routes/sessions";
import { adminRouter } from "./routes/admin";
import { addictionProtectionRouter } from "./routes/addiction-protection";
import { adminProtectionRouter } from "./routes/admin-protection";
import { adminNotificationsRouter } from "./routes/admin-notifications";
import { errorHandler, notFoundHandler } from "./middleware/error";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
      // Non-simple custom headers must be allow-listed for a future web/PC client's
      // CORS preflight (the RN app is not a browser, so this is only for the web).
      allowedHeaders: ["Content-Type", "Authorization", "X-WeLockIn-Device-Id", "X-WeLockIn-Attest"],
    }),
  );
  app.use(express.json({ limit: "5mb" }));
  if (env.nodeEnv !== "test") {
    app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));
  }

  // Routes — everything under /api.
  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/me", meRouter);
  app.use("/api/devices", devicesRouter);
  // Cross-device focus: invite the account's other devices to join a session.
  app.use("/api/focus-invites", focusInvitesRouter);
  app.use("/api/sync", syncRouter);
  app.use("/api/focus-events", focusEventsRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/feedback", feedbackRouter);
  app.use("/api/attest", attestRouter);
  app.use("/api/breaks", breaksRouter);
  app.use("/api/notifications", notificationsRouter);
  // Live-session heartbeats (client) + the admin console API (distinct from the
  // feedback-board /admin HTML page below; this is a JSON API for the separate
  // admin-dashboard app, gated by env-cred admin JWT, not User.isAdmin).
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/admin", adminRouter);
  // Addiction protection: the curated list + partner-OTP / dated lock (client),
  // and the admin CRUD + active-protection panel.
  app.use("/api/addiction-protection", addictionProtectionRouter);
  app.use("/api/admin/addiction-protection", adminProtectionRouter);
  app.use("/api/admin/notifications", adminNotificationsRouter);

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
