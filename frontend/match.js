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
    "Based on tuition, scholarships and funding only. Entry requirements such as minimum GPA or test scores aren't part of this data, so this is not a prediction of whether you'd be admitted.";

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

  function renderCard(rec, isBest) {
    const place = [rec.city, rec.country].filter(Boolean).join(", ");
    return `
      <article class="match-card${isBest ? " match-card--best" : ""}">
        <span class="match-card__rank">${isBest ? "Best match" : `#${escapeHtml(rec.rank)}`}</span>
        <h3><a href="university.html?school=${encodeURIComponent(rec.slug)}">${escapeHtml(rec.name || rec.slug)}</a></h3>
        ${place ? `<p class="match-card__place">${escapeHtml(place)}</p>` : ""}
        ${rec.match_summary ? `<p class="match-card__summary">${escapeHtml(rec.match_summary)}</p>` : ""}
        ${renderPoints(rec.strengths, "is-good")}
        ${renderPoints(rec.concerns, "is-warn")}
      </article>
    `;
  }

  function renderExcludedNote(excluded) {
    if (!excluded || !excluded.length) return "";
    const names = excluded.map((ex) => escapeHtml(ex.name || ex.slug)).join(", ");
    const label =
      excluded.length === 1
        ? "1 university you've opened didn't match and isn't shown"
        : `${excluded.length} universities you've opened didn't match and aren't shown`;
    return `<p class="match-results__excluded">${label}: ${names}.</p>`;
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
        <p class="status-banner is-visible">${escapeHtml(data.overall_notes || "None of your discovered universities matched your profile.")}</p>
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
      container.innerHTML = `<p class="status-banner is-visible">Comparing your profile against the universities we've analyzed — this can take a minute on a local model.</p>`;
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