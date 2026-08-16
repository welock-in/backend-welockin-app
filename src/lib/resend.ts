import { env } from "./env";
import type { BillingProvider } from "./entitlement";

// Minimal Resend (resend.com) transactional-email client — used to email the
// addiction-protection partner OTP. No SDK dependency: one fetch to their REST
// API. Sending is a graceful no-op (logged, returns false) while RESEND_API_KEY
// is empty, so the rest of the flow works in dev without email configured.

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
  skipped?: boolean;
}

async function send(
  to: string,
  subject: string,
  html: string,
  text: string,
  // `replyTo` becomes Resend's `reply_to` (their REST payload is snake_case).
  // An options object rather than a fifth positional string, so the next field
  // this needs does not turn the call sites into a row of unlabelled arguments.
  opts?: { replyTo?: string },
): Promise<SendResult> {
  if (!env.resendApiKey) {
    console.warn(`[resend] RESEND_API_KEY not set — skipping email to ${to} ("${subject}")`);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.resendFrom,
        to: [to],
        subject,
        html,
        text,
        ...(opts?.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      return { ok: false, error: data.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

/** The shared card these emails are built from. Not a template engine — one
 *  function, so the three messages cannot drift apart visually. */
const shell = (inner: string) => `
    <div style="font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1714">
${inner}
    </div>`;

/** The big monospaced-looking code block, reused by both code emails. */
const codeBlock = (label: string, code: string) => `
      <div style="text-align:center;background:#faf7f1;border:1px solid #eae4d5;border-radius:14px;padding:22px;margin:0 0 20px">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a8175;margin-bottom:8px">${label}</div>
        <div style="font-size:34px;font-weight:700;letter-spacing:.14em;color:#1a1714">${code}</div>
      </div>`;

/**
 * Email a partner the one-time code that turns the user's addiction protection
 * off. The recipient is the trusted partner, not the user.
 */
export function sendOtpEmail(to: string, code: string): Promise<SendResult> {
  const subject = "WeLockin — your partner asked to turn off protection";
  const text =
    `Someone using WeLockin has asked you to help turn off their addiction protection.\n\n` +
    `One-time code: ${code}\n\n` +
    `Share it with them ONLY if you both agree it's the right moment. This code turns their protection off.`;
  const html = `
    <div style="font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1714">
      <h2 style="font-size:18px;margin:0 0 8px">Turn-off request</h2>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 20px">
        Someone using <strong>WeLockin</strong> has asked you to help turn off their addiction protection.
      </p>
      <div style="text-align:center;background:#faf7f1;border:1px solid #eae4d5;border-radius:14px;padding:22px;margin:0 0 20px">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a8175;margin-bottom:8px">One-time code</div>
        <div style="font-size:34px;font-weight:700;letter-spacing:.14em;color:#1a1714">${code}</div>
      </div>
      <p style="font-size:13px;line-height:1.5;color:#8a8175;margin:0">
        Share it only if you both agree it's the right moment — this code turns their protection off.
      </p>
    </div>`;
  return send(to, subject, html, text);
}

/**
 * Email someone the code that proves they can read the address they signed up
 * with.
 *
 * The subject line carries the code on purpose: most people read it from a
 * notification and never open the message, and a code they can act on from the
 * lock screen is the difference between finishing signup and abandoning it.
 */
export function sendEmailVerificationCode(
  to: string,
  code: string,
  ttlMinutes: number,
): Promise<SendResult> {
  const subject = `${code} is your WeLockin verification code`;
  const text =
    `Your WeLockin verification code is ${code}.\n\n` +
    `It expires in ${ttlMinutes} minutes.\n\n` +
    `If you didn't create a WeLockin account, you can ignore this email — ` +
    `without the code, nothing happens.`;
  const html = shell(`
      <h2 style="font-size:18px;margin:0 0 8px">Confirm your email</h2>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 20px">
        Enter this code in <strong>WeLockin</strong> to finish setting up your account.
      </p>
${codeBlock("Verification code", code)}
      <p style="font-size:13px;line-height:1.5;color:#8a8175;margin:0">
        It expires in ${ttlMinutes} minutes. If you didn't create a WeLockin account,
        ignore this email — without the code, nothing happens.
      </p>`);
  return send(to, subject, html, text);
}

/**
 * Email a password-reset link.
 *
 * The URL is built by the caller from `PUBLIC_SITE_URL`, never from the request
 * host — a link assembled from an attacker-supplied `Host` header is the
 * classic way this exact email becomes an account-takeover primitive.
 *
 * Note what the copy does NOT do: it never says "someone requested a reset for
 * your account". This message also goes out for addresses that have no account,
 * so it must read sensibly to a stranger and confirm nothing either way.
 */
export function sendPasswordResetLink(
  to: string,
  url: string,
  ttlMinutes: number,
): Promise<SendResult> {
  const subject = "Reset your WeLockin password";
  const text =
    `Open this link to choose a new WeLockin password:\n\n${url}\n\n` +
    `The link works once and expires in ${ttlMinutes} minutes.\n\n` +
    `If you didn't ask for this, ignore this email — your password stays as it is.`;
  const html = shell(`
      <h2 style="font-size:18px;margin:0 0 8px">Reset your password</h2>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 20px">
        Choose a new password for your <strong>WeLockin</strong> account.
      </p>
      <div style="text-align:center;margin:0 0 20px">
        <a href="${url}" style="display:inline-block;background:#1a1714;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 26px;border-radius:12px">
          Choose a new password
        </a>
      </div>
      <p style="font-size:12px;line-height:1.5;color:#8a8175;margin:0 0 16px;word-break:break-all">
        Or paste this into your browser:<br />${url}
      </p>
      <p style="font-size:13px;line-height:1.5;color:#8a8175;margin:0">
        The link works once and expires in ${ttlMinutes} minutes. If you didn't ask
        for this, ignore this email — your password stays as it is.
      </p>`);
  return send(to, subject, html, text);
}

/**
 * Is this BCP-47 tag French-speaking? Only the language matters — "fr",
 * "fr-FR", "fr-CH" and friends all read the French copy; everything else
 * (including nothing at all) falls back to English, because a reminder about
 * money must never be skipped over a locale string we failed to parse.
 */
export const isFrenchLocale = (locale: string | null | undefined): boolean =>
  /^fr\b/i.test((locale ?? "").trim());

/**
 * The trial end as the words the reminder copy prints — date and time as two
 * parts, because the email and the push phrase the join differently ("on X at
 * Y" / "le X à Y").
 *
 * UTC, and LABELLED UTC by every caller. The server does not know the reader's
 * timezone, and an unlabelled local-looking time that is hours off is worse
 * than an honest UTC one — this is the instant a payment fires or access ends.
 */
export function trialEndParts(endsAt: Date, fr: boolean): { date: string; time: string } {
  const locale = fr ? "fr-FR" : "en-GB";
  return {
    date: new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(endsAt),
    time: new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }).format(endsAt),
  };
}

export interface TrialReminderOpts {
  /** The server-authoritative end of the window — the resolver's, never a guess. */
  endsAt: Date;
  /** Will the trial CONVERT (a payment fires) — or merely stop (access ends)? */
  willRenew: boolean;
  /** Whose store holds the money, for the "where to manage it" sentence. */
  billingProvider: BillingProvider;
  /** BCP-47, from the onboarding profile. Anything non-French reads English. */
  locale?: string | null;
}

/**
 * Remind someone their trial ends within the next day.
 *
 * The one rule of this copy: NEVER promise an action we cannot take. An Apple
 * subscription can only be cancelled by its owner in Apple's own settings, and
 * a Lemon Squeezy one in the billing portal — so every sentence points, none
 * performs. The subject carries the date and time for the same reason the
 * verification code rides its subject line: most people read it from a
 * notification and never open the message.
 */
export function sendTrialEndingReminder(to: string, opts: TrialReminderOpts): Promise<SendResult> {
  const fr = isFrenchLocale(opts.locale);
  const { date, time } = trialEndParts(opts.endsAt, fr);
  // What happens at the boundary, and where to act on it. `willRenew` is only
  // meaningful when a store is billing; a machine trial (NONE) always ends.
  const converts = opts.willRenew && opts.billingProvider !== "NONE";

  if (fr) {
    const subject = `Votre essai WeLockin se termine le ${date} à ${time} UTC`;
    const next = converts
      ? "Sans action de votre part, votre abonnement démarre à ce moment-là et votre premier paiement est prélevé."
      : "Votre accès s'arrête à ce moment-là — aucun paiement ne sera prélevé.";
    const manage =
      opts.billingProvider === "APPLE"
        ? converts
          ? "Pour vérifier ou annuler avant cette date, ouvrez Réglages sur votre iPhone → votre nom → Abonnements. Apple gère la facturation, donc c'est là que les changements prennent effet — nous ne pouvons pas annuler un abonnement Apple à votre place."
          : "Pour conserver l'accès, réactivez le renouvellement dans Réglages sur votre iPhone → votre nom → Abonnements."
        : opts.billingProvider === "LEMON_SQUEEZY"
          ? converts
            ? "Pour vérifier ou annuler avant cette date, ouvrez Réglages → Gérer l'abonnement dans l'application — vous arriverez sur votre portail de facturation."
            : "Pour conserver l'accès, ouvrez Réglages → Gérer l'abonnement dans l'application."
          : "Pour que vos blocages et vos plannings continuent, choisissez une formule dans les Réglages de l'application.";
    const text =
      `Votre essai WeLockin se termine le ${date} à ${time} (UTC).\n\n` +
      `${next}\n\n${manage}`;
    const html = shell(`
      <h2 style="font-size:18px;margin:0 0 8px">Votre essai se termine</h2>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 20px">
        Votre essai <strong>WeLockin</strong> se termine le
        <strong>${date} à ${time} (UTC)</strong>.
      </p>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 20px">${next}</p>
      <p style="font-size:13px;line-height:1.5;color:#8a8175;margin:0">${manage}</p>`);
    return send(to, subject, html, text);
  }

  const subject = `Your WeLockin trial ends ${date} at ${time} UTC`;
  const next = converts
    ? "If you do nothing, your subscription starts then and your first payment is taken."
    : "Your access ends then — no payment will be taken.";
  const manage =
    opts.billingProvider === "APPLE"
      ? converts
        ? "To review or cancel before then, open Settings on your iPhone → your name → Subscriptions. Apple handles the billing, so that is where changes take effect — we cannot cancel an Apple subscription for you."
        : "To keep access, turn renewal back on in Settings on your iPhone → your name → Subscriptions."
      : opts.billingProvider === "LEMON_SQUEEZY"
        ? converts
          ? "To review or cancel before then, open the app's Settings → Manage subscription — it takes you to your billing portal."
          : "To keep access, open the app's Settings → Manage subscription."
        : "To keep your blocks and schedules running, choose a plan in the app's Settings.";
  const text =
    `Your WeLockin trial ends on ${date} at ${time} (UTC).\n\n` + `${next}\n\n${manage}`;
  const html = shell(`
      <h2 style="font-size:18px;margin:0 0 8px">Your trial is ending</h2>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 20px">
        Your <strong>WeLockin</strong> trial ends on
        <strong>${date} at ${time} (UTC)</strong>.
      </p>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 20px">${next}</p>
      <p style="font-size:13px;line-height:1.5;color:#8a8175;margin:0">${manage}</p>`);
  return send(to, subject, html, text);
}

/**
 * Escape user text for interpolation into an email's HTML body. The other
 * emails in this file interpolate only server-generated values (codes, URLs we
 * built ourselves); the contact form is the first whose content is AUTHORED BY
 * THE SUBMITTER, so without this anyone could inject markup into the mail the
 * support inbox renders.
 */
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Where the contact form delivers. One constant, shared with the route's 502. */
export const CONTACT_INBOX = "hello@welock.in";

/**
 * Forward a contact-form submission to the support inbox.
 *
 * `reply_to` is set to the SUBMITTER's address, so answering is just pressing
 * reply — without it every response would start by copying an email address out
 * of the body, which is the step that gets skipped on a busy day.
 */
export function sendContactEmail(
  fromUser: { name?: string; email: string; topic: string },
  message: string,
): Promise<SendResult> {
  const { name, email, topic } = fromUser;
  const who = name ? `${name} <${email}>` : `<${email}>`;
  const subject = `[${topic}] Contact form — ${who}`;
  const text =
    `From: ${who}\n` +
    `Topic: ${topic}\n\n` +
    `${message}\n\n` +
    `Reply to this email to answer them directly.`;
  const html = shell(`
      <h2 style="font-size:18px;margin:0 0 8px">Contact form</h2>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 20px">
        <strong>${escapeHtml(who)}</strong> — ${escapeHtml(topic)}
      </p>
      <div style="background:#faf7f1;border:1px solid #eae4d5;border-radius:14px;padding:18px;margin:0 0 20px">
        <div style="font-size:14px;line-height:1.6;color:#1a1714;white-space:pre-wrap">${escapeHtml(message)}</div>
      </div>
      <p style="font-size:13px;line-height:1.5;color:#8a8175;margin:0">
        Reply to this email to answer them directly.
      </p>`);
  return send(CONTACT_INBOX, subject, html, text, { replyTo: email });
}
