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

async function send(to: string, subject: string, html: string, text: string): Promise<SendResult> {
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
      body: JSON.stringify({ from: env.resendFrom, to: [to], subject, html, text }),
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
