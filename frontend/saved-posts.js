/*
 * BilimLaunch — "Saved posts" on the profile page: the posts the user saved
 * on Discover, as an Instagram-style grid. Each tile opens the post on
 * discover.html?post=<id>.
 */
(function () {
  "use strict";

  const grid = document.getElementById("savedGrid");
  if (!grid) return;
  const empty = document.getElementById("savedEmpty");
  const more = document.getElementById("savedMore");
  const nf = new Intl.NumberFormat("en-US", { notation: "compact" });

  const SVG = {
    stack: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="14" height="14" rx="2.5"/><path d="M17 3H5.5A2.5 2.5 0 0 0 3 5.5V17"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true" class="is-filled"><path d="M8 5.5v13l11-6.5z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.6s-7.6-4.6-9.4-9.5C1.4 7.9 3.4 4.4 7 4.4c2.1 0 3.7 1.2 5 3 1.3-1.8 2.9-3 5-3 3.6 0 5.6 3.5 4.4 6.7-1.8 4.9-9.4 9.5-9.4 9.5z"/></svg>',
    comment: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.7 16.1A9 9 0 1 0 16.9 19.9L21.5 21z"/></svg>',
  };

  function tile(post) {
    const first = post.media[0];
    const a = document.createElement("a");
    a.className = "dc-saved__tile";
    a.href = `discover.html?post=${encodeURIComponent(post.id)}`;
    a.setAttribute("aria-label", `Saved post by ${post.author.username}${post.caption ? `: ${post.caption.slice(0, 80)}` : ""}`);

    if (first && first.kind === "video") {
      const v = document.createElement("video");
      v.src = `${first.url}#t=0.1`;
      v.muted = true;
      v.preload = "metadata";
      v.setAttribute("playsinline", "");
      a.append(v);
    } else if (first) {
      const img = document.createElement("img");
      img.src = first.url;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      a.append(img);
    }

    const badgeKind = post.media.length > 1 ? "stack" : first && first.kind === "video" ? "play" : null;
    if (badgeKind) {
      const badge = document.createElement("span");
      badge.className = "dc-saved__badge";
      badge.innerHTML = SVG[badgeKind];
      a.append(badge);
    }

    const overlay = document.createElement("span");
    overlay.className = "dc-saved__overlay";
    for (const [icon, count] of [["heart", post.likeCount], ["comment", post.commentCount]]) {
      const s = document.createElement("span");
      s.innerHTML = SVG[icon];
      s.append(nf.format(count));
      overlay.append(s);
    }
    a.append(overlay);
    return a;
  }

  let cursor = null;
  async function load() {
    more.disabled = true;
    try {
      const data = await Auth.api(`/api/posts/saved${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      data.posts.forEach((p) => grid.append(tile(p)));
      cursor = data.nextCursor;
      more.hidden = !cursor;
      empty.hidden = grid.children.length > 0;
    } catch (err) {
      empty.hidden = false;
      empty.textContent = err.message || "Couldn't load your saved posts.";
    } finally {
      more.disabled = false;
      grid.setAttribute("aria-busy", "false");
    }
  }

  more.addEventListener("click", load);
  load().then(() => {
    // profile.html#saved (the "Your saved posts" link on Discover) — scroll there once it's filled.
    if (location.hash === "#saved") document.getElementById("saved").scrollIntoView({ behavior: "smooth" });
  });
})();
