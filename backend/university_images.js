/**
 * University photos, stored in Cloudflare R2 (see storage.js).
 *
 * Every university can have
 *   - one main image   (shown on its card in the list and next to its name), and
 *   - a gallery        (any number of photos, up to MAX_GALLERY, on its page).
 *
 * The files live in R2 under one folder ("prefix") per university:
 *   universities/<slug>/main/<random>.<ext>
 *   universities/<slug>/gallery/<random>.<ext>
 * and MongoDB (universities_init) only keeps the keys:
 *   mainImage: { key, type, size, uploadedAt, uploadedBy }
 *   gallery:   [{ id, key, type, size, uploadedAt, uploadedBy }, ...]
 *
 * Admin routes (mounted inside the admin router, so admins only):
 *   PUT    /api/admin/universities/:slug/images/main          body = the image file
 *   DELETE /api/admin/universities/:slug/images/main
 *   POST   /api/admin/universities/:slug/images/gallery       body = the image file
 *   DELETE /api/admin/universities/:slug/images/gallery/:id
 * Each answers { mainImage, gallery, uploadsEnabled } -- the university's photos after the change.
 *
 * Public: GET /media/<key> streams a photo from R2 when there is no public
 * bucket address (R2_PUBLIC_URL) to load it from directly.
 */
const crypto = require("crypto");
const express = require("express");
const storage = require("./storage");
const cache = require("./cache");

const MAX_BYTES = 8 * 1024 * 1024; // per file, after the browser has shrunk it
const MAX_GALLERY = 40;

const TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Works out the real type from the file's first bytes -- never trusts the name or the header. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function newKey(slug, kind, ext) {
  return `universities/${slug}/${kind}/${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
}

/** The university's photos as the browser needs them: addresses only, no storage details. */
function presentImages(doc) {
  const main = doc && doc.mainImage && doc.mainImage.key ? { url: storage.publicUrl(doc.mainImage.key) } : null;
  const gallery = (doc && Array.isArray(doc.gallery) ? doc.gallery : [])
    .filter((g) => g && g.id && g.key)
    .map((g) => ({ id: g.id, url: storage.publicUrl(g.key) }));
  return { mainImage: main, gallery, uploadsEnabled: storage.configured };
}

function mainImageUrl(doc) {
  return doc && doc.mainImage && doc.mainImage.key ? storage.publicUrl(doc.mainImage.key) : null;
}

class HttpFail extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Checks the uploaded body and returns { ext, type, buffer }. */
function readUpload(req) {
  if (!storage.configured) throw new storage.StorageError(503, "Image storage isn't set up on this server yet. Add the R2_* settings to backend/.env and restart.");
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpFail(400, "No image was received.");
  const ext = sniff(buffer);
  if (!ext) throw new HttpFail(415, "Only JPEG, PNG or WebP images can be uploaded.");
  return { ext, type: TYPES[ext], buffer };
}

function sendError(res, err, db) {
  if (err instanceof HttpFail || err instanceof storage.StorageError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[images] ${err && err.stack ? err.stack : err}`);
  res.status(502).json({ error: db.explainError(err) });
}

