const crypto = require("crypto");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return email.length <= 254 && EMAIL_RE.test(email);
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** What the browser is allowed to know about a user (never the hash). */
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    username: row.username,
    // 'user' or 'admin'. Only used to decide what to SHOW; the server re-checks the database on every admin request.
    role: row.role,
    emailVerified: row.email_verified,
    avatarUrl: row.avatar_url || null,
    hasPassword: !!row.password_hash,
    createdAt: row.created_at,
  };
}

async function findByEmail(db, email) {
  return (await db.query("SELECT * FROM users WHERE email = $1", [email])).rows[0] || null;
}

async function findById(db, id) {
  return (await db.query("SELECT * FROM users WHERE id = $1", [id])).rows[0] || null;
}

async function findByOAuth(db, provider, providerUserId) {
  return (
    (
      await db.query(
        "SELECT u.* FROM users u JOIN oauth_accounts o ON o.user_id = u.id WHERE o.provider = $1 AND o.provider_user_id = $2",
        [provider, providerUserId]
      )
    ).rows[0] || null
  );
}

async function usernameTaken(db, username) {
  return (await db.query("SELECT 1 FROM users WHERE username = $1", [username])).rowCount > 0;
}

/**
 * Returns `desired` if nobody else has it, otherwise the same name with a random
 * number added ("aigerim.b" -> "aigerim.b4821"). Usernames are never reported as
 * "taken", because that would let anyone test which usernames exist.
 * `excludeUserId` is the account that is allowed to keep its own name.
 */
async function availableUsername(db, desired, excludeUserId = null) {
  const taken = async (name) =>
    (await db.query("SELECT 1 FROM users WHERE username = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)", [name, excludeUserId])).rowCount > 0;
  if (!(await taken(desired))) return desired;
  const base = desired.slice(0, 25);
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}${crypto.randomInt(1000, 10000)}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${desired.slice(0, 22)}${crypto.randomBytes(4).toString("hex")}`;
}

/** A free username derived from the e-mail's local part, e.g. "aigerim.b" -> "aigerim.b" or "aigerim.b4821". */
async function suggestUsername(db, email, fullName) {
  const local = (email.split("@")[0] || fullName || "student").toLowerCase().replace(/[^a-z0-9_.]/g, "");
  const base = (local.length >= 3 ? local : `${local}user`).slice(0, 22);
  if (!(await usernameTaken(db, base))) return base;
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}${crypto.randomInt(1000, 10000)}`;
    if (!(await usernameTaken(db, candidate))) return candidate;
  }
  return `${base}${crypto.randomBytes(4).toString("hex")}`;
}

module.exports = {
  EMAIL_RE,
  USERNAME_RE,
  normalizeEmail,
  isValidEmail,
  normalizeUsername,
  publicUser,
  findByEmail,
  findById,
  findByOAuth,
  usernameTaken,
  availableUsername,
  suggestUsername,
};
