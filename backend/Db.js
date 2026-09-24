require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.MONGODB_DB || "universities";

// universities_init  -> config/reference data: which universities exist and
//                        which pages to scrape for each. Add a university
//                        here (via seed.js + data/universities.json, or
//                        directly in Mongo) and the app picks it up.
// universities_info   -> generated data only: the LLM's extracted tuition/
//                        scholarships for a slug, once it's been opened.
//                        Empty for a university until someone visits it.
const INIT_COLLECTION_NAME = process.env.MONGODB_INIT_COLLECTION || "universities_init";
const INFO_COLLECTION_NAME = process.env.MONGODB_INFO_COLLECTION || "universities_info";

let client = null;
let initCollection = null;
let infoCollection = null;

/**
 * Connects once and reuses the same collection handles on every later call
 * (the MongoDB driver pools connections internally, so there's no need to
 * reconnect per-request). Returns { init, info }.
 */
async function connect() {
  if (initCollection && infoCollection) return { init: initCollection, info: infoCollection };

  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const database = client.db(DB_NAME);
  initCollection = database.collection(INIT_COLLECTION_NAME);
  infoCollection = database.collection(INFO_COLLECTION_NAME);
  await initCollection.createIndex({ slug: 1 }, { unique: true });
  await infoCollection.createIndex({ slug: 1 }, { unique: true });
  return { init: initCollection, info: infoCollection };
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    initCollection = null;
    infoCollection = null;
  }
}

module.exports = {
  connect,
  close,
  MONGODB_URI,
  DB_NAME,
  INIT_COLLECTION_NAME,
  INFO_COLLECTION_NAME,
};