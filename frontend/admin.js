/*
 * BilimLaunch admin panel. Adds new universities and edits existing ones.
 * Everything is saved through /api/admin/* into MongoDB. Unsaved edits are
 * kept per degree tab while you switch.
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
    if (message) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---------------- sidebar ---------------- */

  // Static markup (no user data), so innerHTML is safe here.
  const TRASH_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  function renderList() {
    const q = $("uniSearch").value.trim().toLowerCase();
    const ul = $("uniList");
    ul.innerHTML = "";
    universities
      .filter((u) => !q || `${u.name} ${u.country}`.toLowerCase().includes(q))
      .forEach((u) => {
        const li = document.createElement("li");
        li.className = "admin-row";

        const del = document.createElement("button");
        del.type = "button";
        del.className = "admin-del";
        del.title = `Delete ${u.name}`;
        del.setAttribute("aria-label", `Delete ${u.name}`);
        del.innerHTML = TRASH_ICON;
        del.addEventListener("click", () => deleteUniversity(u));
        li.appendChild(del);

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
      $("uniCount").textContent = `${universities.length} ${universities.length === 1 ? "university" : "universities"}`;
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

  function hasUnsavedEdits() {
    return !!slug && (Object.keys(drafts).length > 0 || $("progSaved").textContent === "Unsaved changes");
  }

  async function openUniversity(s) {
    if (hasUnsavedEdits() && !confirm("Switch university? Unsaved edits will be lost.")) return;
    try {
      current = await api(`/universities/${encodeURIComponent(s)}`);
      slug = s;
      Object.keys(drafts).forEach((k) => delete drafts[k]);
      degree = "bachelor";
      $("emptyHint").hidden = true;
      $("newUni").hidden = true;
      $("editor").hidden = false;
      status("", false);
      fillConfig(current.config);
      showDegree();
      renderList();
    } catch (err) {
      status(err.message, true);
    }
  }

  /* ---------------- removing a university ---------------- */

  async function deleteUniversity(u) {
    const ok = confirm(
      `Delete "${u.name}"?\n\n` +
        "This permanently removes the university and all information saved for it " +
        "(every degree level) from the database. This can't be undone."
    );
    if (!ok) return;
    try {
      await api(`/universities/${encodeURIComponent(u.slug)}`, { method: "DELETE" });
      if (slug === u.slug) {
        // The university being edited is gone: close its editor.
        slug = null;
        current = null;
        Object.keys(drafts).forEach((k) => delete drafts[k]);
        $("editor").hidden = true;
        $("emptyHint").hidden = false;
      }
      await loadList();
      status(`Deleted "${u.name}".`, false);
    } catch (err) {
      status(`"${u.name}" was not deleted: ${err.message}`, true);
    }
  }

  /* ---------------- adding a university ---------------- */

  const NEW_FIELDS = ["name", "shortName", "country", "city", "officialSite", "slug"];
  let slugTouched = false; // true once the admin types their own ID

  // Mirrors slugify() in server/admin.js so the ID preview matches what the server makes.
  function slugify(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "");
  }

  function showAddForm() {
    if (hasUnsavedEdits() && !confirm("Leave this university? Unsaved edits will be lost.")) return;
    slug = null;
    current = null;
    Object.keys(drafts).forEach((k) => delete drafts[k]);
    for (const f of NEW_FIELDS) $(`n_${f}`).value = "";
    slugTouched = false;
    $("emptyHint").hidden = true;
    $("editor").hidden = true;
    $("newUni").hidden = false;
    $("createUniBtn").disabled = false;
    status("", false);
    renderList();
    $("n_name").focus();
  }

  function hideAddForm() {
    $("newUni").hidden = true;
    if (!slug) $("emptyHint").hidden = false;
    status("", false);
  }

  async function createUniversity() {
    const body = {};
    for (const f of NEW_FIELDS) body[f] = $(`n_${f}`).value;
    if (!body.name.trim()) return status("Enter the university's name.", true), $("n_name").focus();
    if (!body.country.trim()) return status("Enter the country.", true), $("n_country").focus();

    const btn = $("createUniBtn");
    btn.disabled = true;
    try {
      const created = await api("/universities", { method: "POST", body: JSON.stringify(body) });
      await loadList();
      await openUniversity(created.slug); // straight into the editor to fill in the rest
      if (slug === created.slug) {
        status(`Created "${created.config.name}" in ${created.saved_to}. Add its details and each degree level below, then save.`, false);
      } else {
        status(`Created "${created.config.name}", but it could not be opened. Pick it in the list.`, true);
      }
    } catch (err) {
      status(`University was not created: ${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- saving ---------------- */

  async function saveConfig() {
    try {
      await api(`/universities/${encodeURIComponent(slug)}/config`, { method: "PUT", body: JSON.stringify(collectConfig()) });
      $("configSaved").textContent = `Saved to MongoDB at ${new Date().toLocaleTimeString()}`;
      status("", false);
      $("edTitle").textContent = $("c_name").value;
      await loadList();
    } catch (err) {
      $("configSaved").textContent = "NOT saved";
      status(`Details were not saved: ${err.message}`, true);
    }
  }

  async function saveProgram() {
    try {
      const { program, saved_to, action } = await api(`/universities/${encodeURIComponent(slug)}/programs/${degree}`, {
        method: "PUT",
        body: JSON.stringify(collectProgram()),
      });
      current.programs[degree] = program;
      delete drafts[degree];
      showDegree();
      $("progSaved").textContent = `Saved at ${new Date().toLocaleTimeString()} — ${action || "ok"} in ${saved_to || "MongoDB"}`;
      status("", false);
      await loadList();
    } catch (err) {
      $("progSaved").textContent = "NOT saved";
      status(`This degree level was not saved: ${err.message}`, true);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("uniSearch").addEventListener("input", renderList);
    $("p_fields").addEventListener("input", updateFieldCount);
    $("addSchBtn").addEventListener("click", () => addScholarshipRow());
    $("saveConfigBtn").addEventListener("click", saveConfig);
    $("saveProgBtn").addEventListener("click", saveProgram);
    $("addUniBtn").addEventListener("click", showAddForm);
    $("cancelNewBtn").addEventListener("click", hideAddForm);
    $("createUniBtn").addEventListener("click", createUniversity);
    $("n_name").addEventListener("input", () => {
      if (!slugTouched) $("n_slug").value = slugify($("n_name").value);
    });
    $("n_slug").addEventListener("input", () => {
      slugTouched = $("n_slug").value.trim() !== "";
    });
    $("newUni").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT") {
        e.preventDefault();
        createUniversity();
      }
    });
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