function createImageRouter(db) {
  const router = express.Router();
  // The file itself is the request body (no multipart form), up to MAX_BYTES.
  const rawImage = express.raw({ type: () => true, limit: MAX_BYTES });

  // Called after every photo change, so it also clears the cached pages.
  async function respond(res, slug) {
    await cache.invalidateUniversity(slug);
    const { init } = await db.connect();
    const doc = await init.findOne({ slug }, { projection: { mainImage: 1, gallery: 1 } });
    res.json(presentImages(doc));
  }

  // Set or replace the main image.
  router.put("/universities/:slug/images/main", rawImage, async (req, res) => {
    const { slug } = req.params;
    try {
      const upload = readUpload(req);
      const { init } = await db.connect();
      if (!(await init.findOne({ slug }, { projection: { _id: 1 } }))) throw new HttpFail(404, "Unknown university.");

      const key = newKey(slug, "main", upload.ext);
      await storage.putObject(key, upload.buffer, upload.type);
      const mainImage = { key, type: upload.type, size: upload.buffer.length, uploadedAt: new Date().toISOString(), uploadedBy: req.auth.userId };

      let before;
      try {
        before = await init.findOneAndUpdate({ slug }, { $set: { mainImage } }, { returnDocument: "before", projection: { mainImage: 1 } });
      } catch (err) {
        await storage.deleteObject(key).catch(() => {}); // don't leave an unused file behind
        throw err;
      }
      if (!before) {
        await storage.deleteObject(key).catch(() => {});
        throw new HttpFail(404, "Unknown university.");
      }
      const oldKey = before.mainImage && before.mainImage.key;
      if (oldKey && oldKey !== key) {
        storage.deleteObject(oldKey).catch((err) => console.warn(`[images] could not delete old main image ${oldKey}: ${err.message}`));
      }
      await respond(res, slug);
    } catch (err) {
      sendError(res, err, db);
    }
  });

  router.delete("/universities/:slug/images/main", async (req, res) => {
    const { slug } = req.params;
    try {
      const { init } = await db.connect();
      const before = await init.findOneAndUpdate({ slug }, { $unset: { mainImage: "" } }, { returnDocument: "before", projection: { mainImage: 1 } });
      if (!before) throw new HttpFail(404, "Unknown university.");
      const oldKey = before.mainImage && before.mainImage.key;
      if (oldKey) await storage.deleteObject(oldKey).catch((err) => console.warn(`[images] could not delete ${oldKey}: ${err.message}`));
      await respond(res, slug);
    } catch (err) {
      sendError(res, err, db);
    }
  });

  // Add one photo to the gallery.
  router.post("/universities/:slug/images/gallery", rawImage, async (req, res) => {
    const { slug } = req.params;
    try {
      const upload = readUpload(req);
      const { init } = await db.connect();
      const doc = await init.findOne({ slug }, { projection: { gallery: 1 } });
      if (!doc) throw new HttpFail(404, "Unknown university.");
      if (Array.isArray(doc.gallery) && doc.gallery.length >= MAX_GALLERY) {
        throw new HttpFail(409, `This university already has ${MAX_GALLERY} photos. Delete some before adding more.`);
      }

      const key = newKey(slug, "gallery", upload.ext);
      await storage.putObject(key, upload.buffer, upload.type);
      const item = {
        id: crypto.randomBytes(8).toString("hex"),
        key,
        type: upload.type,
        size: upload.buffer.length,
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.auth.userId,
      };

      let result;
      try {
        // Only push while there is still room (the MAX_GALLERY-th slot is empty),
        // so two uploads at the same moment can't go over the limit.
        result = await init.updateOne({ slug, [`gallery.${MAX_GALLERY - 1}`]: { $exists: false } }, { $push: { gallery: item } });
      } catch (err) {
        await storage.deleteObject(key).catch(() => {});
        throw err;
      }
      if (!result.matchedCount) {
        await storage.deleteObject(key).catch(() => {});
        throw new HttpFail(409, `This university already has ${MAX_GALLERY} photos. Delete some before adding more.`);
      }
      await respond(res, slug);
    } catch (err) {
      sendError(res, err, db);
    }
  });

  router.delete("/universities/:slug/images/gallery/:id", async (req, res) => {
    const { slug, id } = req.params;
    try {
      const { init } = await db.connect();
      const before = await init.findOneAndUpdate({ slug }, { $pull: { gallery: { id } } }, { returnDocument: "before", projection: { gallery: 1 } });
      if (!before) throw new HttpFail(404, "Unknown university.");
      const item = (before.gallery || []).find((g) => g && g.id === id);
      if (!item) throw new HttpFail(404, "That photo was already removed.");
      await storage.deleteObject(item.key).catch((err) => console.warn(`[images] could not delete ${item.key}: ${err.message}`));
      await respond(res, slug);
    } catch (err) {
      sendError(res, err, db);
    }
  });

  // A file over MAX_BYTES is refused by the body parser before reaching a route.
  router.use((err, req, res, next) => {
    if (err && err.type === "entity.too.large") {
      return res.status(413).json({ error: `That image is too large (the limit is ${MAX_BYTES / 1024 / 1024} MB).` });
    }
    next(err);
  });

  return router;
}

/** Removes every photo of a university from R2 (used when the university is deleted). */
async function deleteUniversityImages(slug) {
  if (!storage.configured) return 0;
  return storage.deletePrefix(`universities/${slug}/`);
}

// Only our own key shape can be requested -- nothing else in the bucket is reachable.
const MEDIA_KEY_RE = /^universities\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:main|gallery)\/[a-z0-9]+-[a-f0-9]{12}\.(jpg|png|webp)$/;

/** GET /media/<key> -- streams a university photo from R2 (used when R2_PUBLIC_URL is not set). */
async function mediaHandler(req, res) {
  const key = req.params[0] || "";
  const match = MEDIA_KEY_RE.exec(key);
  if (!match || !storage.configured) return res.status(404).end();
  try {
    const obj = await storage.getObject(key, req.get("if-none-match"));
    if (!obj) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    if (obj.notModified) return res.status(304).end();
    res.set("Content-Type", TYPES[match[1]]);
    if (obj.ETag) res.set("ETag", obj.ETag);
    if (obj.ContentLength != null) res.set("Content-Length", String(obj.ContentLength));
    obj.Body.on("error", () => res.destroy());
    obj.Body.pipe(res);
  } catch (err) {
    console.warn(`[media] ${key}: ${err.message}`);
    res.status(err.status === 503 ? 404 : 502).end();
  }
}

module.exports = { createImageRouter, presentImages, mainImageUrl, deleteUniversityImages, mediaHandler, sniff, MAX_GALLERY, MAX_BYTES };
