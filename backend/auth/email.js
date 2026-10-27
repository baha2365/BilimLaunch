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
<html><head><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;background:#000000;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#1c1c1e;border:1px solid #2c2c2e;border-radius:22px;">
      <tr><td style="padding:40px 36px 36px;color:#f5f5f7;">
        <p style="margin:0 0 28px;font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#ffffff;">Bilim<span style="color:#0a84ff;">Launch</span></p>
        <p style="margin:0 0 6px;font-size:28px;line-height:1.15;font-weight:700;letter-spacing:-0.8px;color:#ffffff;">Verify your email</p>
        <p style="margin:0 0 26px;font-size:17px;line-height:1.47;color:#a1a1a6;">Hi ${esc(first)}, enter this code to finish creating your account.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#0a84ff1f;border:1px solid #0a84ff66;border-radius:16px;padding:22px 12px;">
          <span style="display:inline-block;font-size:40px;line-height:1;font-weight:700;letter-spacing:10px;padding-left:10px;color:#ffffff;font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,'Courier New',monospace;-webkit-user-select:all;user-select:all;">${esc(code)}</span>
        </td></tr></table>
        <p style="margin:12px 0 0;text-align:center;font-size:13px;color:#6e6e73;">Double-click the code to select it, then copy.</p>
        <p style="margin:26px 0 6px;font-size:15px;line-height:1.5;color:#a1a1a6;">The code expires in ${minutes} minutes.</p>
        <p style="margin:0;font-size:15px;line-height:1.5;color:#6e6e73;">If you didn't create a BilimLaunch account, you can safely ignore this email.</p>
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
