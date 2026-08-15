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

// --- Subscriptions ----------------------------------------------------------
/**
 * The change is possible, just not from HERE. Lemon Squeezy cannot PATCH a
 * PayPal-backed subscription — the API answers 422 — because the change has to
 * go through PayPal's own consent flow, which lives behind the signed
 * `customer_portal_update_subscription` URL on the subscription object.
 *
 * Carries that URL so the client can open the page that CAN do it instead of
 * dead-ending on an error, and MUST carry the code: without it this 409 is
 * indistinguishable from "there is nothing to change".
 */
export const subscriptionPortalRequired = (
  url: string,
  msg = "This subscription can only be changed from its billing portal",
) => new HttpError(409, msg, { code: "SUBSCRIPTION_PORTAL_REQUIRED", details: { url } });

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

// --- Email verification -----------------------------------------------------
/**
 * The account exists and the credentials were fine, but the address behind it
 * has never been proved.
 *
 * Carries the address so the client can say "we sent a code to j***@gmail.com"
 * without a second round trip, and MUST carry the code: this is the one 403 a
 * client is expected to recover from on its own (show the code screen) rather
 * than treat as "you may not do that".
 */
export const emailNotVerified = (email: string) =>
  new HttpError(403, "Verify your email address to continue", {
    code: "EMAIL_NOT_VERIFIED",
    details: { email },
  });
/**
 * Wrong code, expired code, or no outstanding code — deliberately one answer.
 *
 * 400, NOT 401, and the distinction is load-bearing rather than pedantic. The
 * request WAS authenticated: the bearer token is valid and the account is real,
 * and only a form field is wrong. Clients treat 401 as "this session is dead"
 * and discard the token on it — the desktop app clears the Windows Credential
 * Manager entry — so a 401 here meant one mistyped digit signed the user out and
 * the next attempt failed with "not signed in". A genuinely expired token still
 * produces a 401, from `requireAuth`, where it belongs.
 */
export const verificationCodeInvalid = (msg = "Incorrect or expired code") =>
  new HttpError(400, msg, { code: "VERIFICATION_CODE_INVALID" });
/**
 * The attempt budget for this code is spent and the code is now dead.
 *
 * Distinct from the above on purpose: the recovery differs. "Wrong code" means
 * try again, this means request a new one — and a client that showed "incorrect
 * code" here would leave the user retyping a code that can no longer ever work.
 */
export const verificationAttemptsExhausted = (
  msg = "Too many attempts — request a new code",
) => new HttpError(400, msg, { code: "VERIFICATION_ATTEMPTS_EXHAUSTED" });

// --- Password reset ---------------------------------------------------------
/**
 * ONE answer for expired, already-used and never-existed.
 *
 * Telling those apart would tell an attacker holding a guessed token which
 * guesses are real, and telling a stranger that an address has an outstanding
 * reset is itself an account-existence oracle.
 */
export const resetTokenInvalid = (msg = "This link has expired or has already been used") =>
  new HttpError(400, msg, { code: "RESET_TOKEN_INVALID" });

// --- Device binding ---------------------------------------------------------
/**
 * This machine already belongs to another account, and `DEVICE_BINDING_ENFORCED`
 * says to refuse rather than merely withhold a second trial.
 *
 * The message names a way out on purpose. Everyone who hits this legitimately —
 * a shared computer, a resold laptop — needs a human, and an error with no
 * address to write to converts them into a lost customer instead of a ticket.
 */
export const deviceAlreadyClaimed = (
  msg = "This computer is already linked to a WeLockIn account. Sign in with it, or contact hello@welock.in.",
) => new HttpError(409, msg, { code: "DEVICE_ALREADY_CLAIMED" });

/**
 * This device already belongs to an account with REAL MONEY on it, and
 * `SIGNUP_PAYING_DEVICE_BLOCK` says to refuse a second account rather than let
 * someone accidentally pay twice (spec S1/N4).
 *
 * Sibling of `deviceAlreadyClaimed`, but it MUST carry more than a code: the
 * client's interstitial says "this phone already has a paying account —
 * {maskedEmail}" and offers the right sign-in buttons, and neither is knowable
 * client-side. `maskedEmail` is the `maskEmail` form, never the raw address —
 * this 409 answers people who have NOT authenticated as that account.
 */
export const deviceLinkedToPayingAccount = (
  maskedEmail: string,
  loginMethods: ("password" | "apple")[],
  msg = "This device already belongs to a WeLockIn account with an active purchase. Sign in with that account instead.",
) =>
  new HttpError(409, msg, {
    code: "DEVICE_LINKED_TO_PAYING_ACCOUNT",
    details: { maskedEmail, loginMethods },
  });
