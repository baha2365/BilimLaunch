/**
 * Discover -- the news & opportunities feed. Mounted at /api/posts behind
 * requireAuth (every route needs a signed-in user).
 *
 *   GET    /                       the feed, newest first        ?cursor=
 *   GET    /saved                  the viewer's saved posts       ?cursor=
 *   GET    /:id                    one post
 *   PUT    /:id/like   DELETE      like / unlike                 -> { liked, likeCount }
 *   PUT    /:id/save   DELETE      save / unsave                 -> { saved }
 *   GET    /:id/comments           oldest first                  ?cursor=
 *   POST   /:id/comments           { body }                      -> { comment, commentCount }
 *   DELETE /:id/comments/:cid      own comment (admins: any)     -> { commentCount }
 *
 * Admins only (the role is re-read from PostgreSQL on every request):
 *   POST   /media                  body = one photo/video file   ?w=&h=  -> { media }
 *   DELETE /media/:mediaId         drop an upload that wasn't posted
 *   POST   /                       { caption, mediaIds: [...] }  -> { post }
 *   PATCH  /:id                    { caption }                   -> { post }
 *   DELETE /:id
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const pg = require("../pg");
const storage = require("../storage");
const { requireAdmin } = require("../auth/middleware");
const { HttpError, wrap } = require("../auth/errors");
const { avatarUrlOf } = require("../auth/users");
const { storeUpload, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES, VIDEO_MAX_SECONDS } = require("./media");

const PAGE_SIZE = 8;
const COMMENT_PAGE_SIZE = 30;
const MAX_MEDIA_PER_POST = 10;
const MAX_CAPTION = 2200;
const MAX_COMMENT = 1000;
const UNATTACHED_TTL_HOURS = 6;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(value, what = "post") {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new HttpError(404, `That ${what} doesn't exist.`, "not_found");
  return value.toLowerCase();
}

/* ---------------- cursors: "<timestamp>|<uuid>", base64url ---------------- */

function encodeCursor(ts, id) {
  return Buffer.from(`${ts}|${id}`).toString("base64url");
}

function decodeCursor(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const [ts, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!ts || Number.isNaN(Date.parse(ts)) || !UUID_RE.test(id || "")) throw new HttpError(400, "Invalid page cursor.", "bad_cursor");
  return { ts, id };
}

/* ---------------- reading posts ---------------- */

// $1 is always the viewer's user id.
const POST_COLUMNS = `
  p.id, p.caption, p.like_count, p.comment_count, p.created_at, p.updated_at,
  p.created_at::text AS cursor_ts,
  u.full_name AS author_name, u.username AS author_username, u.avatar_url AS author_avatar, u.avatar_key AS author_avatar_key,
  EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked,
  EXISTS (SELECT 1 FROM saved_posts s WHERE s.post_id = p.id AND s.user_id = $1) AS saved,
  COALESCE((
    SELECT json_agg(json_build_object('id', m.id, 'kind', m.kind, 'key', m.storage_key, 'width', m.width,
                                      'height', m.height, 'duration', m.duration_seconds) ORDER BY m.position)
    FROM post_media m WHERE m.post_id = p.id
  ), '[]'::json) AS media`;

function presentPost(row) {
  const edited = row.updated_at && row.created_at && new Date(row.updated_at) - new Date(row.created_at) > 60000;
  return {
    id: row.id,
    caption: row.caption,
    author: {
      name: row.author_name || "BilimLaunch",
      username: row.author_username || "bilimlaunch",
      avatarUrl: avatarUrlOf(row.author_avatar_key, row.author_avatar),
    },
    media: (row.media || []).map((m) => ({
      id: m.id,
      kind: m.kind,
      url: storage.publicUrl(m.key),
      width: m.width,
      height: m.height,
      duration: m.duration == null ? null : Number(m.duration),
    })),
    likeCount: row.like_count,
    commentCount: row.comment_count,
    liked: row.liked,
    saved: row.saved,
    createdAt: row.created_at,
    edited: Boolean(edited),
  };
}

