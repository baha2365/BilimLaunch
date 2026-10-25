const cfg = require("./config");

/*
 * E-mail sending through Resend (https://resend.com). The "from" domain
 * (bilimlaunch.com) must be verified in the Resend dashboard first -- see the
 * README. With no RESEND_API_KEY and not in production, the code is printed
 * to the server console instead, so you can develop without sending anything.
 */
let client = null;
function getClient() {
  if (!client) {
    const { Resend } = require("resend");
    client = new Resend(cfg.RESEND_API_KEY);
  }
  return client;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function verificationEmail({ name, code }) {
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  const minutes = cfg.CODE_TTL_MINUTES;
  const text =
    `Hi ${first},\n\nYour BilimLaunch verification code is: ${code}\n\n` +
    `It expires in ${minutes} minutes. If you didn't create a BilimLaunch account, you can ignore this email.\n\n— BilimLaunch`;
  const html = `<!doctype html>
<html><body style="margin:0;background:#0f1728;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#17223b;border:1px solid #2a3a5c;border-radius:12px;">
      <tr><td style="padding:32px;color:#f3f1ea;">
        <p style="margin:0 0 20px;font-size:20px;font-weight:bold;">Bilim<span style="color:#e7b14c;">Launch</span></p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">Hi ${esc(first)}, use this code to verify your email address:</p>
        <p style="margin:0 0 20px;font-size:34px;letter-spacing:8px;font-weight:bold;color:#e7b14c;">${esc(code)}</p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#96a1bd;">It expires in ${minutes} minutes.</p>
        <p style="margin:0;font-size:14px;line-height:1.5;color:#96a1bd;">If you didn't create a BilimLaunch account, you can safely ignore this email.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject: `${code} is your BilimLaunch verification code`, text, html };
}

async function sendVerificationEmail({ to, name, code }) {
  const message = verificationEmail({ name, code });

  if (!cfg.RESEND_API_KEY) {
    if (cfg.IS_PROD) throw new Error("RESEND_API_KEY is not set.");
    console.log(`\n[email:dev] RESEND_API_KEY is not set, so nothing was sent.\n[email:dev] Verification code for ${to}:  ${code}\n`);
    return { dev: true };
  }

  const { data, error } = await getClient().emails.send({ from: cfg.EMAIL_FROM, to: [to], ...message });
  if (error) throw new Error(`Resend rejected the email: ${error.message || error.name}`);
  return { id: data && data.id };
}

module.exports = { sendVerificationEmail };
