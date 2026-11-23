/*
 * BilimLaunch — profile photo on the profile page.
 *
 * Click the photo (or the camera button on it):
 *   - no photo yet  -> pick a picture
 *   - has a photo   -> "Upload new photo" / "Remove current photo"
 * A picked picture opens a crop editor (drag to move, slider / wheel / pinch
 * to zoom, inside a circle like Instagram). The browser then draws the crop
 * onto a 640×640 JPEG and uploads only that — small, square, and with the
 * camera's hidden metadata (such as GPS location) left out.
 * The file is stored in Cloudflare R2 by the server (POST /api/me/avatar).
 */
(function () {
  "use strict";

  const OUT_SIZE = 640; // pixels, square
  const MAX_INPUT_BYTES = 25 * 1024 * 1024; // the original the user picks; what's uploaded is far smaller
  const MAX_ZOOM = 4;

  let user = null;
  let avatarEl = null;
  let busy = false;

  /* ---------------- helpers ---------------- */

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    if (props.className) node.className = props.className;
    if (props.text != null) node.textContent = props.text;
    if (props.html != null) node.innerHTML = props.html; // constant icons only
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
    if (props.on) for (const [k, fn] of Object.entries(props.on)) node.addEventListener(k, fn);
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }

  let toastEl = null;
  let toastTimer = 0;
  function toast(message) {
    if (!toastEl) {
      toastEl = h("div", { className: "dc-toast", attrs: { role: "status", "aria-live": "polite" } });
      document.body.append(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2800);
  }

  function openDialog(className, content, { onClose, label } = {}) {
    const dialog = h("dialog", { className: `dc-dialog ${className}`, attrs: { "aria-label": label } }, content);
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (!document.querySelector("dialog.dc-dialog[open]")) document.documentElement.classList.remove("dc-lock");
      if (onClose) onClose();
    });
    document.body.append(dialog);
    document.documentElement.classList.add("dc-lock");
    dialog.showModal();
    return dialog;
  }

  const letter = () => (user.fullName || user.username || "?").trim().charAt(0).toUpperCase() || "?";

  /* ---------------- the photo on the page ---------------- */

  function render() {
    avatarEl.replaceChildren();
    avatarEl.classList.toggle("has-photo", Boolean(user.avatarUrl));
    if (user.avatarUrl) {
      const img = h("img", { attrs: { src: user.avatarUrl, alt: "", referrerpolicy: "no-referrer", draggable: "false" } });
      img.addEventListener("error", () => {
        avatarEl.classList.remove("has-photo");
        avatarEl.textContent = letter();
      });
      avatarEl.append(img);
    } else {
      avatarEl.textContent = letter();
    }
  }

  function setBusy(on) {
    busy = on;
    avatarEl.parentElement.classList.toggle("is-busy", on);
  }

  function applyUser(next) {
    user = next;
    Auth.setCachedUser(next);
    render();
  }

  /* ---------------- menu ---------------- */

  function openMenu() {
    if (busy) return;
    if (!user.avatarUrl) return pickFile();
    const item = (label, cls, run) =>
      h("button", {
        className: `dc-sheet__item ${cls}`,
        text: label,
        attrs: { type: "button" },
        on: {
          click: () => {
            dialog.close();
            if (run) run();
          },
        },
      });
    const box = h(
      "div",
      { className: "dc-confirm" },
      h("div", { className: "pf-menu__photo" }, h("img", { attrs: { src: user.avatarUrl, alt: "", referrerpolicy: "no-referrer" } })),
      h("h3", { text: "Change profile photo" }),
      h("div", { className: "dc-sheet" }, item("Upload new photo", "is-strong", pickFile), item("Remove current photo", "is-danger", removePhoto), item("Cancel", ""))
    );
    const dialog = openDialog("dc-dialog--sheet", box, { label: "Change profile photo" });
  }

  function pickFile() {
    const input = h("input", { attrs: { type: "file", accept: "image/*" } });
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) openFile(file);
    });
    input.click();
  }

  async function removePhoto() {
    setBusy(true);
    try {
      const data = await Auth.api("/api/me/avatar", { method: "DELETE" });
      applyUser(data.user);
      toast("Profile photo removed");
    } catch (err) {
      toast(err.message || "Couldn't remove the photo.");
    } finally {
      setBusy(false);
    }
  }

  function openFile(file) {
    if (!/^image\//.test(file.type) && file.type) return toast("Please choose a photo (JPEG, PNG or WebP).");
    if (file.size > MAX_INPUT_BYTES) return toast(`That photo is too large (${Math.round(file.size / 1024 / 1024)} MB). Please choose one under 25 MB.`);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth < 100 || img.naturalHeight < 100) {
        URL.revokeObjectURL(url);
        return toast("That photo is too small. Please choose one at least 100 × 100 pixels.");
      }
      openCropper(img, url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast("This photo can't be opened here. Please use a JPEG, PNG or WebP image.");
    };
    img.src = url;
  }

  /* ---------------- crop editor ---------------- */

  function openCropper(img, url) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    img.className = "pf-crop__img";
    img.alt = "";
    img.draggable = false;

    const stage = h(
      "div",
      { className: "pf-crop__stage", attrs: { tabindex: "0", role: "application", "aria-label": "Photo position. Drag or use the arrow keys to move it; plus and minus to zoom." } },
      img,
      h("div", { className: "pf-crop__grid", attrs: { "aria-hidden": "true" } }),
      h("div", { className: "pf-crop__mask", attrs: { "aria-hidden": "true" } })
    );
    const slider = h("input", { className: "pf-crop__zoom", attrs: { type: "range", min: "1", max: String(MAX_ZOOM), step: "0.01", value: "1", "aria-label": "Zoom" } });
    const zoomBtn = (label, sign) =>
      h("button", {
        className: "pf-crop__zbtn",
        text: sign > 0 ? "+" : "−",
        attrs: { type: "button", "aria-label": label },
        on: { click: () => setZoom(zoom * (sign > 0 ? 1.15 : 1 / 1.15)) },
      });
    const error = h("p", { className: "dc-form-error" });
    const saveBtn = h("button", { className: "btn btn-primary btn-small", text: "Save", attrs: { type: "button" } });

    const box = h(
      "div",
      { className: "pf-crop" },
      h(
        "div",
        { className: "dc-dialog__head" },
        h("button", { className: "dc-text-btn", text: "Cancel", attrs: { type: "button" }, on: { click: () => dialog.close() } }),
        h("h3", { text: "Crop your photo" }),
        saveBtn
      ),
      h(
        "div",
        { className: "pf-crop__body" },
        stage,
        h("div", { className: "pf-crop__controls" }, zoomBtn("Zoom out", -1), slider, zoomBtn("Zoom in", 1)),
        h("p", { className: "pf-crop__hint", text: "Drag to reposition · scroll or pinch to zoom" }),
        error
      )
    );

    // Geometry: S = stage size (px). The picture is drawn at `scale` = base * zoom,
    // where base makes its shorter side exactly fill the circle; (ox, oy) is its
    // top-left corner inside the stage. It always covers the whole circle.
    let S = 0;
    let base = 1;
    let zoom = 1;
    let ox = 0;
    let oy = 0;

    function clamp() {
      const w = nw * base * zoom;
      const hgt = nh * base * zoom;
      ox = Math.min(0, Math.max(S - w, ox));
      oy = Math.min(0, Math.max(S - hgt, oy));
    }
    function draw() {
      clamp();
      img.style.width = `${nw * base * zoom}px`;
      img.style.height = `${nh * base * zoom}px`;
      img.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
      slider.value = String(zoom);
    }
    /** Zoom to z, keeping the point (cx, cy) of the stage where it is. */
    function setZoom(z, cx = S / 2, cy = S / 2) {
      z = Math.min(MAX_ZOOM, Math.max(1, z));
      const before = base * zoom;
      const after = base * z;
      ox = cx - ((cx - ox) / before) * after;
      oy = cy - ((cy - oy) / before) * after;
      zoom = z;
      draw();
    }
    function layout() {
      const next = stage.clientWidth;
      if (!next) return;
      if (S) {
        ox *= next / S;
        oy *= next / S;
      }
      S = next;
      base = S / Math.min(nw, nh);
      draw();
    }

    // Dragging with mouse / one finger; pinch with two fingers.
    const pointers = new Map();
    let pinch = null;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    stage.addEventListener("pointerdown", (e) => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: dist(a, b) || 1, z: zoom };
      }
      stage.classList.add("is-dragging");
    });
    stage.addEventListener("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 1) {
        ox += dx;
        oy += dy;
        draw();
      } else if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const r = stage.getBoundingClientRect();
        setZoom((pinch.z * dist(a, b)) / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      }
    });
    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) stage.classList.remove("is-dragging");
    };
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointercancel", release);
    stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false }
    );
    stage.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 40 : 10;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) {
        e.preventDefault();
        ox += moves[e.key][0];
        oy += moves[e.key][1];
        draw();
      } else if (e.key === "+" || e.key === "=") setZoom(zoom * 1.15);
      else if (e.key === "-" || e.key === "_") setZoom(zoom / 1.15);
    });
    slider.addEventListener("input", () => setZoom(Number(slider.value)));

    function exportBlob() {
      const canvas = document.createElement("canvas");
      canvas.width = OUT_SIZE;
      canvas.height = OUT_SIZE;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0b0d12"; // behind transparent PNGs
      ctx.fillRect(0, 0, OUT_SIZE, OUT_SIZE);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const scale = base * zoom;
      ctx.drawImage(img, -ox / scale, -oy / scale, S / scale, S / scale, 0, 0, OUT_SIZE, OUT_SIZE);
      return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    }

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      error.textContent = "";
      setBusy(true);
      try {
        const blob = await exportBlob();
        if (!blob) throw new Error("Couldn't prepare the photo. Please try a different one.");
        const data = await Auth.upload("/api/me/avatar", blob);
        applyUser(data.user);
        dialog.close();
        toast("Profile photo updated");
      } catch (err) {
        error.textContent = err.message || "Couldn't save the photo.";
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
      } finally {
        setBusy(false);
      }
    });

    const onResize = () => layout();
    const dialog = openDialog("pf-dialog--crop", box, {
      label: "Crop your photo",
      onClose: () => {
        window.removeEventListener("resize", onResize);
        URL.revokeObjectURL(url);
      },
    });
    window.addEventListener("resize", onResize);
    layout();
    // Start centred.
    ox = (S - nw * base) / 2;
    oy = (S - nh * base) / 2;
    draw();
    stage.focus({ preventScroll: true });
  }

  /* ---------------- start ---------------- */

  window.ProfilePhoto = {
    /** Called by app.js once the signed-in user is known. */
    init(currentUser, el) {
      user = currentUser;
      avatarEl = el;
      render();
      avatarEl.addEventListener("click", openMenu);
      const edit = document.getElementById("avatarEditBtn");
      if (edit) edit.addEventListener("click", openMenu);
    },
  };
})();
