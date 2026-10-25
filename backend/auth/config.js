const crypto = require("crypto");
const cfg = require("./config");
const pg = require("../pg");
const { HttpError } = require("./errors");

/*
 * E-mailed verification codes: six digits, valid for 10 minutes, five wrong
 * guesses allowed per code. Only a keyed hash is stored, so a copy of the
 * database does not reveal live codes.
 */
const KEY = crypto.createHmac("sha256", cfg.ACCESS_SECRET).update("email-code-v1").digest();

function hashCode(userId, purpose, code) {
  return crypto.createHmac("sha256", KEY).update(`${userId}:${purpose}:${code}`).digest("hex");
}

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/**
 * Creates a fresh code (replacing any earlier unused one) and returns it.
 * Throws HttpError 429 if asked again too quickly, or too often in an hour.
 */
async function issueCode(userId, purpose) {
  return pg.tx(async (c) => {
    // Serialise per user so two simultaneous clicks can't both pass the cooldown check.
    await c.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);

    const last = (
      await c.query("SELECT created_at FROM email_codes WHERE user_id = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1", [userId, purpose])
    ).rows[0];
    if (last) {
      const wait = Math.ceil(cfg.CODE_RESEND_COOLDOWN_SECONDS - (Date.now() - new Date(last.created_at).getTime()) / 1000);
      if (wait > 0) {
        throw new HttpError(429, `Please wait ${wait} seconds before asking for another code.`, "cooldown", { retryAfter: wait });
      }
    }
    const sentLastHour = (
      await c.query("SELECT count(*)::int AS n FROM email_codes WHERE user_id = $1 AND purpose = $2 AND created_at > now() - interval '1 hour'", [userId, purpose])
    ).rows[0].n;
    if (sentLastHour >= cfg.CODE_MAX_PER_HOUR) {
      throw new HttpError(429, "Too many codes requested. Please try again in an hour.", "too_many_codes", { retryAfter: 3600 });
    }

    await c.query("UPDATE email_codes SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL", [userId, purpose]);
    const code = newCode();
    const id = (
      await c.query(
        "INSERT INTO email_codes (user_id, purpose, code_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id",
        [userId, purpose, hashCode(userId, purpose, code), cfg.CODE_TTL_MINUTES]
      )
    ).rows[0].id;
    return { code, id };
  });
}

/** Removes a code that never reached the user (e-mail sending failed), so they can retry at once. */
function discardCode(id) {
  return pg.query("DELETE FROM email_codes WHERE id = $1", [id]);
}

/**
 * Checks a code inside the caller's transaction `c`.
 * Returns 'ok' | 'invalid' | 'expired' | 'locked' (plus attemptsLeft for 'invalid').
 * Never throws for a wrong code, so the attempt counter is committed.
 */
async function checkCode(c, userId, purpose, code) {
  const row = (
    await c.query(
      "SELECT * FROM email_codes WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [userId, purpose]
    )
  ).rows[0];
  if (!row || new Date(row.expires_at) < new Date()) return { result: "expired" };
  if (row.attempts >= cfg.CODE_MAX_ATTEMPTS) return { result: "locked" };

  const given = Buffer.from(hashCode(userId, purpose, code));
  const stored = Buffer.from(row.code_hash);
  if (given.length === stored.length && crypto.timingSafeEqual(given, stored)) {
    await c.query("UPDATE email_codes SET consumed_at = now() WHERE id = $1", [row.id]);
    return { result: "ok" };
  }
  await c.query("UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
  return { result: "invalid", attemptsLeft: Math.max(0, cfg.CODE_MAX_ATTEMPTS - row.attempts - 1) };
}

module.exports = { issueCode, discardCode, checkCode };
