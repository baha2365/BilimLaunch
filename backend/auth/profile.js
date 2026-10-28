/*
 * The academic profile every student must complete before using the app.
 * REQUIRED is the single list to edit if you want to ask for more (or less)
 * at sign-up. Values are stored as text exactly as the matcher expects them.
 */
const countries = require("./countries");

const MAX_TARGET_COUNTRIES = 10;
const CURRENT_YEARS = ["1st year", "2nd year", "3rd year", "4th year", "Graduate"];
const TARGET_DEGREES = ["Bachelor's", "Master's", "PhD", "Internship", "Exchange (Erasmus)"];

const REQUIRED = ["country", "fieldOfStudy", "currentYear", "gpa", "targetDegree", "targetCountries"];
const FIELDS = ["country", "university", "fieldOfStudy", "currentYear", "gpa", "ielts", "targetDegree", "targetCountries", "extracurriculars"];

const COLUMN = {
  country: "country",
  university: "university",
  fieldOfStudy: "field_of_study",
  currentYear: "current_year",
  gpa: "gpa",
  ielts: "ielts",
  targetDegree: "target_degree",
  targetCountries: "target_countries",
  extracurriculars: "extracurriculars",
};

const LABEL = {
  country: "country of residence",
  fieldOfStudy: "field of study",
  currentYear: "current year",
  gpa: "GPA",
  targetDegree: "target degree",
  targetCountries: "target countries",
};

const MAX = { country: 80, university: 120, fieldOfStudy: 120, targetCountries: 400, extracurriculars: 1000 };

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : typeof value === "number" ? String(value) : "";
}

/** Returns { values, errors }. `errors` maps field name -> message. */
function validateProfile(input) {
  const body = input && typeof input === "object" ? input : {};
  const values = {};
  const errors = {};

  for (const key of FIELDS) {
    // The experience box keeps its line breaks; everything else is one line.
    values[key] = key === "extracurriculars" ? (typeof body[key] === "string" ? body[key].trim() : "") : clean(body[key]);
  }

  for (const key of REQUIRED) {
    if (!values[key]) errors[key] = `Enter your ${LABEL[key]}.`;
  }
  for (const [key, max] of Object.entries(MAX)) {
    if (values[key].length > max) errors[key] = `Keep this under ${max} characters.`;
  }

  if (values.currentYear && !CURRENT_YEARS.includes(values.currentYear)) errors.currentYear = "Choose one of the options.";
  if (values.targetDegree && !TARGET_DEGREES.includes(values.targetDegree)) errors.targetDegree = "Choose one of the options.";

  // Countries must come from the list (the form has a searchable drop-down for it). Common
  // spellings such as "USA" are accepted and stored under the official name.
  if (values.country && !errors.country) {
    const name = countries.canonical(values.country);
    if (name) values.country = name;
    else errors.country = "Choose your country from the list.";
  }
  if (values.targetCountries && !errors.targetCountries) {
    const picked = [];
    let unknown = false;
    for (const part of values.targetCountries.split(/[,;\n]/)) {
      if (!part.trim()) continue;
      const name = countries.canonical(part);
      if (!name) unknown = true;
      else if (!picked.includes(name)) picked.push(name);
    }
    if (unknown || !picked.length) errors.targetCountries = "Choose your target countries from the list.";
    else if (picked.length > MAX_TARGET_COUNTRIES) errors.targetCountries = `Choose up to ${MAX_TARGET_COUNTRIES} countries.`;
    else values.targetCountries = picked.join(", ");
  }

  if (values.gpa && !errors.gpa) {
    const n = Number(values.gpa.replace(",", "."));
    // match.py compares on a 4.0 scale (up to 4.3), so that's the scale we ask for.
    if (!Number.isFinite(n) || n <= 0 || n > 4.3) errors.gpa = "Enter your GPA on a 4.0 scale, for example 3.6.";
    else values.gpa = String(n);
  }
  if (values.ielts) {
    const n = Number(values.ielts.replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 9) errors.ielts = "IELTS scores run from 0 to 9, for example 6.5. Leave it empty if you haven't taken it.";
    else values.ielts = String(n);
  }

  return { values, errors };
}

/** DB row -> the camelCase object the front end and matcher use. */
function fromRow(row) {
  const out = {};
  for (const key of FIELDS) out[key] = row ? row[COLUMN[key]] || "" : "";
  return out;
}

async function getProfile(db, userId) {
  const row = (await db.query("SELECT * FROM profiles WHERE user_id = $1", [userId])).rows[0];
  return { profile: fromRow(row), completed: !!(row && row.completed_at) };
}

/** Saves an already-validated profile and marks it complete. */
async function saveProfile(db, userId, values) {
  const cols = FIELDS.map((k) => COLUMN[k]);
  const params = [userId, ...FIELDS.map((k) => values[k])];
  await db.query(
    `INSERT INTO profiles (user_id, ${cols.join(", ")}, completed_at, updated_at)
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET
       ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")},
       completed_at = COALESCE(profiles.completed_at, now()),
       updated_at = now()`,
    params
  );
}

module.exports = { validateProfile, getProfile, saveProfile, REQUIRED, FIELDS, CURRENT_YEARS, TARGET_DEGREES };
