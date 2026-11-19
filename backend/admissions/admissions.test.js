// Run with:  node --test admissions/admissions.test.js   (from the backend folder)
const test = require("node:test");
const assert = require("node:assert");
const { buildRequirements, evaluateGap } = require("./requirements");
const roadmap = require("./roadmap");

const REQ = {
  minimum_gpa: "3.0",
  language_tests: ["IELTS 6.5 overall", "TOEFL 90"],
  standardized_tests: ["GRE (optional)"],
  required_documents: ["Official transcript", "Two reference letters", "CV", "Personal statement"],
};
const PROFILE = { country: "Kazakhstan", fieldOfStudy: "Computer Science", currentYear: "4th year", gpa: "3.6", ielts: "6.5" };
const TODAY = "2026-11-19";

function plan(overrides = {}) {
  const requirements = buildRequirements(overrides.req || REQ);
  const intake = roadmap.intakeDate("fall", 2027);
  const deadline = roadmap.submissionDeadline({ keyDeadlines: overrides.deadlines || [], degree: "master", intake, today: TODAY });
  const tasks = roadmap.planRoadmap(
    {
      requirements,
      profile: overrides.profile || PROFILE,
      degree: "master",
      university: { slug: "x", name: "X University", country: overrides.country || "United Kingdom" },
      program: { requirements: overrides.req || REQ, scholarships: [], sources: [] },
      programName: "",
      deadline,
      intake,
    },
    TODAY
  );
  return { requirements, tasks, deadline, intake };
}

test("requirements are normalized from scraped text", () => {
  const items = buildRequirements(REQ);
  assert.deepStrictEqual(items.map((i) => i.key), ["gpa", "language", "test.gre", "doc.transcript", "doc.recommendation", "doc.cv", "doc.sop"]);
  assert.strictEqual(items.find((i) => i.key === "language").ieltsMin, 6.5);
  assert.strictEqual(items.find((i) => i.key === "test.gre").optional, true);
  assert.strictEqual(items.find((i) => i.key === "doc.recommendation").count, 2);
});

test("a GPA on another scale is not compared numerically", () => {
  const [gpa] = buildRequirements({ minimum_gpa: "75%" });
  assert.strictEqual(gpa.min, null);
  assert.strictEqual(evaluateGap([gpa], PROFILE)[0].status, "unknown");
});

test("gap analysis compares profile values and uses ticked tasks for documents", () => {
  const items = buildRequirements(REQ);
  const rows = Object.fromEntries(evaluateGap(items, PROFILE, {}).map((r) => [r.key, r.status]));
  assert.strictEqual(rows.gpa, "met");
  assert.strictEqual(rows.language, "met");
  assert.strictEqual(rows["test.gre"], "optional");
  assert.strictEqual(rows["doc.cv"], "missing");
  assert.strictEqual(evaluateGap(items, PROFILE, { "doc.cv": true }).find((r) => r.key === "doc.cv").status, "met");
  assert.strictEqual(evaluateGap(items, { ...PROFILE, gpa: "2.5", ielts: "" }, {}).find((r) => r.key === "gpa").status, "missing");
  assert.strictEqual(evaluateGap(items, { ...PROFILE, ielts: "" }, {}).find((r) => r.key === "language").status, "missing");
});

test("deadline is read from the university text, ignoring scholarship and decision dates", () => {
  const intake = roadmap.intakeDate("fall", 2027);
  const found = roadmap.findDeadline(["Scholarship applications close 1 December 2026", "Applications close on 15 January 2027", "Decisions by March 2027"], intake, TODAY);
  assert.strictEqual(found.date, "2027-01-15");
  assert.strictEqual(roadmap.findDeadline(["Apply by January 15"], intake, TODAY).date, "2027-01-15"); // no year: closest one before the intake
  assert.strictEqual(roadmap.submissionDeadline({ keyDeadlines: [], degree: "master", intake, today: TODAY }).source, "estimated");
});

test("tasks only exist for requirements the university states", () => {
  const keys = plan().tasks.map((t) => t.key);
  assert.ok(keys.includes("docs.cv") && keys.includes("docs.recommendation"));
  assert.ok(!keys.includes("acad.language"), "IELTS is met, so no IELTS preparation task");
  assert.ok(!keys.includes("int.prepare"), "no interview is mentioned");
  const noGre = plan({ req: { ...REQ, standardized_tests: [] } }).tasks.map((t) => t.key);
  assert.ok(!noGre.some((k) => k.startsWith("acad.test.")));
});

test("gaps create preparation tasks, and visa tasks depend on the country", () => {
  const weak = plan({ profile: { ...PROFILE, gpa: "2.5", ielts: "5.5" } }).tasks.map((t) => t.key);
  assert.ok(weak.includes("acad.gpa") && weak.includes("acad.language"));
  assert.ok(plan().tasks.some((t) => t.key === "visa.apply"));
  assert.ok(!plan({ country: "Kazakhstan" }).tasks.some((t) => t.key.startsWith("visa.")), "studying at home needs no visa");
  assert.ok(plan({ req: { ...REQ, other: "An interview may be required." } }).tasks.some((t) => t.key === "int.prepare"));
});

test("every task has a date between today and the start of the intake, in a sensible order", () => {
  const { tasks, intake, deadline } = plan();
  for (const t of tasks) assert.ok(t.dueDate >= TODAY && t.dueDate <= intake, `${t.key} ${t.dueDate}`);
  const due = Object.fromEntries(tasks.map((t) => [t.key, t.dueDate]));
  assert.strictEqual(due["sub.submit"], deadline.date);
  assert.ok(due["docs.cv"] <= due["app.form"] && due["app.form"] <= due["sub.submit"]);
  assert.ok(due["visa.apply"] > due["sub.submit"]);
});

test("stage locks follow the rules", () => {
  const counts = { 3: { total: 2, done: 1 }, 4: { total: 1, done: 1 }, 5: { total: 1, done: 0 } };
  assert.strictEqual(roadmap.lockState(5, counts).locked, true);
  counts[3].done = 2;
  assert.strictEqual(roadmap.lockState(5, counts).locked, false);
  assert.strictEqual(roadmap.lockState(1, counts).locked, false);
});
