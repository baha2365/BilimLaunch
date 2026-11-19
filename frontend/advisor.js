/*
 * BilimLaunch — Admissions Advisor: the list of the student's plans and the
 * form that starts a new one. A plan itself lives on plan.html.
 *
 * Opened from a match card or a university page as
 *   advisor.html?school=<slug>&degree=<key>
 * which pre-selects that university and degree level.
 */
(function () {
  const DEGREE_LABELS = { bachelor: "Bachelor's", master: "Master's", doctorate: "PhD", exchange: "Exchange", internship: "Internship" };
  const DEGREE_ORDER = ["bachelor", "master", "doctorate", "exchange", "internship"];
  const INTAKE_MONTH = { spring: 1, summer: 5, fall: 8 }; // month index of the first day (Feb 1, Jun 1, Sep 1); keep in sync with backend/admissions/roadmap.js
  const MIN_LEAD_DAYS = 45; // the server refuses intakes that start sooner than this

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  Auth.requireUser().then((user) => {
    if (user) main(user);
  });

  function main(user) {
    Auth.wireTopbar(user);

    const uniSel = $("planUni");
    const degreeSel = $("planDegree");
    const programInput = $("planProgram");
    const seasonSel = $("planSeason");
    const yearSel = $("planYear");
    const statusEl = $("planStatus");
    const submitBtn = $("planSubmit");
    const form = $("planForm");

    const configs = new Map(); // slug -> config from /api/universities/:slug
    let universities = [];

    function showStatus(message, kind) {
      statusEl.textContent = message;
      statusEl.classList.toggle("is-error", kind === "error");
      statusEl.classList.toggle("is-loading", kind === "loading");
      statusEl.classList.toggle("is-visible", !!message);
    }

    /* ---------------------------------------------------------------- plans */

    function renderPlans(plans) {
      $("plansSection").hidden = !plans.length;
      $("planGrid").innerHTML = plans
        .map((p) => {
          const sub = [p.degreeLabel, p.program].filter(Boolean).join(" · ");
          const next = p.next
            ? `<p class="plan-card__next${p.next.overdue ? " is-overdue" : ""}">Next: <b>${escapeHtml(p.next.title)}</b>${p.next.dueDate ? ` <span class="due">· due ${escapeHtml(fmtDate(p.next.dueDate))}${p.next.overdue ? " (overdue)" : ""}</span>` : ""}</p>`
            : `<p class="plan-card__next">${p.progress.total && p.progress.done === p.progress.total ? "Everything is done. Good luck!" : "Tasks are locked until earlier stages are finished."}</p>`;
          return `
            <a class="plan-card" href="plan.html?id=${encodeURIComponent(p.id)}">
              <h3>${escapeHtml(p.university.name)}</h3>
              <p class="plan-card__sub">${escapeHtml(sub)}</p>
              <p class="plan-card__sub">${escapeHtml(p.intake)} intake · deadline ${escapeHtml(fmtDate(p.deadline))}</p>
              <div class="plan-card__pct"><span>${p.progress.done} of ${p.progress.total} tasks</span><strong>${p.progress.percent}%</strong></div>
              <div class="adv-track"><span style="width:${p.progress.percent}%"></span></div>
              ${next}
            </a>`;
        })
        .join("");
    }

    Auth.api("/api/plans")
      .then((data) => renderPlans(data.plans || []))
      .catch((err) => showStatus(err.message, "error"));

    /* ------------------------------------------------------------- the form */

    function fillYears() {
      const season = seasonSel.value;
      const keep = yearSel.value;
      const now = new Date();
      const options = [];
      for (let y = now.getFullYear(); y <= now.getFullYear() + 3; y++) {
        const start = new Date(y, INTAKE_MONTH[season], 1);
        if ((start - now) / 86400000 >= MIN_LEAD_DAYS) options.push(y);
      }
      yearSel.innerHTML = options.map((y) => `<option value="${y}">${y}</option>`).join("");
      if (options.map(String).includes(keep)) yearSel.value = keep;
    }

    function defaultIntake() {
      // The next September that is far enough away, the most common start for a degree.
      seasonSel.value = "fall";
      fillYears();
    }

    function fillUniversities() {
      const sorted = [...universities].sort((a, b) => a.name.localeCompare(b.name));
      uniSel.innerHTML =
        `<option value="">Choose a university</option>` +
        sorted.map((u) => `<option value="${escapeHtml(u.slug)}">${escapeHtml(u.name)}${u.country ? ` — ${escapeHtml(u.country)}` : ""}</option>`).join("");
    }

    function fillDegrees(preferred) {
      const uni = universities.find((u) => u.slug === uniSel.value);
      const offered = uni ? DEGREE_ORDER.filter((d) => (uni.offeredDegrees || []).includes(d)) : [];
      if (!uni) {
        degreeSel.innerHTML = `<option value="">Choose a university first</option>`;
        return;
      }
      if (!offered.length) {
        degreeSel.innerHTML = `<option value="">No degree levels available yet</option>`;
        return;
      }
      degreeSel.innerHTML = offered.map((d) => `<option value="${d}">${escapeHtml(DEGREE_LABELS[d])}</option>`).join("");
      const profileDegree = mapProfileDegree((user.profile || {}).targetDegree);
      degreeSel.value = [preferred, profileDegree].find((d) => d && offered.includes(d)) || offered[0];
    }

    function mapProfileDegree(text) {
      const t = String(text || "").toLowerCase();
      if (t.includes("bachelor")) return "bachelor";
      if (t.includes("master")) return "master";
      if (t.includes("phd") || t.includes("doctor")) return "doctorate";
      if (t.includes("exchange")) return "exchange";
      if (t.includes("internship")) return "internship";
      return null;
    }

    async function fillPrograms() {
      const slug = uniSel.value;
      const degree = degreeSel.value;
      $("programList").innerHTML = "";
      if (!slug || !degree) return;
      try {
        if (!configs.has(slug)) configs.set(slug, await Auth.api(`/api/universities/${encodeURIComponent(slug)}`));
        // The user may have changed the selection while the request was running.
        if (uniSel.value !== slug || degreeSel.value !== degree) return;
        const list = ((configs.get(slug).programs || {})[degree] || {}).fields_of_study || [];
        $("programList").innerHTML = list
          .slice(0, 400)
          .map((f) => `<option value="${escapeHtml(f)}"></option>`)
          .join("");
      } catch (_) {
        /* no suggestions: the field still accepts typing */
      }
    }

    uniSel.addEventListener("change", () => {
      clearFieldError(uniSel);
      fillDegrees();
      fillPrograms();
    });
    degreeSel.addEventListener("change", () => {
      clearFieldError(degreeSel);
      fillPrograms();
    });
    seasonSel.addEventListener("change", fillYears);
    yearSel.addEventListener("change", () => clearFieldError(yearSel));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      [uniSel, degreeSel, yearSel].forEach(clearFieldError);
      showStatus("", "");
      let bad = false;
      if (!uniSel.value) (setFieldError(uniSel, "Choose a university."), (bad = true));
      if (!degreeSel.value) (setFieldError(degreeSel, "Choose a degree level."), (bad = true));
      if (!yearSel.value) (setFieldError(yearSel, "Choose a later intake."), (bad = true));
      if (bad) return;

      setBusy(submitBtn, true, "Building your roadmap…");
      showStatus("Reading the university's official requirements and building your plan. If this is the first plan for this university it can take a few minutes, so please keep this page open.", "loading");
      try {
        const plan = await Auth.api("/api/plans", {
          method: "POST",
          body: { slug: uniSel.value, degree: degreeSel.value, program: programInput.value.trim(), intakeSeason: seasonSel.value, intakeYear: Number(yearSel.value) },
        });
        window.location.href = `plan.html?id=${encodeURIComponent(plan.id)}`;
      } catch (err) {
        setBusy(submitBtn, false);
        if (err.code === "duplicate" && err.body && err.body.planId) {
          window.location.href = `plan.html?id=${encodeURIComponent(err.body.planId)}`;
          return;
        }
        showApiError(err, { slug: uniSel, degree: degreeSel, intakeYear: yearSel, intakeSeason: seasonSel }, null);
        showStatus(err.message + (err.code === "research_failed" ? " Make sure Ollama is running locally (ollama serve) and you have an internet connection." : ""), "error");
      }
    });

    /* ----------------------------------------------------------------- init */

    defaultIntake();
    Auth.api("/api/universities")
      .then((list) => {
        universities = list;
        fillUniversities();
        const slug = params.get("school");
        if (slug && universities.some((u) => u.slug === slug)) {
          uniSel.value = slug;
          fillDegrees(params.get("degree"));
          fillPrograms();
          const uni = universities.find((u) => u.slug === slug);
          $("newPlanTitle").textContent = `Plan your admission to ${uni.name}`;
          $("newPlanCard").scrollIntoView({ behavior: "smooth", block: "start" });
        }
      })
      .catch((err) => showStatus(err.message, "error"));
  }
})();
