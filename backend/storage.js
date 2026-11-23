/**
 * Object storage on Cloudflare R2 (S3-compatible). Holds the university images.
 *
 * Settings (backend/.env):
 *   R2_ACCOUNT_ID         Cloudflare account ID (R2 overview page, right side)
 *   R2_ACCESS_KEY_ID      R2 API token -> Access Key ID
 *   R2_SECRET_ACCESS_KEY  R2 API token -> Secret Access Key
 *   R2_BUCKET             bucket name, e.g. bilimlaunch-media
 *   R2_PUBLIC_URL         optional: the bucket's public address (custom domain or
 *                         https://pub-xxxx.r2.dev), no trailing slash. When empty,
 *                         this server streams the images itself at /media/<key>.
 *   R2_ENDPOINT           optional: override the S3 endpoint (e.g. an EU-jurisdiction
 *                         bucket: https://<account>.eu.r2.cloudflarestorage.com)
 *
 * Nothing here is required for the rest of the site: without these settings the
 * pages simply show no photos and uploads answer "storage isn't configured".
 */
require("dotenv").config();
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const env = (name) => (process.env[name] || "").trim();

const ACCOUNT_ID = env("R2_ACCOUNT_ID");
const BUCKET = env("R2_BUCKET");
const ENDPOINT = env("R2_ENDPOINT") || (ACCOUNT_ID ? `https://${ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
const PUBLIC_URL = env("R2_PUBLIC_URL").replace(/\/+$/, "");

const configured = Boolean(ENDPOINT && BUCKET && env("R2_ACCESS_KEY_ID") && env("R2_SECRET_ACCESS_KEY"));

const client = configured
  ? new S3Client({
      region: "auto",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
      // Recent SDK versions add checksum headers by default; Cloudflare recommends
      // only sending them when an operation actually requires one.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    })
  : null;

class StorageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireClient() {
  if (!client) {
    throw new StorageError(503, "Image storage isn't set up on this server yet. Add the R2_* settings to backend/.env and restart.");
  }
  return client;
}

/** Turns S3/R2 error codes into something a teammate can act on. */
function explainError(err) {
  const code = (err && (err.Code || err.name)) || "";
  if (code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch") return "R2 rejected the access key. Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in backend/.env.";
  if (code === "NoSuchBucket") return `The R2 bucket '${BUCKET}' doesn't exist. Check R2_BUCKET (and R2_ACCOUNT_ID) in backend/.env.`;
  if (code === "AccessDenied" || code === "Forbidden") return "The R2 API token isn't allowed to use this bucket. Give it 'Object Read & Write' on the bucket.";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(String(err && err.message))) return "Could not reach Cloudflare R2. Check R2_ACCOUNT_ID and your internet connection.";
  return (err && err.message) || "Image storage failed.";
}

/** Where a browser can load the object from. */
function publicUrl(key) {
  if (!key) return null;
  return PUBLIC_URL ? `${PUBLIC_URL}/${key}` : `/media/${key}`;
}

/** `body` is a Buffer, or a stream together with its exact `contentLength` in bytes. */
async function putObject(key, body, contentType, contentLength) {
  try {
    await requireClient().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: contentLength,
        // Keys are never reused (each upload gets a new random name), so the
        // file at a given address never changes and may be cached forever.
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(502, explainError(err));
  }
}

async function deleteObject(key) {
  if (!key) return;
  try {
    await requireClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(502, explainError(err));
  }
}

/** Deletes every object whose key starts with `prefix`. Returns how many were removed. */
async function deletePrefix(prefix) {
  const s3 = requireClient();
  let removed = 0;
  let token;
  try {
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
      for (const obj of page.Contents || []) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
        removed++;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch (err) {
    throw new StorageError(502, explainError(err));
  }
  return removed;
}

/**
 * Opens an object for streaming. Resolves null when it doesn't exist; { notModified: true } for a 304;
 * { badRange: true } when `range` (an HTTP Range header such as "bytes=0-1023") lies outside the file.
 */
async function getObject(key, ifNoneMatch, range) {
  try {
    return await requireClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: key, IfNoneMatch: ifNoneMatch || undefined, Range: range || undefined }));
  } catch (err) {
    const status = err && err.$metadata && err.$metadata.httpStatusCode;
    if (status === 304) return { notModified: true };
    if (status === 416) return { badRange: true };
    if (status === 404 || (err && err.name === "NoSuchKey")) return null;
    if (err instanceof StorageError) throw err;
    throw new StorageError(502, explainError(err));
  }
}

/** Startup check: is the bucket reachable with these credentials? Never throws. */
async function check() {
  if (!configured) return { ok: false, message: "not configured (no R2_* settings) -- university photos are switched off" };
  try {
    // A one-item listing works with an "Object Read & Write" token (HeadBucket may not).
    await client.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }));
    return { ok: true, message: `bucket '${BUCKET}', served from ${PUBLIC_URL || "/media (through this server)"}` };
  } catch (err) {
    return { ok: false, message: explainError(err) };
  }
}

module.exports = { configured, BUCKET, PUBLIC_URL, StorageError, publicUrl, putObject, deleteObject, deletePrefix, getObject, check };
