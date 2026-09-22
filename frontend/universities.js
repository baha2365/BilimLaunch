/*
 * BilimLaunch — universities list + detail pages.
 *
 * Both pages require a signed-in session (reuses Store from app.js) and
 * share the same topbar wiring. The list page just reflects what the
 * server already knows (cached or not); the detail page is what actually
 * triggers the scrape + local-model extraction on the server, the first
 * time a given university is opened.
 */

function requireSession() {
  const user = Store.getSession();
  if (!user) {
    window.location.href = "index.html";
    return null;
  }
  return user;
}

function wireTopbar(user) {
  const greeting = document.getElementById("greeting");
  if (greeting) greeting.textContent = `Signed in as ${user.name}`;

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      Store.clearSession();
      window.location.href = "index.html";
    });
  }
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

const CARD_COLORS = ["#e7b14c", "#5fbfb3", "#e1685f", "#96a1bd"];

/* -------------------------------------------------------------------- */
/* Universities list                                                    */
/* -------------------------------------------------------------------- */

function initUniversitiesListPage() {
  const grid = document.getElementById("uniGrid");
  if (!grid) return;

  const user = requireSession();
  if (!user) return;
  wireTopbar(user);

  fetch("/api/universities")
    .then((res) => {
      if (!res.ok) throw new Error("Could not load the university list.");
      return res.json();
    })
    .then((universities) => {
      grid.innerHTML = "";
      universities.forEach((uni, i) => {
        const card = document.createElement("a");
        card.className = "uni-card";
        card.href = `university.html?school=${encodeURIComponent(uni.slug)}`;

        const color = CARD_COLORS[i % CARD_COLORS.length];
        card.innerHTML = `
          <div class="uni-card__mark" style="background:${color}">${escapeHtml(uni.shortName.charAt(0))}</div>
          <div class="uni-card__body">
            <h3>${escapeHtml(uni.name)}</h3>
            <p>${escapeHtml(uni.city)}, ${escapeHtml(uni.country)}</p>
          </div>
          <span class="uni-card__status ${uni.cached ? "is-ready" : "is-pending"}">
            ${uni.cached ? "Ready to view" : "Generates on first visit"}
          </span>
        `;
        grid.appendChild(card);
      });
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
    return `<p class="empty-note">No specific bachelor's scholarships were found on the pages we read.</p>`;
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

function renderDeadlines(deadlines) {
  if (!deadlines || !deadlines.length) {
    return `<p class="empty-note">No specific deadlines were found on the pages we read.</p>`;
  }
  return `<ul class="deadline-list">${deadlines.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`;
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

function initUniversityDetailPage() {
  const page = document.getElementById("universityPage");
  if (!page) return;

  const user = requireSession();
  if (!user) return;
  wireTopbar(user);

  const slug = getQueryParam("school");
  const titleEl = document.getElementById("uniTitle");
  const subEl = document.getElementById("uniSubtitle");
  const statusEl = document.getElementById("uniStatus");
  const contentEl = document.getElementById("uniContent");
  const regenerateBtn = document.getElementById("regenerateBtn");

  if (!slug) {
    titleEl.textContent = "No university selected";
    statusEl.textContent = "Go back and pick one from the list.";
    statusEl.classList.add("is-visible");
    regenerateBtn.style.display = "none";
    return;
  }

  function renderData(data) {
    titleEl.textContent = data.university || slug;
    subEl.textContent = data.degree_level || "Bachelor's / Undergraduate";
    statusEl.classList.remove("is-visible", "is-error");

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
        <h3>Scholarships &amp; financial aid</h3>
        ${data.financial_aid_summary ? `<p>${escapeHtml(data.financial_aid_summary)}</p>` : ""}
        ${renderScholarships(data.scholarships)}
      </section>

      <section class="info-section">
        <h3>Key deadlines</h3>
        ${renderDeadlines(data.key_deadlines)}
      </section>

      ${data.notes ? `<section class="info-section"><h3>Notes</h3><p>${escapeHtml(data.notes)}</p></section>` : ""}

      <section class="info-section info-section--muted">
        <h3>Sources</h3>
        ${renderSources(data.sources, data.model, data.generated_at)}
      </section>
    `;
  }

  function renderError(message) {
    statusEl.textContent = message;
    statusEl.classList.add("is-visible", "is-error");
  }

  function load(force) {
    statusEl.classList.remove("is-error");
    statusEl.classList.add("is-visible");
    statusEl.textContent = force
      ? "Re-reading the official pages and regenerating…"
      : "Reading official pages and extracting bachelor's info — this can take a minute the first time.";
    contentEl.innerHTML = "";
    regenerateBtn.disabled = true;

    const url = force ? `/api/universities/${slug}/refresh` : `/api/universities/${slug}`;
    const options = force ? { method: "POST" } : {};

    fetch(url, options)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Something went wrong.");
        return body;
      })
      .then(renderData)
      .catch((err) => {
        renderError(
          `${err.message} — make sure Ollama is running locally (ollama serve) with llama3.1:8b pulled, and that you have an internet connection.`
        );
      })
      .finally(() => {
        regenerateBtn.disabled = false;
      });
  }

  regenerateBtn.addEventListener("click", () => load(true));

  load(false);
}

document.addEventListener("DOMContentLoaded", () => {
  initUniversitiesListPage();
  initUniversityDetailPage();
});