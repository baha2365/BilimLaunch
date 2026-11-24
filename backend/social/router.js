/**
 * People & follows -- Instagram-style public following between users.
 * Mounted at /api/users behind requireAuth (every route needs a signed-in user).
 *
 *   GET    /search?q=                 find people by username or name        -> { users }
 *   GET    /suggested                 people to follow (follows-you first)   -> { users }
 *   GET    /:username                 a profile with counts                  -> { user }
 *   PUT    /:username/follow          follow     -> { following, followerCount, followingCount }
 *   DELETE /:username/follow          unfollow   -> { following, followerCount, followingCount }
 *   DELETE /:username/follower        remove them from MY followers          -> { followerCount }
 *   GET    /:username/followers       who follows them, newest first         ?cursor=  -> { users, nextCursor }
 *   GET    /:username/following       who they follow, newest first          ?cursor=  -> { users, nextCursor }
 *
 * Only accounts with a verified e-mail can be seen or followed. Nothing private
 * (e-mail, academic profile, GPA...) is ever returned -- only the name, the
 * username, the photo and the follow counts.
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const pg = require("../pg");
const { HttpError, wrap } = require("../auth/errors");
const { normalizeUsername, USERNAME_RE } = require("../auth/users");
const { PERSON_COLUMNS, presentPerson } = require("./people");
const { encodeCursor, decodeCursor } = require("../posts/router");

const LIST_PAGE_SIZE = 30;
const SEARCH_LIMIT = 20;
const SUGGESTED_LIMIT = 12;
const MAX_QUERY = 50;

async function counts(userId, db = pg) {
  const row = (
    await db.query(
      `SELECT (SELECT count(*) FROM follows WHERE followee_id = $1)::int AS followers,
              (SELECT count(*) FROM follows WHERE follower_id = $1)::int AS following`,
      [userId]
    )
  ).rows[0];
  return { followerCount: row.followers, followingCount: row.following };
}

const notFound = () => new HttpError(404, "This account doesn't exist or is no longer available.", "not_found");

/** The verified user behind a :username parameter, or a 404. */
async function findPerson(raw, viewerId) {
  const username = normalizeUsername(raw);
  if (!USERNAME_RE.test(username)) throw notFound();
  const row = (await pg.query(`SELECT ${PERSON_COLUMNS}, u.created_at FROM users u WHERE u.username = $2 AND u.email_verified`, [viewerId, username]))
    .rows[0];
  if (!row) throw notFound();
  return row;
}

/** "ai_gerim" -> a LIKE pattern piece with % and _ taken literally. */
const likeEscape = (s) => s.replace(/[\\%_]/g, "\\$&");

function limiter(max, windowMs, message) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.auth.userId,
    handler: (req, res) => res.status(429).json({ error: message, code: "rate_limited" }),
  });
}

