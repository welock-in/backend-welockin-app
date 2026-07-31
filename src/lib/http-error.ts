/**
 * An error carrying an HTTP status code. Thrown from routes/services and turned
 * into a JSON body by the error middleware. Beyond `status` + `message` it can
 * carry a machine-readable `code` (so clients branch reliably instead of matching
 * on human strings) and arbitrary `details` (extra fields spread into the body).
 */
export class HttpError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    opts?: { code?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const tooManyRequests = (msg = "Too many requests") => new HttpError(429, msg);

// --- Device identity / anti-abuse (Part D) ---------------------------------
// The mobile client branches on these `code` values (DEVICE_NOT_BOUND etc).
export const deviceNotBound = (msg = "This device isn’t bound to your account") =>
  new HttpError(403, msg, { code: "DEVICE_NOT_BOUND" });
export const deviceSuperseded = (msg = "This iPhone is no longer the active device") =>
  new HttpError(403, msg, { code: "DEVICE_SUPERSEDED" });
export const deviceRevoked = (msg = "This device has been revoked") =>
  new HttpError(403, msg, { code: "DEVICE_REVOKED" });
export const deviceConflict = (
  activeDevice: { name?: string | null; model?: string | null; lastSeenAt?: Date | null },
  msg = "Another iPhone is already active on this account",
) => new HttpError(409, msg, { code: "DEVICE_CONFLICT", details: { activeDevice } });
export const rebindCooldown = (msg = "You changed devices recently — try again later") =>
  new HttpError(429, msg, { code: "REBIND_COOLDOWN" });

// --- Purchases --------------------------------------------------------------
// The client branches on these `code` values: a rejected transaction must never
// be retried in a loop, while a transport failure must be.
export const transactionInvalid = (msg: string) =>
  new HttpError(400, msg, { code: "TRANSACTION_INVALID" });
export const transactionForeign = (msg = "This transaction belongs to another app") =>
  new HttpError(400, msg, { code: "TRANSACTION_FOREIGN" });
export const transactionUnknownProduct = (msg = "Unknown product") =>
  new HttpError(400, msg, { code: "TRANSACTION_UNKNOWN_PRODUCT" });

// --- Onboarding funnel ------------------------------------------------------
// The mobile funnel branches on these `code` values.
export const ageBelowMinimum = (minimumAge: number) =>
  new HttpError(403, `You must be at least ${minimumAge} to use WeLockIn`, {
    code: "AGE_BELOW_MINIMUM",
    details: { minimumAge },
  });
export const onboardingRateLimited = (
  msg = "Too many onboarding updates — try again shortly",
) => new HttpError(429, msg, { code: "ONBOARDING_RATE_LIMITED" });
/**
 * A FIRST submission arrived without `age` and/or `selfReportedDailyHours`.
 *
 * Both are optional in zod so a later partial edit (renaming in Settings from a
 * device that reinstalled and only ever sees `ageBand`) does not have to restate
 * the whole funnel. On a first submission they are mandatory: the row cannot be
 * created without a band and an hours value. Carries the missing keys so the
 * client can name the bug instead of guessing at a generic 400.
 */
export const onboardingIncomplete = (missing: string[]) =>
  new HttpError(400, `A first onboarding submission requires: ${missing.join(", ")}`, {
    code: "ONBOARDING_INCOMPLETE",
    details: { missing },
  });
/**
 * The authenticated account no longer exists (stateless JWT outliving the row).
 *
 * MUST carry a code: a bare 404 body is byte-identical to `notFoundHandler`'s
 * (an unrouted path, an edge/proxy 404, a client base-path bug), and the client's
 * documented 404 action — drop the queued answers and sign out — is the one
 * destructive branch in its error table. A codeless 404 is a transport fault.
 */
export const accountGone = (msg = "This account no longer exists") =>
  new HttpError(404, msg, { code: "ACCOUNT_NOT_FOUND" });
