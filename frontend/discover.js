/*
 * BilimLaunch — Discover: an Instagram-style feed of news and opportunities.
 *
 * Everybody signed in can like, comment, share and save posts; only admins
 * see the composer (the server checks the role on every write anyway).
 * Opening discover.html?post=<id> shows that one post (this is the link that
 * "Share" hands out).
 *
 * All user text is put on the page with textContent / DOM nodes, never as HTML.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  const $ = (sel, scope = document) => scope.querySelector(sel);

  /** h("div", { className, text, attrs, on }, ...children) */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    if (props.className) node.className = props.className;
    if (props.text != null) node.textContent = props.text;
    if (props.html != null) node.innerHTML = props.html; // constants only (icons)
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
    if (props.on) for (const [k, fn] of Object.entries(props.on)) node.addEventListener(k, fn);
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }

  const ICONS = {
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.6s-7.6-4.6-9.4-9.5C1.4 7.9 3.4 4.4 7 4.4c2.1 0 3.7 1.2 5 3 1.3-1.8 2.9-3 5-3 3.6 0 5.6 3.5 4.4 6.7-1.8 4.9-9.4 9.5-9.4 9.5z"/></svg>',
    comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.7 16.1A9 9 0 1 0 16.9 19.9L21.5 21z"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 2.5 10.6 13.4"/><path d="M21.5 2.5 15 21.2l-4.4-7.8L2.8 9z"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.5 21 12 15.8 5.5 21V3.5h13z"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true" class="is-filled"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6 8.5 12l6 6"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
    soundOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true" class="is-filled"><path d="M8 5.5v13l11-6.5z"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L11.6 6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/></svg>',
    media: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m21 15-4.5-4.5L7 20"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };

  const icon = (name, className = "dc-icon") => h("span", { className, html: ICONS[name] });

  const nf = new Intl.NumberFormat("en-US");

  function likesText(n) {
    if (!n) return "Be the first to like this";
    return `${nf.format(n)} ${n === 1 ? "like" : "likes"}`;
  }

  /** The "2 likes" line under a post: opens the list of who liked it (people.js). */
  function likesEl(post) {
    return h("button", {
      className: "dc-likes",
      attrs: { type: "button", "aria-haspopup": "dialog", title: "See who liked this" },
      on: { click: () => (state.posts.get(post.id) || post).likeCount && People.openLikes(post.id) },
    });
  }

  /** "now", "5m", "3h", "2d", "4w", "Nov 23" — the short form used in headers and comments. */
  function shortAgo(iso) {
    const date = new Date(iso);
    const s = (Date.now() - date.getTime()) / 1000;
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    if (s < 5 * 7 * 86400) return `${Math.floor(s / (7 * 86400))}w`;
    return longDate(date);
  }

  function longDate(date) {
    const opts = { month: "long", day: "numeric" };
    if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return date.toLocaleDateString("en-US", opts);
  }

  /** "2 hours ago" / "November 23" — under a post, like Instagram. */
  function longAgo(iso) {
    const date = new Date(iso);
    const s = (Date.now() - date.getTime()) / 1000;
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    if (s < 60) return "just now";
    if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
    if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
    if (s < 7 * 86400) return rtf.format(-Math.floor(s / 86400), "day");
    return longDate(date);
  }

  function timeEl(iso, text, className) {
    return h("time", { className, text, attrs: { datetime: iso, title: new Date(iso).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" }) } });
  }

  function fmtMB(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function fmtLength(seconds) {
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  /** Avatar circle: the photo if there is one, otherwise the first letter. Blue ring like a story ring. */
  function avatar(person, size = "") {
    const inner = person.avatarUrl
      ? h("img", { attrs: { src: person.avatarUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" } })
      : h("span", { text: (person.name || person.username || "?").trim().charAt(0).toUpperCase() || "?" });
    return h("span", { className: `dc-avatar ${size}`.trim(), attrs: { "aria-hidden": "true" } }, inner);
  }

  /** Wraps an avatar / username in a link to that person's profile (people.js). Deleted users get no link. */
  function userLink(username, ...children) {
    if (!username || typeof People === "undefined") return h("span", { className: "dc-user-link" }, ...children);
    return h("a", { className: "dc-user-link", attrs: { href: People.url(username) } }, ...children);
  }

  /** Caption / comment text: links become clickable, #tags and @mentions are highlighted. */
  const TOKEN_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,:;'!?)\]])|([#@][\p{L}\p{N}_.]*[\p{L}\p{N}_])/gu;
  function richText(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(TOKEN_RE)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      if (m[1]) {
        frag.append(h("a", { text: m[1].replace(/^https?:\/\//, ""), attrs: { href: m[1], target: "_blank", rel: "noopener noreferrer nofollow ugc" } }));
      } else {
        frag.append(h("span", { className: "dc-tag", text: m[2] }));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  const CAPTION_PREVIEW = 140;

  /** "username caption" with a "more" button for long captions. */
  function captionEl(post, { full = false } = {}) {
    const box = h("div", { className: "dc-caption" }, userLink(post.author.username, h("strong", { className: "dc-username", text: post.author.username })), " ");
    const text = post.caption || "";
    const lines = text.split("\n");
    const long = !full && (text.length > CAPTION_PREVIEW || lines.length > 3);
    const body = h("span", { className: "dc-caption__text" });
    if (long) {
      let cut = lines.slice(0, 3).join("\n").slice(0, CAPTION_PREVIEW);
      const space = cut.lastIndexOf(" ");
      if (space > CAPTION_PREVIEW * 0.6) cut = cut.slice(0, space);
      body.append(richText(cut.trimEnd()), "… ");
      const more = h("button", {
        className: "dc-more",
        text: "more",
        attrs: { type: "button" },
        on: {
          click: () => {
            body.replaceChildren(richText(text));
          },
        },
      });
      body.append(more);
    } else {
      body.append(richText(text));
    }
    box.append(body);
    if (post.edited) box.append(h("span", { className: "dc-edited", text: " · edited" }));
    return box;
  }

  /* ---------------- toast ---------------- */

  let toastTimer = 0;
  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2600);
  }

  /* ---------------- dialogs ---------------- */

  /** Opens a modal <dialog>. Closes on Esc / backdrop click; removed from the page when closed. */
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

  /** A centered list of actions, like Instagram's "..." menu. */
  function actionSheet(actions) {
    const list = h("div", { className: "dc-sheet" });
    const dialog = openDialog("dc-dialog--sheet", list, { label: "Post options" });
    for (const a of actions) {
      list.append(
        h("button", {
          className: `dc-sheet__item${a.danger ? " is-danger" : ""}${a.strong ? " is-strong" : ""}`,
          text: a.label,
          attrs: { type: "button" },
          on: {
            click: () => {
              dialog.close();
              if (a.run) a.run();
            },
          },
        })
      );
    }
    list.append(h("button", { className: "dc-sheet__item", text: "Cancel", attrs: { type: "button" }, on: { click: () => dialog.close() } }));
    return dialog;
  }

  function confirmDialog({ title, text, confirm, danger }) {
    return new Promise((resolve) => {
      let answer = false;
      const box = h(
        "div",
        { className: "dc-confirm" },
        h("h3", { text: title }),
        text ? h("p", { text }) : null,
        h(
          "div",
          { className: "dc-sheet" },
          h("button", {
            className: `dc-sheet__item ${danger ? "is-danger" : "is-strong"}`,
            text: confirm,
            attrs: { type: "button" },
            on: {
              click: () => {
                answer = true;
                dialog.close();
              },
            },
          }),
          h("button", { className: "dc-sheet__item", text: "Cancel", attrs: { type: "button" }, on: { click: () => dialog.close() } })
        )
      );
      const dialog = openDialog("dc-dialog--sheet", box, { onClose: () => resolve(answer), label: title });
    });
  }

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */

  const state = {
    user: null,
    canPost: false,
    limits: null,
    posts: new Map(), // id -> post
    views: new Map(), // id -> Set of refresh functions (feed card, open modal)
    cursor: null,
    loading: false,
    done: false,
    muted: true,
  };

  function watch(id, fn) {
    if (!state.views.has(id)) state.views.set(id, new Set());
    state.views.get(id).add(fn);
    return () => state.views.get(id) && state.views.get(id).delete(fn);
  }

  /** Merges changes into a post and redraws every view of it. */
  function patchPost(id, changes) {
    const post = state.posts.get(id);
    if (!post) return;
    Object.assign(post, changes);
    (state.views.get(id) || new Set()).forEach((fn) => fn(post));
  }

  function rememberPost(post) {
    const existing = state.posts.get(post.id);
    if (existing) {
      Object.assign(existing, post);
      return existing;
    }
    state.posts.set(post.id, post);
    return post;
  }

  const shareUrl = (id) => `${location.origin}/discover.html?post=${encodeURIComponent(id)}`;

  /* ------------------------------------------------------------------ */
  /* Actions: like, save, share, comment                                */
  /* ------------------------------------------------------------------ */

  const pending = new Set();

  async function toggleLike(post, forceLike = false) {
    if (forceLike && post.liked) return;
    const key = `like:${post.id}`;
    if (pending.has(key)) return;
    pending.add(key);
    const liked = !post.liked;
    const before = { liked: post.liked, likeCount: post.likeCount };
    patchPost(post.id, { liked, likeCount: Math.max(0, post.likeCount + (liked ? 1 : -1)) });
    try {
      const data = await Auth.api(`/api/posts/${post.id}/like`, { method: liked ? "PUT" : "DELETE" });
      patchPost(post.id, { liked: data.liked, likeCount: data.likeCount });
    } catch (err) {
      patchPost(post.id, before);
      toast(err.message || "Couldn't update the like.");
    } finally {
      pending.delete(key);
    }
  }

  async function toggleSave(post) {
    const key = `save:${post.id}`;
    if (pending.has(key)) return;
    pending.add(key);
    const saved = !post.saved;
    patchPost(post.id, { saved });
    try {
      await Auth.api(`/api/posts/${post.id}/save`, { method: saved ? "PUT" : "DELETE" });
      toast(saved ? "Saved to your profile" : "Removed from saved");
    } catch (err) {
      patchPost(post.id, { saved: !saved });
      toast(err.message || "Couldn't save the post.");
    } finally {
      pending.delete(key);
    }
  }

  async function copyLink(post) {
    const url = shareUrl(post.id);
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch (_) {
      window.prompt("Copy this link:", url);
    }
  }

  function shareText(post) {
    const first = (post.caption || "").split("\n")[0].slice(0, 120);
    return first || "Check out this opportunity on BilimLaunch";
  }

  function openShare(post) {
    const url = shareUrl(post.id);
    const text = shareText(post);
    const enc = encodeURIComponent;
    const targets = [
      { label: "Telegram", cls: "is-telegram", href: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}` },
      { label: "WhatsApp", cls: "is-whatsapp", href: `https://wa.me/?text=${enc(`${text} ${url}`)}` },
      { label: "X", cls: "is-x", href: `https://twitter.com/intent/tweet?url=${enc(url)}&text=${enc(text)}` },
      { label: "Email", cls: "is-email", href: `mailto:?subject=${enc(text)}&body=${enc(`${text}\n\n${url}`)}` },
    ];

    const grid = h("div", { className: "dc-share__grid" });
    for (const t of targets) {
      grid.append(
        h(
          "a",
          { className: `dc-share__target ${t.cls}`, attrs: { href: t.href, target: "_blank", rel: "noopener noreferrer" }, on: { click: () => dialog.close() } },
          h("span", { className: "dc-share__bubble", text: t.label.charAt(0) }),
          h("span", { text: t.label })
        )
      );
    }

    const linkRow = h(
      "div",
      { className: "dc-share__link" },
      h("input", { attrs: { type: "text", value: url, readonly: true, "aria-label": "Post link" }, on: { focus: (e) => e.target.select() } }),
      h("button", {
        className: "btn btn-primary btn-small",
        text: "Copy link",
        attrs: { type: "button" },
        on: {
          click: () => {
            copyLink(post);
            dialog.close();
          },
        },
      })
    );

    const box = h(
      "div",
      { className: "dc-share" },
      h(
        "div",
        { className: "dc-dialog__head" },
        h("h3", { text: "Share" }),
        h("button", { className: "dc-icon-btn", html: ICONS.close, attrs: { type: "button", "aria-label": "Close" }, on: { click: () => dialog.close() } })
      ),
      h("p", { className: "dc-share__hint", text: "Send this to a friend who should see it." }),
      grid,
      linkRow,
      navigator.share
        ? h("button", {
            className: "btn btn-secondary btn-small dc-share__more",
            text: "More options…",
            attrs: { type: "button" },
            on: {
              click: () => {
                dialog.close();
                navigator.share({ title: "BilimLaunch", text, url }).catch(() => {});
              },
            },
          })
        : null
    );
    const dialog = openDialog("dc-dialog--share", box, { label: "Share post" });
  }

  function openOptions(post) {
    const actions = [];
    if (state.canPost) {
      actions.push({ label: "Delete", danger: true, run: () => deletePost(post) });
      actions.push({ label: "Edit caption", run: () => editCaption(post) });
    }
    actions.push({ label: "Go to post", run: () => openPost(post.id) });
    actions.push({ label: "Share to…", run: () => openShare(post) });
    actions.push({ label: "Copy link", run: () => copyLink(post) });
    actions.push({ label: post.saved ? "Remove from saved" : "Save", run: () => toggleSave(post) });
    actionSheet(actions);
  }

  /* ---------------- admin: edit / delete ---------------- */

  async function deletePost(post) {
    const ok = await confirmDialog({ title: "Delete post?", text: "The post, its likes and comments will be removed for everyone.", confirm: "Delete", danger: true });
    if (!ok) return;
    try {
      await Auth.api(`/api/posts/${post.id}`, { method: "DELETE" });
      const card = document.querySelector(`.dc-post[data-id="${post.id}"]`);
      if (card) {
        card.classList.add("is-removing");
        setTimeout(() => card.remove(), 350);
      }
      if (modal && modal.postId === post.id) modal.dialog.close();
      state.posts.delete(post.id);
      state.views.delete(post.id);
      toast("Post deleted");
      if (!state.posts.size) renderEmpty();
    } catch (err) {
      toast(err.message || "Couldn't delete the post.");
    }
  }

  function editCaption(post) {
    const max = (state.limits && state.limits.maxCaption) || 2200;
    const textarea = h("textarea", { className: "dc-textarea", attrs: { rows: 8, maxlength: max, "aria-label": "Caption" } });
    textarea.value = post.caption || "";
    const counter = h("span", { className: "dc-counter" });
    const sync = () => (counter.textContent = `${textarea.value.length} / ${max}`);
    textarea.addEventListener("input", sync);
    sync();
    const error = h("p", { className: "dc-form-error" });
    const saveBtn = h("button", { className: "btn btn-primary btn-small", text: "Save", attrs: { type: "submit" } });
    const form = h(
      "form",
      { className: "dc-edit" },
      h(
        "div",
        { className: "dc-dialog__head" },
        h("button", { className: "dc-text-btn", text: "Cancel", attrs: { type: "button" }, on: { click: () => dialog.close() } }),
        h("h3", { text: "Edit caption" }),
        saveBtn
      ),
      h("div", { className: "dc-edit__body" }, textarea, counter, error)
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      error.textContent = "";
      try {
        const data = await Auth.api(`/api/posts/${post.id}`, { method: "PATCH", body: { caption: textarea.value } });
        patchPost(post.id, { caption: data.post.caption, edited: data.post.edited });
        dialog.close();
        toast("Caption updated");
      } catch (err) {
        error.textContent = err.message;
        saveBtn.disabled = false;
      }
    });
    const dialog = openDialog("dc-dialog--edit", form, { label: "Edit caption" });
    textarea.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Media: carousel, videos, double-tap like                          */
  /* ------------------------------------------------------------------ */

  const videoObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const video = entry.target;
              if (entry.isIntersecting && entry.intersectionRatio >= 0.6 && !video.dataset.userPaused) {
                video.muted = state.muted;
                video.play().catch(() => {});
              } else {
                video.pause();
              }
            }
          },
          { threshold: [0, 0.6, 1] }
        )
      : null;

  function syncMuteButtons() {
    document.querySelectorAll(".dc-mute").forEach((btn) => {
      btn.innerHTML = state.muted ? ICONS.soundOff : ICONS.soundOn;
      btn.setAttribute("aria-label", state.muted ? "Turn sound on" : "Turn sound off");
    });
    document.querySelectorAll(".dc-slide video").forEach((v) => (v.muted = state.muted));
  }

  /** Frame shape from the first photo/video, kept between 4:5 (tall) and 1.91:1 (wide), like Instagram. */
  function frameRatio(media) {
    const first = media[0];
    if (!first || !first.width || !first.height) return 1;
    return Math.min(1.91, Math.max(0.8, first.width / first.height));
  }

  /**
   * The photo/video area of a post. `onDoubleTap` likes the post.
   * In the modal (`fill`), the frame fills the available height instead.
   */
  function mediaEl(post, { onDoubleTap, fill = false } = {}) {
    const frame = h("div", { className: `dc-media${fill ? " dc-media--fill" : ""}` });
    if (!fill) frame.style.aspectRatio = String(frameRatio(post.media));
    const track = h("div", { className: "dc-media__track" });
    frame.append(track);

    post.media.forEach((m, i) => {
      const slide = h("div", { className: "dc-slide", attrs: { "aria-roledescription": "slide", "aria-label": `${i + 1} of ${post.media.length}` } });
      if (m.kind === "video") {
        const video = h("video", {
          attrs: { src: m.url, playsinline: true, loop: true, preload: "metadata", "aria-label": "Video" },
        });
        video.muted = true;
        slide.append(video);
        const playBadge = h("span", { className: "dc-play-badge", html: ICONS.play });
        slide.append(playBadge);
        video.addEventListener("play", () => slide.classList.remove("is-paused"));
        video.addEventListener("pause", () => slide.classList.add("is-paused"));
        slide.classList.add("is-paused");
        slide.append(
          h("button", {
            className: "dc-mute",
            html: state.muted ? ICONS.soundOff : ICONS.soundOn,
            attrs: { type: "button", "aria-label": state.muted ? "Turn sound on" : "Turn sound off" },
            on: {
              click: (e) => {
                e.stopPropagation();
                state.muted = !state.muted;
                syncMuteButtons();
                if (!state.muted && video.paused) video.play().catch(() => {});
              },
            },
          })
        );
        if (videoObserver) videoObserver.observe(video);
      } else {
        slide.append(h("img", { attrs: { src: m.url, alt: "", loading: i === 0 ? "eager" : "lazy", decoding: "async", draggable: "false" } }));
      }
      track.append(slide);
    });

    // Single tap on a video: play / pause. Double tap anywhere: like (with a heart burst).
    // Timed by hand: phones don't reliably report click counts for taps.
    let tapTimer = 0;
    let lastTap = 0;
    frame.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const slide = e.target.closest(".dc-slide");
      const now = performance.now();
      if (now - lastTap < 320) {
        lastTap = 0;
        clearTimeout(tapTimer);
        burst(frame, e);
        if (onDoubleTap) onDoubleTap();
        return;
      }
      lastTap = now;
      const video = slide && slide.querySelector("video");
      if (!video) return;
      tapTimer = setTimeout(() => {
        if (video.paused) {
          delete video.dataset.userPaused;
          video.muted = state.muted;
          video.play().catch(() => {});
        } else {
          video.dataset.userPaused = "1";
          video.pause();
        }
      }, 230);
    });

    if (post.media.length > 1) {
      const prev = h("button", { className: "dc-nav dc-nav--prev", html: ICONS.prev, attrs: { type: "button", "aria-label": "Previous" } });
      const next = h("button", { className: "dc-nav dc-nav--next", html: ICONS.next, attrs: { type: "button", "aria-label": "Next" } });
      const dots = h("div", { className: "dc-dots", attrs: { "aria-hidden": "true" } }, post.media.map(() => h("span")));
      const counter = h("span", { className: "dc-counter-pill" });
      frame.append(prev, next, dots, counter);

      const go = (dir) => track.scrollBy({ left: dir * track.clientWidth, behavior: "smooth" });
      prev.addEventListener("click", () => go(-1));
      next.addEventListener("click", () => go(1));

      let current = -1;
      const update = () => {
        const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        if (index === current) return;
        current = index;
        prev.hidden = index <= 0;
        next.hidden = index >= post.media.length - 1;
        [...dots.children].forEach((d, i) => d.classList.toggle("is-active", i === index));
        counter.textContent = `${index + 1}/${post.media.length}`;
        // Only the visible slide's video keeps playing.
        [...track.children].forEach((s, i) => {
          const v = s.querySelector("video");
          if (v && i !== index) v.pause();
        });
      };
      track.addEventListener("scroll", () => requestAnimationFrame(update), { passive: true });
      frame.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") go(-1);
        if (e.key === "ArrowRight") go(1);
      });
      update();
    }
    return frame;
  }

  function burst(frame, e) {
    const rect = frame.getBoundingClientRect();
    const heart = h("span", { className: "dc-burst", html: ICONS.heart });
    heart.style.left = `${e.clientX - rect.left}px`;
    heart.style.top = `${e.clientY - rect.top}px`;
    frame.append(heart);
    heart.addEventListener("animationend", () => heart.remove());
  }

  /** The like / comment / share ... save row. Returns { el, refresh(post) }. */
  function actionsEl(post, { onComment }) {
    const like = h("button", { className: "dc-action dc-action--like", html: ICONS.heart, attrs: { type: "button" }, on: { click: () => toggleLike(state.posts.get(post.id) || post) } });
    const comment = h("button", { className: "dc-action", html: ICONS.comment, attrs: { type: "button", "aria-label": "Comment" }, on: { click: onComment } });
    const share = h("button", { className: "dc-action", html: ICONS.share, attrs: { type: "button", "aria-label": "Share" }, on: { click: () => openShare(post) } });
    const save = h("button", { className: "dc-action dc-action--save", html: ICONS.save, attrs: { type: "button" }, on: { click: () => toggleSave(state.posts.get(post.id) || post) } });
    const el = h("div", { className: "dc-actions" }, like, comment, share, h("span", { className: "dc-actions__spacer" }), save);
    const refresh = (p) => {
      like.classList.toggle("is-on", p.liked);
      like.setAttribute("aria-pressed", p.liked ? "true" : "false");
      like.setAttribute("aria-label", p.liked ? "Unlike" : "Like");
      save.classList.toggle("is-on", p.saved);
      save.setAttribute("aria-pressed", p.saved ? "true" : "false");
      save.setAttribute("aria-label", p.saved ? "Remove from saved" : "Save");
    };
    refresh(post);
    // Pop animation only when the state flips.
    like.addEventListener("click", () => {
      like.classList.remove("is-pop");
      void like.offsetWidth;
      like.classList.add("is-pop");
    });
    return { el, refresh };
  }

  /* ------------------------------------------------------------------ */
  /* Comments                                                           */
  /* ------------------------------------------------------------------ */

  function commentEl(comment, post, onDeleted) {
    const meta = h("div", { className: "dc-comment__meta" }, timeEl(comment.createdAt, shortAgo(comment.createdAt)));
    if (comment.canDelete) {
      meta.append(
        h("button", {
          className: "dc-text-btn dc-text-btn--muted",
          text: "Delete",
          attrs: { type: "button" },
          on: {
            click: async () => {
              const ok = await confirmDialog({ title: "Delete comment?", confirm: "Delete", danger: true });
              if (!ok) return;
              try {
                const data = await Auth.api(`/api/posts/${post.id}/comments/${comment.id}`, { method: "DELETE" });
                row.remove();
                patchPost(post.id, { commentCount: data.commentCount });
                if (onDeleted) onDeleted();
              } catch (err) {
                toast(err.message || "Couldn't delete the comment.");
              }
            },
          },
        })
      );
    }
    const row = h(
      "div",
      { className: "dc-comment" },
      userLink(comment.author.username, avatar(comment.author, "dc-avatar--sm")),
      h(
        "div",
        { className: "dc-comment__body" },
        h("p", {}, userLink(comment.author.username, h("strong", { className: "dc-username", text: comment.author.username || comment.author.name })), " ", richText(comment.body)),
        meta
      )
    );
    return row;
  }

  /** "Add a comment…" box. `onPosted(comment)` runs after the server accepted it. */
  function commentForm(post, onPosted) {
    const max = 1000;
    const input = h("textarea", { className: "dc-add-comment__input", attrs: { rows: 1, placeholder: "Add a comment…", maxlength: max, "aria-label": "Add a comment" } });
    const send = h("button", { className: "dc-add-comment__send", text: "Post", attrs: { type: "submit", disabled: true } });
    const form = h("form", { className: "dc-add-comment" }, input, send);
    const autosize = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
      send.disabled = !input.value.trim();
    };
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body || send.disabled) return;
      send.disabled = true;
      input.disabled = true;
      try {
        const data = await Auth.api(`/api/posts/${post.id}/comments`, { method: "POST", body: { body } });
        input.value = "";
        patchPost(post.id, { commentCount: data.commentCount });
        onPosted(data.comment);
      } catch (err) {
        toast(err.message || "Couldn't post the comment.");
      } finally {
        input.disabled = false;
        autosize();
        input.focus();
      }
    });
    return { form, input };
  }

  /* ------------------------------------------------------------------ */
  /* Feed card                                                          */
  /* ------------------------------------------------------------------ */

  function postHeader(post) {
    return h(
      "header",
      { className: "dc-post__head" },
      userLink(post.author.username, avatar(post.author)),
      h(
        "div",
        { className: "dc-post__who" },
        userLink(post.author.username, h("strong", { className: "dc-username", text: post.author.username })),
        h("span", { className: "dc-dot", text: "•", attrs: { "aria-hidden": "true" } }),
        timeEl(post.createdAt, shortAgo(post.createdAt), "dc-post__ago")
      ),
      h("button", { className: "dc-icon-btn dc-post__more", html: ICONS.more, attrs: { type: "button", "aria-label": "More options" }, on: { click: () => openOptions(state.posts.get(post.id) || post) } })
    );
  }

  function postCard(post) {
    const card = h("article", { className: "dc-post", attrs: { "data-id": post.id, "aria-label": `Post by ${post.author.username}` } });
    const actions = actionsEl(post, { onComment: () => openPost(post.id, { focusComment: true }) });
    const likes = likesEl(post);
    let caption = captionEl(post);
    const viewComments = h("button", { className: "dc-view-comments", attrs: { type: "button" }, on: { click: () => openPost(post.id) } });
    const mine = h("div", { className: "dc-my-comments" });
    const { form } = commentForm(post, (comment) => {
      // Like Instagram: your new comment shows under the post right away.
      mine.append(commentEl(comment, post));
    });

    card.append(
      postHeader(post),
      mediaEl(post, { onDoubleTap: () => toggleLike(state.posts.get(post.id), true) }),
      h("div", { className: "dc-post__body" }, actions.el, likes, caption, viewComments, mine, timeEl(post.createdAt, longAgo(post.createdAt), "dc-post__date")),
      form
    );

    let lastCaption = post.caption;
    let lastEdited = post.edited;
    const refresh = (p) => {
      actions.refresh(p);
      likes.textContent = likesText(p.likeCount);
      likes.classList.toggle("is-empty", !p.likeCount);
      likes.disabled = !p.likeCount;
      viewComments.hidden = !p.commentCount;
      viewComments.textContent = p.commentCount === 1 ? "View 1 comment" : `View all ${nf.format(p.commentCount)} comments`;
      if (p.caption !== lastCaption || p.edited !== lastEdited) {
        lastCaption = p.caption;
        lastEdited = p.edited;
        const fresh = captionEl(p);
        caption.replaceWith(fresh);
        caption = fresh;
      }
      caption.hidden = !p.caption;
    };
    refresh(post);
    watch(post.id, refresh);
    return card;
  }

  /* ------------------------------------------------------------------ */
  /* Post modal (comments view) — also what a shared link opens         */
  /* ------------------------------------------------------------------ */

  let modal = null; // { dialog, postId }

  async function openPost(id, { focusComment = false, fromLink = false } = {}) {
    let post = state.posts.get(id);
    if (!post) {
      try {
        post = rememberPost((await Auth.api(`/api/posts/${encodeURIComponent(id)}`)).post);
      } catch (err) {
        toast(err.status === 404 ? "That post isn't available anymore." : err.message);
        if (fromLink) history.replaceState(null, "", "discover.html");
        return;
      }
    }
    if (modal && modal.postId === id) return;
    if (modal) {
      modal.keepUrl = true; // replaced by the new post: leave the address alone
      modal.dialog.close();
    }
    // Feed videos stop while a post is open.
    feed.querySelectorAll("video").forEach((v) => v.pause());

    const comments = h("div", { className: "dc-modal__comments" });
    const list = h("div", { className: "dc-comment-list" });
    const loadMore = h("button", { className: "dc-load-more", attrs: { type: "button" }, html: ICONS.plus });
    loadMore.setAttribute("aria-label", "Load more comments");
    loadMore.hidden = true;

    const captionBlock = h(
      "div",
      { className: "dc-comment dc-comment--caption" },
      userLink(post.author.username, avatar(post.author, "dc-avatar--sm")),
      h("div", { className: "dc-comment__body" }, captionEl(post, { full: true }), h("div", { className: "dc-comment__meta" }, timeEl(post.createdAt, shortAgo(post.createdAt))))
    );
    if (!post.caption) captionBlock.hidden = true;
    const empty = h("div", { className: "dc-no-comments" }, h("strong", { text: "No comments yet." }), h("span", { text: "Start the conversation." }));
    comments.append(captionBlock, list, loadMore, empty);

    const actions = actionsEl(post, { onComment: () => input.focus() });
    const likes = likesEl(post);
    const { form, input } = commentForm(post, (comment) => {
      list.append(commentEl(comment, post, syncEmpty));
      syncEmpty();
      comments.scrollTop = comments.scrollHeight;
    });

    const side = h(
      "div",
      { className: "dc-modal__side" },
      postHeader(post),
      comments,
      h("div", { className: "dc-modal__footer" }, actions.el, likes, timeEl(post.createdAt, longAgo(post.createdAt), "dc-post__date")),
      form
    );
    const inner = h("div", { className: "dc-modal__inner" }, h("div", { className: "dc-modal__media" }, mediaEl(post, { fill: true, onDoubleTap: () => toggleLike(state.posts.get(post.id), true) })), side);
    const closeBtn = h("button", { className: "dc-modal__close", html: ICONS.close, attrs: { type: "button", "aria-label": "Close" } });

    function syncEmpty() {
      empty.hidden = list.children.length > 0 || loadMore.hidden === false;
    }

    let captionText = post.caption;
    const refresh = (p) => {
      actions.refresh(p);
      likes.textContent = likesText(p.likeCount);
      likes.classList.toggle("is-empty", !p.likeCount);
      likes.disabled = !p.likeCount;
      if (p.caption !== captionText) {
        captionText = p.caption;
        captionBlock.querySelector(".dc-caption").replaceWith(captionEl(p, { full: true }));
        captionBlock.hidden = !p.caption;
      }
    };
    refresh(post);
    const unwatch = watch(post.id, refresh);

    if (!fromLink) history.pushState({ post: id }, "", `discover.html?post=${encodeURIComponent(id)}`);

    const dialog = openDialog("dc-dialog--post", h("div", {}, closeBtn, inner), {
      label: `Post by ${post.author.username}`,
      onClose: () => {
        unwatch();
        dialog.querySelectorAll("video").forEach((v) => {
          v.pause();
          if (videoObserver) videoObserver.unobserve(v);
        });
        const keepUrl = modal && modal.dialog === dialog && modal.keepUrl;
        if (modal && modal.dialog === dialog) modal = null;
        if (keepUrl) return;
        const params = new URLSearchParams(location.search);
        if (params.get("post") === id) {
          if (history.state && history.state.post === id) history.back();
          else history.replaceState(null, "", "discover.html");
        }
      },
    });
    closeBtn.addEventListener("click", () => dialog.close());
    modal = { dialog, postId: id, keepUrl: false };

    // Comments, oldest first, 30 at a time.
    let cursor = null;
    async function loadComments() {
      loadMore.disabled = true;
      try {
        const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const data = await Auth.api(`/api/posts/${post.id}/comments${q}`);
        for (const c of data.comments) list.append(commentEl(c, post, syncEmpty));
        cursor = data.nextCursor;
        loadMore.hidden = !cursor;
      } catch (err) {
        toast(err.message || "Couldn't load comments.");
      } finally {
        loadMore.disabled = false;
        syncEmpty();
      }
    }
    loadMore.addEventListener("click", loadComments);
    empty.hidden = true;
    loadComments();
    if (focusComment) input.focus();
  }

  window.addEventListener("popstate", () => {
    const id = new URLSearchParams(location.search).get("post");
    if (!id && modal) modal.dialog.close();
    else if (id && (!modal || modal.postId !== id)) openPost(id, { fromLink: true });
  });

  /* ------------------------------------------------------------------ */
  /* Feed loading                                                       */
  /* ------------------------------------------------------------------ */

  const feed = $("#feed");

  function skeleton() {
    return h(
      "div",
      { className: "dc-post dc-post--skeleton", attrs: { "aria-hidden": "true" } },
      h("div", { className: "dc-post__head" }, h("span", { className: "dc-avatar dc-sk" }), h("span", { className: "dc-sk dc-sk--line" })),
      h("div", { className: "dc-media dc-sk" }),
      h("div", { className: "dc-post__body" }, h("span", { className: "dc-sk dc-sk--line" }), h("span", { className: "dc-sk dc-sk--line dc-sk--short" }))
    );
  }

  function renderEmpty() {
    if (feed.querySelector(".dc-empty")) return;
    feed.append(
      h(
        "div",
        { className: "dc-empty" },
        h("span", { className: "dc-empty__icon", html: ICONS.media }),
        h("h2", { text: "No posts yet" }),
        h("p", { text: state.canPost ? "Share the first piece of news or an opportunity with your students." : "News, hackathons and volunteering opportunities will show up here. Check back soon!" }),
        state.canPost ? h("button", { className: "btn btn-primary btn-small", text: "Create the first post", attrs: { type: "button" }, on: { click: openComposer } }) : null
      )
    );
  }

  async function loadMorePosts() {
    if (state.loading || state.done) return;
    state.loading = true;
    const skeletons = state.posts.size ? [skeleton()] : [skeleton(), skeleton()];
    feed.append(...skeletons);
    try {
      const q = state.cursor ? `?cursor=${encodeURIComponent(state.cursor)}` : "";
      const data = await Auth.api(`/api/posts${q}`);
      if (state.cursor === null) {
        state.canPost = data.canPost;
        state.limits = data.limits;
        $("#composeBar").hidden = !state.canPost;
      }
      skeletons.forEach((s) => s.remove());
      for (const p of data.posts) {
        if (state.posts.has(p.id)) continue;
        feed.append(postCard(rememberPost(p)));
      }
      state.cursor = data.nextCursor;
      state.done = !data.nextCursor;
      if (state.done && !state.posts.size) renderEmpty();
      if (state.done && state.posts.size) $("#feedEnd").replaceChildren(h("span", { text: "You're all caught up" }));
    } catch (err) {
      skeletons.forEach((s) => s.remove());
      $("#feedEnd").replaceChildren(
        h("p", { className: "dc-error", text: err.message || "Couldn't load posts." }),
        h("button", {
          className: "btn btn-secondary btn-small",
          text: "Try again",
          attrs: { type: "button" },
          on: {
            click: () => {
              $("#feedEnd").replaceChildren();
              state.done = false;
              loadMorePosts();
            },
          },
        })
      );
      state.done = true; // stop auto-loading until "Try again"
    } finally {
      state.loading = false;
      feed.setAttribute("aria-busy", "false");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Composer (admins)                                                  */
  /* ------------------------------------------------------------------ */

  const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,.mov,.m4v";

  function imageSize(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error("unreadable"));
      img.src = url;
    });
  }

  /** Duration and size from the browser. Resolves nulls when the browser can't decode it (the server still checks). */
  function videoMeta(url) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const done = (meta) => {
        v.removeAttribute("src");
        v.load();
        resolve(meta);
      };
      v.onloadedmetadata = () => done({ duration: Number.isFinite(v.duration) ? v.duration : null, width: v.videoWidth || null, height: v.videoHeight || null });
      v.onerror = () => done({ duration: null, width: null, height: null });
      setTimeout(() => done({ duration: null, width: null, height: null }), 15000);
      v.src = url;
    });
  }

  function openComposer() {
    if (!state.canPost) return;
    const L = state.limits || { imageMaxBytes: 10 * 1024 * 1024, videoMaxBytes: 500 * 1024 * 1024, videoMaxSeconds: 300, maxMedia: 10, maxCaption: 2200 };
    const items = []; // { key, file, kind, url, width, height, duration, status, progress, mediaId, error, abort }
    let selected = 0;
    let publishing = false;
    let uploading = false;

    const fileInput = h("input", { attrs: { type: "file", accept: ACCEPT, multiple: true, hidden: true } });
    const stage = h("div", { className: "dc-composer__stage" });
    const strip = h("div", { className: "dc-composer__strip" });
    const problems = h("ul", { className: "dc-composer__problems", attrs: { "aria-live": "polite" } });
    const caption = h("textarea", { className: "dc-textarea", attrs: { rows: 7, maxlength: L.maxCaption, placeholder: "Write a caption… what's the opportunity, who can join, the deadline and the link to apply." } });
    const counter = h("span", { className: "dc-counter", text: `0 / ${L.maxCaption}` });
    const shareBtn = h("button", { className: "btn btn-primary btn-small", text: "Share", attrs: { type: "button", disabled: true } });
    const status = h("p", { className: "dc-composer__status" });

    caption.addEventListener("input", () => (counter.textContent = `${caption.value.length} / ${L.maxCaption}`));

    const rules = h(
      "ul",
      { className: "dc-composer__rules" },
      h("li", { text: `Photos: JPEG, PNG, WebP or GIF, up to ${Math.round(L.imageMaxBytes / 1024 / 1024)} MB each` }),
      h("li", { text: `Videos: MP4 or MOV, up to ${Math.round(L.videoMaxSeconds / 60)} minutes (${Math.round(L.videoMaxBytes / 1024 / 1024)} MB)` }),
      h("li", { text: `Up to ${L.maxMedia} per post — swipe through them like a carousel` })
    );

    const box = h(
      "div",
      { className: "dc-composer" },
      h(
        "div",
        { className: "dc-dialog__head" },
        h("button", { className: "dc-text-btn", text: "Cancel", attrs: { type: "button" }, on: { click: () => dialog.close() } }),
        h("h3", { text: "Create new post" }),
        shareBtn
      ),
      h(
        "div",
        { className: "dc-composer__body" },
        h("div", { className: "dc-composer__left" }, stage, strip),
        h("div", { className: "dc-composer__right" }, h("label", { className: "dc-composer__label", text: "Caption" }), caption, counter, problems, status, rules)
      ),
      fileInput
    );

    const dialog = openDialog("dc-dialog--composer", box, {
      label: "Create new post",
      onClose: () => {
        // Cancel what's still uploading and drop what was uploaded but not posted.
        for (const it of items) {
          if (it.abort) it.abort.abort();
          if (it.mediaId && !publishing) Auth.api(`/api/posts/media/${it.mediaId}`, { method: "DELETE" }).catch(() => {});
          URL.revokeObjectURL(it.url);
        }
      },
    });
    // Don't lose work to a stray Esc / backdrop click.
    dialog.addEventListener("cancel", (e) => {
      if (items.length && !window.confirm("Discard this post?")) e.preventDefault();
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog && items.length && !window.confirm("Discard this post?")) e.stopImmediatePropagation();
    }, true);

    function pick() {
      fileInput.click();
    }

    function render() {
      // Stage: the selected item large, or the drop zone.
      stage.replaceChildren();
      const it = items[selected];
      if (!it) {
        stage.append(
          h(
            "div",
            { className: "dc-drop" },
            h("span", { className: "dc-drop__icon", html: ICONS.media }),
            h("p", { text: "Drag photos and videos here" }),
            h("button", { className: "btn btn-primary btn-small", text: "Select from computer", attrs: { type: "button" }, on: { click: pick } })
          )
        );
      } else if (it.kind === "video") {
        stage.append(h("video", { attrs: { src: it.url, controls: true, playsinline: true, preload: "metadata" } }));
      } else {
        stage.append(h("img", { attrs: { src: it.url, alt: "" } }));
      }

      // Strip of thumbnails with progress and remove buttons.
      strip.replaceChildren();
      items.forEach((item, i) => {
        const thumb = h(
          "div",
          { className: `dc-thumb${i === selected ? " is-selected" : ""} is-${item.status}`, attrs: { title: item.file.name } },
          item.kind === "video" ? h("video", { attrs: { src: `${item.url}#t=0.1`, muted: true, preload: "metadata" } }) : h("img", { attrs: { src: item.url, alt: "" } }),
          item.kind === "video" && item.duration ? h("span", { className: "dc-thumb__len", text: fmtLength(item.duration) }) : null,
          item.status === "uploading" || item.status === "queued"
            ? h("span", { className: "dc-thumb__progress" }, h("span", { attrs: { style: `width:${Math.round((item.progress || 0) * 100)}%` } }))
            : null,
          item.status === "error" ? h("span", { className: "dc-thumb__err", text: "!" }) : null,
          h("button", {
            className: "dc-thumb__remove",
            html: ICONS.close,
            attrs: { type: "button", "aria-label": `Remove ${item.file.name}` },
            on: {
              click: (e) => {
                e.stopPropagation();
                remove(item);
              },
            },
          })
        );
        thumb.addEventListener("click", () => {
          selected = i;
          render();
        });
        strip.append(thumb);
      });
      if (items.length && items.length < L.maxMedia) {
        strip.append(h("button", { className: "dc-thumb dc-thumb--add", html: ICONS.plus, attrs: { type: "button", "aria-label": "Add more" }, on: { click: pick } }));
      }

      const busy = items.some((x) => x.status === "uploading" || x.status === "queued" || x.status === "checking");
      const failed = items.some((x) => x.status === "error");
      const ready = items.length > 0 && !busy && !failed && !publishing;
      shareBtn.disabled = !ready;
      shareBtn.textContent = publishing ? "Sharing…" : "Share";
      const up = items.find((x) => x.status === "uploading");
      status.textContent = failed
        ? "Remove the files marked “!” to continue."
        : up
          ? `Uploading ${up.file.name} — ${Math.round((up.progress || 0) * 100)}%`
          : busy
            ? "Preparing…"
            : "";
      if (failed) {
        const errs = items.filter((x) => x.status === "error").map((x) => `${x.file.name}: ${x.error}`);
        [...problems.querySelectorAll("li.is-upload")].forEach((li) => li.remove());
        errs.forEach((t) => problems.append(h("li", { className: "is-upload", text: t })));
      } else {
        [...problems.querySelectorAll("li.is-upload")].forEach((li) => li.remove());
      }
    }

    function remove(item) {
      const i = items.indexOf(item);
      if (i < 0) return;
      items.splice(i, 1);
      if (item.abort) item.abort.abort();
      if (item.mediaId) Auth.api(`/api/posts/media/${item.mediaId}`, { method: "DELETE" }).catch(() => {});
      URL.revokeObjectURL(item.url);
      selected = Math.min(selected, Math.max(0, items.length - 1));
      render();
      pump();
    }

    /** Checks one file before uploading: type, size, and (videos) length. Returns an error message or null. */
    async function inspect(item) {
      const f = item.file;
      const name = f.name || "";
      const isImage = /^image\/(jpeg|png|webp|gif)$/.test(f.type) || (!f.type && /\.(jpe?g|png|webp|gif)$/i.test(name));
      const isVideo = /^video\/(mp4|quicktime|x-m4v)$/.test(f.type) || /\.(mp4|m4v|mov)$/i.test(name);
      if (isImage) {
        item.kind = "image";
        if (f.size > L.imageMaxBytes) return `${fmtMB(f.size)} — photos can be at most ${Math.round(L.imageMaxBytes / 1024 / 1024)} MB.`;
        try {
          Object.assign(item, await imageSize(item.url));
        } catch (_) {
          return "this image can't be opened.";
        }
        return null;
      }
      if (isVideo) {
        item.kind = "video";
        if (f.size > L.videoMaxBytes) return `${fmtMB(f.size)} — videos can be at most ${Math.round(L.videoMaxBytes / 1024 / 1024)} MB.`;
        const meta = await videoMeta(item.url);
        Object.assign(item, meta);
        if (meta.duration != null && meta.duration > L.videoMaxSeconds + 0.5) {
          return `${fmtLength(meta.duration)} long — videos can be at most ${Math.round(L.videoMaxSeconds / 60)} minutes.`;
        }
        return null;
      }
      return "only JPEG, PNG, WebP, GIF photos and MP4 / MOV videos can be posted.";
    }

    async function add(fileList) {
      const files = [...fileList];
      const room = L.maxMedia - items.length;
      [...problems.querySelectorAll("li:not(.is-upload)")].forEach((li) => li.remove());
      if (files.length > room) problems.append(h("li", { text: `A post can have at most ${L.maxMedia} photos and videos — only the first ${Math.max(0, room)} were added.` }));
      for (const file of files.slice(0, Math.max(0, room))) {
        const item = { key: Math.random().toString(36).slice(2), file, url: URL.createObjectURL(file), status: "checking", progress: 0 };
        items.push(item);
        render();
        const error = await inspect(item);
        if (!items.includes(item)) continue; // removed meanwhile
        if (error) {
          items.splice(items.indexOf(item), 1);
          URL.revokeObjectURL(item.url);
          problems.append(h("li", { text: `${file.name}: ${error}` }));
        } else {
          item.status = "queued";
          if (items.length === 1) selected = 0;
        }
        render();
        pump();
      }
    }

    /** Uploads queued files one at a time (so each gets the full connection). */
    async function pump() {
      if (uploading) return;
      const item = items.find((x) => x.status === "queued");
      if (!item) return;
      uploading = true;
      item.status = "uploading";
      item.abort = new AbortController();
      render();
      const params = new URLSearchParams();
      if (item.width) params.set("w", item.width);
      if (item.height) params.set("h", item.height);
      try {
        const data = await Auth.upload(`/api/posts/media?${params}`, item.file, {
          signal: item.abort.signal,
          onProgress: (p) => {
            item.progress = p;
            const bar = strip.children[items.indexOf(item)];
            const fill = bar && bar.querySelector(".dc-thumb__progress span");
            if (fill) fill.style.width = `${Math.round(p * 100)}%`;
            status.textContent = `Uploading ${item.file.name} — ${Math.round(p * 100)}%`;
          },
        });
        item.mediaId = data.media.id;
        item.status = "done";
        if (!items.includes(item)) Auth.api(`/api/posts/media/${item.mediaId}`, { method: "DELETE" }).catch(() => {});
      } catch (err) {
        if (err.code !== "aborted") {
          item.status = "error";
          item.error = err.message;
        }
      } finally {
        item.abort = null;
        uploading = false;
        render();
        pump();
      }
    }

    fileInput.addEventListener("change", () => {
      if (fileInput.files.length) add(fileInput.files);
      fileInput.value = "";
    });

    // Drag and drop anywhere on the composer.
    box.addEventListener("dragover", (e) => {
      e.preventDefault();
      box.classList.add("is-dragging");
    });
    box.addEventListener("dragleave", (e) => {
      if (!box.contains(e.relatedTarget)) box.classList.remove("is-dragging");
    });
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("is-dragging");
      if (e.dataTransfer && e.dataTransfer.files.length) add(e.dataTransfer.files);
    });

    shareBtn.addEventListener("click", async () => {
      if (shareBtn.disabled) return;
      publishing = true;
      render();
      try {
        const data = await Auth.api("/api/posts", { method: "POST", body: { caption: caption.value, mediaIds: items.map((x) => x.mediaId) } });
        const post = rememberPost(data.post);
        const empty = feed.querySelector(".dc-empty");
        if (empty) empty.remove();
        const card = postCard(post);
        card.classList.add("is-new");
        feed.prepend(card);
        dialog.close();
        window.scrollTo({ top: 0, behavior: "smooth" });
        toast("Your post is live");
      } catch (err) {
        publishing = false;
        problems.append(h("li", { text: err.message || "Couldn't share the post." }));
        render();
      }
    });

    render();
  }

  /* ------------------------------------------------------------------ */
  /* Start                                                              */
  /* ------------------------------------------------------------------ */

  Auth.requireUser().then((user) => {
    if (!user) return;
    state.user = user;
    Auth.wireTopbar(user);
    const me = { name: user.fullName, username: user.username, avatarUrl: user.avatarUrl };
    $("#sideAvatar").replaceWith(avatar(me, "dc-avatar--lg"));
    $("#composeAvatar").replaceWith(avatar(me, "dc-avatar--sm"));
    $("#sideUsername").textContent = user.username;
    $("#sideName").textContent = user.fullName;
    $("#composeBar").addEventListener("click", openComposer);
    $("#findPeople").addEventListener("click", () => People.openSearch());

    loadMorePosts().then(() => {
      const end = $("#feedEnd");
      if ("IntersectionObserver" in window) {
        new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMorePosts(), { rootMargin: "900px 0px" }).observe(end);
      } else {
        window.addEventListener("scroll", () => {
          if (window.innerHeight + window.scrollY > document.body.offsetHeight - 1200) loadMorePosts();
        });
      }
    });

    // A shared link: discover.html?post=<id>
    const linked = new URLSearchParams(location.search).get("post");
    if (linked) openPost(linked, { fromLink: true });
  });
})();
