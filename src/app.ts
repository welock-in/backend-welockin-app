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
import { errorHandler, notFoundHandler } from "./middleware/error";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
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

  // Fallbacks.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
