const cfg = require("./config");
const pg = require("../pg");
const tokens = require("./tokens");
const users = require("./users");
const { getProfile } = require("./profile");

/**
 * Starts a login for `user`: stores a new refresh token (sent as an HttpOnly
 * cookie) and returns the access token for the response body.
 */
async function startSession(res, user) {
  await pg.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  await tokens.purgeExpired(user.id);
  const refresh = await tokens.createRefreshToken(pg, user.id);
  tokens.setRefreshCookie(res, refresh.token);
  return accessPayload(user);
}

function accessPayload(user) {
  return { accessToken: tokens.signAccessToken(user), tokenType: "Bearer", expiresIn: cfg.ACCESS_TTL_SECONDS };
}

/** The user as the browser sees it: account fields + profile + whether onboarding is done. */
async function describeUser(db, userRow) {
  const { profile, completed } = await getProfile(db, userRow.id);
  return { ...users.publicUser(userRow), profile, profileCompleted: completed };
}

module.exports = { startSession, accessPayload, describeUser };