async function getPost(id, viewerId, db = pg) {
  const row = (await db.query(`SELECT ${POST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = $2`, [viewerId, id])).rows[0];
  if (!row) throw new HttpError(404, "That post doesn't exist anymore.", "not_found");
  return presentPost(row);
}

async function isAdmin(userId) {
  const row = (await pg.query("SELECT role, email_verified FROM users WHERE id = $1", [userId])).rows[0];
  return Boolean(row && row.role === "admin" && row.email_verified);
}

function presentComment(row, viewerId, viewerIsAdmin) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: { name: row.full_name || "Deleted user", username: row.username || "", avatarUrl: avatarUrlOf(row.avatar_key, row.avatar_url) },
    canDelete: viewerIsAdmin || row.user_id === viewerId,
  };
}

/* ---------------- input ---------------- */

function cleanCaption(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw new HttpError(400, "The caption must be text.", "invalid", { errors: { caption: "Invalid caption." } });
  const caption = value.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (caption.length > MAX_CAPTION) {
    throw new HttpError(400, `Captions can be at most ${MAX_CAPTION} characters.`, "invalid", { errors: { caption: "Too long." } });
  }
  return caption;
}

/* ---------------- unattached uploads ---------------- */

/** Removes uploads that were never posted (the admin closed the composer). Never throws. */
async function sweepUnattachedMedia() {
  try {
    const { rows } = await pg.query(
      `DELETE FROM post_media WHERE id IN (
         SELECT id FROM post_media WHERE post_id IS NULL AND created_at < now() - make_interval(hours => $1) LIMIT 200
       ) RETURNING storage_key`,
      [UNATTACHED_TTL_HOURS]
    );
    for (const { storage_key: key } of rows) {
      await storage.deleteObject(key).catch((err) => console.warn(`[posts] could not delete ${key}: ${err.message}`));
    }
    if (rows.length) console.log(`[posts] removed ${rows.length} upload(s) that were never posted`);
  } catch (err) {
    if (err && err.code !== "42P01") console.warn(`[posts] cleanup failed: ${err.message}`);
  }
}

function startMediaSweeper() {
  setTimeout(sweepUnattachedMedia, 30 * 1000).unref();
  setInterval(sweepUnattachedMedia, 60 * 60 * 1000).unref();
}

/* ---------------- router ---------------- */

function limiter(max, what) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.auth.userId,
    handler: (req, res) => res.status(429).json({ error: `You're ${what} too fast. Please wait a moment.`, code: "rate_limited" }),
  });
}

