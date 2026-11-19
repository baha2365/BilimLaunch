/**
 * AI University Admissions Advisor API (all routes need a signed-in user).
 *
 *   GET    /api/plans                              the student's plans, with progress
 *   POST   /api/plans                              create a plan for one university + programme + intake
 *   GET    /api/plans/:id                          the full plan: gap analysis, roadmap, progress
 *   PATCH  /api/plans/:id                          change the application deadline (re-schedules the tasks)
 *   POST   /api/plans/:id/replan                   rebuild from the current profile + university data, keeping progress
 *   DELETE /api/plans/:id
 *   PATCH  /api/plans/:id/tasks/:taskId            mark a task done / not done
 *   POST   /api/plans/:id/advice                   (re)generate the AI advisor summary
 *   POST   /api/plans/:id/tasks/:taskId/assistant  one message to the AI Task Assistant
 *   DELETE /api/plans/:id/tasks/:taskId/assistant  clear that task's chat
 *
 * What a plan contains is decided by deterministic code (requirements.js,
 * roadmap.js) from the scraped university data and the student's saved
 * profile; the model (scraper/advisor.py) only writes the summary and chats.
 * Everything is scoped to req.auth.userId, so nobody can read or change
 * another student's plan.
 */
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { types } = require("pg");
const pg = require("../pg");
const cfg = require("../auth/config");
const { getProfile } = require("../auth/profile");
const { HttpError, wrap } = require("../auth/errors");
const { runPythonScript } = require("../python");
const { buildRequirements, evaluateGap, summarizeGap } = require("./requirements");
const roadmap = require("./roadmap");

// DATE columns come back as "YYYY-MM-DD" strings instead of JS Dates, which would shift by time zone.
types.setTypeParser(1082, (value) => value);

const MAX_PLANS = 10;
const MAX_CHAT_MESSAGES = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROFILE_KEYS = ["country", "university", "fieldOfStudy", "currentYear", "gpa", "ielts", "targetDegree", "targetCountries", "extracurriculars"];

const DEGREE_LABELS = {
  bachelor: "Bachelor's / Undergraduate",
  master: "Master's / Graduate",
  doctorate: "PhD / Doctoral",
  exchange: "Exchange / study-abroad",
  internship: "Internship",
};
const SEASON_LABELS = { fall: "Fall", spring: "Spring", summer: "Summer" };

/* ---------------------------------------------------------------- helpers -- */

function clip(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanProfile(raw) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    const v = raw && typeof raw[key] === "string" ? raw[key].trim().slice(0, 1000) : "";
    if (v) out[key] = v;
  }
  return out;
}

function profileHash(profile) {
  const p = cleanProfile(profile);
  return crypto.createHash("sha1").update(JSON.stringify(PROFILE_KEYS.map((k) => p[k] || ""))).digest("hex").slice(0, 16);
}

