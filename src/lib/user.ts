import type { User } from "@prisma/client";

export type PublicUser = Omit<User, "passwordHash">;

/** Strip the password hash before returning a user over the API. */
export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}
