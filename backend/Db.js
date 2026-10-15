require("dotenv").config();
const { MongoClient } = require("mongodb");

// The shared team database lives on MongoDB Atlas: put its connection string
// in server/.env as MONGODB_ATLAS_URI (never commit it). Without it we fall
// back to MONGODB_URI, then to a local MongoDB.
const ATLAS_URI = (process.env.MONGODB_ATLAS_URI || "").trim();
const MONGODB_URI = ATLAS_URI || process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.MONGODB_DB || (ATLAS_URI ? "bilimlaunchDatabase" : "universities");

/** The URI with the username/password hidden, safe to print in logs. */
function safeUri(uri = MONGODB_URI) {
  return uri.replace(/\/\/[^@/]*@/, "//***:***@");
}

/** Turns the driver's connection errors into something a teammate can act on. */
function explainError(err) {
  const msg = String((err && err.message) || err);
  if (/authentication failed|bad auth/i.test(msg)) return "Wrong database username or password in MONGODB_ATLAS_URI (special characters in the password must be URL-encoded).";
  if (/ENOTFOUND|querySrv|ECONNREFUSED.*srv/i.test(msg)) return "Could not resolve the Atlas address. Check the URI for typos and your internet/DNS connection.";
  if (/timed out|ReplicaSetNoPrimary|Server selection|ETIMEDOUT/i.test(msg)) return "Could not reach the database. In Atlas open Security > Network Access and make sure your IP address is allowed.";
  return msg;
}

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

  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: ATLAS_URI ? 15000 : 5000 });
  try {
    await client.connect();
  } catch (err) {
    client = null;
    throw new Error(explainError(err));
  }
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
  safeUri,
  explainError,
  DB_NAME,
  INIT_COLLECTION_NAME,
  INFO_COLLECTION_NAME,
};