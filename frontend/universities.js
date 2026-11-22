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
  internship: "Internship",
};
const DEGREE_ORDER = ["bachelor", "master", "doctorate", "exchange", "internship"];

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

// Colour + initial shown until a university has a main image (uni-images.js).
const { colorFor, initialOf } = UniImages;

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
  const degreeSelect = document.getElementById("uniDegree");

  Auth.api("/api/universities")
    .then((universities) => {
      grid.innerHTML = "";
      universities.forEach((uni) => {
        const card = document.createElement("a");
        card.className = "uni-card";
        card.href = `university.html?school=${encodeURIComponent(uni.slug)}`;
        card.dataset.baseHref = card.href;

        const degreeTags = (uni.offeredDegrees || [])
          .map((d) => `<span class="degree-tag${(uni.availableDegrees || []).includes(d) ? " is-ready" : ""}">${escapeHtml(DEGREE_LABELS[d] || d)}</span>`)
          .join("");
        // The main image as the card's cover; a coloured initial until one is uploaded.
        const cover = uni.mainImageUrl
          ? `<img src="${escapeHtml(uni.mainImageUrl)}" alt="" loading="lazy" decoding="async" />`
          : `<span class="uni-card__initial">${escapeHtml(initialOf(uni))}</span>`;
        card.innerHTML = `
          <div class="uni-card__cover${uni.mainImageUrl ? " has-image" : ""}" style="background:${colorFor(uni.slug)}">${cover}</div>
          <div class="uni-card__body">
            <h3>${escapeHtml(uni.name)}</h3>
            <p>${escapeHtml(uni.city)}, ${escapeHtml(uni.country)}</p>
            <div class="uni-card__degrees">${degreeTags}</div>
          </div>
          <span class="uni-card__status ${uni.cached ? "is-ready" : "is-pending"}">
            ${uni.cached ? "Ready to view" : "Generates on first visit"}
          </span>
        `;
        card.dataset.degrees = (uni.offeredDegrees || []).join(" ");
        card.dataset.search = [uni.name, uni.shortName, uni.city, uni.country].filter(Boolean).join(" ").toLowerCase();
        grid.appendChild(card);
      });

      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = "No universities match your search.";
      empty.hidden = true;
      grid.appendChild(empty);

      const applyFilters = () => {
        const q = search ? search.value.trim().toLowerCase() : "";
        const wanted = degreeSelect ? degreeSelect.value : "";
        let shown = 0;
        grid.querySelectorAll(".uni-card").forEach((card) => {
          const hit =
            (!q || card.dataset.search.includes(q)) &&
            (!wanted || card.dataset.degrees.split(" ").includes(wanted));
          card.hidden = !hit;
          // Open the university straight on the level the visitor filtered by.
          card.href = wanted ? `${card.dataset.baseHref}&degree=${encodeURIComponent(wanted)}` : card.dataset.baseHref;
          if (hit) shown++;
        });
        empty.hidden = shown > 0;
      };
      if (search) search.addEventListener("input", applyFilters);
      if (degreeSelect) degreeSelect.addEventListener("change", applyFilters);
      applyFilters(); // a browser may restore the dropdown choice on reload
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

/* -------------------------------------------------------------------- */
/* University photos: main image (avatar) + gallery                     */
/* -------------------------------------------------------------------- */

const UPLOADS_OFF = "Photo uploads are off: image storage (R2) isn't set up on the server.";

function initUniversityPhotos(slug, config, isAdmin) {
  const $ = (id) => document.getElementById(id);
  const section = $("uniPhotos");
  const mosaic = $("photoMosaic");
  const countEl = $("photoCount");
  const note = $("photoNote");
  const addBtn = $("addPhotosBtn");
  const avatar = $("uniAvatar");
  const avatarEdit = $("avatarEditBtn");
  const lightbox = $("lightbox");
  const lbImg = $("lbImg");
  const name = config.name || slug;
  const canEdit = isAdmin;

  let images = { mainImage: config.mainImage || null, gallery: config.gallery || [], uploadsEnabled: !!config.uploadsEnabled };
  let index = 0;

  function setNote(text, isError) {
    note.textContent = text || "";
    note.classList.toggle("is-error", !!isError);
  }

  function renderAvatar() {
    avatar.style.background = colorFor(slug);
    $("uniAvatarLetter").textContent = initialOf(config);
    let img = avatar.querySelector("img");
    if (images.mainImage) {
      if (!img) {
        img = document.createElement("img");
        img.alt = name;
        avatar.prepend(img);
      }
      img.src = images.mainImage.url;
    } else if (img) {
      img.remove();
    }
    avatar.classList.toggle("has-image", !!images.mainImage);
    avatar.classList.add("is-ready");
  }

  function renderGallery() {
    const photos = images.gallery;
    section.hidden = !photos.length && !canEdit;
    countEl.textContent = photos.length ? String(photos.length) : "";
    mosaic.innerHTML = "";
    mosaic.dataset.count = String(Math.min(photos.length, 5));

    if (!photos.length) {
      // Only admins get here (the section is hidden for everybody else).
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "uni-mosaic__empty";
      const strong = document.createElement("strong");
      strong.textContent = `Add the first photos of ${name}`;
      const hint = document.createElement("span");
      hint.textContent = "Click to choose, or drop image files here. JPEG, PNG or WebP.";
      empty.append(strong, hint);
      empty.addEventListener("click", choosePhotos);
      mosaic.appendChild(empty);
      return;
    }

    photos.slice(0, 5).forEach((photo, i) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "uni-mosaic__tile";
      tile.setAttribute("aria-label", `Open photo ${i + 1} of ${photos.length}`);
      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = "";
      img.loading = i === 0 ? "eager" : "lazy";
      img.decoding = "async";
      tile.appendChild(img);
      if (i === 4 && photos.length > 5) {
        const more = document.createElement("span");
        more.className = "uni-mosaic__more";
        more.textContent = `+${photos.length - 5}`;
        tile.appendChild(more);
      }
      tile.addEventListener("click", () => openViewer(i));
      mosaic.appendChild(tile);
    });
  }

  /* ---- full-screen viewer ---- */

  function show() {
    const photos = images.gallery;
    if (!photos.length) {
      if (lightbox.open) lightbox.close();
      return;
    }
    index = (index + photos.length) % photos.length;
    lbImg.src = photos[index].url;
    lbImg.alt = `${name} — photo ${index + 1} of ${photos.length}`;
    $("lbCount").textContent = `${index + 1} / ${photos.length}`;
    $("lbPrev").hidden = $("lbNext").hidden = photos.length < 2;
  }

  function step(by) {
    index += by;
    show();
  }

  function openViewer(i) {
    index = i;
    show();
    if (!lightbox.open) lightbox.showModal();
  }

  $("lbClose").addEventListener("click", () => lightbox.close());
  $("lbPrev").addEventListener("click", () => step(-1));
  $("lbNext").addEventListener("click", () => step(1));
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) lightbox.close(); // a click on the dark backdrop
  });
  lightbox.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  /* ---- admins: upload / replace / delete ---- */

  async function addPhotos(files) {
    if (!files.length) return;
    if (!images.uploadsEnabled) return setNote(UPLOADS_OFF, true);
    addBtn.disabled = true;
    setNote(`Uploading 0 of ${files.length}…`);
    try {
      const { images: updated, failed } = await UniImages.addToGallery(slug, files, (done, total) => setNote(`Uploading ${done} of ${total}…`));
      if (updated) images = updated;
      renderGallery();
      const added = files.length - failed.length;
      setNote(failed.length ? UniImages.describeFailures(failed) : `Added ${added} ${added === 1 ? "photo" : "photos"}.`, failed.length > 0);
    } finally {
      addBtn.disabled = false;
    }
  }

  function choosePhotos() {
    UniImages.pickFiles(true).then(addPhotos);
  }

  async function changeMainImage() {
    const [file] = await UniImages.pickFiles(false);
    if (!file) return;
    if (!images.uploadsEnabled) return setNote(UPLOADS_OFF, true);
    avatar.classList.add("is-busy");
    setNote("Uploading the main image…");
    try {
      images = await UniImages.setMain(slug, file);
      renderAvatar();
      setNote("Main image updated.");
    } catch (err) {
      setNote(`The main image was not changed: ${err.message}`, true);
    } finally {
      avatar.classList.remove("is-busy");
    }
  }

  async function deleteCurrent() {
    const photo = images.gallery[index];
    if (!photo || !confirm("Delete this photo? It is removed from storage for good.")) return;
    const btn = $("lbDelete");
    btn.disabled = true;
    try {
      images = await UniImages.removeFromGallery(slug, photo.id);
      renderGallery();
      setNote("Photo deleted.");
      show();
    } catch (err) {
      alert(`The photo was not deleted: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  if (canEdit) {
    $("photoAdmin").hidden = false;
    avatarEdit.hidden = false;
    $("lbDelete").hidden = false;
    addBtn.addEventListener("click", choosePhotos);
    avatarEdit.addEventListener("click", changeMainImage);
    $("lbDelete").addEventListener("click", deleteCurrent);
    if (!images.uploadsEnabled) setNote(UPLOADS_OFF, true);

    section.addEventListener("dragover", (e) => {
      e.preventDefault();
      section.classList.add("is-drop");
    });
    section.addEventListener("dragleave", (e) => {
      if (!section.contains(e.relatedTarget)) section.classList.remove("is-drop");
    });
    section.addEventListener("drop", (e) => {
      e.preventDefault();
      section.classList.remove("is-drop");
      addPhotos(UniImages.filesFromDrop(e));
    });
  }

  renderAvatar();
  renderGallery();
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
    document.getElementById("uniAvatar").hidden = true;
    statusEl.textContent = "Go back and pick one from the list.";
    statusEl.classList.add("is-visible");
    regenerateBtn.style.display = "none";
    return;
  }

  let currentDegree = null;
  let offeredDegrees = [];

  function renderProgram(degree, data) {
    const planBtn = document.getElementById("planBtn");
    if (planBtn) planBtn.href = `advisor.html?school=${encodeURIComponent(slug)}&degree=${encodeURIComponent(degree)}`;
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
      initUniversityPhotos(slug, config, user.role === "admin");
      const sourceUrls = config.sourceUrls || {};
      const programs = config.programs || {};
      // A degree level is shown if it has data already (e.g. entered in the
      // admin panel) OR source pages to generate it from. Same rule as the
      // /api/universities list.
      offeredDegrees = DEGREE_ORDER.filter(
        (d) => (programs[d] && programs[d].generated_at) ||
          (sourceUrls[d] && sourceUrls[d].length) ||
          (config.degreeTypes || []).includes(d)
      );

      if (!offeredDegrees.length) {
        subEl.textContent = "";
        regenerateBtn.style.display = "none";
        renderError("There is no information for this university yet. Please check back soon.");
        return;
      }

      // Prefer a degree level that already has data, so returning to a
      // page you've already generated doesn't re-trigger anything.
      const requested = getQueryParam("degree");
      currentDegree = offeredDegrees.includes(requested)
        ? requested
        : offeredDegrees.find((d) => programs[d] && programs[d].generated_at) || offeredDegrees[0];
      renderTabs();
      loadProgram(false);
    })
    .catch((err) => {
      titleEl.textContent = "Couldn't load this university";
      document.getElementById("uniAvatar").hidden = true;
      regenerateBtn.style.display = "none";
      renderError(err.message);
    });
}

document.addEventListener("DOMContentLoaded", () => {
  initUniversitiesListPage();
  initUniversityDetailPage();
});
