import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "./env";

export interface JwtPayload {
  sub: string; // user id
  email?: string | null; // absent for social accounts that mask the email
}

export function signToken(payload: JwtPayload): string {
  const options: SignOptions = {
    expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"],
  };
  return jwt.sign(payload, env.jwtSecret, options);
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.jwtSecret);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as JwtPayload).sub !== "string"
  ) {
    throw new Error("Invalid token payload");
  }
  const payload = decoded as JwtPayload;
  return { sub: payload.sub, email: payload.email };
}
