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
    ["internship", "Internship"],
  ];
  const $ = (id) => document.getElementById(id);
  const lines = (id) => $(id).value;
  const toLines = (arr) => (Array.isArray(arr) ? arr.join("\n") : "");

  let universities = [];
  let current = null; // { config, programs }
  let slug = null;
  let degree = "bachelor";
  const drafts = {}; // degree -> form values not yet saved

  // All requests go through Auth.api, which sends the signed-in user's access
  // token. The server only answers if that user's role in PostgreSQL is "admin".
  async function api(path, options = {}) {
    const body = options.body ? JSON.parse(options.body) : undefined;
    try {
      return await Auth.api(`/api/admin${path}`, { method: options.method || "GET", body });
    } catch (err) {
      if (err.status === 403) {
        window.location.replace("profile.html"); // not an administrator (any more)
      }
      throw err;
    }
  }

  // Shows a save result next to a Save button: kind is "ok", "warn" or "error".
  function flash(id, text, kind) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle("is-visible", !!text);
    el.classList.toggle("is-warn", kind === "warn");
    el.classList.toggle("is-error", kind === "error");
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

  /** A square picture: the main image, or the university's colour + initial. */
  function thumbFor(uniSlug, uni, url, className) {
    const box = document.createElement("span");
    box.className = className;
    box.style.background = UniImages.colorFor(uniSlug);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      box.appendChild(img);
    } else {
      box.textContent = UniImages.initialOf(uni);
    }
    return box;
  }

  function renderList() {
    const q = $("uniSearch").value.trim().toLowerCase();
    const typeFilter = $("uniTypeFilter").value;
    const ul = $("uniList");
    ul.innerHTML = "";
    universities
      .filter((u) => !q || `${u.name} ${u.country}`.toLowerCase().includes(q))
      .filter((u) => !typeFilter || (u.degreeTypes || []).includes(typeFilter) || (u.status && u.status[typeFilter]))
      .forEach((u) => {
        const li = document.createElement("li");
        li.className = "admin-row";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "admin-list__item" + (u.slug === slug ? " is-active" : "");
        btn.appendChild(thumbFor(u.slug, u, u.mainImageUrl, "admin-list__thumb"));
        const textCol = document.createElement("span");
        textCol.className = "admin-list__text";
        const name = document.createElement("strong");
        name.textContent = u.name;
        const sub = document.createElement("span");
        sub.textContent = u.country || "";
        textCol.append(name, sub);
        btn.appendChild(textCol);
        // One tag per degree level that has data; blue when an admin entered it.
        const tags = document.createElement("div");
        tags.className = "admin-tags";
        DEGREES.forEach(([d, label]) => {
          const s = u.status && u.status[d];
          if (!s) return;
          const tag = document.createElement("span");
          tag.className = "degree-tag" + (s.manual ? " is-ready" : "");
          tag.textContent = label;
          tags.appendChild(tag);
        });
        if (!tags.children.length) {
          const none = document.createElement("span");
          none.className = "degree-tag";
          none.textContent = "No data yet";
          tags.appendChild(none);
        }
        textCol.appendChild(tags);
        btn.addEventListener("click", () => openUniversity(u.slug));
        li.appendChild(btn);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "admin-del";
        del.title = `Delete ${u.name}`;
        del.setAttribute("aria-label", `Delete ${u.name}`);
        del.innerHTML = TRASH_ICON;
        del.addEventListener("click", () => deleteUniversity(u));
        li.appendChild(del);
        ul.appendChild(li);
      });
  }

  async function loadList() {
    try {
      universities = await api("/universities");
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
    $("c_acceptanceRate").value = typeof config.acceptanceRate === "number" ? String(config.acceptanceRate) : "";
    buildUrlGrid(config);
    $("edTitle").textContent = config.name;
  }

  function collectConfig() {
    const out = { sourceUrls: {}, fieldUrls: {} };
    for (const key of ["name", "shortName", "country", "city", "officialSite"]) out[key] = $(`c_${key}`).value;
    out.acceptanceRate = $("c_acceptanceRate").value;
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
    flash("progSaved", drafts[degree] ? "Unsaved changes" : "", "warn");
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
      flash("configSaved", "", "ok");
      fillConfig(current.config);
      imgNote("");
      renderImages();
      showDegree();
      renderList();
      // On narrow screens the editor sits below the list: bring it into view.
      if (window.innerWidth <= 980) $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      status(err.message, true);
    }
  }

  /* ---------------- photos (Cloudflare R2) ---------------- */

  const UPLOADS_OFF = ".";

  function imgNote(text, isError) {
    const el = $("imgNote");
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function renderImages() {
    const images = current.images || { mainImage: null, gallery: [], uploadsEnabled: false };
    const config = current.config;

    const frame = $("mainImgFrame");
    frame.style.background = UniImages.colorFor(slug);
    frame.querySelectorAll("img").forEach((img) => img.remove());
    $("mainImgLetter").textContent = images.mainImage ? "" : UniImages.initialOf(config);
    if (images.mainImage) {
      const img = document.createElement("img");
      img.src = images.mainImage.url;
      img.alt = `${config.name} main image`;
      frame.prepend(img);
    }
    $("mainImgBtn").textContent = images.mainImage ? "Replace" : "Upload";
    $("mainImgRemove").hidden = !images.mainImage;

    const grid = $("galleryGrid");
    grid.innerHTML = "";
    $("galleryCount").textContent = `(${images.gallery.length} / ${UniImages.MAX_GALLERY})`;
    images.gallery.forEach((photo, i) => {
      const tile = document.createElement("div");
      tile.className = "adm-thumb";
      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = `Photo ${i + 1}`;
      img.loading = "lazy";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "adm-thumb__del";
      del.title = "Delete this photo";
      del.setAttribute("aria-label", `Delete photo ${i + 1}`);
      del.innerHTML = TRASH_ICON;
      del.addEventListener("click", () => deletePhoto(photo.id));
      tile.append(img, del);
      grid.appendChild(tile);
    });
    if (images.gallery.length < UniImages.MAX_GALLERY) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "adm-thumb adm-thumb--add";
      add.id = "addPhotosTile";
      add.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add photos</span>';
      add.addEventListener("click", () => UniImages.pickFiles(true).then(addPhotos));
      grid.appendChild(add);
    }
    if (!images.uploadsEnabled) imgNote(UPLOADS_OFF, true);
  }

  // Keeps the sidebar thumbnail in step with the main image.
  function afterImagesChanged(images) {
    current.images = images;
    renderImages();
    const row = universities.find((u) => u.slug === slug);
    if (row) {
      row.mainImageUrl = images.mainImage ? images.mainImage.url : null;
      renderList();
    }
  }

  function setImagesBusy(busy) {
    $("admImages").classList.toggle("is-busy", busy);
    $("mainImgBtn").disabled = busy;
    $("mainImgRemove").disabled = busy;
  }

  async function uploadMain() {
    const forSlug = slug;
    const [file] = await UniImages.pickFiles(false);
    if (!file || forSlug !== slug) return;
    if (!current.images.uploadsEnabled) return imgNote(UPLOADS_OFF, true);
    setImagesBusy(true);
    imgNote("Uploading the main image…");
    try {
      const images = await UniImages.setMain(forSlug, file);
      if (forSlug === slug) afterImagesChanged(images);
      imgNote("Main image saved to R2.");
    } catch (err) {
      imgNote(`The main image was not saved: ${err.message}`, true);
    } finally {
      setImagesBusy(false);
    }
  }

  async function removeMain() {
    if (!confirm("Remove the main image? The file is deleted from storage.")) return;
    const forSlug = slug;
    setImagesBusy(true);
    try {
      const images = await UniImages.removeMain(forSlug);
      if (forSlug === slug) afterImagesChanged(images);
      imgNote("Main image removed.");
    } catch (err) {
      imgNote(`The main image was not removed: ${err.message}`, true);
    } finally {
      setImagesBusy(false);
    }
  }

  async function addPhotos(files) {
    if (!files.length) return;
    if (!current.images.uploadsEnabled) return imgNote(UPLOADS_OFF, true);
    const forSlug = slug;
    setImagesBusy(true);
    imgNote(`Uploading 0 of ${files.length}…`);
    try {
      const { images, failed } = await UniImages.addToGallery(forSlug, files, (done, total) => imgNote(`Uploading ${done} of ${total}…`));
      if (images && forSlug === slug) afterImagesChanged(images);
      const added = files.length - failed.length;
      imgNote(failed.length ? UniImages.describeFailures(failed) : `Added ${added} ${added === 1 ? "photo" : "photos"}.`, failed.length > 0);
    } finally {
      setImagesBusy(false);
    }
  }

  async function deletePhoto(id) {
    if (!confirm("Delete this photo? The file is deleted from storage.")) return;
    const forSlug = slug;
    try {
      const images = await UniImages.removeFromGallery(forSlug, id);
      if (forSlug === slug) afterImagesChanged(images);
      imgNote("Photo deleted.");
    } catch (err) {
      imgNote(`The photo was not deleted: ${err.message}`, true);
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
      const result = await api(`/universities/${encodeURIComponent(u.slug)}`, { method: "DELETE" });
      if (slug === u.slug) {
        // The university being edited is gone: close its editor.
        slug = null;
        current = null;
        Object.keys(drafts).forEach((k) => delete drafts[k]);
        $("editor").hidden = true;
        $("emptyHint").hidden = false;
      }
      await loadList();
      if (result && result.imagesWarning) status(`Deleted "${u.name}". ${result.imagesWarning}`, true);
      else status(`Deleted "${u.name}".`, false);
    } catch (err) {
      status(`"${u.name}" was not deleted: ${err.message}`, true);
    }
  }

  /* ---------------- adding a university ---------------- */

  const NEW_FIELDS = ["name", "shortName", "country", "city", "officialSite", "acceptanceRate", "slug", "degreeType"];
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
    if (!body.degreeType) return status("Choose the degree type.", true), $("n_degreeType").focus();

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
      flash("configSaved", `Saved to MongoDB at ${new Date().toLocaleTimeString()}`, "ok");
      status("", false);
      $("edTitle").textContent = $("c_name").value;
      await loadList();
    } catch (err) {
      flash("configSaved", "NOT saved", "error");
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
      flash("progSaved", `Saved at ${new Date().toLocaleTimeString()} — ${action || "ok"} in ${saved_to || "MongoDB"}`, "ok");
      status("", false);
      await loadList();
    } catch (err) {
      flash("progSaved", "NOT saved", "error");
      status(`This degree level was not saved: ${err.message}`, true);
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // The page stays hidden until we know the visitor is an administrator.
    // (Just a courtesy: every admin request is checked again by the server.)
    const user = await Auth.requireUser();
    if (!user) return;
    if (user.role !== "admin") {
      window.location.replace("profile.html");
      return;
    }
    document.body.hidden = false;
    Auth.wireTopbar(user);

    $("uniSearch").addEventListener("input", renderList);
    $("uniTypeFilter").addEventListener("change", renderList);
    $("p_fields").addEventListener("input", updateFieldCount);
    $("addSchBtn").addEventListener("click", () => addScholarshipRow());
    $("saveConfigBtn").addEventListener("click", saveConfig);
    $("saveProgBtn").addEventListener("click", saveProgram);
    $("addUniBtn").addEventListener("click", showAddForm);
    $("mainImgBtn").addEventListener("click", uploadMain);
    $("mainImgRemove").addEventListener("click", removeMain);
    // Drop image files anywhere on the Photos section to add them to the gallery.
    const imagesForm = $("imagesForm");
    imagesForm.addEventListener("dragover", (e) => {
      e.preventDefault();
      imagesForm.classList.add("is-drop");
    });
    imagesForm.addEventListener("dragleave", (e) => {
      if (!imagesForm.contains(e.relatedTarget)) imagesForm.classList.remove("is-drop");
    });
    imagesForm.addEventListener("drop", (e) => {
      e.preventDefault();
      imagesForm.classList.remove("is-drop");
      if (slug) addPhotos(UniImages.filesFromDrop(e));
    });
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
    document.querySelectorAll("#programForm input, #programForm textarea").forEach((el) =>
      el.addEventListener("input", () => flash("progSaved", "Unsaved changes", "warn"))
    );
    loadList();
  });
})();
