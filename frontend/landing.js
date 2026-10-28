/*
 * BilimLaunch landing page -- runs first (in <head>).
 *  1. Marks the page as "JS is running" so scroll-reveal can hide things safely.
 *  2. Google sign-in failures are redirected to "/index.html?error=..." by the server;
 *     the sign-in form now lives on login.html, so forward those visitors there.
 */
(function () {
  "use strict";
  document.documentElement.classList.add("js");
  if (/[?&]error=/.test(window.location.search)) {
    window.location.replace("login.html" + window.location.search);
  }
})();
