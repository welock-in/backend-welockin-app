import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "./env";

export interface JwtPayload {
  sub: string; // user id
  email: string;
}

/**
 * What a verified token actually carries.
 *
 * `iat` is stamped by `jwt.sign` and is the only thing that lets a password
 * change invalidate the sessions that predate it — these tokens are stateless
 * with no id and no revocation list, so "issued before the password moved" is
 * the sole handle we have on them. Nullable because it is not ours to
 * guarantee: a token minted by some other tool might not carry one, and the
 * check treats a missing `iat` as "cannot prove it is fresh".
 */
export interface VerifiedJwt extends JwtPayload {
  iat: number | null;
}

export function signToken(payload: JwtPayload): string {
  const options: SignOptions = {
    expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"],
  };
  return jwt.sign(payload, env.jwtSecret, options);
}

export function verifyToken(token: string): VerifiedJwt {
  const decoded = jwt.verify(token, env.jwtSecret);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as JwtPayload).sub !== "string"
  ) {
    throw new Error("Invalid token payload");
  }
  const payload = decoded as JwtPayload & { iat?: unknown };
  return {
    sub: payload.sub,
    email: payload.email,
    iat: typeof payload.iat === "number" ? payload.iat : null,
  };
}
