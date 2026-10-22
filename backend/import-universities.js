/**
 * One command to add universities (details + programme data) to MongoDB Atlas
 * from a single JSON file.
 *
 *   npm run import:universities -- ../data/import/<file>.json [options]
 *
 *   --dry-run          check the file and show what would happen; never touches the database
 *   --overwrite        also replace degree-level data that already exists in the database
 *                      (default: existing data is kept, so hand edits in the admin panel are safe)
 *   --update-config    also update the details (name, city, ...) of universities that already exist
 *   --allow-duplicates add a university even if one with the same name already exists under another ID
 *
 * Universities that are new are inserted into universities_init (marked admin-edited, so
 * `npm run seed` never overwrites them) and their programmes into universities_info.
 * Every write is read back; the script exits with an error if anything is missing afterwards.
 * Uses the same connection settings as the server (.env) and never prints the password.
 *
 * File format: see server/bundle.js.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { MONGODB_URI, DB_NAME, INIT_COLLECTION_NAME, INFO_COLLECTION_NAME, safeUri, explainError } = require("./db");
const { prepareBundle } = require("./bundle");
const { normalize } = require("./admission");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const file = args.find((a) => !a.startsWith("--"));
const dryRun = flags.has("--dry-run");

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  if (!file) fail("Usage: npm run import:universities -- <file.json> [--dry-run] [--overwrite] [--update-config] [--allow-duplicates]");
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) fail(`Can't find ${full}`);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(full, "utf-8"));
  } catch (err) {
    fail(`${path.basename(full)} is not valid JSON: ${err.message}`);
  }

  const { items, errors } = prepareBundle(raw);
  console.log(`Read ${items.length} universit${items.length === 1 ? "y" : "ies"} from ${path.basename(full)}.`);
  if (errors.length) {
    console.error("\nThe file has problems -- nothing was imported:");
    errors.forEach((e) => console.error("  - " + e));
    process.exit(1);
  }
  for (const it of items) {
    const degrees = Object.keys(it.programs);
    console.log(`  ${it.config.slug.padEnd(22)} ${it.config.name} (${it.config.country}) -- ${degrees.length ? degrees.join(", ") : "details only"}`);
    it.warnings.forEach((w) => console.log(`      note: ${w}`));
  }
  if (dryRun) {
    console.log("\nDry run: the file is valid. Run again without --dry-run to import it.");
    return;
  }

  console.log(`\nConnecting to ${safeUri()} (database: ${DB_NAME}) ...`);
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect().catch((err) => {
    throw new Error(explainError(err));
  });
  let problems = 0;
  try {
    const db = client.db(DB_NAME);
    const init = db.collection(INIT_COLLECTION_NAME);
    const info = db.collection(INFO_COLLECTION_NAME);
    await init.createIndex({ slug: 1 }, { unique: true });
    await info.createIndex({ slug: 1 }, { unique: true });

    const byName = new Map();
    for (const c of await init.find({}).toArray()) byName.set(normalize(c.name), c.slug);

    const now = new Date().toISOString();
    let added = 0, updated = 0, skipped = 0, programsWritten = 0, programsKept = 0;

    for (const { config, programs } of items) {
      const existing = await init.findOne({ slug: config.slug });
      const sameName = byName.get(normalize(config.name));

      if (!existing) {
        if (sameName && !flags.has("--allow-duplicates")) {
          console.log(`  ${config.slug}: SKIPPED -- '${config.name}' already exists as '${sameName}'. Use that ID in the file, or pass --allow-duplicates.`);
          skipped++;
          continue;
        }
        await init.insertOne({ ...config, admin_edited: true, admin_edited_at: now, created_by_import: true, created_at: now });
        added++;
        console.log(`  ${config.slug}: university added`);
      } else if (flags.has("--update-config")) {
        await init.updateOne({ slug: config.slug }, { $set: { ...config, admin_edited: true, admin_edited_at: now } });
        updated++;
        console.log(`  ${config.slug}: details updated`);
      } else {
        console.log(`  ${config.slug}: already exists, details left as they are`);
      }

      const infoDoc = (await info.findOne({ slug: config.slug })) || {};
      const old = infoDoc.programs && typeof infoDoc.programs === "object" && !Array.isArray(infoDoc.programs) ? infoDoc.programs : {};
      const merged = { ...old };
      let wrote = false;
      for (const [degree, program] of Object.entries(programs)) {
        if (old[degree] && old[degree].generated_at && !flags.has("--overwrite")) {
          programsKept++;
          console.log(`      ${degree}: kept existing data (use --overwrite to replace it)`);
          continue;
        }
        merged[degree] = program;
        programsWritten++;
        wrote = true;
      }
      if (wrote) await info.updateOne({ slug: config.slug }, { $set: { slug: config.slug, programs: merged } }, { upsert: true });

      // Read back everything that was supposed to be written.
      const checkInit = await init.findOne({ slug: config.slug });
      const checkInfo = await info.findOne({ slug: config.slug });
      const missing = [];
      if (!checkInit) missing.push("university details");
      for (const [degree, program] of Object.entries(programs)) {
        const stored = checkInfo && checkInfo.programs && checkInfo.programs[degree];
        const expected = merged[degree];
        if (!stored || stored.edited_at !== expected.edited_at) missing.push(`${degree} programme`);
      }
      if (missing.length) {
        problems++;
        console.log(`      NOT FOUND AFTER WRITE: ${missing.join(", ")}`);
      } else if (wrote) {
        console.log(`      saved and verified (${Object.keys(programs).join(", ")})`);
      }
    }

    console.log(
      `\nDone. ${added} added, ${updated} updated, ${skipped} skipped; ${programsWritten} programme(s) written, ${programsKept} kept.` +
        `\n${DB_NAME}.${INIT_COLLECTION_NAME}: ${await init.countDocuments()} universities. ${DB_NAME}.${INFO_COLLECTION_NAME}: ${await info.countDocuments()} documents.`
    );
  } finally {
    await client.close();
  }
  if (problems) process.exit(1);
}

main().catch((err) => {
  console.error("Import failed:", err.message);
  process.exit(1);
});