function createUsersRouter() {
  const router = express.Router();
  // Stops scripts mass-following people (Instagram has similar limits).
  const followLimit = [
    limiter(60, 60 * 1000, "You're doing that too fast. Please wait a moment."),
    limiter(500, 24 * 60 * 60 * 1000, "You've reached today's limit for following people. Please try again tomorrow."),
  ];
  const searchLimit = limiter(90, 60 * 1000, "You're searching too fast. Please wait a moment.");

  /* ---- search ---- */
  router.get(
    "/search",
    searchLimit,
    wrap(async (req, res) => {
      const raw = typeof req.query.q === "string" ? req.query.q : "";
      const q = raw.trim().replace(/^@+/, "").toLowerCase().slice(0, MAX_QUERY);
      if (!q) return res.json({ users: [] });
      const pattern = likeEscape(q);
      const { rows } = await pg.query(
        `SELECT ${PERSON_COLUMNS}
           FROM users u
          WHERE u.email_verified
            AND (u.username LIKE $2::text || '%' OR u.full_name ILIKE '%' || $2::text || '%')
          ORDER BY (u.username = $3::text) DESC, (u.username LIKE $2::text || '%') DESC, is_following DESC, u.username
          LIMIT $4`,
        [req.auth.userId, pattern, q, SEARCH_LIMIT]
      );
      res.json({ users: rows.map(presentPerson) });
    })
  );

  /* ---- suggestions: people who follow you first, then the most followed ---- */
  router.get(
    "/suggested",
    searchLimit,
    wrap(async (req, res) => {
      const { rows } = await pg.query(
        `SELECT ${PERSON_COLUMNS}
           FROM users u
          WHERE u.email_verified
            AND u.id <> $1
            AND NOT EXISTS (SELECT 1 FROM follows x WHERE x.follower_id = $1 AND x.followee_id = u.id)
          ORDER BY follows_you DESC,
                   (SELECT count(*) FROM follows f WHERE f.followee_id = u.id) DESC,
                   u.created_at DESC
          LIMIT $2`,
        [req.auth.userId, SUGGESTED_LIMIT]
      );
      res.json({ users: rows.map(presentPerson) });
    })
  );

  /* ---- one profile ---- */
  router.get(
    "/:username",
    wrap(async (req, res) => {
      const row = await findPerson(req.params.username, req.auth.userId);
      res.json({ user: { ...presentPerson(row), joinedAt: row.created_at, ...(await counts(row.id)) } });
    })
  );

  /* ---- follow / unfollow ---- */
  router.put(
    "/:username/follow",
    followLimit,
    wrap(async (req, res) => {
      const viewer = req.auth.userId;
      const target = await findPerson(req.params.username, viewer);
      if (target.is_me) throw new HttpError(400, "You can't follow yourself.", "self_follow");
      await pg.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [viewer, target.id]);
      const c = await counts(target.id);
      res.json({ following: true, followerCount: c.followerCount, followingCount: c.followingCount });
    })
  );

  router.delete(
    "/:username/follow",
    followLimit,
    wrap(async (req, res) => {
      const viewer = req.auth.userId;
      const target = await findPerson(req.params.username, viewer);
      await pg.query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [viewer, target.id]);
      const c = await counts(target.id);
      res.json({ following: false, followerCount: c.followerCount, followingCount: c.followingCount });
    })
  );

  /* ---- remove a follower (like Instagram's "Remove" in your own followers list) ---- */
  router.delete(
    "/:username/follower",
    followLimit,
    wrap(async (req, res) => {
      const viewer = req.auth.userId;
      const target = await findPerson(req.params.username, viewer);
      await pg.query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [target.id, viewer]);
      res.json({ followerCount: (await counts(viewer)).followerCount });
    })
  );

  /* ---- followers / following lists ---- */
  function listRoute(kind) {
    // followers: rows where they are the followee, listing the followers (and vice versa).
    const [mine, theirs] = kind === "followers" ? ["followee_id", "follower_id"] : ["follower_id", "followee_id"];
    return wrap(async (req, res) => {
      const viewer = req.auth.userId;
      const person = await findPerson(req.params.username, viewer);
      const cursor = decodeCursor(req.query.cursor);
      const { rows } = await pg.query(
        `SELECT ${PERSON_COLUMNS}, f.created_at::text AS cursor_ts
           FROM follows f
           JOIN users u ON u.id = f.${theirs}
          WHERE f.${mine} = $2
            AND u.email_verified
            AND ($3::timestamptz IS NULL OR (f.created_at, f.${theirs}) < ($3::timestamptz, $4::uuid))
          ORDER BY f.created_at DESC, f.${theirs} DESC
          LIMIT $5`,
        [viewer, person.id, cursor ? cursor.ts : null, cursor ? cursor.id : null, LIST_PAGE_SIZE + 1]
      );
      const page = rows.slice(0, LIST_PAGE_SIZE);
      const last = page[page.length - 1];
      res.json({
        users: page.map(presentPerson),
        nextCursor: rows.length > LIST_PAGE_SIZE ? encodeCursor(last.cursor_ts, last.id) : null,
      });
    });
  }
  router.get("/:username/followers", listRoute("followers"));
  router.get("/:username/following", listRoute("following"));

  /* ---- errors ---- */
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    if (err && err.code === "42P01") {
      console.error("[users] the follows table doesn't exist yet. Run:  node migrate_pg.js");
      return res.status(503).json({ error: "Following isn't set up on this server yet.", code: "not_migrated" });
    }
    console.error(`[users] ${req.method} ${req.originalUrl}: ${err && err.stack ? err.stack : err}`);
    res.status(500).json({ error: "Something went wrong. Please try again.", code: "server_error" });
  });

  return router;
}

module.exports = { createUsersRouter };
