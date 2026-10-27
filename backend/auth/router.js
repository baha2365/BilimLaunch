const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const cfg = require("./config");
const pg = require("../pg");
const tokens = require("./tokens");
const users = require("./users");
const codes = require("./codes");
const google = require("./google");
const { sendVerificationEmail, sendAccountNoticeEmail } = require("./email");
const { passwordProblem, hashPassword, verifyPassword, burnTime } = require("./passwords");
const { validateProfile, saveProfile } = require("./profile");
const { startSession, accessPayload, describeUser } = require("./session");
const { requireAuth } = require("./middleware");
const { HttpError, wrap } = require("./errors");

const PURPOSE = "verify_email";
const NOTICE_PURPOSE = "account_notice"; // only used to rate-limit the "you already have an account" e-mails

/* ---- rate limits (per IP; switched off under NODE_ENV=test) ---- */
function limiter(max, minutes, what) {
  if (cfg.IS_TEST) return (req, res, next) => next();
  return rateLimit({
    windowMs: minutes * 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: `Too many ${what} attempts. Please wait a few minutes and try again.`, code: "rate_limited" }),
  });
}

/* ---- helpers ---- */
function constraintToField(err) {
  if (err && err.code === "23505") {
    if (/username/.test(err.constraint || "")) return "username";
    if (/email/.test(err.constraint || "")) return "email";
  }
  return null;
}

function validateUsername(raw) {
  const username = users.normalizeUsername(raw);
  if (!users.USERNAME_RE.test(username)) {
    throw new HttpError(422, "Check the highlighted fields.", "validation", {
      errors: { username: "Use 3-30 characters: lowercase letters, numbers, dots and underscores." },
    });
  }
  return username;
}

/** Creates a code and e-mails it. If the e-mail can't be sent, the code is discarded so the user can retry immediately. */
async function sendVerificationFor(user) {
  const { code, id } = await codes.issueCode(user.id, PURPOSE);
  try {
    await sendVerificationEmail({ to: user.email, name: user.full_name, code });
  } catch (err) {
    await codes.discardCode(id).catch(() => {});
    console.error(`[auth] could not send verification email to ${user.email}: ${err.message}`);
    throw new HttpError(502, "We couldn't send the verification email. Please try again in a moment.", "email_failed");
  }
}

/** Tells the owner of an existing account that someone tried to sign up with their address. Rate-limited like codes are. */
async function sendNoticeFor(user) {
  const { id } = await codes.issueCode(user.id, NOTICE_PURPOSE);
  try {
    await sendAccountNoticeEmail({ to: user.email, name: user.full_name, viaGoogle: !user.password_hash });
  } catch (err) {
    await codes.discardCode(id).catch(() => {});
    console.error(`[auth] could not send account notice to ${user.email}: ${err.message}`);
    throw new HttpError(502, "We couldn't send the verification email. Please try again in a moment.", "email_failed");
  }
}

function readRefreshCookie(req) {
  return (req.cookies && req.cookies[cfg.REFRESH_COOKIE]) || "";
}

/* ======================================================================
   /api/auth
   ====================================================================== */
