import { env } from "./env";

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

/**
 * "Your trial ends in two days, and then we charge you."
 *
 * The most important email this product sends, and the one with the least room
 * for cleverness. A card is already on file and the charge is automatic, so a
 * customer who does not want it has exactly one job — cancel — and this message
 * exists to make that job impossible to miss.
 *
 * So: the amount and the date are in the SUBJECT LINE, because most people read
 * a notification and never open the message. The cancel link is above the fold
 * and is not competing with an upsell. And the tone is a reminder, not a sales
 * pitch: someone who feels tricked into a renewal charges it back, which costs
 * far more than the subscription was worth.
 */
export function sendTrialEndingSoon(
  to: string,
  opts: { price: string; period: string; endsAt: Date; manageUrl: string | null; locale: "en" | "fr" },
): Promise<SendResult> {
  const fr = opts.locale === "fr";
  const day = new Intl.DateTimeFormat(fr ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "long",
  }).format(opts.endsAt);

  const subject = fr
    ? `Ton essai WeLockin se termine le ${day} — ${opts.price} ensuite`
    : `Your WeLockin trial ends ${day} — ${opts.price} after that`;

  const text = fr
    ? `Ton essai gratuit se termine le ${day}.

` +
      `Sans action de ta part, ton abonnement démarre à ${opts.price} / ${opts.period}.

` +
      (opts.manageUrl ? `Pour annuler : ${opts.manageUrl}

` : "") +
      `Si tu comptes rester, tu n'as rien à faire.`
    : `Your free trial ends on ${day}.

` +
      `Unless you cancel, your subscription starts at ${opts.price} / ${opts.period}.

` +
      (opts.manageUrl ? `To cancel: ${opts.manageUrl}

` : "") +
      `If you are staying, there is nothing to do.`;

  const html = shell(`
      <h2 style="font-size:18px;margin:0 0 8px">${fr ? "Ton essai se termine bientôt" : "Your trial ends soon"}</h2>
      <p style="font-size:14px;line-height:1.5;color:#5b5448;margin:0 0 18px">
        ${
          fr
            ? `Ton essai gratuit se termine le <strong>${day}</strong>. Sans action de ta part, ton abonnement démarre à <strong>${opts.price} / ${opts.period}</strong>.`
            : `Your free trial ends on <strong>${day}</strong>. Unless you cancel, your subscription starts at <strong>${opts.price} / ${opts.period}</strong>.`
        }
      </p>
      ${
        opts.manageUrl
          ? `<div style="text-align:center;margin:0 0 18px">
        <a href="${opts.manageUrl}" style="display:inline-block;background:#1a1714;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 26px;border-radius:12px">
          ${fr ? "Gérer mon abonnement" : "Manage my subscription"}
        </a>
      </div>`
          : ""
      }
      <p style="font-size:13px;line-height:1.5;color:#8a8175;margin:0">
        ${fr ? "Si tu comptes rester, tu n'as rien à faire." : "If you are staying, there is nothing to do."}
      </p>`);

  return send(to, subject, html, text);
}
