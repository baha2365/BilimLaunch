/*
 * Checks the field-of-study list:  node check_fields.js
 *   - the server copy (auth/fields.js) and the browser copy (../frontend/fields.js) hold identical data
 *   - names are unique, comma-free and short enough for the profile column
 *   - every synonym points at a real field and none is claimed twice
 *   - searching gives the results people expect (so a change to the search code can't quietly break it)
 * Exits with a non-zero code on the first failed group so it can run in CI.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const server = require("./auth/fields");

const browserFile = path.join(__dirname, "..", "frontend", "fields.js");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(browserFile, "utf8"), sandbox, { filename: browserFile });
const browser = sandbox.window.BLFields;

let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${label}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
}
const fold = server.fold;
const names = server.FIELDS_OF_STUDY;

console.log("data");
check("browser copy loads", () => assert.ok(browser, "window.BLFields is missing"));
check("fold() strips accents and keeps letters of any alphabet", () => {
  assert.strictEqual(fold("Café"), "cafe");
  assert.strictEqual(fold("  Arts & Design "), "arts and design");
  assert.strictEqual(fold("Computer-Science"), "computer science");
  assert.strictEqual(fold("Информатика"), "информатика");
});
check("names are unique, comma-free and at most 120 characters", () => {
  const seen = new Set();
  for (const name of names) {
    assert.ok(name === name.trim() && name.length > 0 && name.length <= 120, `bad name: "${name}"`);
    assert.ok(!name.includes(","), `comma in "${name}"`);
    const key = fold(name);
    assert.ok(!seen.has(key), `duplicate field: "${name}"`);
    seen.add(key);
  }
});
check("every group has a title and at least one field", () => {
  for (const g of server.GROUPS) assert.ok(g.title && g.fields.length > 0, `empty group: ${JSON.stringify(g.title)}`);
});
check("popular fields all exist", () => {
  for (const name of server.POPULAR) assert.ok(names.includes(name), `popular but not listed: "${name}"`);
});
check("every synonym points at a real field, is not a field name itself and is claimed once", () => {
  const owner = new Map();
  for (const [name, aliases] of Object.entries(server.SYNONYMS)) {
    assert.ok(names.includes(name), `synonyms given for unknown field "${name}"`);
    for (const alias of aliases) {
      const key = fold(alias);
      assert.ok(key, `empty synonym under "${name}"`);
      assert.ok(!names.some((n) => fold(n) === key), `synonym "${alias}" (under "${name}") is also a field name`);
      assert.ok(!owner.has(key) || owner.get(key) === name, `synonym "${alias}" is under both "${owner.get(key)}" and "${name}"`);
      assert.ok(!(owner.get(key) === name && aliases.indexOf(alias) !== aliases.lastIndexOf(alias)), `synonym "${alias}" listed twice under "${name}"`);
      owner.set(key, name);
    }
  }
});

console.log("server and browser copies match");
// The browser file runs in its own VM context, so its arrays are not the same kind of object as ours;
// comparing the JSON text also checks that the ORDER matches, which is what the drop-down shows.
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
check("groups, popular list and synonyms are identical", () => {
  same(browser.GROUPS, server.GROUPS);
  same(browser.POPULAR, server.POPULAR);
  same(browser.SYNONYMS, server.SYNONYMS);
  same(browser.NAMES, names);
});
check("fold() gives the same answer on both sides", () => {
  for (const s of ["Café", "Arts & Design", " CS ", "Computer-Science", "Информатика", "Ёлка", "Ph.D. (Physics)", ""]) {
    assert.strictEqual(browser.fold(s), fold(s), `fold differs for ${JSON.stringify(s)}`);
  }
});
check("canonical() gives the same answer on both sides for every name and synonym", () => {
  const inputs = [...names, ...Object.values(server.SYNONYMS).flat(), "Basket weaving", "", "  computer   science  ", "COMPUTER SCIENCE"];
  for (const s of inputs) assert.strictEqual(browser.canonical(s), server.canonical(s), `canonical differs for ${JSON.stringify(s)}`);
});
check("canonical() accepts names, synonyms and sloppy spacing; rejects the rest", () => {
  assert.strictEqual(server.canonical("computer science"), "Computer Science");
  assert.strictEqual(server.canonical("  CS "), "Computer Science");
  assert.strictEqual(server.canonical("AI"), "Artificial Intelligence");
  assert.strictEqual(server.canonical("Arts & Design"), null);
  assert.strictEqual(server.canonical("Basket weaving"), null);
  assert.strictEqual(server.canonical(""), null);
  assert.strictEqual(server.canonical(undefined), null);
});

console.log("search");
const top = (q, n = 1) => browser.search(q).slice(0, n).map((r) => r.name);
const SEARCHES = [
  ["cs", "Computer Science"],
  ["CS", "Computer Science"],
  ["ai", "Artificial Intelligence"],
  ["it", "Information Technology"],
  ["art", "Fine Arts"],
  ["comp", "Computer Science"],
  ["mech eng", "Mechanical Engineering"],
  ["engineering mech", "Mechanical Engineering"],
  ["elec", "Electrical Engineering"],
  ["med", "Medicine"],
  ["econ", "Economics"],
  ["psych", "Psychology"],
  ["poli sci", "Political Science"],
  ["business", "Business Administration"],
  ["engineering", "General Engineering"],
  ["law", "Law"],
  ["architect", "Architecture"],
  ["maths", "Mathematics"],
  ["compter sience", "Computer Science"],
  ["bioloy", "Biology"],
];
for (const [query, expected] of SEARCHES) {
  check(`"${query}" -> ${expected}`, () => assert.strictEqual(top(query)[0], expected, `got: ${top(query, 4).join(", ")}`));
}
check("a category word lists the whole category (\"health\" finds Medicine and Nursing)", () => {
  const all = browser.search("health").map((r) => r.name);
  for (const n of ["Medicine", "Nursing", "Public Health", "Health Sciences"]) assert.ok(all.includes(n), `missing ${n}`);
});
check("\"science\" finds fields whose later word is Science", () => {
  const all = browser.search("science").map((r) => r.name);
  for (const n of ["Computer Science", "Data Science", "Political Science", "Environmental Science"]) assert.ok(all.includes(n), `missing ${n}`);
});
check("synonym hits say which synonym matched", () => {
  const hit = browser.search("cs")[0];
  assert.strictEqual(hit.via, "cs");
  assert.strictEqual(browser.search("computer")[0].via, "");
});
check("typing a field's exact name puts it first", () => {
  for (const name of names) assert.strictEqual(top(name)[0], name, `"${name}" came back as ${top(name, 2).join(", ")}`);
});
check("typing any synonym finds its field somewhere in the top 3", () => {
  for (const [name, aliases] of Object.entries(server.SYNONYMS)) {
    for (const alias of aliases) assert.ok(top(alias, 3).includes(name), `"${alias}" should find ${name}, got ${top(alias, 3).join(", ")}`);
  }
});
check("nonsense finds nothing; an empty query lists everything", () => {
  assert.strictEqual(browser.search("qzxqzxqzx").length, 0);
  assert.strictEqual(browser.search("").length, names.length);
});
check("every field can be found by its first word", () => {
  for (const name of names) {
    const word = fold(name).split(" ")[0];
    assert.ok(browser.search(word).some((r) => r.name === name), `"${word}" does not find "${name}"`);
  }
});

console.log(failed ? `\n${failed} check(s) failed` : `\nall checks passed (${names.length} fields in ${server.GROUPS.length} groups)`);
process.exit(failed ? 1 : 0);