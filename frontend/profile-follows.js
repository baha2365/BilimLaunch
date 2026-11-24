/*
 * BilimLaunch — followers / following counts on your own profile page.
 * Click a count to see the list (you can remove followers there), or
 * "Find people" to search for someone to follow. See people.js.
 */
(function () {
  "use strict";

  const stats = document.getElementById("followStats");
  if (!stats) return;

  let me = null;
  let timer = 0;

  async function refresh() {
    try {
      const { user } = await Auth.api(`/api/users/${encodeURIComponent(me.username)}`);
      document.getElementById("followerCount").textContent = People.nf.format(user.followerCount);
      document.getElementById("followerWord").textContent = user.followerCount === 1 ? "follower" : "followers";
      document.getElementById("followingCount").textContent = People.nf.format(user.followingCount);
    } catch (_) {
      /* keep the last numbers */
    }
  }

  stats.addEventListener("click", (e) => {
    if (!me) return;
    const btn = e.target.closest("[data-list]");
    if (btn) People.openList(me.username, btn.dataset.list, { isMe: true });
  });
  document.getElementById("findPeopleBtn").addEventListener("click", () => People.openSearch());

  // Following / unfollowing / removing someone anywhere on the page changes your counts.
  document.addEventListener("people:follow", () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  });

  Auth.requireUser().then((user) => {
    if (!user) return;
    me = user;
    refresh();
  });
})();
