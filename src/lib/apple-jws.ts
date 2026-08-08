import { X509Certificate, createPublicKey, verify } from "node:crypto";

/* ─────────────────────────────────────────────────────────────
   Verify a StoreKit 2 signed transaction (JWS), with no third-party
   dependency and WITHOUT an App Store Connect API key.

   That distinction matters and is often missed: the API key is needed
   to CALL Apple's App Store Server API (looking up history, refunds).
   It is NOT needed to verify a signature — StoreKit 2 hands the client
   a JWS whose header carries the full certificate chain (`x5c`), so
   anyone holding Apple's public root can check it offline.

   What a valid signature proves: Apple itself asserted that this Apple
   ID bought this product, in this app, at this date. A jailbroken phone
   can lie to our app all day; it cannot forge this.

   THE CHAIN IS THE WHOLE POINT. Skipping it — decoding the payload and
   trusting it, which is what most "quick" integrations do — means any
   user can POST a hand-written JSON and get a lifetime unlock. So we
   check, in order:
     1. the leaf is signed by the intermediate,
     2. the intermediate is signed by the root,
     3. the root is byte-identical to Apple's published root,
     4. every certificate is inside its validity window,
     5. the payload's signature verifies under the leaf's public key.
   ───────────────────────────────────────────────────────────── */

/**
 * Apple Root CA - G3, from apple.com/certificateauthority, inlined as DER base64.
 * SHA-256 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
 *
 * INLINED, NOT READ FROM DISK — and that is load-bearing, not a style choice.
 * This module previously did `readFileSync(join(__dirname, "certs", ...))`, which
 * took the whole API down the moment it deployed: `npm run build` is
 * `prisma generate && tsc`, and tsc emits JavaScript only — it never copies a
 * `.cer` sitting in `src/`. So `dist/lib/certs/` did not exist, the read threw
 * ENOENT at MODULE LOAD, `createApp()` threw with it, and every route — not just
 * the purchase one — answered 500. (Vercel's bundler traces `import`s, so a
 * runtime path built with `join()` is invisible to it too; there is no
 * `includeFiles` in vercel.json either.)
 *
 * A base64 literal is compiled into the emitted JS, so it cannot be left behind
 * by any build step or bundler. The trade is that renewing the root means editing
 * this constant — acceptable: it expires in 2039, and the test below pins its
 * fingerprint so a careless edit fails loudly instead of silently trusting
 * whatever it was replaced with.
 */
export const APPLE_ROOT_G3_DER_B64 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9v" +
  "dCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UE" +
  "CgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2" +
  "WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmlj" +
  "YXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqG" +
  "SM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxE" +
  "tX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNC" +
  "MEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0P" +
  "AQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3m" +
  "eoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkL" +
  "F1vLUagM6BgD56KyKA==";

const APPLE_ROOT = new X509Certificate(Buffer.from(APPLE_ROOT_G3_DER_B64, "base64"));

export type SignedTransaction = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  /** ms epoch, Apple's clock — the only trustworthy "when" we ever get. */
  purchaseDate: number;
  originalPurchaseDate?: number;
  type?: string;
  environment?: string;
  /** Auto-renewable subscriptions only: when the paid/trial period ends, ms
   *  epoch on Apple's clock. Each renewal arrives as a new transaction whose
   *  `expiresDate` is one period later — the server's `validUntil` follows it. */
  expiresDate?: number;
  /** Present when a discount governed THIS period. 1 = introductory offer —
   *  which for our products can only be the free trial configured in App Store
   *  Connect, so `offerType === 1` is what "on trial" looks like on the wire. */
  offerType?: number;
  /** Present when Apple has refunded/revoked it; access must stop. */
  revocationDate?: number;
  revocationReason?: number;
};

export class InvalidTransaction extends Error {}

const b64url = (s: string): Buffer => Buffer.from(s, "base64url");

/**
 * Verify and decode. Throws `InvalidTransaction` on anything that is not a
 * genuine, currently-valid Apple signature — never returns a half-trusted value.
 */
export function verifySignedTransaction(jws: string, now = new Date()): SignedTransaction {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new InvalidTransaction("Malformed JWS");
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; x5c?: string[] };
  try {
    header = JSON.parse(b64url(headerB64).toString("utf8"));
  } catch {
    throw new InvalidTransaction("Unreadable JWS header");
  }
  // ES256 only. Accepting `alg: none` (or an HMAC alg, where the "key" is public
  // data) is the classic JWT forgery, so the algorithm is pinned, not read.
  if (header.alg !== "ES256") throw new InvalidTransaction("Unexpected algorithm");

  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 3) throw new InvalidTransaction("Missing certificate chain");

  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  let root: X509Certificate;
  try {
    [leaf, intermediate, root] = x5c
      .slice(0, 3)
      .map((c) => new X509Certificate(Buffer.from(c, "base64")));
  } catch {
    throw new InvalidTransaction("Unreadable certificate chain");
  }

  // 3 first: an attacker controls the whole chain they send, so the only fixed
  // point is OUR copy of Apple's root. Compare the raw DER, not a subject string
  // — a subject is trivially forged.
  if (!root.raw.equals(APPLE_ROOT.raw)) throw new InvalidTransaction("Chain does not end at Apple's root");
  if (!leaf.verify(intermediate.publicKey)) throw new InvalidTransaction("Leaf not signed by intermediate");
  if (!intermediate.verify(root.publicKey)) throw new InvalidTransaction("Intermediate not signed by root");

  for (const [name, cert] of [
    ["leaf", leaf],
    ["intermediate", intermediate],
    ["root", root],
  ] as const) {
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) {
      throw new InvalidTransaction(`Expired or not-yet-valid ${name} certificate`);
    }
  }

  // JWS carries ECDSA as raw r||s (IEEE P1363); Node defaults to DER.
  // A malformed signature makes node:crypto THROW rather than return false (wrong
  // length for the curve, unparseable bytes). Unwrapped, that would surface as a
  // 500 on what is simply a bad request — and a forged token must never be able
  // to tell the difference between "rejected" and "crashed the server".
  let ok = false;
  try {
    ok = verify(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: createPublicKey(leaf.publicKey), dsaEncoding: "ieee-p1363" },
      b64url(signatureB64),
    );
  } catch {
    throw new InvalidTransaction("Signature does not verify");
  }
  if (!ok) throw new InvalidTransaction("Signature does not verify");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64url(payloadB64).toString("utf8"));
  } catch {
    throw new InvalidTransaction("Unreadable payload");
  }

  const str = (k: string): string | undefined =>
    typeof payload[k] === "string" ? (payload[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof payload[k] === "number" ? (payload[k] as number) : undefined;

  const transactionId = str("transactionId");
  const bundleId = str("bundleId");
  const productId = str("productId");
  const purchaseDate = num("purchaseDate");
  if (!transactionId || !bundleId || !productId || purchaseDate == null) {
    throw new InvalidTransaction("Payload is missing required fields");
  }

  return {
    transactionId,
    originalTransactionId: str("originalTransactionId") ?? transactionId,
    bundleId,
    productId,
    purchaseDate,
    originalPurchaseDate: num("originalPurchaseDate"),
    type: str("type"),
    environment: str("environment"),
    expiresDate: num("expiresDate"),
    offerType: num("offerType"),
    revocationDate: num("revocationDate"),
    revocationReason: num("revocationReason"),
  };
}
