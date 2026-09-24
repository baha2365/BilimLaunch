require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.MONGODB_DB || "universities";
const COLLECTION_NAME = process.env.MONGODB_COLLECTION || "universities_info";

let client = null;
let collection = null;

/**
 * Connects once and reuses the same collection handle on every later call
 * (the MongoDB driver pools connections internally, so there's no need to
 * reconnect per-request).
 */
async function connect() {
  if (collection) return collection;

  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  collection = client.db(DB_NAME).collection(COLLECTION_NAME);
  await collection.createIndex({ slug: 1 }, { unique: true });
  return collection;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    collection = null;
  }
}

module.exports = { connect, close, MONGODB_URI, DB_NAME, COLLECTION_NAME };