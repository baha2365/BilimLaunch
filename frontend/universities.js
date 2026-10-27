/*
 * BilimLaunch — universities list + detail pages.
 *
 * Both pages require a signed-in user (see auth.js) and
 * share the same topbar wiring. The list page just reflects what the
 * server already knows; the detail page shows one tab per degree level
 * the university actually has source pages for, and lazily triggers the
 * scrape + local-model extraction for a tab the first time it's opened.
 */

const DEGREE_LABELS = {
  bachelor: "Bachelor's",
  master: "Master's",
  doctorate: "PhD",
  exchange: "Exchange",
};
const DEGREE_ORDER = ["bachelor", "master", "doctorate", "exchange"];

function requireSession() {
  return Auth.requireUser();
}

function wireTopbar(user) {
  Auth.wireTopbar(user);
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

const CARD_COLORS = [
  "linear-gradient(145deg,#5ac8fa,#0a84ff)",
  "linear-gradient(145deg,#7d7aff,#5e5ce6)",
  "linear-gradient(145deg,#4cd964,#1fa84b)",
  "linear-gradient(145deg,#ffb340,#ff9500)",
  "linear-gradient(145deg,#ff6482,#ff375f)",
  "linear-gradient(145deg,#bf5af2,#8944ab)",
];

/* -------------------------------------------------------------------- */
/* Universities list                                                    */
/* -------------------------------------------------------------------- */

async function initUniversitiesListPage() {
  const grid = document.getElementById("uniGrid");
  if (!grid) return;

  const user = await requireSession();
  if (!user) return;
  wireTopbar(user);

  const search = document.getElementById("uniSearch");

  Auth.api("/api/universities")
    .then((universities) => {
      grid.innerHTML = "";
      universities.forEach((uni, i) => {
        const card = document.createElement("a");
        card.className = "uni-card";
        card.href = `university.html?school=${encodeURIComponent(uni.slug)}`;

        const color = CARD_COLORS[i % CARD_COLORS.length];
        const degreeTags = (uni.offeredDegrees || [])
          .map((d) => `<span class="degree-tag${(uni.availableDegrees || []).includes(d) ? " is-ready" : ""}">${escapeHtml(DEGREE_LABELS[d] || d)}</span>`)
          .join("");
        card.innerHTML = `
          <div class="uni-card__mark" style="background:${color}">${escapeHtml((uni.shortName || uni.name || "?").charAt(0))}</div>
          <div class="uni-card__body">
            <h3>${escapeHtml(uni.name)}</h3>
            <p>${escapeHtml(uni.city)}, ${escapeHtml(uni.country)}</p>
            <div class="uni-card__degrees">${degreeTags}</div>
          </div>
          <span class="uni-card__status ${uni.cached ? "is-ready" : "is-pending"}">
            ${uni.cached ? "Ready to view" : "Generates on first visit"}
          </span>
        `;
        card.dataset.search = [uni.name, uni.shortName, uni.city, uni.country].filter(Boolean).join(" ").toLowerCase();
        grid.appendChild(card);
      });

      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = "No universities match your search.";
      empty.hidden = true;
      grid.appendChild(empty);

      if (search) {
        search.addEventListener("input", () => {
          const q = search.value.trim().toLowerCase();
          let shown = 0;
          grid.querySelectorAll(".uni-card").forEach((card) => {
            const hit = !q || card.dataset.search.includes(q);
            card.hidden = !hit;
            if (hit) shown++;
          });
          empty.hidden = shown > 0;
        });
      }
    })
    .catch((err) => {
      grid.innerHTML = `<p class="empty-note">${escapeHtml(err.message)}</p>`;
    });
}

/* -------------------------------------------------------------------- */
/* University detail                                                    */
/* -------------------------------------------------------------------- */

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function renderScholarships(scholarships) {
  if (!scholarships || !scholarships.length) {
    return `<p class="empty-note">No specific scholarships were found on the pages we read.</p>`;
  }
  const items = scholarships
    .map((s) => {
      const parts = [];
      if (s.eligibility) parts.push(`<span>${escapeHtml(s.eligibility)}</span>`);
      if (s.amount) parts.push(`<span>${escapeHtml(s.amount)}</span>`);
      if (s.deadline) parts.push(`<span>Deadline: ${escapeHtml(s.deadline)}</span>`);
      return `<li><strong>${escapeHtml(s.name || "Untitled award")}</strong>${parts.join("")}</li>`;
    })
    .join("");
  return `<ul class="scholarship-list">${items}</ul>`;
}

function renderList(items, emptyText) {
  if (!items || !items.length) {
    return `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
  }
  return `<ul class="deadline-list">${items.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`;
}

function renderRequirements(requirements) {
  const req = requirements || {};
  const hasAny =
    req.minimum_gpa || (req.language_tests && req.language_tests.length) ||
    (req.standardized_tests && req.standardized_tests.length) || (req.required_documents && req.required_documents.length) || req.other;

  if (!hasAny) {
    return `<p class="empty-note">No specific entry requirements were found on the pages we read.</p>`;
  }

  return `
    <div class="grid-2">
      <div>
        <span class="info-label">Minimum GPA</span>
        <p>${escapeHtml(req.minimum_gpa || "Not stated")}</p>
      </div>
      <div>
        <span class="info-label">Language tests</span>
        <p>${req.language_tests && req.language_tests.length ? escapeHtml(req.language_tests.join(", ")) : "Not stated"}</p>
      </div>
    </div>
    <div class="grid-2">
      <div>
        <span class="info-label">Standardized tests</span>
        <p>${req.standardized_tests && req.standardized_tests.length ? escapeHtml(req.standardized_tests.join(", ")) : "Not stated"}</p>
      </div>
      <div>
        <span class="info-label">Required documents</span>
        <p>${req.required_documents && req.required_documents.length ? escapeHtml(req.required_documents.join(", ")) : "Not stated"}</p>
      </div>
    </div>
    ${req.other ? `<p class="info-note">${escapeHtml(req.other)}</p>` : ""}
  `;
}

function renderSources(sources, model, generatedAt) {
  const when = generatedAt ? new Date(generatedAt).toLocaleString() : "an earlier visit";
  const list = (sources || [])
    .map((url) => `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></li>`)
    .join("");
  return `
    <p class="info-note">
      Extracted automatically by ${escapeHtml(model || "a local model")} on ${escapeHtml(when)}.
      Always confirm on the official page before making a decision.
    </p>
    <ul class="source-list">${list}</ul>
  `;
}

async function initUniversityDetailPage() {
  const page = document.getElementById("universityPage");
  if (!page) return;

  const user = await requireSession();
  if (!user) return;
  wireTopbar(user);

  const slug = getQueryParam("school");
  const titleEl = document.getElementById("uniTitle");
  const subEl = document.getElementById("uniSubtitle");
  const statusEl = document.getElementById("uniStatus");
  const contentEl = document.getElementById("uniContent");
  const regenerateBtn = document.getElementById("regenerateBtn");
  const tabsEl = document.getElementById("degreeTabs");

  // Only administrators may re-read the official pages and overwrite saved data
  // (the server enforces this too; here we just don't show the button to others).
  if (user.role !== "admin") regenerateBtn.style.display = "none";

  if (!slug) {
    titleEl.textContent = "No university selected";
    statusEl.textContent = "Go back and pick one from the list.";
    statusEl.classList.add("is-visible");
    regenerateBtn.style.display = "none";
    return;
  }

  let currentDegree = null;
  let offeredDegrees = [];

  function renderProgram(degree, data) {
    subEl.textContent = DEGREE_LABELS[degree] ? `${DEGREE_LABELS[degree]} admissions` : degree;
    statusEl.classList.remove("is-visible", "is-error", "is-loading");

    const tuition = data.tuition || {};

    contentEl.innerHTML = `
      <section class="info-section">
        <h3>Tuition &amp; costs</h3>
        <div class="grid-2">
          <div>
            <span class="info-label">Home / domestic students</span>
            <p>${escapeHtml(tuition.domestic_or_home || "Not stated on the source pages")}</p>
          </div>
          <div>
            <span class="info-label">International students</span>
            <p>${escapeHtml(tuition.international || "Not stated on the source pages")}</p>
          </div>
        </div>
        ${tuition.notes ? `<p class="info-note">${escapeHtml(tuition.notes)}</p>` : ""}
      </section>

      <section class="info-section">
        <h3>Entry requirements</h3>
        ${renderRequirements(data.requirements)}
      </section>

      <section class="info-section">
        <h3>Scholarships &amp; financial aid</h3>
        ${data.financial_aid_summary ? `<p>${escapeHtml(data.financial_aid_summary)}</p>` : ""}
        ${renderScholarships(data.scholarships)}
      </section>

      <section class="info-section">
        <h3>Key deadlines</h3>
        ${renderList(data.key_deadlines, "No specific deadlines were found on the pages we read.")}
      </section>

      ${
        (data.fields_of_study || []).length
          ? `<section class="info-section"><h3>Programmes listed (${data.fields_of_study.length})</h3><details><summary>Show all</summary><p class="info-note">${data.fields_of_study.map(escapeHtml).join(" &middot; ")}</p></details></section>`
          : ""
      }

      ${data.notes ? `<section class="info-section"><h3>Notes</h3><p>${escapeHtml(data.notes)}</p></section>` : ""}

      <section class="info-section info-section--muted">
        <h3>Sources</h3>
        ${renderSources(data.sources, data.model, data.generated_at)}
      </section>
    `;
  }

  function renderError(message) {
    statusEl.textContent = message;
    statusEl.classList.remove("is-loading");
    statusEl.classList.add("is-visible", "is-error");
  }

  function renderTabs() {
    tabsEl.hidden = offeredDegrees.length === 0;
    tabsEl.innerHTML = offeredDegrees
      .map(
        (d) =>
          `<button type="button" class="degree-tab${d === currentDegree ? " is-active" : ""}" data-degree="${d}">${escapeHtml(DEGREE_LABELS[d] || d)}</button>`
      )
      .join("");
    tabsEl.querySelectorAll(".degree-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.degree === currentDegree) return;
        currentDegree = btn.dataset.degree;
        renderTabs();
        loadProgram(false);
      });
    });
  }

  function loadProgram(force) {
    if (!currentDegree) return;
    statusEl.classList.remove("is-error");
    statusEl.classList.add("is-visible", "is-loading");
    statusEl.textContent = force
      ? `Re-reading the official pages and regenerating ${DEGREE_LABELS[currentDegree] || currentDegree} info…`
      : `Reading official pages and extracting ${DEGREE_LABELS[currentDegree] || currentDegree} info — this can take a minute the first time.`;
    contentEl.innerHTML = "";
    regenerateBtn.disabled = true;

    const url = force
      ? `/api/universities/${slug}/${currentDegree}/refresh`
      : `/api/universities/${slug}/${currentDegree}`;

    Auth.api(url, { method: force ? "POST" : "GET" })
      .then((data) => renderProgram(currentDegree, data))
      .catch((err) => {
        renderError(
          `${err.message} — make sure Ollama is running locally (ollama serve) with llama3.1:8b pulled, and that you have an internet connection.`
        );
      })
      .finally(() => {
        regenerateBtn.disabled = false;
      });
  }

  regenerateBtn.addEventListener("click", () => loadProgram(true));

  // First, a pure read to find the university's name and which degree
  // levels it actually has source pages for -- no generation triggered yet.
  Auth.api(`/api/universities/${encodeURIComponent(slug)}`)
    .then((config) => {
      titleEl.textContent = config.name || slug;
      const sourceUrls = config.sourceUrls || {};
      const programs = config.programs || {};
      // A degree level is shown if it has data already (e.g. entered in the
      // admin panel) OR source pages to generate it from. Same rule as the
      // /api/universities list.
      offeredDegrees = DEGREE_ORDER.filter(
        (d) => (programs[d] && programs[d].generated_at) || (sourceUrls[d] && sourceUrls[d].length)
      );

      if (!offeredDegrees.length) {
        subEl.textContent = "";
        regenerateBtn.style.display = "none";
        renderError("There is no information for this university yet. Please check back soon.");
        return;
      }

      // Prefer a degree level that already has data, so returning to a
      // page you've already generated doesn't re-trigger anything.
      currentDegree =
        offeredDegrees.find((d) => programs[d] && programs[d].generated_at) || offeredDegrees[0];
      renderTabs();
      loadProgram(false);
    })
    .catch((err) => {
      titleEl.textContent = "Couldn't load this university";
      regenerateBtn.style.display = "none";
      renderError(err.message);
    });
}

document.addEventListener("DOMContentLoaded", () => {
  initUniversitiesListPage();
  initUniversityDetailPage();
});
