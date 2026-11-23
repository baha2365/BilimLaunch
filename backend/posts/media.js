/**
 * Discover post photos and videos: receiving an upload, checking it, storing it
 * in Cloudflare R2 (see ../storage.js) and streaming it back out.
 *
 * Rules (checked here on the server -- the browser checks them too, but only
 * as a convenience):
 *   - photos: JPEG, PNG, WebP or GIF, at most 10 MB
 *   - videos: MP4 or MOV, at most 5 minutes long (read from the file itself),
 *             and at most POST_VIDEO_MAX_MB megabytes (default 500)
 *
 * An upload is written to a temporary file first (never held in memory, so a
 * large video can't exhaust the server), checked, then sent on to R2 under
 *   posts/<yyyy>/<mm>/<random>.<ext>
 */
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Transform, pipeline } = require("stream");
const storage = require("../storage");
const { HttpError } = require("../auth/errors");

const MB = 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * MB;
const VIDEO_MAX_SECONDS = 5 * 60;
const VIDEO_MAX_BYTES = Math.max(1, parseFloat(process.env.POST_VIDEO_MAX_MB || "500")) * MB;

const IMAGE_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
// MOV and MP4 share one container format. Serving both as video/mp4 lets
// Chrome and Firefox play iPhone .mov files that use H.264.
const VIDEO_TYPE = "video/mp4";

// HEIF/AVIF photos also start with an "ftyp" box; these brands mean "image", not video.
const IMAGE_BRANDS = new Set(["avif", "avis", "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);
// Old QuickTime files may start straight with one of these boxes instead of "ftyp".
const QT_FIRST_BOXES = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

/** What the file really is, from its first bytes: { kind, ext } or null. Never trusts the name or the header. */
function sniff(head) {
  if (!Buffer.isBuffer(head) || head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", ext: "jpg" };
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", ext: "png" };
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return { kind: "image", ext: "webp" };
  const six = head.toString("ascii", 0, 6);
  if (six === "GIF87a" || six === "GIF89a") return { kind: "image", ext: "gif" };
  const box = head.toString("latin1", 4, 8);
  if (box === "ftyp") {
    const brand = head.toString("latin1", 8, 12).trim().toLowerCase();
    return IMAGE_BRANDS.has(brand) ? null : { kind: "video", ext: "mp4" };
  }
  if (QT_FIRST_BOXES.has(box)) return { kind: "video", ext: "mp4" };
  return null;
}

/* ---------------------------------------------------------------------------
 * Video length, read from the MP4 / MOV "movie header" (moov > mvhd). Works
 * whether the header sits at the start or the end of the file.
 * ------------------------------------------------------------------------- */

async function findBox(fh, start, end, type) {
  const head = Buffer.alloc(16);
  let pos = start;
  while (pos + 8 <= end) {
    const { bytesRead } = await fh.read(head, 0, 16, pos);
    if (bytesRead < 8) return null;
    let size = head.readUInt32BE(0);
    const boxType = head.toString("latin1", 4, 8);
    let headerLen = 8;
    if (size === 1) {
      if (bytesRead < 16) return null;
      size = Number(head.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) {
      size = end - pos; // "runs to the end of the file"
    }
    if (size < headerLen) return null; // corrupt
    if (boxType === type) return { start: pos + headerLen, end: Math.min(pos + size, end) };
    pos += size;
  }
  return null;
}

/** Seconds, or null if the file has no readable length. */
async function videoDuration(file, fileSize) {
  const fh = await fsp.open(file, "r");
  try {
    const moov = await findBox(fh, 0, fileSize, "moov");
    if (!moov) return null;
    const mvhd = await findBox(fh, moov.start, moov.end, "mvhd");
    if (!mvhd) return null;
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, mvhd.start);
    if (bytesRead < 20) return null;
    const version = buf[0];
    let timescale;
    let duration;
    if (version === 1) {
      if (bytesRead < 32) return null;
      timescale = buf.readUInt32BE(20);
      duration = Number(buf.readBigUInt64BE(24));
    } else {
      timescale = buf.readUInt32BE(12);
      duration = buf.readUInt32BE(16);
      if (duration === 0xffffffff) duration = 0; // "unknown"
    }
    if (!timescale) return null;

    // Fragmented MP4s keep the real length in moov > mvex > mehd instead.
    if (!duration) {
      const mvex = await findBox(fh, moov.start, moov.end, "mvex");
      const mehd = mvex && (await findBox(fh, mvex.start, mvex.end, "mehd"));
      if (mehd) {
        const m = Buffer.alloc(12);
        const r = await fh.read(m, 0, 12, mehd.start);
        if (r.bytesRead >= 8) duration = m[0] === 1 && r.bytesRead >= 12 ? Number(m.readBigUInt64BE(4)) : m.readUInt32BE(4);
      }
    }
    return duration ? duration / timescale : null;
  } finally {
    await fh.close();
  }
}

/* ---------------------------------------------------------------------------
 * Receiving the upload
 * ------------------------------------------------------------------------- */

function tooLarge(message) {
  return new HttpError(413, message, "too_large");
}

/** Streams the request body into a temporary file, stopping as soon as it passes maxBytes. */
function receiveToFile(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `bilimlaunch-upload-${crypto.randomBytes(10).toString("hex")}`);
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(tooLarge(`That file is too large (the limit is ${Math.round(maxBytes / MB)} MB).`));
        cb(null, chunk);
      },
    });
    req.on("close", () => {
      if (!req.complete) counter.destroy(new HttpError(400, "The upload was interrupted. Please try again.", "aborted"));
    });
    req.pipe(counter);
    pipeline(counter, fs.createWriteStream(file, { flags: "wx" }), (err) => {
      if (err) {
        req.unpipe(counter);
        fs.rm(file, { force: true }, () => {});
        return reject(err);
      }
      resolve({ file, size });
    });
  });
}

