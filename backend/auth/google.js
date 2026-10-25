const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const cfg = require("./config");
const pg = require("../pg");
const users = require("./users");
const { startSession } = require("./session");

/*
 * "Continue with Google": OAuth 2.0 authorization-code flow with PKCE and
 * OpenID Connect, done on the server so the client secret never reaches the
 * browser.
 *
 *   1. GET /api/auth/google          -> redirect to Google (state + nonce + PKCE challenge,
 *                                       remembered in a short-lived signed cookie)
 *   2. Google redirects back to      GET /api/auth/google/callback?code=...&state=...
 *   3. We swap the code for an ID token, check its signature and claims, then
 *      find / link / create the user and start a normal session.
 *   4. Redirect to /auth-callback.html, which picks up the session.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const STATE_COOKIE = "bl_oauth";

const REDIRECT_URI = `${cfg.APP_BASE_URL}/api/auth/google/callback`;
const isConfigured = () => !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET);

const b64url = (buf) => buf.toString("base64url");

function stateCookieOptions() {
  return { httpOnly: true, secure: cfg.COOKIE_SECURE, sameSite: "lax", path: "/api/auth/google" };
}

function fail(res, code) {
  res.clearCookie(STATE_COOKIE, stateCookieOptions());
  res.redirect(`/index.html?error=${encodeURIComponent(code)}`);
}

/* ---- step 1 ---- */
function start(req, res) {
  if (!isConfigured()) return res.redirect("/index.html?error=google_not_configured");

  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48)); // PKCE code_verifier
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  const signed = jwt.sign({ typ: "oauth_state", state, nonce, cv: verifier }, cfg.ACCESS_SECRET, { algorithm: "HS256", expiresIn: 600 });
  res.cookie(STATE_COOKIE, signed, { ...stateCookieOptions(), maxAge: 600 * 1000 });

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: cfg.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  res.redirect(url.toString());
}

/* ---- ID token verification ---- */
let certs = { keys: [], fetchedAt: 0 };
async function googleKey(kid) {
  const stale = Date.now() - certs.fetchedAt > 3600 * 1000;
  if (stale || !certs.keys.some((k) => k.kid === kid)) {
    const res = await fetch(CERTS_URL);
    if (!res.ok) throw new Error(`Could not fetch Google's signing keys (${res.status})`);
    certs = { keys: (await res.json()).keys || [], fetchedAt: Date.now() };
  }
  const jwk = certs.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error("ID token was signed with an unknown key");
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

async function verifyIdToken(idToken, nonce) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || decoded.header.alg !== "RS256") throw new Error("Unexpected ID token format");
  const payload = jwt.verify(idToken, await googleKey(decoded.header.kid), {
    algorithms: ["RS256"],
    audience: cfg.GOOGLE_CLIENT_ID,
    issuer: ISSUERS,
  });
  if (payload.nonce !== nonce) throw new Error("ID token nonce mismatch");
  return payload;
}

/* ---- find / link / create the local user ---- */
async function findOrCreateUser(g) {
  const email = users.normalizeEmail(g.email);
  const fullName = String(g.name || "").trim().slice(0, 80) || email.split("@")[0];

  return pg.tx(async (c) => {
    // 1. Returning Google user.
    const linked = await users.findByOAuth(c, "google", g.sub);
    if (linked) return { user: linked, isNew: false };

    // 2. Someone already registered with this e-mail: attach Google to that account.
    const existing = (await c.query("SELECT * FROM users WHERE email = $1 FOR UPDATE", [email])).rows[0];
    if (existing) {
      // If the e-mail was never verified, whoever set its password never proved they own
      // the address -- Google just did, so that password is discarded.
      const row = (
        await c.query(
          `UPDATE users SET email_verified = true,
                  password_hash = CASE WHEN email_verified THEN password_hash ELSE NULL END,
                  avatar_url = COALESCE(avatar_url, $2), updated_at = now()
           WHERE id = $1 RETURNING *`,
          [existing.id, g.picture || null]
        )
      ).rows[0];
      await c.query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email) VALUES ($1, 'google', $2, $3)", [row.id, g.sub, email]);
      return { user: row, isNew: false };
    }

    // 3. Brand-new user.
    const username = await users.suggestUsername(c, email, fullName);
    const row = (
      await c.query(
        "INSERT INTO users (email, email_verified, full_name, username, avatar_url) VALUES ($1, true, $2, $3, $4) RETURNING *",
        [email, fullName, username, g.picture || null]
      )
    ).rows[0];
    await c.query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email) VALUES ($1, 'google', $2, $3)", [row.id, g.sub, email]);
    return { user: row, isNew: true };
  });
}

/* ---- step 2-4 ---- */
async function callback(req, res) {
  if (!isConfigured()) return fail(res, "google_not_configured");
  if (req.query.error) return fail(res, req.query.error === "access_denied" ? "google_denied" : "google_failed");

  // Check `state` against the cookie set in step 1 (protects against forged callbacks).
  let saved;
  try {
    saved = jwt.verify(req.cookies && req.cookies[STATE_COOKIE], cfg.ACCESS_SECRET, { algorithms: ["HS256"] });
    if (saved.typ !== "oauth_state") throw new Error("wrong type");
  } catch (_) {
    return fail(res, "google_state");
  }
  const given = Buffer.from(String(req.query.state || ""));
  const expected = Buffer.from(saved.state);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected) || !req.query.code) {
    return fail(res, "google_state");
  }
  res.clearCookie(STATE_COOKIE, stateCookieOptions());

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: cfg.GOOGLE_CLIENT_ID,
        client_secret: cfg.GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: saved.cv,
      }),
    });
    const tokenBody = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenBody.id_token) throw new Error(`Google token exchange failed: ${tokenBody.error_description || tokenBody.error || tokenRes.status}`);

    const claims = await verifyIdToken(tokenBody.id_token, saved.nonce);
    if (!claims.sub || !claims.email) throw new Error("Google did not return an email address");
    if (claims.email_verified !== true) return fail(res, "google_unverified_email");

    let outcome;
    try {
      outcome = await findOrCreateUser(claims);
    } catch (err) {
      if (err.code !== "23505") throw err;
      outcome = await findOrCreateUser(claims); // two callbacks raced; the second pass finds the user
    }

    await startSession(res, outcome.user);
    res.redirect("/auth_callback.html");
  } catch (err) {
    console.error(`[auth] Google sign-in failed: ${err.message}`);
    fail(res, "google_failed");
  }
}

module.exports = { start, callback, isConfigured, REDIRECT_URI };
