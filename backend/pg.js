require("dotenv").config();
const { Pool } = require("pg");

// User accounts live in PostgreSQL (Neon in production). Put the connection
// string in server/.env as DATABASE_URL, for example:
//   postgresql://user:password@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

let pool = null;

function getPool() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Add your PostgreSQL (Neon) connection string to server/.env.");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: parseInt(process.env.PG_POOL_MAX || "10", 10),
      idleTimeoutMillis: 30000,
      // Neon pauses idle databases; the first connection after a pause can take a few seconds.
      connectionTimeoutMillis: 15000,
    });
    // An idle client can be dropped by the server (Neon does this). Without a
    // listener, that 'error' event would crash the whole process.
    pool.on("error", (err) => console.error(`[postgres] idle client error: ${err.message}`));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

/** Runs fn(client) inside BEGIN/COMMIT; rolls back if fn throws. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* connection already gone */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** The connection string with the password hidden, safe to print. */
function safeUrl() {
  return DATABASE_URL.replace(/(\/\/[^:/@]*):[^@]*@/, "$1:***@");
}

/** Turns driver errors into something a teammate can act on. */
function explainError(err) {
  const msg = String((err && err.message) || err);
  if (/password authentication failed/i.test(msg)) return "Wrong username or password in DATABASE_URL.";
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return "Could not resolve the PostgreSQL host in DATABASE_URL. Check it for typos and check your internet connection.";
  if (/ECONNREFUSED/i.test(msg)) return "PostgreSQL refused the connection. Is it running, and are the host and port in DATABASE_URL right?";
  if (/timeout|timed out/i.test(msg)) return "Timed out connecting to PostgreSQL. If it's Neon, the database may be waking up -- try again in a few seconds.";
  if (/SSL|TLS/i.test(msg)) return "SSL problem. Neon needs ?sslmode=require at the end of DATABASE_URL; a local PostgreSQL usually needs no sslmode at all.";
  return msg;
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { query, tx, getPool, close, safeUrl, explainError, DATABASE_URL };