function intParam(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n <= 20000 ? n : null;
}

function fmtLength(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function newKey(ext) {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `posts/${now.getUTCFullYear()}/${month}/${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
}

/**
 * Checks and stores one uploaded file. `req.query.w` / `req.query.h` are the
 * width and height the browser measured (only used to size the frame before
 * the file loads). Returns the stored file's details for the post_media row.
 */
async function storeUpload(req) {
  if (!storage.configured) {
    throw new HttpError(503, "Media storage isn't set up on this server yet. Add the R2_* settings to backend/.env and restart.", "storage_off");
  }
  // Refuse obviously oversized files before reading a single byte.
  const declared = parseInt(req.get("content-length") || "", 10);
  const declaredType = (req.get("content-type") || "").toLowerCase();
  if (declared > VIDEO_MAX_BYTES) throw tooLarge(`That file is too large (the limit is ${Math.round(VIDEO_MAX_BYTES / MB)} MB).`);
  if (declaredType.startsWith("image/") && declared > IMAGE_MAX_BYTES) throw tooLarge("Photos can be at most 10 MB.");

  const { file, size } = await receiveToFile(req, VIDEO_MAX_BYTES);
  try {
    if (!size) throw new HttpError(400, "No file was received.", "empty");

    const head = Buffer.alloc(16);
    const fh = await fsp.open(file, "r");
    try {
      await fh.read(head, 0, 16, 0);
    } finally {
      await fh.close();
    }
    const type = sniff(head);
    if (!type) throw new HttpError(415, "Only photos (JPEG, PNG, WebP, GIF) and videos (MP4, MOV) can be posted.", "unsupported");

    let duration = null;
    if (type.kind === "image") {
      if (size > IMAGE_MAX_BYTES) throw tooLarge("Photos can be at most 10 MB.");
    } else {
      duration = await videoDuration(file, size);
      if (duration == null) {
        throw new HttpError(422, "We couldn't read this video's length. Please export it as a standard MP4 and try again.", "bad_video");
      }
      if (duration > VIDEO_MAX_SECONDS + 0.5) {
        throw new HttpError(422, `Videos can be at most 5 minutes long -- this one is ${fmtLength(duration)}.`, "too_long");
      }
    }

    const key = newKey(type.ext);
    const contentType = type.kind === "image" ? IMAGE_TYPES[type.ext] : VIDEO_TYPE;
    await storage.putObject(key, fs.createReadStream(file), contentType, size);
    return {
      key,
      kind: type.kind,
      contentType,
      size,
      width: intParam(req.query.w),
      height: intParam(req.query.h),
      duration: duration == null ? null : Math.min(VIDEO_MAX_SECONDS, Math.round(duration * 100) / 100),
    };
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

/* ---------------------------------------------------------------------------
 * Serving: GET /media/<prefix><key> -- used when the bucket has no public
 * address (R2_PUBLIC_URL). Supports byte ranges, which browsers need to seek
 * in videos. Only keys matching `keyRe` (whose first group is the file
 * extension) can be read -- nothing else in the bucket is reachable.
 * ------------------------------------------------------------------------- */

const MEDIA_KEY_RE = /^posts\/\d{4}\/\d{2}\/[a-z0-9]+-[a-f0-9]{12}\.(jpg|png|webp|gif|mp4)$/;
const RANGE_RE = /^bytes=\d*-\d*$/;
const TYPES_BY_EXT = { ...IMAGE_TYPES, mp4: VIDEO_TYPE };

const createMediaHandler = (prefix, keyRe) => async (req, res) => {
  const key = `${prefix}${req.params[0] || ""}`;
  const match = keyRe.exec(key);
  if (!match || !storage.configured) return res.status(404).end();
  const rawRange = req.get("range");
  const range = rawRange && RANGE_RE.test(rawRange) && rawRange !== "bytes=-" ? rawRange : null;
  try {
    const obj = await storage.getObject(key, range ? null : req.get("if-none-match"), range);
    if (!obj) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Accept-Ranges", "bytes");
    if (obj.notModified) return res.status(304).end();
    if (obj.badRange) return res.status(416).end();
    res.set("Content-Type", TYPES_BY_EXT[match[1]]);
    if (obj.ETag) res.set("ETag", obj.ETag);
    if (obj.ContentLength != null) res.set("Content-Length", String(obj.ContentLength));
    if (range && obj.ContentRange) {
      res.status(206);
      res.set("Content-Range", obj.ContentRange);
    }
    obj.Body.on("error", () => res.destroy());
    obj.Body.pipe(res);
  } catch (err) {
    console.warn(`[media] ${key}: ${err.message}`);
    res.status(err.status === 503 ? 404 : 502).end();
  }
};

const postMediaHandler = createMediaHandler("posts/", MEDIA_KEY_RE);

module.exports = { storeUpload, postMediaHandler, createMediaHandler, TYPES_BY_EXT, sniff, videoDuration, IMAGE_MAX_BYTES, VIDEO_MAX_BYTES, VIDEO_MAX_SECONDS };
