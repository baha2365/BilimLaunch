/*
 * BilimLaunch — people & follows, shared by profile.html, user.html and
 * discover.html (load after auth.js).
 *
 *   People.url(username)                 link to someone's profile (user.html?u=...)
 *   People.avatar(person, size)          the round photo / initial
 *   People.followButton(person)          Follow / Follow back / Following (asks before unfollowing)
 *   People.openList(username, kind, { isMe })   followers / following dialog
 *   People.openSearch()                  "Find people" dialog (suggestions + search)
 *   People.openLikes(postId)             who liked a Discover post
 *
 * Every follow change fires a `people:follow` event on document with
 * { username, following, followerCount } so pages can update their counts.
 * All user text goes on the page with textContent / DOM nodes, never as HTML.
 */
const People = (() => {
  "use strict";

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

  const ICONS = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    team: '<svg viewBox="0 0 24 24" aria-hidden="true" class="is-filled"><path d="M12 1.8l2.4 1.8 3-.1.9 2.8 2.5 1.7-.9 2.9.9 2.9-2.5 1.7-.9 2.8-3-.1L12 22.2l-2.4-1.8-3 .1-.9-2.8-2.5-1.7.9-2.9-.9-2.9 2.5-1.7.9-2.8 3 .1z"/><path d="m8.2 12.2 2.6 2.6 5-5.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.6"/><path d="M2.5 20c.6-3.7 3.2-5.8 6.5-5.8s5.9 2.1 6.5 5.8"/><path d="M16 4.6a3.4 3.4 0 0 1 0 6.6M18.2 14.6c1.8.7 3 2.5 3.3 5.4"/></svg>',
  };

  const nf = new Intl.NumberFormat("en-US");
  const url = (username) => `user.html?u=${encodeURIComponent(username)}`;
  const apiPath = (username, rest = "") => `/api/users/${encodeURIComponent(username)}${rest}`;

  function avatar(person, size = "") {
    const name = person.fullName || person.name || person.username || "?";
    const inner = person.avatarUrl
      ? h("img", { attrs: { src: person.avatarUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" } })
      : h("span", { text: name.trim().charAt(0).toUpperCase() || "?" });
    return h("span", { className: `dc-avatar ${size}`.trim(), attrs: { "aria-hidden": "true" } }, inner);
  }

  /** The blue badge shown next to BilimLaunch team (admin) accounts. */
  const teamBadge = () => h("span", { className: "pp-badge", html: ICONS.team, attrs: { title: "BilimLaunch team", "aria-label": "BilimLaunch team", role: "img" } });

  let toastTimer = 0;
  function toast(message) {
    let el = document.getElementById("toast");
    if (!el) {
      el = h("div", { className: "dc-toast", attrs: { id: "toast", role: "status", "aria-live": "polite" } });
      document.body.append(el);
    }
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2600);
  }

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

  /** Instagram's "Unfollow @name?" / "Remove follower?" sheet. Resolves true when confirmed. */
  function confirmSheet(person, { title, text, confirm }) {
    return new Promise((resolve) => {
      let answer = false;
      const box = h(
        "div",
        { className: "dc-confirm pp-confirm" },
        avatar(person, "dc-avatar--xl"),
        h("h3", { text: title }),
        text ? h("p", { text }) : null,
        h(
          "div",
          { className: "dc-sheet" },
          h("button", {
            className: "dc-sheet__item is-danger",
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

  function announce(detail) {
    document.dispatchEvent(new CustomEvent("people:follow", { detail }));
  }

  /* ---------------- follow button ---------------- */

  async function setFollow(person, follow) {
    const data = await Auth.api(apiPath(person.username, "/follow"), { method: follow ? "PUT" : "DELETE" });
    person.isFollowing = data.following;
    announce({ username: person.username, following: data.following, followerCount: data.followerCount });
    return data;
  }

  /** Follow / Follow back / Following. Returns null for your own account. */
  function followButton(person, { large = false } = {}) {
    if (person.isMe) return null;
    const btn = h("button", { className: `pp-follow${large ? " pp-follow--lg" : ""}`, attrs: { type: "button" } });
    let busy = false;

    function render() {
      btn.classList.toggle("is-following", person.isFollowing);
      btn.textContent = person.isFollowing ? "Following" : person.followsYou ? "Follow back" : "Follow";
      btn.setAttribute("aria-pressed", String(person.isFollowing));
      btn.setAttribute("aria-label", `${btn.textContent} ${person.username}`);
    }

    btn.addEventListener("click", async () => {
      if (busy) return;
      if (person.isFollowing) {
        const ok = await confirmSheet(person, {
          title: `Unfollow @${person.username}?`,
          text: "You can follow them again at any time.",
          confirm: "Unfollow",
        });
        if (!ok) return;
      }
      const next = !person.isFollowing;
      busy = true;
      person.isFollowing = next; // show it straight away, undo if the server says no
      render();
      try {
        await setFollow(person, next);
      } catch (err) {
        person.isFollowing = !next;
        toast(err.message || "Something went wrong. Please try again.");
      } finally {
        busy = false;
        render();
      }
    });

    // Another button for the same person (e.g. in a list over the profile) changed it.
    const sync = (e) => {
      if (!btn.isConnected && btn.dataset.mounted) return document.removeEventListener("people:follow", sync);
      if (e.detail.username !== person.username || e.detail.following == null || busy) return;
      person.isFollowing = e.detail.following;
      render();
    };
    document.addEventListener("people:follow", sync);
    requestAnimationFrame(() => (btn.dataset.mounted = "1"));

    render();
    return btn;
  }

  /* ---------------- one person in a list ---------------- */

  function personRow(person, { onNavigate, actions } = {}) {
    const names = h(
      "span",
      { className: "pp-row__names" },
      h("span", { className: "pp-row__user" }, h("strong", { text: person.username }), person.isTeam ? teamBadge() : null),
      h("span", { className: "pp-row__name", text: person.fullName || "" })
    );
    const link = h("a", { className: "pp-row__who", attrs: { href: person.isMe ? "profile.html" : url(person.username) }, on: { click: () => onNavigate && onNavigate() } }, avatar(person, "dc-avatar--md"), names);
    return h("div", { className: "pp-row" }, link, h("div", { className: "pp-row__actions" }, actions !== undefined ? actions : followButton(person)));
  }

  /** In your own followers list: "Follow back" (if you don't yet) and "Remove". */
  function ownFollowerActions(person) {
    const wrap = h("div", { className: "pp-row__btns" });
    if (!person.isFollowing) wrap.append(followButton(person));
    const remove = h("button", { className: "pp-follow is-following", text: "Remove", attrs: { type: "button", "aria-label": `Remove follower ${person.username}` } });
    remove.addEventListener("click", async () => {
      const ok = await confirmSheet(person, {
        title: "Remove follower?",
        text: `BilimLaunch won't tell @${person.username} they were removed from your followers.`,
        confirm: "Remove",
      });
      if (!ok) return;
      remove.disabled = true;
      try {
        const data = await Auth.api(apiPath(person.username, "/follower"), { method: "DELETE" });
        wrap.replaceChildren(h("span", { className: "pp-removed", text: "Removed" }));
        announce({ username: person.username, removedFollower: true, myFollowerCount: data.followerCount });
      } catch (err) {
        remove.disabled = false;
        toast(err.message || "Couldn't remove this follower.");
      }
    });
    wrap.append(remove);
    return wrap;
  }

  /* ---------------- shared dialog frame ---------------- */

  function dialogFrame(title) {
    const close = h("button", { className: "dc-icon-btn", html: ICONS.close, attrs: { type: "button", "aria-label": "Close" } });
    const head = h("div", { className: "dc-dialog__head" }, h("span"), h("h3", { text: title }), close);
    const box = h("div", { className: "pp-box" }, head);
    return { box, head, close };
  }

  function statusEl() {
    return h("div", { className: "pp-status" });
  }

  function spinner() {
    return h("span", { className: "pp-spinner", attrs: { role: "progressbar", "aria-label": "Loading" } });
  }

  /* ---------------- followers / following ---------------- */

  const EMPTY = {
    followers: { me: ["Followers", "When people follow you, you'll see them here."], other: ["No followers yet", "Be the first to follow."] },
    following: { me: ["Following", "When you follow people, you'll see them here."], other: ["Not following anyone", "They haven't followed anyone yet."] },
  };

  /**
   * A list of people that keeps loading as you scroll. `fetchPage(cursor)`
   * resolves to { users, nextCursor }; `row(person, close)` builds one row;
   * `empty()` gives [title, text] for an empty list. Call reset() to start over.
   */
  function pagedList({ fetchPage, row, empty, getClose }) {
    const list = h("div", { className: "pp-list" });
    const status = statusEl();
    const sentinel = h("div", { className: "pp-sentinel" });
    const scroller = h("div", { className: "pp-scroll" }, list, status, sentinel);

    let cursor = null;
    let done = false;
    let loading = false;
    let token = 0;

    async function load() {
      if (loading || done) return;
      loading = true;
      const mine = token;
      status.replaceChildren(spinner());
      try {
        const data = await fetchPage(cursor);
        if (mine !== token) return;
        for (const person of data.users) list.append(row(person, getClose()));
        cursor = data.nextCursor;
        done = !cursor;
        status.replaceChildren();
        if (!list.children.length) {
          const [title, text] = empty();
          status.append(h("div", { className: "pp-empty" }, h("span", { className: "pp-empty__icon", html: ICONS.people }), h("strong", { text: title }), h("p", { text })));
        }
      } catch (err) {
        if (mine !== token) return;
        status.replaceChildren(h("p", { className: "pp-error", text: err.message || "Couldn't load this list." }));
        done = true;
      } finally {
        if (mine === token) loading = false;
      }
      // A short first page may not fill the box: keep loading while the end is visible.
      if (mine === token && !done && sentinel.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom + 200) load();
    }

    function reset() {
      token++;
      cursor = null;
      done = false;
      loading = false;
      list.replaceChildren();
      status.replaceChildren();
      scroller.scrollTop = 0;
      load();
    }

    const observer = "IntersectionObserver" in window ? new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && load(), { root: scroller, rootMargin: "200px 0px" }) : null;
    if (observer) observer.observe(sentinel);
    else scroller.addEventListener("scroll", () => scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 200 && load());

    return { scroller, list, reset, disconnect: () => observer && observer.disconnect() };
  }

  const pageQuery = (cursor) => (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");

  function openList(username, kind = "followers", { isMe = false } = {}) {
    const { box, close } = dialogFrame(username);
    const tabs = h("div", { className: "pp-tabs", attrs: { role: "tablist" } });
    let current = kind;
    let dialog = null;

    const paged = pagedList({
      fetchPage: (cursor) => Auth.api(apiPath(username, `/${current}${pageQuery(cursor)}`)),
      row: (person, closeDialog) => {
        const actions = isMe && current === "followers" && !person.isMe ? ownFollowerActions(person) : undefined;
        return personRow(person, { actions, onNavigate: closeDialog });
      },
      empty: () => EMPTY[current][isMe ? "me" : "other"],
      getClose: () => () => dialog && dialog.close(),
    });
    paged.list.setAttribute("role", "tabpanel");
    box.append(tabs, paged.scroller);

    const tabBtns = {};
    for (const k of ["followers", "following"]) {
      tabBtns[k] = h("button", {
        className: "pp-tab",
        text: k === "followers" ? "Followers" : "Following",
        attrs: { type: "button", role: "tab" },
        on: { click: () => switchTo(k) },
      });
      tabs.append(tabBtns[k]);
    }

    function switchTo(k) {
      current = k;
      for (const [name, b] of Object.entries(tabBtns)) {
        b.classList.toggle("is-active", name === k);
        b.setAttribute("aria-selected", String(name === k));
      }
      paged.reset();
    }

    dialog = openDialog("pp-dialog", box, { label: `${username} — ${kind}`, onClose: paged.disconnect });
    close.addEventListener("click", () => dialog.close());
    switchTo(kind);
    return dialog;
  }

  /* ---------------- who liked a post ---------------- */

  function openLikes(postId) {
    const { box, close } = dialogFrame("Likes");
    let dialog = null;
    const paged = pagedList({
      fetchPage: (cursor) => Auth.api(`/api/posts/${encodeURIComponent(postId)}/likes${pageQuery(cursor)}`),
      row: (person, closeDialog) => personRow(person, { onNavigate: closeDialog }),
      empty: () => ["No likes yet", "When people like this post, you'll see them here."],
      getClose: () => () => dialog && dialog.close(),
    });
    box.append(paged.scroller);
    dialog = openDialog("pp-dialog", box, { label: "People who liked this post", onClose: paged.disconnect });
    close.addEventListener("click", () => dialog.close());
    paged.reset();
    return dialog;
  }

  /* ---------------- find people ---------------- */

  function openSearch() {
    const { box, close } = dialogFrame("Find people");
    const input = h("input", {
      className: "pp-search__input",
      attrs: { type: "search", placeholder: "Search by name or username", "aria-label": "Search people", autocomplete: "off", spellcheck: "false", maxlength: 50 },
    });
    const field = h("label", { className: "pp-search" }, h("span", { className: "pp-search__icon", html: ICONS.search }), input);
    const label = h("p", { className: "pp-section-label" });
    const list = h("div", { className: "pp-list" });
    const status = statusEl();
    const scroller = h("div", { className: "pp-scroll" }, label, list, status);
    box.append(h("div", { className: "pp-search-wrap" }, field), scroller);

    let token = 0;
    let timer = 0;

    async function show(path, heading, emptyText) {
      const mine = ++token;
      status.replaceChildren(spinner());
      try {
        const data = await Auth.api(path);
        if (mine !== token) return;
        label.textContent = data.users.length ? heading : "";
        list.replaceChildren(...data.users.map((p) => personRow(p, { onNavigate: () => dialog.close() })));
        status.replaceChildren();
        if (!data.users.length) status.append(h("p", { className: "pp-muted", text: emptyText }));
      } catch (err) {
        if (mine !== token) return;
        list.replaceChildren();
        status.replaceChildren(h("p", { className: "pp-error", text: err.message || "Search isn't working right now." }));
      }
    }

    function run() {
      const q = input.value.trim().replace(/^@+/, "");
      if (!q) return show("/api/users/suggested", "Suggested for you", "No suggestions right now. Try searching by name.");
      show(`/api/users/search?q=${encodeURIComponent(q)}`, "Results", `No one found for “${q}”.`);
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(timer);
        run();
      }
    });

    const dialog = openDialog("pp-dialog", box, { label: "Find people", onClose: () => clearTimeout(timer) });
    close.addEventListener("click", () => dialog.close());
    run();
    input.focus();
    return dialog;
  }

  return { url, avatar, teamBadge, followButton, personRow, openList, openLikes, openSearch, toast, nf, ICONS };
})();
