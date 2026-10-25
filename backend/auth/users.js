const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const cfg = require("./config");
const pg = require("../pg");

/*
 * Two kinds of JWT, signed with two different secrets:
 *
 *   access token   short-lived (15 min), sent as `Authorization: Bearer ...`.
 *                  Stateless: the server only checks the signature.
 *   refresh token  long-lived (30 days), lives in an HttpOnly cookie that
 *                  JavaScript can't read. Every use swaps it for a new one
 *                  ("rotation"), and each one is recorded in Postgres so it
 *                  can be revoked (logout, theft detection).
 */

const COMMON = { algorithm: "HS256", issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE };
const VERIFY = { algorithms: ["HS256"], issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE };

function signAccessToken(user) {
  return jwt.sign({ typ: "access", email: user.email }, cfg.ACCESS_SECRET, {
    ...COMMON,
    subject: user.id,
    expiresIn: cfg.ACCESS_TTL_SECONDS,
  });
}

/** Returns the payload, or throws a jsonwebtoken error (TokenExpiredError, JsonWebTokenError...). */
function verifyAccessToken(token) {
  const payload = jwt.verify(token, cfg.ACCESS_SECRET, VERIFY);
  if (payload.typ !== "access") throw new jwt.JsonWebTokenError("wrong token type");
  return payload;
}

function signRefreshToken({ userId, jti, familyId }) {
  return jwt.sign({ typ: "refresh", fid: familyId }, cfg.REFRESH_SECRET, {
    ...COMMON,
    subject: userId,
    jwtid: jti,
    expiresIn: cfg.REFRESH_TTL_DAYS * 86400,
  });
}

function verifyRefreshToken(token) {
  const payload = jwt.verify(token, cfg.REFRESH_SECRET, VERIFY);
  if (payload.typ !== "refresh" || !payload.jti || !payload.fid) throw new jwt.JsonWebTokenError("wrong token type");
  return payload;
}

/** Stores a new refresh token row and returns the signed JWT. */
async function createRefreshToken(db, userId, familyId = crypto.randomUUID()) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + cfg.REFRESH_TTL_DAYS * 86400 * 1000);
  await db.query(
    "INSERT INTO refresh_tokens (id, user_id, family_id, expires_at) VALUES ($1, $2, $3, $4)",
    [jti, userId, familyId, expiresAt]
  );
  return { token: signRefreshToken({ userId, jti, familyId }), jti, familyId };
}

/*
 * Swaps a refresh token for a fresh one. Returns:
 *   { userId, refreshToken }            normal rotation
 *   { userId, refreshToken: null }      same token arrived twice within a few seconds
 *                                        (two tabs): caller issues an access token only
 * Throws an Error with .reason = 'invalid' | 'reuse' when the token must be refused.
 */
async function rotateRefreshToken(oldJwt) {
  let payload;
  try {
    payload = verifyRefreshToken(oldJwt);
  } catch (_) {
    throw Object.assign(new Error("invalid refresh token"), { reason: "invalid" });
  }

  return pg.tx(async (c) => {
    const row = (await c.query("SELECT * FROM refresh_tokens WHERE id = $1 FOR UPDATE", [payload.jti])).rows[0];
    if (!row || row.user_id !== payload.sub || row.family_id !== payload.fid || new Date(row.expires_at) < new Date()) {
      throw Object.assign(new Error("unknown refresh token"), { reason: "invalid" });
    }

    if (row.revoked_at) {
      const ageSeconds = (Date.now() - new Date(row.revoked_at).getTime()) / 1000;
      if (row.replaced_by && ageSeconds <= cfg.REFRESH_REUSE_GRACE_SECONDS) {
        return { userId: row.user_id, refreshToken: null };
      }
      // A token that was already used up is being replayed: assume it was stolen
      // and end every session that descends from the same login.
      await c.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id]);
      // (the revocation must survive, so signal the caller *after* commit)
      return { reuse: true };
    }

    const next = await createRefreshToken(c, row.user_id, row.family_id);
    await c.query("UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1", [row.id, next.jti]);
    return { userId: row.user_id, refreshToken: next.token };
  }).then((result) => {
    if (result.reuse) throw Object.assign(new Error("refresh token reuse detected"), { reason: "reuse" });
    return result;
  });
}

/** Revokes the whole login (family) that this refresh token belongs to. Never throws for a bad token. */
async function revokeByToken(refreshJwt) {
  try {
    const payload = verifyRefreshToken(refreshJwt);
    await pg.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [payload.fid]);
  } catch (_) {
    /* expired or forged: nothing to revoke */
  }
}

function revokeAllForUser(userId) {
  return pg.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

/** Housekeeping: forget tokens that expired a while ago. */
function purgeExpired(userId) {
  return pg.query("DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at < now() - interval '1 day'", [userId]);
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: "lax", // "lax" (not "strict") so the cookie survives the redirect back from Google
    path: "/api/auth", // the browser only sends it to the auth endpoints
  };
}

function setRefreshCookie(res, token) {
  res.cookie(cfg.REFRESH_COOKIE, token, { ...cookieOptions(), maxAge: cfg.REFRESH_TTL_DAYS * 86400 * 1000 });
}

function clearRefreshCookie(res) {
  res.clearCookie(cfg.REFRESH_COOKIE, cookieOptions());
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  createRefreshToken,
  rotateRefreshToken,
  revokeByToken,
  revokeAllForUser,
  purgeExpired,
  setRefreshCookie,
  clearRefreshCookie,
};