function createAuthRouter() {
  const router = express.Router();

  /* ---- sign up with e-mail + password ---- */
  router.post(
    "/register",
    limiter(10, 60, "sign-up"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const errors = {};

      const fullName = typeof body.fullName === "string" ? body.fullName.replace(/\s+/g, " ").trim() : "";
      if (fullName.length < 2 || fullName.length > 80) errors.fullName = "Enter your full name.";

      const email = users.normalizeEmail(body.email);
      if (!users.isValidEmail(email)) errors.email = "Enter a valid email address.";

      const username = users.normalizeUsername(body.username);
      if (!users.USERNAME_RE.test(username)) errors.username = "Use 3-30 characters: lowercase letters, numbers, dots and underscores.";

      const pwProblem = passwordProblem(body.password, email);
      if (pwProblem) errors.password = pwProblem;

      if (Object.keys(errors).length) throw new HttpError(422, "Check the highlighted fields.", "validation", { errors });

      const passwordHash = await hashPassword(body.password);

      /*
       * The answer to this request must not depend on whether the address (or the
       * username) is already in use, or the sign-up form becomes a way to look up
       * who has an account. So:
       *   - new address / never-verified address -> create or refresh the row, e-mail a code
       *   - address with a finished account      -> change nothing, e-mail the OWNER a notice
       * and in every case the browser gets the same "verification_sent" answer.
       * A username that is already taken is quietly made unique (aigerim.b -> aigerim.b4821).
       */
      let outcome;
      for (let attempt = 0; ; attempt++) {
        try {
          outcome = await pg.tx(async (c) => {
            const existing = (await c.query("SELECT * FROM users WHERE email = $1 FOR UPDATE", [email])).rows[0];
            if (existing && existing.email_verified) return { kind: "existing", user: existing };

            const finalName = await users.availableUsername(c, username, existing && existing.id);
            if (existing) {
              // Never verified: let the new sign-up take over the row, so nobody can lock an address by typing it in.
              const row = (
                await c.query(
                  "UPDATE users SET full_name = $2, username = $3, password_hash = $4, updated_at = now() WHERE id = $1 RETURNING *",
                  [existing.id, fullName, finalName, passwordHash]
                )
              ).rows[0];
              return { kind: "pending", user: row };
            }
            const row = (
              await c.query("INSERT INTO users (email, full_name, username, password_hash) VALUES ($1, $2, $3, $4) RETURNING *", [email, fullName, finalName, passwordHash])
            ).rows[0];
            return { kind: "new", user: row };
          });
          break;
        } catch (err) {
          // Two sign-ups racing for the same username/address: just look again.
          if (constraintToField(err) && attempt < 4) continue;
          throw err;
        }
      }

      let resendAfter = cfg.CODE_RESEND_COOLDOWN_SECONDS;
      try {
        if (outcome.kind === "existing") await sendNoticeFor(outcome.user);
        else await sendVerificationFor(outcome.user);
      } catch (err) {
        // Signing up twice in a minute (typo in the password, say): whatever we already sent
        // is still valid, so carry on to the "enter your code" step instead of failing.
        if (!(err instanceof HttpError) || (err.code !== "cooldown" && err.code !== "too_many_codes")) throw err;
        resendAfter = err.extra.retryAfter;
      }
      res.status(201).json({ status: "verification_sent", email: outcome.user.email, resendAfterSeconds: resendAfter });
    })
  );

  /* ---- confirm the e-mailed code; this is also what signs the new user in ---- */
  router.post(
    "/verify-email",
    limiter(30, 15, "verification"),
    wrap(async (req, res) => {
      const email = users.normalizeEmail(req.body && req.body.email);
      const code = String((req.body && req.body.code) || "").replace(/\s+/g, "");
      if (!users.isValidEmail(email) || !/^\d{6}$/.test(code)) {
        throw new HttpError(422, "Enter the 6-digit code from your email.", "validation", { errors: { code: "Enter the 6-digit code." } });
      }

      // One answer for every kind of failure (no such address, already verified, wrong, expired,
      // locked), so this can't be used to tell which addresses have an account.
      const invalid = () => new HttpError(400, "That code is incorrect or has expired. You can request a new one.", "invalid_code");

      const user = await users.findByEmail(pg, email);
      if (!user || user.email_verified) {
        await pg.query("SELECT 1 FROM email_codes WHERE user_id = $1 LIMIT 1", [crypto.randomUUID()]); // similar work either way
        throw invalid();
      }

      const outcome = await pg.tx(async (c) => {
        const check = await codes.checkCode(c, user.id, PURPOSE, code);
        if (check.result === "ok") await c.query("UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1", [user.id]);
        return check;
      });
      if (outcome.result !== "ok") throw invalid();

      const verified = await users.findById(pg, user.id);
      const session = await startSession(res, verified);
      res.json({ ...session, user: await describeUser(pg, verified) });
    })
  );

  /* ---- ask for another code ---- */
  router.post(
    "/resend-code",
    limiter(10, 60, "resend"),
    wrap(async (req, res) => {
      const email = users.normalizeEmail(req.body && req.body.email);
      if (!users.isValidEmail(email)) throw new HttpError(422, "Enter a valid email address.", "validation", { errors: { email: "Enter a valid email address." } });

      const user = await users.findByEmail(pg, email);
      // Same answer whether or not the account exists, so this can't be used to probe for registered addresses.
      if (user && !user.email_verified) {
        // Cooldown / hourly limit / sending problems are logged but never shown: an error here
        // would only appear for real, unverified addresses and give them away.
        await sendVerificationFor(user).catch((err) => {
          if (!(err instanceof HttpError) || err.code === "email_failed") console.error(`[auth] resend failed for ${user.email}: ${err.message}`);
        });
      }
      res.json({ status: "ok", resendAfterSeconds: cfg.CODE_RESEND_COOLDOWN_SECONDS });
    })
  );

  /* ---- sign in with e-mail + password ---- */
  router.post(
    "/login",
    limiter(15, 15, "sign-in"),
    wrap(async (req, res) => {
      const email = users.normalizeEmail(req.body && req.body.email);
      const password = req.body && req.body.password;
      if (!users.isValidEmail(email) || typeof password !== "string" || !password) {
        throw new HttpError(422, "Enter your email and password.", "validation");
      }

      const user = await users.findByEmail(pg, email);
      let ok = false;
      if (user && user.password_hash) ok = await verifyPassword(password.slice(0, 200), user.password_hash);
      else await burnTime(password);
      if (!ok) throw new HttpError(401, "Incorrect email or password. If you signed up with Google, use \"Continue with Google\".", "invalid_credentials");

      if (!user.email_verified) {
        // Right password, but the address was never confirmed: send a fresh code (if the cooldown allows) and say so.
        await sendVerificationFor(user).catch((err) => {
          if (!(err instanceof HttpError) || err.code === "email_failed") throw err;
        });
        throw new HttpError(403, "Please verify your email first. We've sent you a code.", "email_not_verified", { email: user.email });
      }

      const session = await startSession(res, user);
      res.json({ ...session, user: await describeUser(pg, user) });
    })
  );

  /* ---- swap the refresh cookie for a new access token (and a new refresh cookie) ---- */
  router.post(
    "/refresh",
    limiter(120, 15, "refresh"),
    wrap(async (req, res) => {
      const cookie = readRefreshCookie(req);
      if (!cookie) throw new HttpError(401, "Please sign in.", "no_refresh_token");

      let rotated;
      try {
        rotated = await tokens.rotateRefreshToken(cookie);
      } catch (err) {
        if (!err.reason) throw err;
        tokens.clearRefreshCookie(res);
        throw new HttpError(401, "Your session has ended. Please sign in again.", err.reason === "reuse" ? "refresh_reuse" : "invalid_refresh_token");
      }

      const user = await users.findById(pg, rotated.userId);
      if (!user) {
        tokens.clearRefreshCookie(res);
        throw new HttpError(401, "Your session has ended. Please sign in again.", "invalid_refresh_token");
      }
      if (rotated.refreshToken) tokens.setRefreshCookie(res, rotated.refreshToken);
      res.json({ ...accessPayload(user), user: await describeUser(pg, user) });
    })
  );

  /* ---- sign out (this device) ---- */
  router.post(
    "/logout",
    wrap(async (req, res) => {
      const cookie = readRefreshCookie(req);
      if (cookie) await tokens.revokeByToken(cookie);
      tokens.clearRefreshCookie(res);
      res.json({ status: "signed_out" });
    })
  );

  /* ---- sign out everywhere ---- */
  router.post(
    "/logout-all",
    requireAuth,
    wrap(async (req, res) => {
      await tokens.revokeAllForUser(req.auth.userId);
      tokens.clearRefreshCookie(res);
      res.json({ status: "signed_out_everywhere" });
    })
  );

  /* ---- Google ---- */
  router.get("/google", limiter(30, 15, "Google sign-in"), (req, res) => google.start(req, res));
  router.get("/google/callback", wrap((req, res) => google.callback(req, res)));

  router.use(errorHandler);
  return router;
}

