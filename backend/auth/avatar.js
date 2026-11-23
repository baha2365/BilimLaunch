/**
 * Profile photos. The browser crops the picture to a square and shrinks it
 * (a few hundred KB at most) before uploading; this file checks it, stores it
 * in Cloudflare R2 (see ../storage.js) and remembers the key on the user row.
 *
 *   POST   /api/me/avatar   body = the image file (JPEG, PNG or WebP, max 2 MB) -> { user }
 *   DELETE /api/me/avatar                                                     -> { user }
 *
 * Files live under  avatars/<user id>/<random>.<ext>  and are never reused, so
 * the old file is deleted whenever the photo changes.
 * Public: GET /media/avatars/<...> streams a photo when R2_PUBLIC_URL isn't set.
 */
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const pg = require("../pg");
const storage = require("../storage");
const users = require("./users");
const { describeUser } = require("./session");
const { requireAuth } = require("./middleware");
const { HttpError, wrap } = require("./errors");
const { sniff } = require("../university_images");
const { createMediaHandler } = require("../posts/media");

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const AVATAR_KEY_RE = /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9]+-[a-f0-9]{12}\.(jpg|png|webp)$/;

function newKey(userId, ext) {
  return `avatars/${userId}/${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
}

async function respond(res, userId) {
  const row = await users.findById(pg, userId);
  if (!row) throw new HttpError(401, "Please sign in again.", "invalid_token");
  res.json({ user: await describeUser(pg, row) });
}

function createAvatarRouter() {
  const router = express.Router();
  router.use(requireAuth);
  const limit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.auth.userId,
    handler: (req, res) => res.status(429).json({ error: "You've changed your photo a lot just now. Please try again later.", code: "rate_limited" }),
  });
  const rawImage = express.raw({ type: () => true, limit: MAX_BYTES });

  router.post(
    "/",
    limit,
    rawImage,
    wrap(async (req, res) => {
      if (!storage.configured) throw new HttpError(503, "Photo storage isn't set up on this server yet.", "storage_off");
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, "No photo was received.", "empty");
      const ext = sniff(body);
      if (!ext) throw new HttpError(415, "Only JPEG, PNG or WebP photos can be used.", "unsupported");

      const userId = req.auth.userId;
      const key = newKey(userId, ext);
      await storage.putObject(key, body, TYPES[ext]);

      let old;
      try {
        // Swap the key in one statement and get the previous one back, so two
        // uploads at the same moment can't leave an orphaned file behind.
        const row = (
          await pg.query(
            `UPDATE users u SET avatar_key = $2, updated_at = now()
               FROM (SELECT id, avatar_key AS old_key FROM users WHERE id = $1 FOR UPDATE) prev
              WHERE u.id = prev.id
              RETURNING prev.old_key`,
            [userId, key]
          )
        ).rows[0];
        if (!row) throw new HttpError(401, "Please sign in again.", "invalid_token");
        old = row.old_key;
      } catch (err) {
        await storage.deleteObject(key).catch(() => {});
        throw err;
      }
      if (old && old !== key) storage.deleteObject(old).catch((e) => console.warn(`[avatar] could not delete ${old}: ${e.message}`));
      await respond(res, userId);
    })
  );

  // "Remove current photo": back to the initial letter. Also forgets the
  // picture Google gave us, so the removal sticks.
  router.delete(
    "/",
    limit,
    wrap(async (req, res) => {
      const userId = req.auth.userId;
      const row = (
        await pg.query(
          `UPDATE users u SET avatar_key = NULL, avatar_url = NULL, updated_at = now()
             FROM (SELECT id, avatar_key AS old_key FROM users WHERE id = $1 FOR UPDATE) prev
            WHERE u.id = prev.id
            RETURNING prev.old_key`,
          [userId]
        )
      ).rows[0];
      if (!row) throw new HttpError(401, "Please sign in again.", "invalid_token");
      if (row.old_key) storage.deleteObject(row.old_key).catch((e) => console.warn(`[avatar] could not delete ${row.old_key}: ${e.message}`));
      await respond(res, userId);
    })
  );

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "That photo is too large (the limit is 2 MB).", code: "too_large" });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    if (err instanceof storage.StorageError) return res.status(err.status).json({ error: err.message, code: "storage" });
    if (err && err.code === "42703") {
      console.error("[avatar] the avatar_key column doesn't exist yet. Run:  node migrate_pg.js");
      return res.status(503).json({ error: "Profile photos aren't set up on this server yet.", code: "not_migrated" });
    }
    console.error(`[avatar] ${req.method} ${req.originalUrl}: ${err && err.stack ? err.stack : err}`);
    res.status(500).json({ error: "Something went wrong. Please try again.", code: "server_error" });
  });

  return router;
}

const avatarMediaHandler = createMediaHandler("avatars/", AVATAR_KEY_RE);

module.exports = { createAvatarRouter, avatarMediaHandler };
