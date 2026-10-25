const bcrypt = require("bcrypt");
const { BCRYPT_ROUNDS } = require("./config");

// bcrypt only looks at the first 72 BYTES of a password and silently ignores
// the rest, so longer passwords are rejected instead of being half-used.
const MAX_BYTES = 72;
const MIN_LENGTH = 8;

/** Returns an error message, or null if the password is acceptable. */
function passwordProblem(password, email) {
  if (typeof password !== "string" || password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (Buffer.byteLength(password, "utf8") > MAX_BYTES) return `Use at most ${MAX_BYTES} bytes (about ${MAX_BYTES} characters, fewer if you use emoji or non-Latin letters).`;
  if (!/[A-Za-zÀ-￿]/.test(password) || !/\d/.test(password)) return "Use at least one letter and one number.";
  if (email && password.toLowerCase() === String(email).toLowerCase()) return "Your password can't be the same as your email.";
  return null;
}

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// When the e-mail isn't registered we still do one bcrypt comparison, so the
// response time doesn't reveal whether an account exists.
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await bcrypt.hash("bilimlaunch-timing-equalizer", BCRYPT_ROUNDS);
  await bcrypt.compare(String(password || ""), dummyHash);
}

module.exports = { passwordProblem, hashPassword, verifyPassword, burnTime };
