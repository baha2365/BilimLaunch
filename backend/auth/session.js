const express = require("express");
const rateLimit = require("express-rate-limit");
const cfg = require("./config");
const pg = require("../pg");
const tokens = require("./tokens");
const users = require("./users");
const codes = require("./codes");
const google = require("./google");
const { sendVerificationEmail } = require("./email");
const { passwordProblem, hashPassword, verifyPassword, burnTime } = require("./passwords");
const { validateProfile, saveProfile } = require("./profile");
const { startSession, accessPayload, describeUser } = require("./session");
const { requireAuth } = require("./middleware");
const { HttpError, wrap } = require("./errors");

const PURPOSE = "verify_email";

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

function usernameError() {
  return new HttpError(409, "That username is taken.", "username_taken", { errors: { username: "That username is taken." } });
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

      let user;
      try {
        user = await pg.tx(async (c) => {
          const existing = (await c.query("SELECT * FROM users WHERE email = $1 FOR UPDATE", [email])).rows[0];
          if (existing && existing.email_verified) {
            const viaGoogle = !existing.password_hash;
            throw new HttpError(
              409,
              viaGoogle ? "This email is already registered with Google. Use \"Continue with Google\"." : "An account with this email already exists. Sign in instead.",
              "email_taken",
              { errors: { email: viaGoogle ? "Already registered with Google." : "Already registered." } }
            );
          }
          if (existing) {
            // Never verified: let the new sign-up take over the row, so nobody can lock an address by typing it in.
            return (
              await c.query(
                "UPDATE users SET full_name = $2, username = $3, password_hash = $4, updated_at = now() WHERE id = $1 RETURNING *",
                [existing.id, fullName, username, passwordHash]
              )
            ).rows[0];
          }
          return (
            await c.query("INSERT INTO users (email, full_name, username, password_hash) VALUES ($1, $2, $3, $4) RETURNING *", [email, fullName, username, passwordHash])
          ).rows[0];
        });
      } catch (err) {
        const field = constraintToField(err);
        if (field === "username") throw usernameError();
        if (field === "email") throw new HttpError(409, "An account with this email already exists. Sign in instead.", "email_taken", { errors: { email: "Already registered." } });
        throw err;
      }

      let resendAfter = cfg.CODE_RESEND_COOLDOWN_SECONDS;
      try {
        await sendVerificationFor(user);
      } catch (err) {
        // Signing up twice in a minute (typo in the password, say): the code we already
        // sent is still valid, so carry on to the "enter your code" step instead of failing.
        if (!(err instanceof HttpError) || err.code !== "cooldown") throw err;
        resendAfter = err.extra.retryAfter;
      }
      res.status(201).json({ status: "verification_sent", email: user.email, resendAfterSeconds: resendAfter });
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

      const user = await users.findByEmail(pg, email);
      if (!user) throw new HttpError(400, "That code is incorrect or has expired.", "invalid_code");
      if (user.email_verified) throw new HttpError(409, "This email is already verified. Please sign in.", "already_verified");

      const outcome = await pg.tx(async (c) => {
        const check = await codes.checkCode(c, user.id, PURPOSE, code);
        if (check.result === "ok") await c.query("UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1", [user.id]);
        return check;
      });

      if (outcome.result === "expired") throw new HttpError(400, "That code has expired. Request a new one.", "code_expired");
      if (outcome.result === "locked") throw new HttpError(429, "Too many wrong attempts. Request a new code.", "code_locked");
      if (outcome.result === "invalid") {
        throw new HttpError(400, `That code is incorrect. ${outcome.attemptsLeft} ${outcome.attemptsLeft === 1 ? "try" : "tries"} left.`, "invalid_code", { attemptsLeft: outcome.attemptsLeft });
      }

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
      if (user && !user.email_verified) await sendVerificationFor(user);
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
      if (!ok) throw new HttpError(401, "Incorrect email or password -- or this account signs in with Google.", "invalid_credentials");

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

      try {
        await pg.tx(async (c) => {
          if (username && username !== user.username) await c.query("UPDATE users SET username = $2, updated_at = now() WHERE id = $1", [user.id, username]);
          await saveProfile(c, user.id, values);
        });
      } catch (err) {
        if (constraintToField(err) === "username") throw usernameError();
        throw err;
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
