/*
 * BilimLaunch landing page -- runs first (in <head>, after auth.js).
 *  1. Marks the page as "JS is running" so scroll-reveal can hide things safely.
 *  2. Google sign-in failures are redirected to "/index.html?error=..." by the server;
 *     the sign-in form now lives on login.html, so forward those visitors there.
 *  3. Visitors who are already signed in never see this page: they are sent to
 *     their home page (profile.html, or onboarding.html if the profile isn't
 *     finished). While that is being checked the page stays invisible, so a
 *     signed-in user doesn't get a flash of the landing page first.
 */
(function () {
  "use strict";

  var root = document.documentElement;
  var SIGNED_IN_HINT = "bl_signed_in"; // same key auth.js sets on sign-in and clears on sign-out
  var MAX_HIDDEN_MS = 4000; // if the server is slow or down, show the landing page anyway
  var revealTimer = null;

  root.classList.add("js");

  if (/[?&]error=/.test(window.location.search)) {
    window.location.replace("login.html" + window.location.search);
    return;
  }

  function showPage() {
    window.clearTimeout(revealTimer);
    root.style.visibility = "";
  }

  function maybeSignedIn() {
    try {
      return window.localStorage.getItem(SIGNED_IN_HINT) === "1";
    } catch (_) {
      return false;
    }
  }

  function routeSignedInVisitor() {
    // Anonymous visitors (the common case) see the page immediately, no network call.
    if (!maybeSignedIn() || typeof Auth === "undefined") {
      showPage();
      return;
    }

    root.style.visibility = "hidden";
    window.clearTimeout(revealTimer);
    revealTimer = window.setTimeout(showPage, MAX_HIDDEN_MS);

    // Swaps the refresh cookie for a new access token. If it works, this
    // redirects to profile.html / onboarding.html (location.replace, so Back
    // doesn't return here) and resolves true. If the session is gone it clears
    // the stale hint and resolves false: show the landing page.
    Auth.redirectIfSignedIn().then(
      function (redirected) {
        if (redirected) window.clearTimeout(revealTimer); // stay hidden until the new page loads
        else showPage();
      },
      showPage
    );
  }

  routeSignedInVisitor();

  // Back/forward can restore this page from the browser's cache without running
  // the script again; check the session again in that case (e.g. after logout).
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) routeSignedInVisitor();
  });
})();