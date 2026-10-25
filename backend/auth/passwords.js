const { verifyAccessToken } = require("./tokens");

/** Requires `Authorization: Bearer <access token>`. Sets req.auth = { userId, email }. */
function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return res.status(401).json({ error: "Please sign in.", code: "unauthenticated" });
  try {
    const payload = verifyAccessToken(match[1].trim());
    req.auth = { userId: payload.sub, email: payload.email };
    next();
  } catch (err) {
    const expired = err && err.name === "TokenExpiredError";
    res.status(401).json({ error: expired ? "Your session expired." : "Please sign in again.", code: expired ? "token_expired" : "invalid_token" });
  }
}

module.exports = { requireAuth };