/** Only what the plan needs from a scraped programme, length-capped, so it can be stored and reused. */
function programSnapshot(program) {
  const p = program || {};
  const req = p.requirements || {};
  const list = (v, n, len) => (Array.isArray(v) ? v : []).map((x) => clip(String(x == null ? "" : x), len)).filter(Boolean).slice(0, n);
  return {
    requirements: {
      minimum_gpa: clip(String(req.minimum_gpa == null ? "" : req.minimum_gpa), 120) || null,
      language_tests: list(req.language_tests, 8, 200),
      standardized_tests: list(req.standardized_tests, 8, 200),
      required_documents: list(req.required_documents, 20, 200),
      other: clip(String(req.other == null ? "" : req.other), 600) || null,
    },
    scholarships: (Array.isArray(p.scholarships) ? p.scholarships : [])
      .filter((s) => s && s.name)
      .slice(0, 5)
      .map((s) => ({ name: clip(String(s.name), 120), eligibility: clip(String(s.eligibility || ""), 250), amount: clip(String(s.amount || ""), 120), deadline: clip(String(s.deadline || ""), 120) })),
    tuition: { international: clip(String((p.tuition || {}).international || ""), 250), domestic_or_home: clip(String((p.tuition || {}).domestic_or_home || ""), 250) },
    notes: clip(String(p.notes || ""), 800),
    key_deadlines: list(p.key_deadlines, 12, 250),
    sources: list(p.sources, 6, 300).filter((u) => /^https?:\/\//i.test(u)),
  };
}

function intakeLabel(plan) {
  return `${SEASON_LABELS[plan.intake_season] || plan.intake_season} ${plan.intake_year}`;
}

function taskRow(row, locked) {
  return {
    id: row.id,
    key: row.task_key,
    stage: row.stage,
    title: row.title,
    why: row.why,
    steps: row.steps || [],
    resources: row.resources || [],
    estimate: row.estimate,
    dueDate: row.due_date,
    priority: row.priority,
    status: row.status,
    completedAt: row.completed_at,
    autoDone: row.auto_done,
    requirementKey: row.requirement_key,
    locked: !!locked && row.status !== "done",
    messageCount: (row.chat || []).length,
  };
}

function stageCounts(tasks) {
  const counts = {};
  for (const t of tasks) {
    const c = (counts[t.stage] = counts[t.stage] || { total: 0, done: 0 });
    c.total += 1;
    if (t.status === "done") c.done += 1;
  }
  return counts;
}

const byDue = (a, b) => (a.due_date || "9999") < (b.due_date || "9999") ? -1 : (a.due_date || "9999") > (b.due_date || "9999") ? 1 : a.position - b.position;

/** Which tasks count as "done" evidence for a requirement in the gap table. Eligibility checks don't: they are only a reading step. */
function doneByRequirement(tasks) {
  const done = {};
  for (const t of tasks) if (t.status === "done" && t.requirement_key && t.stage >= 2 && t.task_key !== "acad.gpa") done[t.requirement_key] = true;
  return done;
}

function rulesAdvice(plan, gap, nextTasks) {
  const s = summarizeGap(gap);
  const open = gap.filter((r) => r.status === "missing" || r.status === "unknown").map((r) => r.label);
  const parts = [];
  if (!gap.length) parts.push(`We could not find specific entry requirements for ${plan.university_name} on the pages we read, so the plan uses typical steps. Check the official site first.`);
  else parts.push(`You meet ${s.met} of ${s.total - s.optional} requirements we found for ${plan.university_name}.`);
  if (open.length) parts.push(`Still open: ${open.slice(0, 5).join(", ")}.`);
  if (nextTasks[0]) parts.push(`Your next step: ${nextTasks[0].title}.`);
  return { summary: parts.join(" "), priorities: nextTasks.slice(0, 3).map((t) => t.title), source: "rules" };
}

function aiContext(plan, profile) {
  return {
    profile: cleanProfile(profile),
    university: {
      name: plan.university_name,
      programme: plan.program || "(not chosen yet)",
      degree_level: DEGREE_LABELS[plan.degree] || plan.degree,
      intake: intakeLabel(plan),
      deadline: roadmap.longDate(plan.submission_deadline),
      deadline_note: plan.deadline_source === "university" ? `found on the university's page: "${(plan.meta || {}).deadlineText || ""}"` : plan.deadline_source === "you" ? "set by the student" : "an estimate, not confirmed by the university",
    },
  };
}

/* ------------------------------------------------------------- data access -- */

async function loadPlan(userId, id) {
  if (!UUID_RE.test(String(id))) throw new HttpError(404, "Plan not found.", "not_found");
  const plan = (await pg.query("SELECT * FROM admission_plans WHERE id = $1 AND user_id = $2", [id, userId])).rows[0];
  if (!plan) throw new HttpError(404, "Plan not found.", "not_found");
  return plan;
}

async function loadTasks(planId) {
  return (await pg.query("SELECT * FROM plan_tasks WHERE plan_id = $1 ORDER BY stage, position", [planId])).rows;
}

async function buildView(plan, tasks, profileState) {
  const today = roadmap.todayIso();
  const counts = stageCounts(tasks);
  const locks = Object.fromEntries(roadmap.STAGES.map((s) => [s.n, roadmap.lockState(s.n, counts)]));
  const gap = evaluateGap(plan.requirements, profileState.profile, doneByRequirement(tasks));
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const sorted = [...tasks].sort(byDue);
  const next = sorted.filter((t) => t.status !== "done" && !locks[t.stage].locked).slice(0, 4);

  const stages = roadmap.STAGES.filter((s) => counts[s.n])
    .map((s) => ({
      n: s.n,
      title: s.title,
      subtitle: s.subtitle,
      total: counts[s.n].total,
      done: counts[s.n].done,
      locked: locks[s.n].locked,
      lockedReason: locks[s.n].reason,
      tasks: sorted.filter((t) => t.stage === s.n).map((t) => taskRow(t, locks[s.n].locked)),
    }));

  const meta = plan.meta || {};
  return {
    id: plan.id,
    today,
    university: { slug: plan.university_slug, name: plan.university_name, city: meta.city || "", country: meta.country || "" },
    degree: plan.degree,
    degreeLabel: DEGREE_LABELS[plan.degree] || plan.degree,
    program: plan.program,
    intake: { season: plan.intake_season, year: plan.intake_year, label: intakeLabel(plan), date: plan.intake_date },
    deadline: { date: plan.submission_deadline, source: plan.deadline_source, text: meta.deadlineText || "" },
    sources: meta.sources || [],
    tightSchedule: roadmap.diffDays(plan.submission_deadline, today) < 60,
    profileChanged: plan.profile_hash !== profileHash(profileState.profile),
    progress: { total, done, remaining: total - done, percent: total ? Math.round((done / total) * 100) : 0 },
    gap: { rows: gap, summary: summarizeGap(gap) },
    nextTasks: next.map((t) => taskRow(t, false)),
    stages,
    advice: plan.advice || rulesAdvice(plan, gap, next),
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
  };
}

async function fullView(userId, planId) {
  const plan = await loadPlan(userId, planId);
  const [tasks, profileState] = await Promise.all([loadTasks(plan.id), getProfile(pg, userId)]);
  return buildView(plan, tasks, profileState);
}

/** Rebuilds the task list inside `client`, keeping each task's progress and chat by task_key. */
async function syncTasks(client, planId, newTasks) {
  const existing = (await client.query("SELECT * FROM plan_tasks WHERE plan_id = $1", [planId])).rows;
  const byKey = new Map(existing.map((t) => [t.task_key, t]));
  const wanted = new Set(newTasks.map((t) => t.key));

  for (const old of existing) {
    // A finished task stays even if the plan no longer asks for it: the student did that work.
    if (!wanted.has(old.task_key) && old.status !== "done") await client.query("DELETE FROM plan_tasks WHERE id = $1", [old.id]);
  }

  for (const t of newTasks) {
    const old = byKey.get(t.key);
    const fields = [t.stage, t.position, t.title, t.why, JSON.stringify(t.steps), JSON.stringify(t.resources), t.estimate, t.priority, t.requirementKey || null];
    if (!old) {
      await client.query(
        `INSERT INTO plan_tasks (plan_id, task_key, stage, position, title, why, steps, resources, estimate, priority, requirement_key, due_date, status, auto_done, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [planId, t.key, ...fields, t.dueDate, t.autoDone ? "done" : "todo", !!t.autoDone, t.autoDone ? new Date() : null]
      );
      continue;
    }
    // Status: a system-completed task follows the profile; one the student touched keeps what they chose.
    let status = old.status;
    let autoDone = old.auto_done;
    let completedAt = old.completed_at;
    if (old.auto_done && !t.autoDone) {
      status = "todo";
      autoDone = false;
      completedAt = null;
    } else if (old.status === "todo" && t.autoDone) {
      status = "done";
      autoDone = true;
      completedAt = new Date();
    }
    await client.query(
      `UPDATE plan_tasks SET stage=$1, position=$2, title=$3, why=$4, steps=$5, resources=$6, estimate=$7, priority=$8, requirement_key=$9,
         due_date = CASE WHEN status = 'done' THEN due_date ELSE $10 END, status=$11, auto_done=$12, completed_at=$13
       WHERE id = $14`,
      [...fields, t.dueDate, status, autoDone, completedAt, old.id]
    );
  }
}

/** Everything roadmap.js needs, from a stored plan + a programme snapshot. */
function roadmapContext(plan, profile, snapshot, requirements) {
  const meta = plan.meta || {};
  return {
    requirements,
    profile: cleanProfile(profile),
    degree: plan.degree,
    university: { slug: plan.university_slug, name: plan.university_name, country: meta.country || "" },
    program: snapshot,
    programName: plan.program,
    deadline: { date: plan.submission_deadline, source: plan.deadline_source },
    intake: plan.intake_date,
  };
}

async function freshSnapshot(plan, db) {
  try {
    const { info } = await db.connect();
    const doc = await info.findOne({ slug: plan.university_slug });
    const program = doc && doc.programs && doc.programs[plan.degree];
    if (program && program.generated_at) return programSnapshot(program);
  } catch (err) {
    console.warn(`[plans] could not refresh data for ${plan.university_slug}: ${err.message}`);
  }
  return null;
}

/* ------------------------------------------------------------------ router -- */

function createPlansRouter({ db, DEGREES, getProgram }) {
  const router = express.Router();

  const costly = (max, what) =>
    cfg.IS_TEST
      ? (req, res, next) => next()
      : rateLimit({
          windowMs: 10 * 60 * 1000,
          limit: max,
          keyGenerator: (req) => req.auth.userId,
          standardHeaders: true,
          legacyHeaders: false,
          handler: (req, res) => res.status(429).json({ error: `Too many ${what} requests. Please wait a few minutes.`, code: "rate_limited" }),
        });

  const busy = new Set(); // plan / task ids with a model call running

  /* ---- list ---- */
  router.get(
    "/",
    wrap(async (req, res) => {
      const userId = req.auth.userId;
      const plans = (await pg.query("SELECT * FROM admission_plans WHERE user_id = $1 ORDER BY updated_at DESC", [userId])).rows;
      if (!plans.length) return res.json({ plans: [] });
      const ids = plans.map((p) => p.id);
      const tasks = (await pg.query("SELECT plan_id, stage, position, title, due_date, status FROM plan_tasks WHERE plan_id = ANY($1::uuid[]) ORDER BY stage, position", [ids])).rows;
      const today = roadmap.todayIso();
      res.json({
        plans: plans.map((plan) => {
          const mine = tasks.filter((t) => t.plan_id === plan.id);
          const counts = stageCounts(mine);
          const next = mine
            .filter((t) => t.status !== "done" && !roadmap.lockState(t.stage, counts).locked)
            .sort(byDue)[0];
          const done = mine.filter((t) => t.status === "done").length;
          return {
            id: plan.id,
            university: { slug: plan.university_slug, name: plan.university_name, country: (plan.meta || {}).country || "" },
            degree: plan.degree,
            degreeLabel: DEGREE_LABELS[plan.degree] || plan.degree,
            program: plan.program,
            intake: intakeLabel(plan),
            deadline: plan.submission_deadline,
            progress: { total: mine.length, done, percent: mine.length ? Math.round((done / mine.length) * 100) : 0 },
            next: next ? { title: next.title, dueDate: next.due_date, overdue: !!next.due_date && next.due_date < today } : null,
          };
        }),
      });
    })
  );

  /* ---- create ---- */
  router.post(
    "/",
    costly(15, "plan"),
    wrap(async (req, res) => {
      const userId = req.auth.userId;
      const body = req.body || {};
      const slug = clip(body.slug, 80);
      const degree = body.degree;
      const program = clip(body.program, 150);
      const season = body.intakeSeason;
      const year = Number(body.intakeYear);

      const errors = {};
      if (!slug) errors.slug = "Choose a university.";
      if (!DEGREES.includes(degree)) errors.degree = "Choose a degree level.";
      if (!roadmap.SEASONS.includes(season)) errors.intakeSeason = "Choose an intake.";
      if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.intakeYear = "Choose the intake year.";
      if (Object.keys(errors).length) throw new HttpError(422, "Check the highlighted fields.", "validation", { errors });

      const today = roadmap.todayIso();
      const intake = roadmap.intakeDate(season, year);
      if (roadmap.diffDays(intake, today) < 45) {
        throw new HttpError(422, "That intake starts too soon to plan for. Choose a later one.", "validation", { errors: { intakeYear: "Choose a later intake." } });
      }

      const profileState = await getProfile(pg, userId);
      if (!profileState.completed) throw new HttpError(409, "Complete your profile first.", "profile_incomplete");

      const count = Number((await pg.query("SELECT count(*) FROM admission_plans WHERE user_id = $1", [userId])).rows[0].count);
      if (count >= MAX_PLANS) throw new HttpError(409, `You can keep up to ${MAX_PLANS} plans. Delete one you no longer need first.`, "too_many_plans");

      const dup = (
        await pg.query(
          "SELECT id FROM admission_plans WHERE user_id=$1 AND university_slug=$2 AND degree=$3 AND program=$4 AND intake_season=$5 AND intake_year=$6",
          [userId, slug, degree, program, season, year]
        )
      ).rows[0];
      if (dup) throw new HttpError(409, "You already have a plan for this university, programme and intake.", "duplicate", { planId: dup.id });

      // The AI step: read the university's official pages for this degree (cached after the first time).
      let config;
      let programData;
      try {
        ({ config, program: programData } = await getProgram(slug, degree));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        const noSource = /source pages/i.test(err.message);
        throw new HttpError(noSource ? 409 : 502, noSource ? `We have no admissions pages for ${DEGREES.includes(degree) ? degree : "this"} study at this university yet.` : err.message, noSource ? "no_data" : "research_failed");
      }

      const snapshot = programSnapshot(programData);
      const requirements = buildRequirements(snapshot.requirements);
      const deadline = roadmap.submissionDeadline({ keyDeadlines: snapshot.key_deadlines, degree, intake, today });

      const plan = {
        university_slug: config.slug,
        university_name: config.name,
        degree,
        program,
        intake_season: season,
        intake_year: year,
        intake_date: intake,
        submission_deadline: deadline.date,
        deadline_source: deadline.source,
        meta: {
          city: config.city || "",
          country: config.country || "",
          deadlineText: deadline.text,
          sources: snapshot.sources,
          snapshot,
          dataGeneratedAt: programData.generated_at || null,
        },
      };
      const tasks = roadmap.planRoadmap(roadmapContext(plan, profileState.profile, snapshot, requirements), today);

      const planId = await pg.tx(async (client) => {
        const row = (
          await client.query(
            `INSERT INTO admission_plans (user_id, university_slug, university_name, degree, program, intake_season, intake_year, intake_date,
               submission_deadline, deadline_source, requirements, meta, profile_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
            [userId, plan.university_slug, plan.university_name, degree, program, season, year, intake, deadline.date, deadline.source, JSON.stringify(requirements), JSON.stringify(plan.meta), profileHash(profileState.profile)]
          )
        ).rows[0];
        await syncTasks(client, row.id, tasks);
        return row.id;
      });
      res.status(201).json(await fullView(userId, planId));
    })
  );

  /* ---- read ---- */
  router.get("/:id", wrap(async (req, res) => res.json(await fullView(req.auth.userId, req.params.id))));

  /* ---- change the deadline ---- */
  router.patch(
    "/:id",
    wrap(async (req, res) => {
      const userId = req.auth.userId;
      const plan = await loadPlan(userId, req.params.id);
      const value = req.body && req.body.submissionDeadline;
      const today = roadmap.todayIso();
      if (typeof value !== "string" || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) throw new HttpError(422, "Enter the deadline as a date.", "validation");
      if (value < today) throw new HttpError(422, "The deadline can't be in the past.", "validation");
      if (value >= plan.intake_date) throw new HttpError(422, `The deadline must be before the start of the intake (${roadmap.longDate(plan.intake_date)}).`, "validation");

      const profileState = await getProfile(pg, userId);
      const updated = { ...plan, submission_deadline: value, deadline_source: "you" };
      const snapshot = (plan.meta || {}).snapshot || programSnapshot({});
      const tasks = roadmap.planRoadmap(roadmapContext(updated, profileState.profile, snapshot, plan.requirements), today);
      await pg.tx(async (client) => {
        await client.query("UPDATE admission_plans SET submission_deadline=$1, deadline_source='you', updated_at=now() WHERE id=$2", [value, plan.id]);
        await syncTasks(client, plan.id, tasks);
      });
      res.json(await fullView(userId, plan.id));
    })
  );

  /* ---- re-plan from the current profile and data ---- */
  router.post(
    "/:id/replan",
    wrap(async (req, res) => {
      const userId = req.auth.userId;
      const plan = await loadPlan(userId, req.params.id);
      const profileState = await getProfile(pg, userId);
      const today = roadmap.todayIso();

      const fresh = await freshSnapshot(plan, db);
      const snapshot = fresh || (plan.meta || {}).snapshot || programSnapshot({});
      const requirements = buildRequirements(snapshot.requirements);

      // Keep the student's own deadline; otherwise look again (the page may have been updated),
      // and never leave a deadline in the past.
      let deadline = { date: plan.submission_deadline, source: plan.deadline_source, text: (plan.meta || {}).deadlineText || "" };
      if (plan.deadline_source !== "you") {
        deadline = roadmap.submissionDeadline({ keyDeadlines: snapshot.key_deadlines, degree: plan.degree, intake: plan.intake_date, today });
      } else if (deadline.date < today) {
        deadline = { date: roadmap.addDays(today, 21) < plan.intake_date ? roadmap.addDays(today, 21) : plan.intake_date, source: "estimated", text: "" };
      }
      const meta = { ...(plan.meta || {}), snapshot, sources: snapshot.sources, deadlineText: deadline.text };
      const updated = { ...plan, submission_deadline: deadline.date, deadline_source: deadline.source, meta };
      const tasks = roadmap.planRoadmap(roadmapContext(updated, profileState.profile, snapshot, requirements), today);

      await pg.tx(async (client) => {
        await client.query(
          `UPDATE admission_plans SET submission_deadline=$1, deadline_source=$2, requirements=$3, meta=$4, profile_hash=$5, advice=NULL, updated_at=now() WHERE id=$6`,
          [deadline.date, deadline.source, JSON.stringify(requirements), JSON.stringify(meta), profileHash(profileState.profile), plan.id]
        );
        await syncTasks(client, plan.id, tasks);
      });
      res.json(await fullView(userId, plan.id));
    })
  );

  router.delete(
    "/:id",
    wrap(async (req, res) => {
      const plan = await loadPlan(req.auth.userId, req.params.id);
      await pg.query("DELETE FROM admission_plans WHERE id = $1", [plan.id]);
      res.json({ ok: true });
    })
  );

  /* ---- tick a task ---- */
  router.patch(
    "/:id/tasks/:taskId",
    wrap(async (req, res) => {
      const userId = req.auth.userId;
      const plan = await loadPlan(userId, req.params.id);
      const status = req.body && req.body.status;
      if (status !== "done" && status !== "todo") throw new HttpError(422, "Status must be done or todo.", "validation");
      if (!UUID_RE.test(req.params.taskId)) throw new HttpError(404, "Task not found.", "not_found");

      const tasks = await loadTasks(plan.id);
      const task = tasks.find((t) => t.id === req.params.taskId);
      if (!task) throw new HttpError(404, "Task not found.", "not_found");

      if (status === "done" && task.status !== "done") {
        const lock = roadmap.lockState(task.stage, stageCounts(tasks));
        if (lock.locked) throw new HttpError(409, lock.reason, "stage_locked");
      }
      await pg.query(
        "UPDATE plan_tasks SET status=$1::text, auto_done=false, completed_at = CASE WHEN $1::text = 'done' THEN now() ELSE NULL END WHERE id=$2",
        [status, task.id]
      );
      await pg.query("UPDATE admission_plans SET updated_at = now() WHERE id = $1", [plan.id]);
      res.json(await fullView(userId, plan.id));
    })
  );

  /* ---- AI advisor summary ---- */
  router.post(
    "/:id/advice",
    costly(10, "advisor"),
    wrap(async (req, res) => {
      const userId = req.auth.userId;
      const plan = await loadPlan(userId, req.params.id);
      if (busy.has(plan.id)) throw new HttpError(409, "The advisor is already working on this plan.", "busy");
      busy.add(plan.id);
      try {
        const [tasks, profileState] = await Promise.all([loadTasks(plan.id), getProfile(pg, userId)]);
        const view = await buildView(plan, tasks, profileState);
        const ctx = aiContext(plan, profileState.profile);
        const result = await runPythonScript(
          "advisor.py",
          { mode: "summary", ...ctx, gap: view.gap.rows.filter((r) => r.status !== "optional").map(({ label, required, student, status }) => ({ label, required, student, status })), tasks: view.nextTasks.map((t) => `${t.title} (due ${t.dueDate})`) },
          "advisor"
        );
        const advice = { summary: result.summary, priorities: result.priorities || [], source: "ai", model: result.model, generatedAt: result.generated_at };
        await pg.query("UPDATE admission_plans SET advice = $1 WHERE id = $2", [JSON.stringify(advice), plan.id]);
        res.json({ advice });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, err.message, "advisor_failed");
      } finally {
        busy.delete(plan.id);
      }
    })
  );

  /* ---- AI Task Assistant ---- */
  async function loadTask(userId, planId, taskId) {
    const plan = await loadPlan(userId, planId);
    if (!UUID_RE.test(taskId)) throw new HttpError(404, "Task not found.", "not_found");
    const task = (await pg.query("SELECT * FROM plan_tasks WHERE id = $1 AND plan_id = $2", [taskId, plan.id])).rows[0];
    if (!task) throw new HttpError(404, "Task not found.", "not_found");
    return { plan, task };
  }

  router.get(
    "/:id/tasks/:taskId/assistant",
    wrap(async (req, res) => {
      const { task } = await loadTask(req.auth.userId, req.params.id, req.params.taskId);
      res.json({ chat: task.chat || [] });
    })
  );

  router.post(
    "/:id/tasks/:taskId/assistant",
    costly(30, "assistant"),
    wrap(async (req, res) => {
      const userId = req.auth.userId;
      const { plan, task } = await loadTask(userId, req.params.id, req.params.taskId);
      const message = clip(req.body && req.body.message, 2000);
      if (!message) throw new HttpError(422, "Write a message first.", "validation");
      if (busy.has(task.id)) throw new HttpError(409, "The assistant is still answering your last message.", "busy");
      busy.add(task.id);
      try {
        const profileState = await getProfile(pg, userId);
        const req_ = (plan.requirements || []).find((r) => r.key === task.requirement_key);
        const history = (task.chat || []).slice(-12).map(({ role, content }) => ({ role, content }));
        const ctx = aiContext(plan, profileState.profile);
        const result = await runPythonScript(
          "advisor.py",
          {
            mode: "assist",
            ...ctx,
            task: {
              title: task.title,
              stage: (roadmap.STAGES[task.stage - 1] || {}).title,
              why: task.why,
              steps: task.steps,
              requirement: req_ ? `${req_.label}: ${req_.required}` : "",
            },
            history,
            message,
          },
          "assistant"
        );
        const chat = [...(task.chat || []), { role: "user", content: message }, { role: "assistant", content: result.reply }].slice(-MAX_CHAT_MESSAGES);
        await pg.query("UPDATE plan_tasks SET chat = $1 WHERE id = $2", [JSON.stringify(chat), task.id]);
        res.json({ reply: result.reply, chat });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, err.message, "assistant_failed");
      } finally {
        busy.delete(task.id);
      }
    })
  );

  router.delete(
    "/:id/tasks/:taskId/assistant",
    wrap(async (req, res) => {
      const { task } = await loadTask(req.auth.userId, req.params.id, req.params.taskId);
      await pg.query("UPDATE plan_tasks SET chat = '[]' WHERE id = $1", [task.id]);
      res.json({ chat: [] });
    })
  );

  router.use(errorHandler);
  return router;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed request.", code: "bad_json" });
  console.error(`[plans] ${req.method} ${req.originalUrl} failed: ${err && err.stack ? err.stack : err}`);
  const unreachable = err && (/^(ECONN|ENOTFOUND|ETIMEDOUT)/.test(err.code || "") || err.code === "57P03" || /timeout|Connection terminated/i.test(err.message || ""));
  if (unreachable) return res.status(503).json({ error: "The database can't be reached right now. Please try again shortly.", code: "db_unavailable" });
  res.status(500).json({ error: "Something went wrong on our side. Please try again.", code: "server_error" });
}

module.exports = { createPlansRouter, programSnapshot, profileHash };
