/*
 * BilimLaunch — "Find my match" on the profile page.
 *
 * Clicking the button saves whatever is currently in the profile form
 * (so the match never runs on stale data), sends the saved profile to
 * POST /api/match, and renders the ranked universities the server returns.
 * The server only ever ranks universities that have already been scraped
 * and extracted, so every result links to a page that has real data.
 */
(function () {
  const NOTE_ALWAYS =
    "Every statement above is either a comparison with data scraped from the university's own pages or a value quoted from them. Always confirm on the official site \u2014 this is not an admission prediction.";

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function renderPoints(items, className) {
    if (!items || !items.length) return "";
    return `<ul class="match-card__points ${className}">${items
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("")}</ul>`;
  }

  function renderSources(sources) {
    if (!sources || !sources.length) return "";
    const links = sources
      .slice(0, 3)
      .map((url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url.replace(/^https?:\/\//, "").slice(0, 50))}</a>`)
      .join(" \u00b7 ");
    return `<p class="match-card__sources">Verify on the official pages: ${links}</p>`;
  }

  function renderCard(rec, isBest) {
    const place = [rec.city, rec.country].filter(Boolean).join(", ");
    return `
      <article class="match-card${isBest ? " match-card--best" : ""}">
        <span class="match-card__rank">${isBest ? "Best match" : `#${escapeHtml(rec.rank)}`}</span>
        <h3><a href="university.html?school=${encodeURIComponent(rec.slug)}">${escapeHtml(rec.name || rec.slug)}</a></h3>
        ${place || rec.degree_level ? `<p class="match-card__place">${[place, rec.degree_level].filter(Boolean).map(escapeHtml).join(" — ")}</p>` : ""}
        ${rec.match_summary ? `<p class="match-card__summary">${escapeHtml(rec.match_summary)}</p>` : ""}
        ${renderPoints(rec.strengths, "is-good")}
        ${renderPoints(rec.concerns, "is-warn")}
        ${renderSources(rec.sources)}
        <a class="btn btn-primary btn-small match-card__letter" href="letter.html?school=${encodeURIComponent(rec.slug)}&degree=${encodeURIComponent(rec.degree || "")}">Write motivation letter</a>
      </article>
    `;
  }

  function renderExcludedNote(excluded) {
    if (!excluded || !excluded.length) return "";
    const items = excluded
      .map((ex) => `<li><strong>${escapeHtml(ex.name || ex.slug)}</strong> \u2014 ${escapeHtml(ex.reason || "")}</li>`)
      .join("");
    return `<details class="match-results__excluded"><summary>${excluded.length} analyzed ${excluded.length === 1 ? "program was" : "programs were"} hidden \u2014 why</summary><ul>${items}</ul></details>`;
  }

  function renderResults(container, data) {
    const recs = data.recommendations || [];
    const excluded = data.excluded || [];

    // Only matching universities are ever in `recs` — the server (via
    // match.py's is_match()) already filtered out anything whose country
    // or degree level doesn't fit, so there's nothing to hide client-side.
    if (!recs.length) {
      container.innerHTML = `
        <div class="match-results__head">
          <h2>Your matches</h2>
        </div>
        <p class="status-banner is-visible">${escapeHtml(data.overall_notes || "No analyzed university satisfies your profile.")}</p>
        ${renderExcludedNote(excluded)}
      `;
      return;
    }

    const count = data.compared_count || recs.length;
    container.innerHTML = `
      <div class="match-results__head">
        <h2>Your matches</h2>
        <p class="match-results__meta">
          ${recs.length} of ${escapeHtml(count)} analyzed ${count === 1 ? "university" : "universities"} matched —
          <a href="universities.html">open more</a> to widen the comparison.
        </p>
      </div>
      <div class="match-list">
        ${recs.map((rec) => renderCard(rec, rec.slug === data.best_match)).join("")}
      </div>
      ${renderExcludedNote(excluded)}
      <p class="match-results__note">${escapeHtml(NOTE_ALWAYS)}</p>
      ${data.overall_notes ? `<p class="match-results__note">${escapeHtml(data.overall_notes)}</p>` : ""}
    `;
  }

  function init() {
    const btn = document.getElementById("findMatchBtn");
    const container = document.getElementById("matchResults");
    const form = document.getElementById("profileForm");
    if (!btn || !container || !form) return;

    btn.addEventListener("click", () => {
      // Run the profile form's own submit handler first, so the match uses
      // exactly what's on screen (and the sidebar summary refreshes too).
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

      const user = Store.getSession();
      if (!user) {
        window.location.href = "index.html";
        return;
      }

      btn.disabled = true;
      btn.textContent = "Analyzing…";
      container.hidden = false;
      container.innerHTML = `<p class="status-banner is-visible">Comparing your profile against the universities we've analyzed — this only takes a moment.</p>`;
      container.scrollIntoView({ behavior: "smooth", block: "start" });

      fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: user.profile }),
      })
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || "Something went wrong.");
          return body;
        })
        .then((data) => renderResults(container, data))
        .catch((err) => {
          container.innerHTML = `<p class="status-banner is-visible is-error">${escapeHtml(err.message)}</p>`;
        })
        .finally(() => {
          btn.disabled = false;
          btn.textContent = "Find my match";
        });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();