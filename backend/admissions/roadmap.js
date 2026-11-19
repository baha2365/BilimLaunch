/*
 * The Personalized Roadmap: 9 stages of tasks built for ONE university,
 * programme and intake, from
 *   - the student's profile,
 *   - the entry requirements scraped from the university's own pages, and
 *   - typical admission timelines.
 *
 * Not every stage applies to every programme: a GPA task only exists when the
 * university states a GPA, GRE tasks only when a GRE is listed, visa tasks
 * only when the student would study abroad, interview tasks only when the
 * university's pages mention an interview. Stages with no tasks are left out.
 *
 * This file is deterministic (no model call). The AI Advisor and the Task
 * Assistant (scraper/advisor.py) explain and help with these tasks; they never
 * decide which requirements exist.
 */
const countries = require("../auth/countries");
const { evaluateGap } = require("./requirements");

const STAGES = [
  { n: 1, title: "Profile & Eligibility Assessment", subtitle: "Check how ready you are for this programme." },
  { n: 2, title: "Academic Preparation", subtitle: "Close the gaps in grades and test scores." },
  { n: 3, title: "Document Preparation", subtitle: "Collect and write everything the application needs." },
  { n: 4, title: "Application Preparation", subtitle: "Get the application ready to send." },
  { n: 5, title: "Application Submission", subtitle: "Send the application and keep track of it." },
  { n: 6, title: "Interview & Admission Decision", subtitle: "From the decision to an accepted offer." },
  { n: 7, title: "Scholarship & Financial Preparation", subtitle: "Plan how you will pay for it." },
  { n: 8, title: "Visa & Accommodation", subtitle: "Prepare to live abroad." },
  { n: 9, title: "Pre-departure & Enrollment", subtitle: "Travel, register and start studying." },
];

// A stage opens once every task in the listed stages is done.
const LOCKS = { 5: [3, 4], 6: [5], 8: [6], 9: [8] };

const INTAKES = { spring: [1, 1], summer: [5, 1], fall: [8, 1] }; // [month index, day] (Feb 1, Jun 1, Sep 1)
const SEASONS = Object.keys(INTAKES);

/* ---------------------------------------------------------------- dates -- */

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");

