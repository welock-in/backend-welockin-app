import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/http-error";

/** 404 handler for unmatched routes. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found" });
}

/**
 * Central error handler. Always responds with a consistent JSON shape:
 * `{ error: string }`.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    const message = err.errors
      .map((e) => `${e.path.join(".") || "body"}: ${e.message}`)
      .join("; ");
    res.status(400).json({ error: message });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details ?? {}),
    });
    return;
  }

  // Prisma known-request errors we can map to a precise status.
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: string }).code;
    // Unique-constraint violation.
    if (code === "P2002") {
      res.status(409).json({ error: "Resource already exists" });
      return;
    }
    // Malformed value for a typed column — e.g. an invalid Mongo ObjectId passed
    // as a path param. That's bad input, not a server fault.
    if (code === "P2023") {
      res.status(400).json({ error: "Malformed id" });
      return;
    }
    // Record targeted by an update/delete no longer exists (e.g. deleted between
    // a read and a write). Not-found, not a 500.
    if (code === "P2025") {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
}
