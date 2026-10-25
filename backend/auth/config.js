require("dotenv").config();
const crypto = require("crypto");

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const IS_TEST = NODE_ENV === "test";

function int(name, fallback, { min = 1, max = Infinity } = {}) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Signing secrets. In production they MUST be set (and be different). In
// development a missing one is replaced by a random value, which means
// everyone is signed out whenever the server restarts -- fine for a laptop.
function secret(name) {
  const value = (process.env[name] || "").trim();
  if (value.length >= 32) return value;
  if (IS_PROD) {
    throw new Error(`${name} must be set to a random string of at least 32 characters (see README: "Generate the two JWT secrets").`);
  }
  if (!secret.warned) secret.warned = new Set();
  if (!secret.warned.has(name)) {
    secret.warned.add(name);
    console.warn(`[auth] ${name} is not set -- using a random one for this run. Everyone is signed out when the server restarts.`);
  }
  return crypto.randomBytes(48).toString("hex");
}

const PORT = process.env.PORT || 3000;
// Public address of the site, no trailing slash. Used for the Google redirect URI.
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).trim().replace(/\/+$/, "");

const ACCESS_SECRET = secret("JWT_ACCESS_SECRET");
const REFRESH_SECRET = secret("JWT_REFRESH_SECRET");
if (ACCESS_SECRET === REFRESH_SECRET) {
  throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be two different values.");
}

module.exports = {
  NODE_ENV,
  IS_PROD,
  IS_TEST,
  APP_BASE_URL,
  COOKIE_SECURE: APP_BASE_URL.startsWith("https://"),

  ACCESS_SECRET,
  REFRESH_SECRET,
  JWT_ISSUER: "bilimlaunch",
  JWT_AUDIENCE: "bilimlaunch-web",
  ACCESS_TTL_SECONDS: int("ACCESS_TOKEN_TTL_MINUTES", 15, { min: 1, max: 24 * 60 }) * 60,
  REFRESH_TTL_DAYS: int("REFRESH_TOKEN_TTL_DAYS", 30, { min: 1, max: 365 }),
  // A refresh token that was *just* rotated may legitimately arrive once more
  // (two tabs refreshing together). Inside this window it is not treated as theft.
  REFRESH_REUSE_GRACE_SECONDS: 10,
  REFRESH_COOKIE: "bl_refresh",

  BCRYPT_ROUNDS: int("BCRYPT_ROUNDS", 12, { min: IS_TEST ? 4 : 10, max: 15 }),

  RESEND_API_KEY: (process.env.RESEND_API_KEY || "").trim(),
  EMAIL_FROM: (process.env.EMAIL_FROM || "BilimLaunch <no-reply@bilimlaunch.com>").trim(),
  CODE_TTL_MINUTES: 10,
  CODE_MAX_ATTEMPTS: 5,
  CODE_RESEND_COOLDOWN_SECONDS: 60,
  CODE_MAX_PER_HOUR: 5,

  GOOGLE_CLIENT_ID: (process.env.GOOGLE_CLIENT_ID || "").trim(),
  GOOGLE_CLIENT_SECRET: (process.env.GOOGLE_CLIENT_SECRET || "").trim(),
};
