import type { NextFunction, Request, Response } from "express";
import { verifyAdminToken } from "../lib/admin-jwt";
import { unauthorized } from "../lib/http-error";

export interface AdminIdentity {
  username: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminIdentity;
    }
  }
}

/**
 * Requires a valid admin `Authorization: Bearer <adminJwt>` header (see
 * `admin-jwt.ts`). On success attaches `req.admin`. Distinct from `requireAuth`
 * so admin routes can never be reached with an ordinary user token.
 */
export function requireAdmin(
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
    const payload = verifyAdminToken(token);
    req.admin = { username: payload.sub };
    next();
  } catch {
    next(unauthorized("Invalid or expired admin token"));
  }
}
