/**
 * Redis cache for the public university pages.
 *
 *   bilimlaunch:universities          the list behind GET /api/universities
 *   bilimlaunch:university:<slug>     one university behind GET /api/universities/:slug
 *                                     (its config, photos and every generated program)
 *
 * Every place that changes a university (admin panel, photo uploads, scraping,
 * the seed/import scripts...) calls invalidateUniversity(slug) or
 * clearUniversities(), so the next visit reads fresh data from MongoDB and
 * caches it again. CACHE_TTL_SECONDS is only a safety net on top of that.
 *
 * The cache is optional and never breaks the site: without REDIS_URL it is
 * switched off, and when Redis is down or slow every call simply falls
 * through to MongoDB as before.
 */
require("dotenv").config();
const { createClient } = require("redis");

const REDIS_URL = (process.env.REDIS_URL || "").trim();
const TTL_SECONDS = Math.max(1, parseInt(process.env.CACHE_TTL_SECONDS || "3600", 10) || 3600);
const PREFIX = "bilimlaunch:";
// A cache that answers slower than this is treated as down for that request.
const OP_TIMEOUT_MS = 500;
// How long a write waits for the connection before giving up on invalidating
// (matters for the one-off scripts, which connect only when they first write).
const READY_TIMEOUT_MS = 3000;

const keys = {
  list: () => `${PREFIX}universities`,
  university: (slug) => `${PREFIX}university:${slug}`,
};

let client = null;
let connecting = null;
let createdAt = 0;
let lastErrorLog = 0;

function safeUrl(url = REDIS_URL) {
  return url.replace(/\/\/[^@/]*@/, "//***:***@");
}

/** The shared client, created (and connected in the background) on first use. */
function getClient() {
  if (!REDIS_URL) return null;
  if (client) return client;

  client = createClient({
    url: REDIS_URL,
    // Fail fast instead of queueing commands while Redis is unreachable.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(500 * 2 ** retries, 30000),
    },
  });
  client.on("ready", () => console.log(`[cache] Redis ready (${safeUrl()})`));
  client.on("error", (err) => {
    // Redis repeats the same error on every reconnect attempt; log at most once a minute.
    if (Date.now() - lastErrorLog > 60000) {
      lastErrorLog = Date.now();
      console.warn(`[cache] Redis unavailable, using MongoDB directly: ${err.message}`);
    }
  });
  createdAt = Date.now();
  connecting = client.connect().catch(() => {});
  return client;
}

function withTimeout(promise, ms = OP_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The client if it is connected, otherwise null. With `waitMs`, a client that
 * is still making its first connection (a script that just started, or the
 * server booting) is given up to that long; one that has been failing for a
 * while is not waited for, so Redis being down doesn't slow every request.
 */
async function readyClient(waitMs = 0) {
  const c = getClient();
  if (!c) return null;
  if (c.isReady) return c;
  const left = waitMs - (Date.now() - createdAt);
  if (left > 0) await withTimeout(connecting, left).catch(() => {});
  return c.isReady ? c : null;
}

async function getJSON(key) {
  const c = await readyClient();
  if (!c) return undefined;
  try {
    const raw = await withTimeout(c.get(key));
    return raw == null ? undefined : JSON.parse(raw);
  } catch (err) {
    console.warn(`[cache] read ${key} failed: ${err.message}`);
    return undefined;
  }
}

async function setJSON(key, value, ttlSeconds = TTL_SECONDS) {
  const c = await readyClient();
  if (!c) return;
  try {
    await withTimeout(c.set(key, JSON.stringify(value), { EX: ttlSeconds }));
  } catch (err) {
    console.warn(`[cache] write ${key} failed: ${err.message}`);
  }
}

/**
 * Returns { value, hit }: the cached value when there is one, otherwise the
 * result of `load()`, which is then cached. null/undefined results (e.g. an
 * unknown slug) are not cached.
 */
async function wrap(key, load, ttlSeconds = TTL_SECONDS) {
  const cached = await getJSON(key);
  if (cached !== undefined) return { value: cached, hit: true };
  const value = await load();
  if (value != null) await setJSON(key, value, ttlSeconds);
  return { value, hit: false };
}

async function del(keyList) {
  const c = await readyClient(READY_TIMEOUT_MS);
  if (!c || !keyList.length) return;
  try {
    await withTimeout(c.unlink(keyList), READY_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[cache] could not clear ${keyList.join(", ")}: ${err.message}`);
  }
}

/** Call after changing anything about one university (config, photos, programs, or deleting it). */
function invalidateUniversity(slug) {
  return del(slug ? [keys.list(), keys.university(slug)] : [keys.list()]);
}

/** Drops every cached university page. For bulk changes (seed / import scripts). */
async function clearUniversities() {
  const c = await readyClient(READY_TIMEOUT_MS);
  if (!c) return;
  try {
    const found = [keys.list()];
    for await (const batch of c.scanIterator({ MATCH: `${PREFIX}university:*`, COUNT: 200 })) {
      found.push(...(Array.isArray(batch) ? batch : [batch]));
    }
    await withTimeout(c.unlink(found), READY_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[cache] could not clear the university cache: ${err.message}`);
  }
}

/** For startup logs: whether the cache is in use. */
async function check() {
  if (!REDIS_URL) return { ok: false, message: "off (REDIS_URL not set)" };
  const c = await readyClient(READY_TIMEOUT_MS);
  return c
    ? { ok: true, message: `on, ${safeUrl()} (entries kept up to ${TTL_SECONDS}s)` }
    : { ok: false, message: `can't reach ${safeUrl()} yet -- serving from MongoDB and retrying in the background` };
}

/** Closes the connection so a one-off script can exit. */
async function close() {
  if (!client) return;
  const c = client;
  client = null;
  connecting = null;
  createdAt = 0;
  try {
    // Connected: finish pending commands first. Still connecting: just stop retrying.
    if (c.isReady) await (typeof c.close === "function" ? c.close() : c.quit());
    else await (typeof c.destroy === "function" ? c.destroy() : c.disconnect());
  } catch (_) {
    /* already closed */
  }
}

module.exports = { keys, wrap, getJSON, setJSON, invalidateUniversity, clearUniversities, check, close, enabled: !!REDIS_URL, TTL_SECONDS };
