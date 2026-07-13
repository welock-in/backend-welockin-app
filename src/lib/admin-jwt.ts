import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "./env";

// Admin tokens are separate from user tokens: signed with `adminJwtSecret` and
// carrying `role: "admin"`, so a user JWT can never authenticate an admin route
// (and an admin JWT is not a valid user token). Short-lived by default (12h).

export interface AdminJwtPayload {
  sub: string; // the admin username
  role: "admin";
}

export function signAdminToken(username: string): string {
  const options: SignOptions = {
    expiresIn: env.adminJwtExpiresIn as SignOptions["expiresIn"],
  };
  return jwt.sign({ sub: username, role: "admin" }, env.adminJwtSecret, options);
}

export function verifyAdminToken(token: string): AdminJwtPayload {
  const decoded = jwt.verify(token, env.adminJwtSecret);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    (decoded as AdminJwtPayload).role !== "admin" ||
    typeof (decoded as AdminJwtPayload).sub !== "string"
  ) {
    throw new Error("Invalid admin token payload");
  }
  const payload = decoded as AdminJwtPayload;
  return { sub: payload.sub, role: "admin" };
}