function iso(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function fromIso(value) {
  const [y, m, d] = String(value).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(value, days) {
  return iso(new Date(fromIso(value).getTime() + days * DAY));
}
function diffDays(a, b) {
  return Math.round((fromIso(a) - fromIso(b)) / DAY);
}
function addMonths(value, months) {
  const d = fromIso(value);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate())));
}
function longDate(value) {
  const d = fromIso(value);
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function todayIso(now = new Date()) {
  return iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

function intakeDate(season, year) {
  const [month, day] = INTAKES[season];
  return iso(new Date(Date.UTC(year, month, day)));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_PATTERN = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DMY_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_PATTERN}\\b\\.?(?:,?\\s+(\\d{4}))?`, "gi");
const MDY_RE = new RegExp(`\\b${MONTH_PATTERN}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi");
const APPLICATION_RE = /(application|apply|applications|submit|closing|closes|deadline)/i;
const NOT_APPLICATION_RE = /(scholarship|funding|bursary|visa|housing|accommodation|fee payment|tuition|decision|offer|notif|enrol|enroll|registration|orientation|exam|test date)/i;

/** Dates found in one sentence: [{ date: "YYYY-MM-DD" | null (no year), month, day, year }] */
function datesIn(sentence) {
  const found = [];
  const push = (day, monthName, year) => {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    const d = Number(day);
    if (month < 0 || d < 1 || d > 31) return;
    found.push({ month, day: d, year: year ? Number(year) : null });
  };
  for (const m of sentence.matchAll(DMY_RE)) push(m[1], m[2], m[3]);
  for (const m of sentence.matchAll(MDY_RE)) push(m[2], m[1], m[3]);
  return found;
}

/**
 * Looks for an application deadline in the scraped `key_deadlines` strings.
 * Returns { date, text } or null. Only dates that fall between 14 months
 * before the intake and the intake itself count (a deadline without a year
 * is read as the closest such date before the intake).
 */
function findDeadline(keyDeadlines, intake, today) {
  const intakeD = fromIso(intake);
  const windowStart = addMonths(intake, -14);
  const candidates = [];
  for (const raw of Array.isArray(keyDeadlines) ? keyDeadlines : []) {
    const sentence = String(raw || "");
    if (!APPLICATION_RE.test(sentence) || NOT_APPLICATION_RE.test(sentence)) continue;
    for (const d of datesIn(sentence)) {
      let date = null;
      if (d.year) {
        date = iso(new Date(Date.UTC(d.year, d.month, d.day)));
      } else {
        for (const y of [intakeD.getUTCFullYear(), intakeD.getUTCFullYear() - 1]) {
          const guess = iso(new Date(Date.UTC(y, d.month, d.day)));
          if (guess < intake && guess >= windowStart) {
            date = guess;
            break;
          }
        }
      }
      if (date && date < intake && date >= windowStart && date >= addDays(today, 7)) candidates.push({ date, text: sentence.trim().slice(0, 240) });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.date < b.date ? -1 : 1));
  // Several rounds: take the earliest one that still leaves 6+ weeks, else the latest.
  return candidates.find((c) => diffDays(c.date, today) >= 42) || candidates[candidates.length - 1];
}

const ESTIMATED_LEAD_MONTHS = { bachelor: 8, master: 6, doctorate: 9, exchange: 5, internship: 4 };

/** { date, source: "university"|"estimated", text? } */
function submissionDeadline({ keyDeadlines, degree, intake, today }) {
  const found = findDeadline(keyDeadlines, intake, today);
  if (found) return { date: found.date, source: "university", text: found.text };
  let date = addMonths(intake, -(ESTIMATED_LEAD_MONTHS[degree] || 6));
  const earliest = addDays(today, 21);
  if (date < earliest) date = earliest <= intake ? earliest : intake;
  return { date, source: "estimated", text: "" };
}

/* ---------------------------------------------------------------- tasks -- */

const RES = {
  europass: { label: "Europass CV editor", url: "https://europass.europa.eu/en/create-europass-cv" },
  owl: { label: "Purdue OWL: writing a résumé or CV", url: "https://owl.purdue.edu/owl/job_search_writing/resumes_and_vitas/index.html" },
  ielts: { label: "IELTS: find and book a test", url: "https://ielts.org/" },
  toefl: { label: "TOEFL iBT: register", url: "https://www.ets.org/toefl.html" },
  gre: { label: "GRE: official test information", url: "https://www.ets.org/gre.html" },
  gmat: { label: "GMAT: official test information", url: "https://www.mba.com/exams/gmat-exam" },
  sat: { label: "SAT: official test information", url: "https://satsuite.collegeboard.org/sat" },
  act: { label: "ACT: official test information", url: "https://www.act.org/" },
};

const TEST_RESOURCE = { IELTS: RES.ielts, TOEFL: RES.toefl, GRE: RES.gre, GMAT: RES.gmat, SAT: RES.sat, ACT: RES.act };

function sameCountry(a, b) {
  const x = countries.canonical(a || "") || String(a || "").trim().toLowerCase();
  const y = countries.canonical(b || "") || String(b || "").trim().toLowerCase();
  return !!x && x === y;
}

const MENTIONS_INTERVIEW = /\binterview(s|ed)?\b/i;

function walkStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => walkStrings(v, out));
  return out;
}

const link = (label, url) => ({ label, url });

/**
 * Builds the unscheduled task list.
 *
 * ctx: { requirements, profile, degree, university: {slug, name, country}, program: {requirements, scholarships,
 *        tuition, notes, sources}, programName, deadline: {date, source}, intake }
 * Each task: { key, stage, title, why, steps[], resources[], estimate, priority, requirementKey?, autoDone?,
 *              when: { before: days } | { after: days } | { beforeIntake: days } }
 */