function createPostsRouter() {
  const router = express.Router();
  const commentLimit = limiter(15, "commenting");
  const reactLimit = limiter(120, "doing that");

  /* ---- feed ---- */
  router.get(
    "/",
    wrap(async (req, res) => {
      const viewer = req.auth.userId;
      const cursor = decodeCursor(req.query.cursor);
      const [{ rows }, admin] = await Promise.all([
        pg.query(
          `SELECT ${POST_COLUMNS}
             FROM posts p LEFT JOIN users u ON u.id = p.author_id
            WHERE ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
            ORDER BY p.created_at DESC, p.id DESC
            LIMIT $4`,
          [viewer, cursor ? cursor.ts : null, cursor ? cursor.id : null, PAGE_SIZE + 1]
        ),
        isAdmin(viewer),
      ]);
      const page = rows.slice(0, PAGE_SIZE);
      const last = page[page.length - 1];
      res.json({
        posts: page.map(presentPost),
        nextCursor: rows.length > PAGE_SIZE ? encodeCursor(last.cursor_ts, last.id) : null,
        canPost: admin,
        // What the composer checks before uploading (the server checks again).
        limits: admin ? { imageMaxBytes: IMAGE_MAX_BYTES, videoMaxBytes: VIDEO_MAX_BYTES, videoMaxSeconds: VIDEO_MAX_SECONDS, maxMedia: MAX_MEDIA_PER_POST, maxCaption: MAX_CAPTION } : null,
      });
    })
  );

  /* ---- saved posts (profile) ---- */
  router.get(
    "/saved",
    wrap(async (req, res) => {
      const viewer = req.auth.userId;
      const cursor = decodeCursor(req.query.cursor);
      const { rows } = await pg.query(
        `SELECT ${POST_COLUMNS}, sp.created_at::text AS saved_ts
           FROM saved_posts sp
           JOIN posts p ON p.id = sp.post_id
           LEFT JOIN users u ON u.id = p.author_id
          WHERE sp.user_id = $1
            AND ($2::timestamptz IS NULL OR (sp.created_at, sp.post_id) < ($2::timestamptz, $3::uuid))
          ORDER BY sp.created_at DESC, sp.post_id DESC
          LIMIT $4`,
        [viewer, cursor ? cursor.ts : null, cursor ? cursor.id : null, 24 + 1]
      );
      const page = rows.slice(0, 24);
      const last = page[page.length - 1];
      res.json({ posts: page.map(presentPost), nextCursor: rows.length > 24 ? encodeCursor(last.saved_ts, last.id) : null });
    })
  );

  /* ---- admin: uploads ---- */
  router.post(
    "/media",
    requireAdmin,
    wrap(async (req, res) => {
      const stored = await storeUpload(req);
      let row;
      try {
        row = (
          await pg.query(
            `INSERT INTO post_media (uploaded_by, kind, storage_key, content_type, size_bytes, width, height, duration_seconds)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [req.auth.userId, stored.kind, stored.key, stored.contentType, stored.size, stored.width, stored.height, stored.duration]
          )
        ).rows[0];
      } catch (err) {
        await storage.deleteObject(stored.key).catch(() => {});
        throw err;
      }
      res.status(201).json({
        media: { id: row.id, kind: stored.kind, url: storage.publicUrl(stored.key), width: stored.width, height: stored.height, duration: stored.duration },
      });
    })
  );

  router.delete(
    "/media/:mediaId",
    requireAdmin,
    wrap(async (req, res) => {
      const id = uuidParam(req.params.mediaId, "upload");
      const row = (await pg.query("DELETE FROM post_media WHERE id = $1 AND post_id IS NULL RETURNING storage_key", [id])).rows[0];
      if (row) await storage.deleteObject(row.storage_key).catch(() => {});
      res.json({ ok: true });
    })
  );

  /* ---- admin: create / edit / delete ---- */
  router.post(
    "/",
    requireAdmin,
    wrap(async (req, res) => {
      const body = req.body || {};
      const caption = cleanCaption(body.caption);
      const ids = Array.isArray(body.mediaIds) ? body.mediaIds : [];
      if (!ids.length) throw new HttpError(400, "Add at least one photo or video.", "no_media");
      if (ids.length > MAX_MEDIA_PER_POST) throw new HttpError(400, `A post can have at most ${MAX_MEDIA_PER_POST} photos and videos.`, "too_many");
      if (!ids.every((id) => typeof id === "string" && UUID_RE.test(id)) || new Set(ids).size !== ids.length) {
        throw new HttpError(400, "Invalid media list.", "invalid");
      }

      const postId = await pg.tx(async (client) => {
        const { id } = (await client.query("INSERT INTO posts (author_id, caption) VALUES ($1, $2) RETURNING id", [req.auth.userId, caption])).rows[0];
        const attached = await client.query(
          `UPDATE post_media m SET post_id = $1, position = x.ord - 1
             FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, ord)
            WHERE m.id = x.id AND m.post_id IS NULL AND m.uploaded_by = $3`,
          [id, ids, req.auth.userId]
        );
        if (attached.rowCount !== ids.length) {
          throw new HttpError(409, "Some of the uploads have expired. Remove them and add them again.", "media_gone");
        }
        return id;
      });
      res.status(201).json({ post: await getPost(postId, req.auth.userId) });
    })
  );

  router.patch(
    "/:id",
    requireAdmin,
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      const caption = cleanCaption((req.body || {}).caption);
      const { rowCount } = await pg.query("UPDATE posts SET caption = $2, updated_at = now() WHERE id = $1", [id, caption]);
      if (!rowCount) throw new HttpError(404, "That post doesn't exist anymore.", "not_found");
      res.json({ post: await getPost(id, req.auth.userId) });
    })
  );

  router.delete(
    "/:id",
    requireAdmin,
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      const keys = await pg.tx(async (client) => {
        const media = await client.query("SELECT storage_key FROM post_media WHERE post_id = $1", [id]);
        const { rowCount } = await client.query("DELETE FROM posts WHERE id = $1", [id]);
        if (!rowCount) throw new HttpError(404, "That post doesn't exist anymore.", "not_found");
        return media.rows.map((r) => r.storage_key);
      });
      for (const key of keys) {
        storage.deleteObject(key).catch((err) => console.warn(`[posts] could not delete ${key}: ${err.message}`));
      }
      res.json({ ok: true });
    })
  );

  /* ---- one post ---- */
  router.get(
    "/:id",
    wrap(async (req, res) => {
      res.json({ post: await getPost(uuidParam(req.params.id), req.auth.userId) });
    })
  );

  /* ---- likes: the counter is updated in the same statement, so it can't drift ---- */
  router.put(
    "/:id/like",
    reactLimit,
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      const row = (
        await pg.query(
          `WITH ins AS (
             INSERT INTO post_likes (post_id, user_id)
             SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM posts WHERE id = $1)
             ON CONFLICT DO NOTHING RETURNING 1
           )
           UPDATE posts SET like_count = like_count + (SELECT count(*) FROM ins) WHERE id = $1 RETURNING like_count`,
          [id, req.auth.userId]
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "That post doesn't exist anymore.", "not_found");
      res.json({ liked: true, likeCount: row.like_count });
    })
  );

  router.delete(
    "/:id/like",
    reactLimit,
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      const row = (
        await pg.query(
          `WITH del AS (DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 RETURNING 1)
           UPDATE posts SET like_count = GREATEST(0, like_count - (SELECT count(*) FROM del)) WHERE id = $1 RETURNING like_count`,
          [id, req.auth.userId]
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "That post doesn't exist anymore.", "not_found");
      res.json({ liked: false, likeCount: row.like_count });
    })
  );

  /* ---- saves ---- */
  router.put(
    "/:id/save",
    reactLimit,
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      const { rowCount } = await pg.query(
        `INSERT INTO saved_posts (user_id, post_id) SELECT $2, $1 WHERE EXISTS (SELECT 1 FROM posts WHERE id = $1)
         ON CONFLICT DO NOTHING`,
        [id, req.auth.userId]
      );
      if (!rowCount && !(await pg.query("SELECT 1 FROM posts WHERE id = $1", [id])).rowCount) {
        throw new HttpError(404, "That post doesn't exist anymore.", "not_found");
      }
      res.json({ saved: true });
    })
  );

  router.delete(
    "/:id/save",
    reactLimit,
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      await pg.query("DELETE FROM saved_posts WHERE user_id = $2 AND post_id = $1", [id, req.auth.userId]);
      res.json({ saved: false });
    })
  );

  /* ---- comments ---- */
  router.get(
    "/:id/comments",
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      const viewer = req.auth.userId;
      const cursor = decodeCursor(req.query.cursor);
      const [{ rows }, admin, exists] = await Promise.all([
        pg.query(
          `SELECT c.id, c.body, c.created_at, c.created_at::text AS cursor_ts, c.user_id, u.full_name, u.username, u.avatar_url, u.avatar_key
             FROM post_comments c LEFT JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1
              AND ($2::timestamptz IS NULL OR (c.created_at, c.id) > ($2::timestamptz, $3::uuid))
            ORDER BY c.created_at, c.id
            LIMIT $4`,
          [id, cursor ? cursor.ts : null, cursor ? cursor.id : null, COMMENT_PAGE_SIZE + 1]
        ),
        isAdmin(viewer),
        pg.query("SELECT 1 FROM posts WHERE id = $1", [id]),
      ]);
      if (!exists.rowCount) throw new HttpError(404, "That post doesn't exist anymore.", "not_found");
      const page = rows.slice(0, COMMENT_PAGE_SIZE);
      const last = page[page.length - 1];
      res.json({
        comments: page.map((r) => presentComment(r, viewer, admin)),
        nextCursor: rows.length > COMMENT_PAGE_SIZE ? encodeCursor(last.cursor_ts, last.id) : null,
      });
    })
  );

  router.post(
    "/:id/comments",
    commentLimit,
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      const raw = (req.body || {}).body;
      const body = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
      if (!body) throw new HttpError(400, "Write something first.", "invalid");
      if (body.length > MAX_COMMENT) throw new HttpError(400, `Comments can be at most ${MAX_COMMENT} characters.`, "invalid");

      const result = await pg.tx(async (client) => {
        const post = (await client.query("UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1 RETURNING comment_count", [id])).rows[0];
        if (!post) throw new HttpError(404, "That post doesn't exist anymore.", "not_found");
        const row = (
          await client.query(
            `WITH c AS (INSERT INTO post_comments (post_id, user_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at, user_id)
             SELECT c.*, u.full_name, u.username, u.avatar_url, u.avatar_key FROM c LEFT JOIN users u ON u.id = c.user_id`,
            [id, req.auth.userId, body]
          )
        ).rows[0];
        return { row, commentCount: post.comment_count };
      });
      res.status(201).json({ comment: presentComment(result.row, req.auth.userId, false), commentCount: result.commentCount });
    })
  );

  router.delete(
    "/:id/comments/:commentId",
    wrap(async (req, res) => {
      const id = uuidParam(req.params.id);
      const commentId = uuidParam(req.params.commentId, "comment");
      const admin = await isAdmin(req.auth.userId);
      const commentCount = await pg.tx(async (client) => {
        const removed = await client.query("DELETE FROM post_comments WHERE id = $1 AND post_id = $2 AND (user_id = $3 OR $4) RETURNING 1", [
          commentId,
          id,
          req.auth.userId,
          admin,
        ]);
        if (!removed.rowCount) throw new HttpError(404, "That comment was already removed.", "not_found");
        return (await client.query("UPDATE posts SET comment_count = GREATEST(0, comment_count - 1) WHERE id = $1 RETURNING comment_count", [id])).rows[0]
          .comment_count;
      });
      res.json({ commentCount });
    })
  );

  /* ---- errors ---- */
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    // An upload refused half-way: answer, then close the connection instead of reading the rest of the file.
    if (err && (err.code === "too_large" || err.code === "aborted")) res.set("Connection", "close");
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    if (err instanceof storage.StorageError) return res.status(err.status).json({ error: err.message, code: "storage" });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request.", code: "invalid" });
    if (err && (err.code === "42P01" || err.code === "42703")) {
      console.error("[posts] the database is missing Discover tables/columns. Run:  node migrate_pg.js");
      return res.status(503).json({ error: "Discover isn't set up on this server yet.", code: "not_migrated" });
    }
    console.error(`[posts] ${req.method} ${req.originalUrl}: ${err && err.stack ? err.stack : err}`);
    res.status(500).json({ error: "Something went wrong. Please try again.", code: "server_error" });
  });

  return router;
}

module.exports = { createPostsRouter, startMediaSweeper, sweepUnattachedMedia };