/* ======================================================================
   /api/me  (needs an access token)
   ====================================================================== */
function createMeRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get(
    "/",
    wrap(async (req, res) => {
      const user = await users.findById(pg, req.auth.userId);
      if (!user) throw new HttpError(401, "Please sign in again.", "invalid_token");
      res.json({ user: await describeUser(pg, user) });
    })
  );

  // Used by onboarding (first time) and by the profile page (later edits).
  // The username is optional here so the profile page can leave it alone.
  router.put(
    "/profile",
    wrap(async (req, res) => {
      const body = req.body || {};
      const { values, errors } = validateProfile(body.profile || body);

      let username = null;
      if (typeof body.username === "string" && body.username.trim()) {
        try {
          username = validateUsername(body.username);
        } catch (err) {
          Object.assign(errors, err.extra.errors);
        }
      }
      if (Object.keys(errors).length) throw new HttpError(422, "Check the highlighted fields.", "validation", { errors });

      const user = await users.findById(pg, req.auth.userId);
      if (!user) throw new HttpError(401, "Please sign in again.", "invalid_token");

      for (let attempt = 0; ; attempt++) {
        try {
          await pg.tx(async (c) => {
            if (username && username !== user.username) {
              // A name somebody else has is quietly made unique, never reported as "taken".
              const finalName = await users.availableUsername(c, username, user.id);
              await c.query("UPDATE users SET username = $2, updated_at = now() WHERE id = $1", [user.id, finalName]);
            }
            await saveProfile(c, user.id, values);
          });
          break;
        } catch (err) {
          if (constraintToField(err) === "username" && attempt < 4) continue;
          throw err;
        }
      }
      res.json({ user: await describeUser(pg, await users.findById(pg, user.id)) });
    })
  );

  router.use(errorHandler);
  return router;
}

/* ---- JSON errors for everything under these routers ---- */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    if (err.extra && err.extra.retryAfter) res.set("Retry-After", String(err.extra.retryAfter));
    return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  }
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed request.", code: "bad_json" });
  const unreachable = err && (/^(ECONN|ENOTFOUND|ETIMEDOUT)/.test(err.code || "") || err.code === "57P03" || /timeout|Connection terminated/i.test(err.message || ""));
  console.error(`[auth] ${req.method} ${req.originalUrl} failed: ${err && err.stack ? err.stack : err}`);
  if (unreachable) return res.status(503).json({ error: "The account database can't be reached right now. Please try again shortly.", code: "db_unavailable" });
  res.status(500).json({ error: "Something went wrong on our side. Please try again.", code: "server_error" });
}

module.exports = { createAuthRouter, createMeRouter };
