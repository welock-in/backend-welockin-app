import crypto from "node:crypto";

/**
 * Build a stable, valid MongoDB ObjectId from a namespace and identity parts.
 * Mongo's primary-key uniqueness then gives us cross-instance idempotency even
 * on serverless deployments, without nullable compound unique indexes.
 */
export function deterministicObjectId(namespace: string, ...parts: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(namespace);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex").slice(0, 24);
}
