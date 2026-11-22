/*
 * BilimLaunch — university photos, browser side.
 * Shared by the university page and the admin panel. Uploading is for
 * administrators only (the server checks that on every request).
 *
 * Before uploading, each photo is decoded and re-drawn at a sensible size:
 * that keeps files small (a phone photo of 6 MB becomes ~300-600 KB) and
 * strips EXIF metadata such as the GPS position the photo was taken at.
 */
const UniImages = (() => {
  const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
  const MAX_INPUT_BYTES = 40 * 1024 * 1024; // what we agree to open at all
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // the server's limit
  const MAX_SIDE = { main: 1600, gallery: 2400 };
  const MAX_GALLERY = 40;

  const COLORS = [
    "linear-gradient(145deg,#5ac8fa,#0a84ff)",
    "linear-gradient(145deg,#7d7aff,#5e5ce6)",
    "linear-gradient(145deg,#4cd964,#1fa84b)",
    "linear-gradient(145deg,#ffb340,#ff9500)",
    "linear-gradient(145deg,#ff6482,#ff375f)",
    "linear-gradient(145deg,#bf5af2,#8944ab)",
  ];

  /** The same university always gets the same colour (list card, page avatar, admin list). */
  function colorFor(slug) {
    let h = 0;
    for (const ch of String(slug || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  /** The letter shown while a university has no main image. */
  function initialOf(uni) {
    return String((uni && (uni.shortName || uni.name)) || "?").trim().charAt(0).toUpperCase() || "?";
  }

  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  /** Validates, resizes and re-encodes one image. Resolves a Blob ready to upload. */
  async function prepare(file, kind) {
    if (!ACCEPT.includes(file.type)) throw new Error(`"${file.name}" isn't a JPEG, PNG or WebP image.`);
    if (file.size > MAX_INPUT_BYTES) throw new Error(`"${file.name}" is too large to open (over 40 MB).`);

    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (_) {
      bitmap = null; // a browser that can't decode it here: send the original if it fits
    }
    if (!bitmap) {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(`"${file.name}" is over 8 MB. Please use a smaller photo.`);
      return file;
    }

    const scale = Math.min(1, MAX_SIDE[kind] / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) bitmap.close();

    let blob = await toBlob(canvas, "image/webp", 0.85);
    if (!blob || blob.type !== "image/webp") {
      // No WebP encoder (older Safari): JPEG, on white so transparent PNGs don't turn black.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      blob = await toBlob(canvas, "image/jpeg", 0.86);
    }
    if (!blob) {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(`"${file.name}" could not be prepared for upload.`);
      return file;
    }
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`"${file.name}" is still over 8 MB after resizing.`);
    return blob;
  }

  const base = (slug) => `/api/admin/universities/${encodeURIComponent(slug)}/images`;

  /** Uploads (or replaces) the main image. Resolves the university's photos. */
  async function setMain(slug, file) {
    const blob = await prepare(file, "main");
    return Auth.api(`${base(slug)}/main`, { method: "PUT", body: blob });
  }

  function removeMain(slug) {
    return Auth.api(`${base(slug)}/main`, { method: "DELETE" });
  }

  /**
   * Uploads gallery photos one after another. onProgress(done, total) is called
   * after each. Resolves { images, failed: [{ name, message }] } -- one bad file
   * doesn't stop the rest.
   */
  async function addToGallery(slug, files, onProgress) {
    let images = null;
    const failed = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const blob = await prepare(files[i], "gallery");
        images = await Auth.api(`${base(slug)}/gallery`, { method: "POST", body: blob });
      } catch (err) {
        failed.push({ name: files[i].name, message: err.message });
        if (err.status === 409 || err.status === 503) break; // gallery full / storage off: the rest would fail too
      }
      if (onProgress) onProgress(i + 1, files.length);
    }
    return { images, failed };
  }

  function removeFromGallery(slug, id) {
    return Auth.api(`${base(slug)}/gallery/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Opens the file chooser. Call it straight from a click handler. Resolves an array (empty if cancelled). */
  function pickFiles(multiple) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ACCEPT.join(",");
      input.multiple = !!multiple;
      input.addEventListener("change", () => resolve([...(input.files || [])]));
      input.addEventListener("cancel", () => resolve([]));
      input.click();
    });
  }

  /** Image files from a drag-and-drop event. */
  function filesFromDrop(event) {
    return [...((event.dataTransfer && event.dataTransfer.files) || [])].filter((f) => f.type.startsWith("image/"));
  }

  /** "2 photos couldn't be added: a.heic (isn't a JPEG...)" */
  function describeFailures(failed) {
    if (!failed.length) return "";
    const list = failed.map((f) => `${f.name} (${f.message})`).join("; ");
    return `${failed.length} ${failed.length === 1 ? "photo" : "photos"} couldn't be added: ${list}`;
  }

  return { ACCEPT, MAX_GALLERY, colorFor, initialOf, prepare, setMain, removeMain, addToGallery, removeFromGallery, pickFiles, filesFromDrop, describeFailures };
})();
