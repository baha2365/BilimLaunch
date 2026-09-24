/**
 * Seeds MongoDB from the local data files:
 *   - data/universities.json   -> base config for each university
 *   - data/cache/<slug>.json   -> any previously-generated extraction
 *                                 results, if you had run the old
 *                                 file-cache version of this app before
 *
 * Safe to run more than once -- every write is an upsert keyed by slug,
 * and existing generated_at/tuition/scholarships fields already in Mongo
 * are left alone unless a matching local cache file overwrites them.
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
const COLLECTION_NAME = process.env.MONGODB_COLLECTION || "universities_info";

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Can't find ${CONFIG_PATH}`);
  }
  const universities = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

  console.log(`Connecting to ${MONGODB_URI} ...`);
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const collection = client.db(DB_NAME).collection(COLLECTION_NAME);
  await collection.createIndex({ slug: 1 }, { unique: true });

  for (const uni of universities) {
    await collection.updateOne({ slug: uni.slug }, { $set: uni }, { upsert: true });
    console.log(`  seeded config: ${uni.slug}`);

    const cacheFile = path.join(CACHE_DIR, `${uni.slug}.json`);
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      await collection.updateOne({ slug: uni.slug }, { $set: cached });
      console.log(`    + imported existing cached extraction for ${uni.slug}`);
    }
  }

  const count = await collection.countDocuments();
  console.log(`\nDone. ${DB_NAME}.${COLLECTION_NAME} now has ${count} document(s).`);
  await client.close();
}

main().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});