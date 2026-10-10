/**
 * Admin API -- lets admins edit existing universities by hand.
 *
 *   GET  /api/admin/universities                       list + per-degree status
 *   GET  /api/admin/universities/:slug                 config + all programs
 *   PUT  /api/admin/universities/:slug/config          name, location, URLs...
 *   PUT  /api/admin/universities/:slug/programs/:degree  one degree level's data
 *
 * New universities are NOT created here -- they come from data/universities.json
 * via `npm run seed`. Everything saved is validated and length-capped, then
 * stored in MongoDB: config in universities_init, programs in universities_info.
 *
 * Access (no login system yet): if ADMIN_TOKEN is set in .env, requests must
 * send it in the `x-admin-token` header; if it isn't set, only requests from
 * this machine (localhost) are accepted.
 */
const express = require("express");
const crypto = require("crypto");

const MAX_TEXT = 3000;
const MAX_ITEM = 400;

function text(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullable(value, max = MAX_TEXT) {
  const t = text(value, max);
  return t || null;
}

function list(value, maxItems = 100, maxLen = MAX_ITEM) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : [];
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const t = text(raw, maxLen).replace(/\s+/g, " ");
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
    if (out.length >= maxItems) break;
  }
  return out;
}

function urls(value) {
  return list(value, 30, 500).filter((u) => /^https?:\/\/\S+$/i.test(u));
}

function sanitizeConfig(body, degrees) {
  const out = {};
  for (const key of ["name", "shortName", "country", "city"]) {
    if (typeof body[key] === "string") out[key] = text(body[key], 200);
  }
  if (!out.name && "name" in out) throw new Error("Name can't be empty.");
  if (typeof body.officialSite === "string") {
    const site = text(body.officialSite, 500);
    if (site && !/^https?:\/\/\S+$/i.test(site)) throw new Error("Official site must start with http:// or https://");
    out.officialSite = site;
  }
  for (const key of ["sourceUrls", "fieldUrls"]) {
    if (body[key] && typeof body[key] === "object") {
      out[key] = {};
      for (const d of degrees) out[key][d] = urls(body[key][d]);
    }
  }
  return out;
}

function sanitizeProgram(body, degree) {
  const tuition = body.tuition || {};
  const req = body.requirements || {};
  const scholarships = (Array.isArray(body.scholarships) ? body.scholarships : [])
    .slice(0, 100)
    .map((s) => ({
      name: text(s && s.name, 200),
      eligibility: text(s && s.eligibility, 1000),
      amount: text(s && s.amount, 300),
      deadline: nullable(s && s.deadline, 200),
    }))
    .filter((s) => s.name);

  return {
    degree,
    tuition: {
      domestic_or_home: nullable(tuition.domestic_or_home, 500),
      international: nullable(tuition.international, 500),
      notes: nullable(tuition.notes),
    },
    requirements: {
      minimum_gpa: nullable(req.minimum_gpa, 200),
      language_tests: list(req.language_tests),
      standardized_tests: list(req.standardized_tests),
      required_documents: list(req.required_documents),
      other: nullable(req.other),
    },
    scholarships,
    financial_aid_summary: text(body.financial_aid_summary),
    key_deadlines: list(body.key_deadlines),
    notes: text(body.notes),
    fields_of_study: list(body.fields_of_study, 600, 120),
    sources: urls(body.sources),
    manual: body.manual !== false, // locked from automatic scraping unless the admin unticks it
  };
}

function guard(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (token) {
    const sent = String(req.get("x-admin-token") || "");
    const a = Buffer.from(sent);
    const b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    return res.status(401).json({ error: "Admin token required." });
  }
  const ip = req.socket.remoteAddress || "";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return next();
  return res.status(403).json({ error: "The admin panel is only available from the server machine. Set ADMIN_TOKEN in .env to use it remotely." });
}

function createAdminRouter(db, DEGREES) {
  const router = express.Router();
  router.use(guard);

  router.get("/universities", async (_req, res) => {
    try {
      const { init, info } = await db.connect();
      const [configs, infos] = await Promise.all([init.find({}).toArray(), info.find({}).toArray()]);
      const bySlug = new Map(infos.map((d) => [d.slug, d.programs || {}]));
      res.json(
        configs
          .map((c) => {
            const programs = bySlug.get(c.slug) || {};
            const status = {};
            for (const d of DEGREES) {
              const p = programs[d];
              status[d] = p && p.generated_at ? { manual: !!p.manual, fields: (p.fields_of_study || []).length } : null;
            }
            return { slug: c.slug, name: c.name, country: c.country, status };
          })
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      );
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get("/universities/:slug", async (req, res) => {
    try {
      const { init, info } = await db.connect();
      const config = await init.findOne({ slug: req.params.slug });
      if (!config) return res.status(404).json({ error: "Unknown university." });
      const doc = await info.findOne({ slug: req.params.slug });
      const { _id, ...rest } = config;
      res.json({ config: rest, programs: (doc && doc.programs) || {} });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.put("/universities/:slug/config", async (req, res) => {
    try {
      const update = sanitizeConfig(req.body || {}, DEGREES);
      const { init } = await db.connect();
      const result = await init.updateOne(
        { slug: req.params.slug },
        { $set: { ...update, admin_edited: true, admin_edited_at: new Date().toISOString() } }
      );
      if (!result.matchedCount) return res.status(404).json({ error: "Unknown university." });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put("/universities/:slug/programs/:degree", async (req, res) => {
    const { slug, degree } = req.params;
    if (!DEGREES.includes(degree)) return res.status(400).json({ error: `Unknown degree level '${degree}'` });
    try {
      const { init, info } = await db.connect();
      if (!(await init.findOne({ slug }))) return res.status(404).json({ error: "Unknown university." });
      const now = new Date().toISOString();
      const program = {
        ...sanitizeProgram(req.body || {}, degree),
        generated_at: now,
        edited_at: now,
        model: "manual",
        fields_sources: [],
      };
      await info.updateOne({ slug }, { $set: { slug, [`programs.${degree}`]: program } }, { upsert: true });
      res.json({ ok: true, program });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter, sanitizeProgram, sanitizeConfig };