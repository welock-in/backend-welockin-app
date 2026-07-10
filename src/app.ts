import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./lib/env";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth";
import { meRouter } from "./routes/me";
import { devicesRouter } from "./routes/devices";
import { syncRouter } from "./routes/sync";
import { focusEventsRouter } from "./routes/focus-events";
import { analyticsRouter } from "./routes/analytics";
import { feedbackRouter } from "./routes/feedback";
import { attestRouter } from "./routes/attest";
import { breaksRouter } from "./routes/breaks";
import { adminPageHtml } from "./admin/page";
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
  app.use("/api/sync", syncRouter);
  app.use("/api/focus-events", focusEventsRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/feedback", feedbackRouter);
  app.use("/api/attest", attestRouter);
  app.use("/api/breaks", breaksRouter);

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
