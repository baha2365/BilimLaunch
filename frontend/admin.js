/*
 * BilimLaunch admin panel. Edits existing universities only (new ones come
 * from data/universities.json). Everything is saved through /api/admin/*
 * into MongoDB. Unsaved edits are kept per degree tab while you switch.
 */
(function () {
  const DEGREES = [
    ["bachelor", "Bachelor's"],
    ["master", "Master's"],
    ["doctorate", "PhD"],
    ["exchange", "Exchange"],
  ];
  const $ = (id) => document.getElementById(id);
  const lines = (id) => $(id).value;
  const toLines = (arr) => (Array.isArray(arr) ? arr.join("\n") : "");

  let universities = [];
  let current = null; // { config, programs }
  let slug = null;
  let degree = "bachelor";
  const drafts = {}; // degree -> form values not yet saved

  function token() {
    try {
      return sessionStorage.getItem("bilimlaunch:adminToken") || "";
    } catch (_) {
      return "";
    }
  }

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token()) headers["x-admin-token"] = token();
    const res = await fetch(`/api/admin${path}`, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) $("tokenBox").hidden = false;
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  function status(message, isError) {
    const el = $("adminStatus");
    el.textContent = message;
    el.classList.toggle("is-visible", !!message);
    el.classList.toggle("is-error", !!isError);
  }

  /* ---------------- sidebar ---------------- */

  function renderList() {
    const q = $("uniSearch").value.trim().toLowerCase();
    const ul = $("uniList");
    ul.innerHTML = "";
    universities
      .filter((u) => !q || `${u.name} ${u.country}`.toLowerCase().includes(q))
      .forEach((u) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "admin-list__item" + (u.slug === slug ? " is-active" : "");
        const name = document.createElement("strong");
        name.textContent = u.name;
        const sub = document.createElement("span");
        const parts = DEGREES.map(([d, label]) => {
          const s = u.status[d];
          return s ? `${label[0] === "B" ? "B" : label[0]}${s.manual ? "✓" : "·"}` : "";
        }).filter(Boolean);
        sub.textContent = `${u.country || ""}${parts.length ? " — " + parts.join(" ") : " — no data"}`;
        btn.append(name, sub);
        btn.addEventListener("click", () => openUniversity(u.slug));
        li.appendChild(btn);
        ul.appendChild(li);
      });
  }

  async function loadList() {
    try {
      universities = await api("/universities");
      $("tokenBox").hidden = true;
      renderList();
    } catch (err) {
      status(err.message, true);
    }
  }

  /* ---------------- config form ---------------- */

  function buildUrlGrid(config) {
    const grid = $("urlGrid");
    grid.innerHTML = "";
    for (const [kind, label] of [["sourceUrls", "Admissions pages"], ["fieldUrls", "Programme list pages"]]) {
      for (const [d, dLabel] of DEGREES) {
        const wrap = document.createElement("div");
        wrap.className = "field";
        const lab = document.createElement("label");
        lab.textContent = `${label} — ${dLabel}`;
        const ta = document.createElement("textarea");
        ta.rows = 2;
        ta.id = `u_${kind}_${d}`;
        ta.value = toLines(config[kind] && config[kind][d]);
        wrap.append(lab, ta);
        grid.appendChild(wrap);
      }
    }
  }

  function fillConfig(config) {
    for (const key of ["name", "shortName", "country", "city", "officialSite"]) $(`c_${key}`).value = config[key] || "";
    buildUrlGrid(config);
    $("edTitle").textContent = config.name;
  }

  function collectConfig() {
    const out = { sourceUrls: {}, fieldUrls: {} };
    for (const key of ["name", "shortName", "country", "city", "officialSite"]) out[key] = $(`c_${key}`).value;
    for (const [d] of DEGREES) {
      out.sourceUrls[d] = $(`u_sourceUrls_${d}`).value.split("\n");
      out.fieldUrls[d] = $(`u_fieldUrls_${d}`).value.split("\n");
    }
    return out;
  }

  /* ---------------- program form ---------------- */

  function addScholarshipRow(s = {}) {
    const row = document.createElement("div");
    row.className = "admin-sch";
    const make = (ph, key, cls) => {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = ph;
      input.dataset.key = key;
      input.value = s[key] || "";
      if (cls) input.className = cls;
      return input;
    };
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "btn btn-secondary btn-small";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => row.remove());
    row.append(make("Name", "name"), make("Amount", "amount"), make("Eligibility", "eligibility"), make("Deadline", "deadline"), rm);
    $("schList").appendChild(row);
  }

  function collectProgram() {
    const scholarships = [...$("schList").querySelectorAll(".admin-sch")].map((row) => {
      const o = {};
      row.querySelectorAll("input").forEach((i) => (o[i.dataset.key] = i.value));
      return o;
    });
    return {
      tuition: { domestic_or_home: $("p_domestic").value, international: $("p_international").value, notes: $("p_tuitionNotes").value },
      requirements: {
        minimum_gpa: $("p_gpa").value,
        language_tests: lines("p_language").split("\n"),
        standardized_tests: lines("p_standardized").split("\n"),
        required_documents: lines("p_documents").split("\n"),
        other: $("p_other").value,
      },
      scholarships,
      financial_aid_summary: $("p_aid").value,
      key_deadlines: lines("p_deadlines").split("\n"),
      notes: $("p_notes").value,
      fields_of_study: lines("p_fields").split("\n"),
      sources: lines("p_sources").split("\n"),
      manual: $("p_locked").checked,
    };
  }

  function fillProgram(p) {
    p = p || {};
    const t = p.tuition || {};
    const r = p.requirements || {};
    $("p_domestic").value = t.domestic_or_home || "";
    $("p_international").value = t.international || "";
    $("p_tuitionNotes").value = t.notes || "";
    $("p_gpa").value = r.minimum_gpa || "";
    $("p_language").value = toLines(r.language_tests);
    $("p_standardized").value = toLines(r.standardized_tests);
    $("p_documents").value = toLines(r.required_documents);
    $("p_other").value = r.other || "";
    $("p_aid").value = p.financial_aid_summary || "";
    $("schList").innerHTML = "";
    (p.scholarships || []).forEach(addScholarshipRow);
    $("p_deadlines").value = toLines(p.key_deadlines);
    $("p_notes").value = p.notes || "";
    $("p_fields").value = toLines(p.fields_of_study);
    $("p_sources").value = toLines(p.sources);
    $("p_locked").checked = p.manual !== false;
    updateFieldCount();
  }

  function updateFieldCount() {
    const n = new Set($("p_fields").value.split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean)).size;
    $("fieldCount").textContent = n ? `(${n})` : "";
  }

  function renderTabs() {
    const wrap = $("adminTabs");
    wrap.innerHTML = "";
    DEGREES.forEach(([d, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "degree-tab" + (d === degree ? " is-active" : "");
      const p = current.programs[d];
      b.textContent = label + (p && p.generated_at ? (p.manual ? " ✓" : " •") : "");
      b.addEventListener("click", () => switchDegree(d));
      wrap.appendChild(b);
    });
  }

  function describe(p) {
    if (!p || !p.generated_at) return "No data yet for this degree level. Fill it in and save.";
    const when = new Date(p.edited_at || p.generated_at).toLocaleString();
    return p.manual ? `Entered by an admin — ${when}` : `Collected automatically (${p.model || "scraper"}) — ${when}. Saving turns it into admin-entered data.`;
  }

  function showDegree() {
    const label = DEGREES.find(([d]) => d === degree)[1];
    $("progTitle").textContent = `${label} programme`;
    const base = current.programs[degree];
    $("progStatus").textContent = describe(base);
    fillProgram(drafts[degree] || base);
    $("progSaved").textContent = drafts[degree] ? "Unsaved changes" : "";
    renderTabs();
  }

  function switchDegree(d) {
    drafts[degree] = collectProgram(); // keep unsaved work
    degree = d;
    showDegree();
  }

  async function openUniversity(s) {
    const dirty = Object.keys(drafts).length > 0 || $("progSaved").textContent === "Unsaved changes";
    if (slug && dirty && !confirm("Switch university? Unsaved edits will be lost.")) return;
    try {
      current = await api(`/universities/${encodeURIComponent(s)}`);
      slug = s;
      Object.keys(drafts).forEach((k) => delete drafts[k]);
      degree = "bachelor";
      $("emptyHint").hidden = true;
      $("editor").hidden = false;
      status("", false);
      fillConfig(current.config);
      showDegree();
      renderList();
    } catch (err) {
      status(err.message, true);
    }
  }

  /* ---------------- saving ---------------- */

  async function saveConfig() {
    try {
      await api(`/universities/${encodeURIComponent(slug)}/config`, { method: "PUT", body: JSON.stringify(collectConfig()) });
      $("configSaved").textContent = "Saved";
      $("edTitle").textContent = $("c_name").value;
      await loadList();
    } catch (err) {
      status(err.message, true);
    }
  }

  async function saveProgram() {
    try {
      const { program } = await api(`/universities/${encodeURIComponent(slug)}/programs/${degree}`, {
        method: "PUT",
        body: JSON.stringify(collectProgram()),
      });
      current.programs[degree] = program;
      delete drafts[degree];
      showDegree();
      $("progSaved").textContent = "Saved to MongoDB";
      status("", false);
      await loadList();
    } catch (err) {
      status(err.message, true);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("uniSearch").addEventListener("input", renderList);
    $("p_fields").addEventListener("input", updateFieldCount);
    $("addSchBtn").addEventListener("click", () => addScholarshipRow());
    $("saveConfigBtn").addEventListener("click", saveConfig);
    $("saveProgBtn").addEventListener("click", saveProgram);
    $("tokenBtn").addEventListener("click", () => {
      try {
        sessionStorage.setItem("bilimlaunch:adminToken", $("tokenInput").value);
      } catch (_) {}
      loadList();
    });
    document.querySelectorAll("#programForm input, #programForm textarea").forEach((el) =>
      el.addEventListener("input", () => ($("progSaved").textContent = "Unsaved changes"))
    );
    loadList();
  });
})();