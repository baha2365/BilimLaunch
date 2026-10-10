/**
 * Seeds MongoDB from the local data files:
 *   - data/universities.json   -> upserted into universities_init (config:
 *                                 name, sourceUrls, etc. -- this is the
 *                                 list that defines which universities the
 *                                 app supports)
 *   - data/cache/<slug>.json   -> upserted into universities_info.programs.bachelor,
 *                                 if you have leftover files from before Mongo
 *                                 (that cache format predates per-degree-level
 *                                 data and was always Bachelor's-only)
 *
 * Safe to run more than once -- every write is an upsert keyed by slug.
 * Rerunning after you've already generated some universities' info won't
 * touch universities_info for schools with no matching local cache file.
 *
 * Usage (from the server/ folder):
 *   node seed.js
 * or:
 *   npm run seed
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const ROOT = path.join(__dirname, "../frontend");
const CONFIG_PATH = path.join(ROOT, "data", "universities.json");
const CACHE_DIR = path.join(ROOT, "data", "cache");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.MONGODB_DB || "universities";
const INIT_COLLECTION_NAME = process.env.MONGODB_INIT_COLLECTION || "universities_init";
const INFO_COLLECTION_NAME = process.env.MONGODB_INFO_COLLECTION || "universities_info";

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Can't find ${CONFIG_PATH}`);
  }
  const universities = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

  console.log(`Connecting to ${MONGODB_URI} ...`);
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const database = client.db(DB_NAME);
  const initCollection = database.collection(INIT_COLLECTION_NAME);
  const infoCollection = database.collection(INFO_COLLECTION_NAME);
  await initCollection.createIndex({ slug: 1 }, { unique: true });
  await infoCollection.createIndex({ slug: 1 }, { unique: true });

  for (const uni of universities) {
    const existing = await initCollection.findOne({ slug: uni.slug });
    if (existing && existing.admin_edited) {
      console.log(`  ${uni.slug}: edited in the admin panel, leaving its config untouched`);
    } else {
      await initCollection.updateOne({ slug: uni.slug }, { $set: uni }, { upsert: true });
      console.log(`  ${uni.slug} -> ${INIT_COLLECTION_NAME}`);
    }

    const cacheFile = path.join(CACHE_DIR, `${uni.slug}.json`);
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      await infoCollection.updateOne(
        { slug: uni.slug },
        { $set: { slug: uni.slug, "programs.bachelor": cached } },
        { upsert: true }
      );
      console.log(`    + existing cached extraction -> ${INFO_COLLECTION_NAME}.programs.bachelor`);
    }
  }

  const initCount = await initCollection.countDocuments();
  const infoCount = await infoCollection.countDocuments();
  console.log(
    `\nDone. ${DB_NAME}.${INIT_COLLECTION_NAME}: ${initCount} document(s). ` +
      `${DB_NAME}.${INFO_COLLECTION_NAME}: ${infoCount} document(s).`
  );
  await client.close();
}

main().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});