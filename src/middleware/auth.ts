import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/jwt";
import { unauthorized } from "../lib/http-error";

export interface AuthUser {
  id: string;
  email?: string | null;
}

// Augment Express's Request so `req.user` is typed everywhere.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Requires a valid `Authorization: Bearer <jwt>` header. On success attaches
 * `req.user`. On failure passes an HttpError(401) to the error handler.
 */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(unauthorized("Missing or malformed Authorization header"));
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
}
