import bcrypt from "bcryptjs";

/**
 * Password hashing, in one place.
 *
 * This lived as a module-private `const BCRYPT_ROUNDS = 10` inside
 * `routes/auth.ts`, which was fine while registration was the only thing that
 * hashed a password. The reset flow is the second, and a second copy of a cost
 * factor is how the two drift: raise it in one file and half the accounts get
 * the old strength, with nothing to notice it. So it moves here and both import
 * it.
 *
 * 10 rounds is bcrypt's usual default and matches every hash already in the
 * database — changing it does NOT invalidate them (the cost is stored inside the
 * hash), it only applies to new ones.
 */
export const BCRYPT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
