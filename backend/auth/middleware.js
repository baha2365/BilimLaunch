const { verifyAccessToken } = require("./tokens");
const pg = require("../pg");

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

/*
 * Admin gate. The role is read from PostgreSQL on EVERY request -- it is not
 * stored in the token and nothing the browser sends can influence it. So
 * promoting or demoting someone takes effect on their very next request.
 * Runs after requireAuth (a valid access token is needed first).
 */
async function adminCheck(req, res, next) {
  try {
    const row = (await pg.query("SELECT role, email_verified FROM users WHERE id = $1", [req.auth.userId])).rows[0];
    if (!row) return res.status(401).json({ error: "Please sign in again.", code: "invalid_token" });
    if (row.role !== "admin" || !row.email_verified) {
      console.warn(`[security] DENIED admin access: user ${req.auth.userId} (${req.auth.email}) ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ error: "This area is for administrators only.", code: "forbidden" });
    }
    req.auth.role = "admin";
    if (req.method !== "GET" && req.method !== "HEAD") {
      console.log(`[audit] admin ${req.auth.email} ${req.method} ${req.originalUrl.split("?")[0]}`);
    }
    next();
  } catch (err) {
    console.error(`[security] admin check failed: ${err.message}`);
    res.status(503).json({ error: "Could not verify your permissions right now. Please try again.", code: "db_unavailable" });
  }
}

const requireAdmin = [requireAuth, adminCheck];

module.exports = { requireAuth, requireAdmin };