function buildTasks(ctx) {
  const { requirements, profile, degree, university, program, programName } = ctx;
  const uni = university.name;
  const sources = (program.sources || []).filter((u) => /^https?:\/\//i.test(u)).slice(0, 3);
  const sourceLinks = sources.map((u) => link(`Official page: ${u.replace(/^https?:\/\//, "").slice(0, 55)}`, u));
  const gapRows = evaluateGap(requirements, profile, {});
  const gapByKey = Object.fromEntries(gapRows.map((r) => [r.key, r]));
  const reqByKey = Object.fromEntries(requirements.map((r) => [r.key, r]));
  const tasks = [];
  const add = (task) => tasks.push({ resources: [], steps: [], priority: "normal", ...task });
  const field = profile.fieldOfStudy || "your field";
  const programLabel = programName || `${uni} programme`;
  const abroad = !sameCountry(profile.country, university.country);

  /* 1 -- Profile & eligibility ------------------------------------------- */
  add({
    key: "elig.requirements",
    stage: 1,
    title: `Read ${uni}'s official admission requirements`,
    why: "Everything in this plan comes from information read automatically from the university's pages. Reading the official pages yourself is the only way to be sure nothing is missing or out of date.",
    steps: [
      "Open the official admissions pages linked below.",
      `Find the requirements for ${programLabel} specifically; they can differ between programmes.`,
      "Note the application deadline and every document or test they ask for.",
      "If anything differs from this plan, tell the assistant here or update the plan.",
    ],
    resources: sourceLinks,
    estimate: "1 hour",
    priority: "high",
    when: { before: 145 },
  });

  const gpa = reqByKey.gpa;
  if (gpa) {
    const row = gapByKey.gpa;
    const evaluable = row.status === "met" || (row.status === "missing" && gpa.min != null && row.student !== "Not in your profile");
    add({
      key: "elig.gpa",
      stage: 1,
      title: "Check the GPA requirement",
      why: `${uni} states a minimum GPA of ${gpa.required}. Your profile says ${row.student}.`,
      steps: [
        `Compare your GPA (${row.student}) with the requirement: ${gpa.required}.`,
        gpa.min == null ? "The university uses a different scale: convert your GPA with your registrar's guidance or the university's conversion table." : "Check whether the requirement applies to your whole degree or to your last two years.",
        row.status === "met" ? "You meet it. Nothing more to do here." : "You are below it: the Academic Preparation stage has a task for this.",
      ],
      estimate: "20 minutes",
      requirementKey: "gpa",
      autoDone: evaluable,
      when: { before: 140 },
    });
  }

  const language = reqByKey.language;
  if (language) {
    const row = gapByKey.language;
    add({
      key: "elig.language",
      stage: 1,
      title: "Check the English-language requirement",
      why: `${uni} lists: ${language.required}.`,
      steps: [
        `Compare your score (${row.student}) with: ${language.required}.`,
        "Check which tests are accepted and how old a result may be (usually 2 years).",
        row.status === "met" ? "You meet it. Keep your test report ready for the application." : "You still need a qualifying result: see the Academic Preparation stage.",
      ],
      estimate: "20 minutes",
      requirementKey: "language",
      autoDone: row.status === "met",
      when: { before: 140 },
    });
  }

  add({
    key: "elig.programme",
    stage: 1,
    title: `Confirm the programme and its prerequisites${programName ? `: ${programName}` : ""}`,
    why: `Prerequisite courses and special requirements are set per programme. Your field is ${field}.`,
    steps: [
      programName ? `Open the page for ${programName}.` : `Choose the exact ${degreeNoun(degree)} programme you will apply to, and open its page.`,
      "List any prerequisite subjects, minimum grades in specific modules, or work-experience requirements.",
      "Check the start dates and the study mode (full-time or part-time).",
      "Write down anything you do not meet; the assistant can help you plan for it.",
    ],
    resources: sourceLinks,
    estimate: "1 hour",
    when: { before: 135 },
  });

  if (program.requirements && program.requirements.other) {
    add({
      key: "elig.other",
      stage: 1,
      title: "Read the additional requirements",
      why: `The university's pages also say: “${String(program.requirements.other).slice(0, 280)}”`,
      steps: ["Read the full text on the official page.", "Note what applies to you and add a task for it if needed."],
      resources: sourceLinks,
      estimate: "30 minutes",
      when: { before: 130 },
    });
  }

  /* 2 -- Academic preparation (only for real gaps) ------------------------ */
  if (gpa && gapByKey.gpa.status === "missing" && gpa.min != null && gapByKey.gpa.student !== "Not in your profile") {
    add({
      key: "acad.gpa",
      stage: 2,
      title: "Plan how to address the GPA gap",
      why: `Your GPA (${gapByKey.gpa.student}) is below the stated minimum (${gpa.required}). It is worth knowing early how the university treats this.`,
      steps: [
        "Email the admissions office: ask whether applicants slightly below the minimum are considered and what strengthens such an application.",
        "If you still have semesters left, plan which grades you can raise.",
        "Strengthen the rest of the application: relevant projects, strong references, a clear statement of purpose.",
        "Decide with the assistant whether to apply here or to add a safer university to your list.",
      ],
      estimate: "1 week",
      priority: "high",
      requirementKey: "gpa",
      when: { before: 120 },
    });
  }

  if (language) {
    const row = gapByKey.language;
    if (row.status !== "met") {
      const testName = language.ieltsMin != null || !language.tests.length ? "IELTS" : language.tests[0];
      const target = language.ieltsMin != null ? ` (target: IELTS ${language.ieltsMin}+)` : "";
      add({
        key: "acad.language",
        stage: 2,
        title: `Prepare for and take ${testName}${target}`,
        why: `${uni} requires: ${language.required}. ${row.student === "No test score yet" ? "You have no result yet." : `Your current result: ${row.student}.`}${row.status === "unknown" ? " Ask the university whether your existing result is accepted before you book another test." : ""}`,
        steps: [
          "Take a free practice test to see your starting level in each section.",
          "Build a study plan around your weakest section; 6 to 10 weeks of regular practice is typical.",
          "Book the exam early; results usually take 1 to 2 weeks, and test centres fill up.",
          "After the exam, add your score to your BilimLaunch profile and order the official report for the university.",
        ],
        resources: [TEST_RESOURCE[testName] || RES.ielts],
        estimate: "6-10 weeks",
        priority: "high",
        requirementKey: "language",
        when: { before: 45 },
      });
    }
  }

  for (const item of requirements.filter((r) => r.type === "test")) {
    const name = item.label.toUpperCase();
    add({
      key: `acad.${item.key}`,
      stage: 2,
      title: item.optional ? `Decide whether to take the ${item.label} (optional)` : `Prepare for and take the ${item.label}`,
      why: `${uni} lists: ${item.required}.${item.optional ? " It is marked optional, so check whether a score would help your application." : ""}`,
      steps: item.optional
        ? ["Read how the university uses optional test scores.", "Take a practice test; submit a score only if it strengthens your application.", "If you decide to take it, book a date and follow the steps for a required test."]
        : [
            "Check the test format and which sections count.",
            "Take a practice test, then plan 2 to 3 months of preparation around your weakest sections.",
            "Book the exam so the score reaches the university before the application deadline.",
            "Send the official score report to the university.",
          ],
      resources: [TEST_RESOURCE[name]].filter(Boolean),
      estimate: item.optional ? "1 hour" : "2-3 months",
      priority: item.optional ? "low" : "high",
      requirementKey: item.key,
      when: { before: item.optional ? 60 : 50 },
    });
  }

  /* 3 -- Documents ---------------------------------------------------------- */
  const docs = requirements.filter((r) => r.type === "document");
  const hasKind = (kind) => docs.some((d) => d.kind === kind);
  const graduating = ["4th year", "Graduate"].includes(profile.currentYear);
  const baseline = [];
  if (!hasKind("transcript")) baseline.push({ kind: "transcript" });
  if (!hasKind("passport")) baseline.push({ kind: "passport" });
  if (!hasKind("cv") && ["master", "doctorate", "internship"].includes(degree)) baseline.push({ kind: "cv" });
  if (!hasKind("sop") && ["bachelor", "master", "doctorate"].includes(degree)) baseline.push({ kind: "sop" });
  if (!hasKind("recommendation") && ["master", "doctorate"].includes(degree)) baseline.push({ kind: "recommendation", count: 2 });

  const docItems = [
    ...docs.map((d) => ({ ...d, stated: true })),
    ...baseline.map((b) => ({ ...b, key: `doc.${b.kind}`, label: kindLabel(b.kind), required: "", stated: false, type: "document" })),
  ];
  for (const doc of docItems) {
    const task = documentTask(doc, ctx, { graduating, sourceLinks, field, uni, programLabel });
    if (task) add(task);
  }

  /* 4 -- Application preparation ------------------------------------------- */
  const docList = docItems.filter((d) => d.kind !== "other").map((d) => kindLabel(d.kind));
  add({
    key: "app.portal",
    stage: 4,
    title: "Create your account on the application portal",
    why: "Most universities ask you to apply through their own portal, or through a national system (UCAS, Common App, etc.). An account lets you save a draft and upload files over several days.",
    steps: [
      `Find the “How to apply” page for ${programLabel} on the official site.`,
      "Create an account with an e-mail you check every day and will keep for years.",
      "Save your login details somewhere safe.",
    ],
    resources: sourceLinks,
    estimate: "30 minutes",
    when: { before: 25 },
  });
  add({
    key: "app.form",
    stage: 4,
    title: "Fill in the application form",
    why: "The form asks for personal details, education history and your programme choice. Mistakes here (names, dates, grades) can delay a decision.",
    steps: [
      "Copy your name exactly as written in your passport.",
      "Enter your education history and grades from your transcript.",
      "Choose the programme and the intake you picked in this plan.",
      "Save the draft; do not submit yet.",
    ],
    estimate: "3 hours",
    when: { before: 14 },
  });
  if (degree === "doctorate") {
    add({
      key: "app.supervisor",
      stage: 4,
      title: "Find and contact a potential supervisor",
      why: "For a PhD, a supervisor who agrees to supervise you is usually the most important part of the application.",
      steps: [
        `Search ${uni}'s department pages for researchers working in ${field}.`,
        "Read two or three of their recent papers.",
        "Write a short, specific e-mail: who you are, why their work, what you want to research, CV attached.",
        "Follow up once after 2 weeks if there is no reply.",
      ],
      estimate: "2-3 weeks",
      priority: "high",
      when: { before: 90 },
    });
  }
  add({
    key: "app.fee",
    stage: 4,
    title: "Check the application fee and how to pay",
    why: "Some universities charge a fee and will not review the application until it is paid. Some offer fee waivers.",
    steps: ["Find the fee amount and accepted payment methods on the official site.", "Ask about a fee waiver if the cost is a problem.", "Keep the payment receipt."],
    estimate: "30 minutes",
    when: { before: 7 },
  });
  add({
    key: "app.review",
    stage: 4,
    title: "Check every document against the checklist",
    why: "Missing or wrongly named files are a common reason for delay. One last check saves a lot of trouble.",
    steps: [
      docList.length ? `Tick off: ${[...new Set(docList)].join(", ")}.` : "Tick off every document the university asks for.",
      "Check file formats and size limits (usually PDF).",
      "Ask a friend or mentor to read your statement and CV one more time.",
    ],
    estimate: "1 hour",
    when: { before: 4 },
  });

  /* 5 -- Submission ---------------------------------------------------------- */
  add({
    key: "sub.upload",
    stage: 5,
    title: "Upload your documents",
    why: "Documents must be uploaded before you can submit.",
    steps: ["Upload every file in the order the portal asks.", "Open each uploaded file to check it is readable and complete."],
    estimate: "1 hour",
    when: { before: 2 },
  });
  add({
    key: "sub.submit",
    stage: 5,
    title: `Submit your application by ${longDate(ctx.deadline.date)}`,
    why: "Applications submitted after the deadline are often not considered at all. Do not wait for the last day: portals get slow.",
    steps: ["Review the full application one more time.", "Pay the fee if required.", "Press submit and download or screenshot the confirmation."],
    estimate: "1 hour",
    priority: "high",
    when: { before: 0 },
  });
  add({
    key: "sub.confirm",
    stage: 5,
    title: "Save the confirmation e-mail",
    why: "It is your proof of submission and often contains your applicant ID for later questions.",
    steps: ["Look for the confirmation e-mail (check spam).", "If nothing arrives within 2 days, contact the admissions office with your name and the time you applied.", "Save the e-mail and your applicant ID."],
    estimate: "15 minutes",
    when: { after: 2 },
  });
  add({
    key: "sub.track",
    stage: 5,
    title: "Track your application status",
    why: "Portals sometimes request extra documents after submission. Missing such a request can end your application.",
    steps: ["Log in to the portal every week.", "Reply to any request for more information within 2 days."],
    estimate: "10 minutes a week",
    when: { after: 14 },
  });

  /* 6 -- Interview & decision --------------------------------------------- */
  const programText = walkStrings([program.requirements, program.notes, program.key_deadlines]).join(" ");
  if (MENTIONS_INTERVIEW.test(programText)) {
    add({
      key: "int.prepare",
      stage: 6,
      title: "Prepare for the admission interview",
      why: "The university's pages mention an interview. Preparation is the difference between a nervous interview and a good one.",
      steps: [
        `Re-read your application and be ready to talk about every line of it, especially ${field}.`,
        "Prepare short answers: why this programme, why this university, your goals, a project you are proud of.",
        "Practise aloud with a friend, or ask the assistant to run a mock interview.",
        "Test your camera, microphone and internet if it is online.",
      ],
      estimate: "1 week",
      priority: "high",
      when: { after: 25 },
    });
  }
  add({
    key: "dec.wait",
    stage: 6,
    title: "Wait for the admission decision",
    why: "Decisions can take several weeks. Keep going with scholarship and visa preparation meanwhile, and keep checking the portal and your e-mail.",
    steps: ["Check the portal weekly.", "Prepare your visa documents in the meantime where you can.", "Ask the admissions office politely if the published decision date has passed."],
    estimate: "4-12 weeks (varies)",
    when: { after: 45 },
  });
  add({
    key: "dec.offer",
    stage: 6,
    title: "Receive and accept your offer",
    why: "An offer usually has to be accepted by a deadline, sometimes with a deposit. It is also the document you need for the visa.",
    steps: ["Read the offer and its conditions (for example final grades or an English test).", "Accept it before the stated deadline.", "Pay the deposit if requested and save the offer letter."],
    estimate: "1 hour",
    priority: "high",
    when: { after: 60 },
  });

  /* 7 -- Scholarships & money ---------------------------------------------- */
  const scholarships = (program.scholarships || []).filter((s) => s && s.name).slice(0, 3);
  const tuition = program.tuition || {};
  const intl = tuition.international || tuition.domestic_or_home || "";
  add({
    key: "fin.research",
    stage: 7,
    title: scholarships.length ? `Review the scholarships listed by ${uni}` : "Research scholarships you can apply for",
    why: scholarships.length
      ? `${uni}'s pages list: ${scholarships.map((s) => s.name).join("; ")}.`
      : `No scholarships were found on the pages we read for ${uni}. External scholarships and government programmes may still apply.`,
    steps: [
      scholarships.length ? "Open each scholarship and check eligibility, amount and its own deadline (it is often earlier than the application deadline)." : "Search the university's funding pages and your country's government scholarship programmes.",
      profile.country === "Kazakhstan" ? "Check the Bolashak international scholarship and any scholarships for students from Kazakhstan." : "Check scholarships from your own country's government or foundations.",
      "Make a table: scholarship, eligibility, deadline, documents needed.",
    ],
    resources: sourceLinks,
    estimate: "3 hours",
    when: { before: 100 },
  });
  scholarships.forEach((s, i) => {
    add({
      key: `fin.scholarship.${i}`,
      stage: 7,
      title: `Apply for: ${String(s.name).slice(0, 80)}`,
      why: [s.eligibility && `Eligibility: ${s.eligibility}`, s.amount && `Amount: ${s.amount}`, s.deadline && `Deadline: ${s.deadline}`].filter(Boolean).join(". ") || "Details are on the official page; confirm them there.",
      steps: ["Confirm you meet the eligibility conditions.", "Collect any extra documents the scholarship asks for.", "Submit before its own deadline (it may differ from the application deadline)."],
      resources: sourceLinks,
      estimate: "1 week",
      when: { before: 7 },
    });
  });
  add({
    key: "fin.budget",
    stage: 7,
    title: "Calculate tuition and living costs",
    why: intl ? `The university's pages state tuition of: ${String(intl).slice(0, 200)}.` : "Tuition was not stated on the pages we read, so find it on the official site.",
    steps: ["Write down tuition for the full programme, per year.", "Estimate rent, food, transport, insurance and books for the city.", "Subtract scholarships; the rest is what your family or you must cover."],
    estimate: "2 hours",
    when: { before: 90 },
  });
  if (abroad) {
    add({
      key: "fin.funds",
      stage: 7,
      title: "Prepare proof of funds",
      why: "Student visas and some universities ask you to show that you can pay for tuition and living costs.",
      steps: ["Check on the visa or university page how much money you need to show, and for how long it must be in the account.", "Collect bank statements and, if a sponsor pays, a sponsor letter and their documents.", "Keep originals and translated copies if the statements are not in English."],
      estimate: "1-2 weeks",
      when: { beforeIntake: 130 },
    });
  }

  /* 8 -- Visa & accommodation ------------------------------------------------ */
  if (abroad) {
    add({
      key: "visa.check",
      stage: 8,
      title: `Check student visa requirements for ${university.country}`,
      why: `You live in ${profile.country || "another country"} and would study in ${university.country}, so you probably need a visa or study permit.`,
      steps: ["Open the official government immigration site of the destination country.", "Note the required documents, fees, processing time and where to apply.", "Check whether you must book a biometrics appointment."],
      estimate: "1 hour",
      when: { beforeIntake: 150 },
    });
    add({
      key: "visa.apply",
      stage: 8,
      title: "Submit your student visa application",
      why: "Processing can take weeks or months, and you can usually only apply after you have an offer.",
      steps: ["Gather the offer letter, passport, proof of funds and any other documents.", "Fill in the visa application and pay the fee.", "Book and attend the appointment.", "Track the application and keep copies of everything."],
      estimate: "2-4 weeks",
      priority: "high",
      when: { beforeIntake: 90 },
    });
  }
  add({
    key: "acc.find",
    stage: 8,
    title: "Find accommodation",
    why: "University housing often has early deadlines and limited places.",
    steps: ["Check the university's housing page for deadlines and how to apply.", "If you go private, compare areas by distance, price and safety, and avoid paying before you have seen a contract.", "Confirm where you will stay for the first nights."],
    estimate: "1-2 weeks",
    when: { beforeIntake: 75 },
  });
  if (abroad) {
    add({
      key: "acc.insurance",
      stage: 8,
      title: "Arrange medical insurance",
      why: "Many countries require health insurance for international students, and some visas depend on it.",
      steps: ["Check what the university or visa requires.", "Compare university-offered and private plans.", "Save your policy documents."],
      estimate: "2 hours",
      when: { beforeIntake: 45 },
    });
  }

  /* 9 -- Pre-departure & enrollment ----------------------------------------- */
  if (abroad) {
    add({
      key: "pre.tickets",
      stage: 9,
      title: "Book your flight",
      why: "Prices rise close to the start date, and you will want to arrive a few days before orientation.",
      steps: ["Confirm your arrival date with the university and your accommodation.", "Compare fares and baggage rules.", "Book once your visa is approved if tickets are not refundable."],
      estimate: "1 hour",
      when: { beforeIntake: 35 },
    });
  }
  add({
    key: "pre.pack",
    stage: 9,
    title: "Prepare what you need to take",
    why: "Some documents must be in your hand luggage on arrival.",
    steps: ["Put the passport, visa, offer letter, insurance and accommodation confirmation in one folder.", "Pack for the climate and check the baggage limits.", "Notify your bank that you will use your card abroad."],
    estimate: "1 week",
    when: { beforeIntake: 14 },
  });
  add({
    key: "pre.enrol",
    stage: 9,
    title: "Register at the university",
    why: "Enrolment is the final step that makes you a student: it often must be done online before you arrive.",
    steps: ["Follow the enrolment instructions in your offer.", "Register for modules and activate your student account and e-mail.", "Pay tuition or arrange the instalments."],
    estimate: "2 hours",
    priority: "high",
    when: { beforeIntake: 10 },
  });
  add({
    key: "pre.orientation",
    stage: 9,
    title: "Attend orientation week",
    why: "It is the easiest way to meet people, find your way around and learn how things work.",
    steps: ["Find the orientation schedule on the university site.", "Attend the sessions for new international students.", "Join one club or society."],
    estimate: "1 week",
    when: { beforeIntake: 3 },
  });
  add({
    key: "pre.start",
    stage: 9,
    title: "Start your studies",
    why: "You made it.",
    steps: ["Check your timetable.", "Meet your academic advisor.", "Set up a study routine from the first week."],
    estimate: "",
    when: { beforeIntake: 0 },
  });

  return tasks;
}

function degreeNoun(degree) {
  return { bachelor: "bachelor's", master: "master's", doctorate: "PhD", exchange: "exchange", internship: "internship" }[degree] || degree;
}

function kindLabel(kind) {
  return (
    {
      transcript: "Transcript of records",
      diploma: "Diploma or graduation certificate",
      cv: "CV",
      sop: "Statement of purpose",
      recommendation: "Recommendation letters",
      passport: "Passport",
      portfolio: "Portfolio",
      financial: "Financial documents",
      proposal: "Research proposal",
    }[kind] || "Document"
  );
}

const COMMON = "Commonly required; it was not listed on the pages we read, so confirm on the official site.";

function documentTask(doc, ctx, { graduating, sourceLinks, field, uni, programLabel }) {
  const note = doc.stated ? `${uni} lists this: “${doc.required}”.` : COMMON;
  const base = { stage: 3, requirementKey: doc.stated ? doc.key : undefined };
  switch (doc.kind) {
    case "transcript":
      return {
        ...base,
        key: "docs.transcript",
        title: "Request your official transcript of records",
        why: `${note} It proves the courses and grades behind your GPA.`,
        steps: ["Ask your registrar's office for an official transcript, in English if the university requires it.", "Ask whether it needs a stamp, signature or a sealed envelope.", "Request a few extra copies, and a certified translation if needed.", "Scan it as a clear PDF."],
        estimate: "1-2 weeks",
        priority: "high",
        when: { before: 60 },
      };
    case "diploma":
      return {
        ...base,
        key: "docs.diploma",
        title: graduating ? "Prepare your diploma or graduation certificate" : "Get a document confirming your current studies",
        why: `${note} ${graduating ? "" : "You have not graduated yet, so ask the university what it accepts instead (usually an enrolment certificate)."}`.trim(),
        steps: graduating
          ? ["Find your diploma or ask your university for a certificate of graduation.", "Get a certified English translation if it is in another language.", "Scan it as a clear PDF."]
          : ["Ask your registrar for an enrolment certificate stating your expected graduation date.", "Ask the target university if it will accept it until you graduate.", "Scan it as a clear PDF."],
        estimate: "1-2 weeks",
        when: { before: 55 },
      };
    case "cv":
      return {
        ...base,
        key: "docs.cv",
        title: "Prepare your CV",
        why: `${note} A CV shows your academic and professional experience in one or two pages. Admissions staff often read it first.`,
        steps: [
          "Write your education: university, field, years and GPA.",
          `Add your projects, research or volunteering related to ${field}.`,
          "List your work experience, skills, languages and test scores.",
          "Proofread, keep it to 1-2 pages and save it as a PDF.",
        ],
        resources: [RES.europass, RES.owl],
        estimate: "3 hours",
        priority: "high",
        when: { before: 50 },
      };
    case "sop":
      return {
        ...base,
        key: "docs.sop",
        title: "Write your Statement of Purpose",
        why: `${note} It is where you explain why you want this programme and why they should choose you.`,
        steps: [
          "Write down your goals and the specific reasons for this programme and university.",
          "Draft 4 short paragraphs: your background, your goal, why this programme, what you will contribute.",
          "Have someone you trust read it and give you honest feedback.",
          "Revise it, check the word limit and save it as a PDF.",
        ],
        resources: [link("BilimLaunch motivation letter writer", `letter.html?school=${encodeURIComponent(ctx.university.slug)}&degree=${encodeURIComponent(ctx.degree)}`)],
        estimate: "5 days",
        priority: "high",
        when: { before: 28 },
      };
    case "recommendation": {
      const n = doc.count || 2;
      return {
        ...base,
        key: "docs.recommendation",
        title: n === 1 ? "Request a recommendation letter" : `Request ${n} recommendation letters`,
        why: `${note} Letters from teachers or supervisors who know your work well make a strong difference.`,
        steps: [
          `Choose ${n} ${n === 1 ? "person" : "people"} who know your work: a professor, a thesis supervisor or an employer.`,
          "Ask them politely at least 4 weeks before the deadline.",
          "Send them your CV, your statement and a list of what to mention, plus the deadline and how the university collects letters.",
          "Remind them a week before the deadline.",
        ],
        estimate: "2-4 weeks",
        priority: "high",
        when: { before: 40 },
      };
    }
    case "passport":
      return {
        ...base,
        key: "docs.passport",
        title: "Check that your passport is valid",
        why: `${note} A passport is also needed for the visa; it normally has to be valid for at least 6 months after your course starts.`,
        steps: ["Check the expiry date.", "If it expires within a year of your start date, renew it now.", "Scan the photo page as a PDF."],
        estimate: "1 day (renewal: up to a few weeks)",
        when: { before: 60 },
      };
    case "portfolio":
      return {
        ...base,
        key: "docs.portfolio",
        title: "Prepare your portfolio",
        why: note,
        steps: ["Read the university's portfolio guidelines (number of pieces, format, size).", "Choose your strongest, most relevant work.", "Add a one-line description to each piece.", "Export it in the requested format."],
        resources: sourceLinks,
        estimate: "2-3 weeks",
        when: { before: 30 },
      };
    case "proposal":
      return {
        ...base,
        key: "docs.proposal",
        title: "Write your research proposal",
        why: `${note} It shows what you want to research and that you can plan a project.`,
        steps: ["Choose a narrow research question in your field.", "Read recent papers and note the gap your question fills.", "Write: question, background, method, timeline.", "Ask a supervisor or mentor for feedback."],
        estimate: "3-4 weeks",
        priority: "high",
        when: { before: 35 },
      };
    case "financial":
      return {
        ...base,
        key: "docs.financial",
        title: "Prepare your financial documents",
        why: note,
        steps: ["Check exactly what the university wants (bank statements, sponsor letter...).", "Collect the documents and make sure the dates fit their rules.", "Scan them as PDFs."],
        estimate: "1-2 weeks",
        when: { before: 35 },
      };
    default:
      return {
        ...base,
        key: doc.key.startsWith("doc.") ? `docs.${doc.key.slice(4)}` : `docs.${doc.key}`,
        title: `Prepare: ${doc.label}`,
        why: note,
        steps: [`Read what the university expects for “${doc.label}” on its official page.`, "Prepare the document and have it checked.", "Save it as a clear PDF."],
        resources: sourceLinks,
        estimate: "1 week",
        when: { before: 35 },
      };
  }
}

/* ------------------------------------------------------------ scheduling -- */

const SPAN = 150; // the longest "before the deadline" lead time used above

/**
 * Gives every task a due date. Lead times are measured back from the
 * application deadline (or forward from it, or back from the start date).
 * When the deadline is close, all lead times are squeezed so that every
 * task still falls between today and the deadline.
 */
function schedule(tasks, { today, deadline, intake }) {
  const available = Math.max(diffDays(deadline, today), 1);
  const scale = Math.min(1, Math.max(0.2, available / SPAN));
  const clampToIntake = (d) => (d > intake ? intake : d);

  return tasks.map((task) => {
    const w = task.when || { before: 0 };
    let due;
    if (w.before != null) {
      due = addDays(deadline, -Math.round(w.before * scale));
      const earliest = addDays(today, Math.min(2, available));
      if (due < earliest) due = earliest;
    } else if (w.after != null) {
      due = clampToIntake(addDays(deadline, w.after));
    } else {
      due = addDays(intake, -w.beforeIntake);
      const afterSubmit = clampToIntake(addDays(deadline, 10));
      if (due < afterSubmit) due = afterSubmit;
      if (due > intake) due = intake;
    }
    return { ...task, dueDate: due };
  });
}

/** Everything the plan needs: requirements -> tasks with dates. */
function planRoadmap(ctx, today) {
  const intake = ctx.intake;
  const deadline = ctx.deadline.date;
  const tasks = schedule(buildTasks(ctx), { today, deadline, intake });
  tasks.forEach((t, i) => (t.position = i));
  return tasks;
}

/** Whether `stage` is open given a map stage -> { total, done }. Returns { locked, reason }. */
function lockState(stage, counts) {
  const needs = LOCKS[stage] || [];
  const open = needs.filter((n) => counts[n] && counts[n].done < counts[n].total);
  if (!open.length) return { locked: false, reason: "" };
  return { locked: true, reason: `Locked until stage ${open.map((n) => `${n}. ${STAGES[n - 1].title}`).join(" and ")} ${open.length > 1 ? "are" : "is"} done.` };
}

module.exports = {
  STAGES,
  LOCKS,
  SEASONS,
  intakeDate,
  submissionDeadline,
  findDeadline,
  planRoadmap,
  lockState,
  todayIso,
  longDate,
  addDays,
  diffDays,
};
