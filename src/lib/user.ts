import type { User } from "@prisma/client";

export type PublicUser = Omit<User, "passwordHash">;

/** Strip the password hash before returning a user over the API. */
export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

const MASK = "•••";

/**
 * An email address a stranger may be shown.
 *
 * The precheck answers UNAUTHENTICATED callers, and its whole point is to say
 * "this phone already has a paying account" to someone who has not proved they
 * own it. The full address would turn that courtesy into an enumeration and
 * doxxing surface, so what leaves the server is only enough for the OWNER to
 * recognise their own account: the first character of the local part, the first
 * one or two of the domain, and the TLD — "hedi.fourati@epfl.ch" becomes
 * "h•••@ep•••.ch".
 *
 * Deterministic and total on purpose: any string in, a masked string out, no
 * throw. A malformed address in the database must not crash the one endpoint
 * that runs before login. Apple private-relay addresses get no special case —
 * "abc@privaterelay.appleid.com" masks to "a•••@pr•••.com" like anything else,
 * which is fine because its owner cannot recognise a relay address anyway and
 * the CTA (sign in with Apple) does not need them to.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  // No "@" (or nothing before it): mask the whole thing rather than guessing
  // at a structure it does not have.
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at + 1) : "";

  const maskedLocal = `${local.slice(0, 1)}${MASK}`;

  if (!domain) return maskedLocal;

  const labels = domain.split(".");
  const head = `${labels[0].slice(0, 2)}${MASK}`;
  // One-label domain ("a@localhost"): there is no TLD to keep.
  const maskedDomain = labels.length >= 2 ? `${head}.${labels[labels.length - 1]}` : head;

  return `${maskedLocal}@${maskedDomain}`;
}
