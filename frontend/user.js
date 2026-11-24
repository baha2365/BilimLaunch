/*
 * BilimLaunch — someone's public profile: user.html?u=<username>.
 * Photo, name, follower / following counts (click to see the lists) and the
 * Follow button. Your own username sends you to profile.html instead.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    if (props.className) node.className = props.className;
    if (props.text != null) node.textContent = props.text;
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
    if (props.on) for (const [k, fn] of Object.entries(props.on)) node.addEventListener(k, fn);
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }

  const plural = (n, one, many) => (n === 1 ? one : many);

  function stat(count, one, many, onClick) {
    const num = h("strong", { text: People.nf.format(count) });
    const word = h("span", { text: plural(count, one, many) });
    const btn = h("button", { className: "pp-stat", attrs: { type: "button" }, on: { click: onClick } }, num, " ", word);
    btn.set = (n) => {
      num.textContent = People.nf.format(n);
      word.textContent = plural(n, one, many);
    };
    return btn;
  }

  function joined(iso) {
    return `Joined ${new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric" })}`;
  }

  function render(person) {
    const box = $("#profile");
    document.title = `${person.fullName} (@${person.username}) — BilimLaunch`;

    const followers = stat(person.followerCount, "follower", "followers", () => People.openList(person.username, "followers"));
    const following = stat(person.followingCount, "following", "following", () => People.openList(person.username, "following"));

    document.addEventListener("people:follow", (e) => {
      if (e.detail.username === person.username && e.detail.followerCount != null) followers.set(e.detail.followerCount);
    });

    box.replaceChildren(
      h("div", { className: "pp-profile__photo" }, People.avatar(person, "pp-avatar-xl")),
      h(
        "div",
        { className: "pp-profile__info" },
        h(
          "div",
          { className: "pp-profile__top" },
          h("h1", { className: "pp-profile__username" }, h("span", { text: person.username }), person.isTeam ? People.teamBadge() : null),
          People.followButton(person, { large: true })
        ),
        h("div", { className: "pp-profile__stats" }, followers, following),
        h("div", { className: "pp-profile__name" }, h("strong", { text: person.fullName }), person.followsYou ? h("span", { className: "pp-chip", text: "Follows you" }) : null),
        person.isTeam ? h("p", { className: "pp-profile__bio", text: "Official BilimLaunch team account — news and opportunities on Discover." }) : null,
        h("p", { className: "pp-profile__joined", text: joined(person.joinedAt) })
      )
    );
    box.setAttribute("aria-busy", "false");
  }

  function renderMissing(message) {
    const box = $("#profile");
    box.classList.add("pp-profile--missing");
    box.replaceChildren(
      h(
        "div",
        { className: "pp-missing" },
        h("h1", { text: "Sorry, this page isn't available." }),
        h("p", { text: message || "The link you followed may be broken, or the account may have been removed." }),
        h("a", { className: "btn btn-secondary btn-small", text: "Go back to Discover", attrs: { href: "discover.html" } })
      )
    );
    box.setAttribute("aria-busy", "false");
  }

  async function loadSuggested(exclude) {
    try {
      const data = await Auth.api("/api/users/suggested");
      const people = data.users.filter((p) => p.username !== exclude).slice(0, 6);
      if (!people.length) return;
      $("#suggested").replaceChildren(...people.map((p) => People.personRow(p)));
      $("#morePeople").hidden = false;
    } catch (_) {
      /* suggestions are optional */
    }
  }

  Auth.requireUser().then(async (me) => {
    if (!me) return;
    Auth.wireTopbar(me);
    $("#findPeople").addEventListener("click", () => People.openSearch());

    const username = (new URLSearchParams(location.search).get("u") || "").trim().replace(/^@+/, "").toLowerCase();
    if (!username || username === me.username) {
      location.replace("profile.html");
      return;
    }
    try {
      const data = await Auth.api(`/api/users/${encodeURIComponent(username)}`);
      render(data.user);
    } catch (err) {
      renderMissing(err.status === 404 ? null : err.message);
    }
    loadSuggested(username);
  });
})();
