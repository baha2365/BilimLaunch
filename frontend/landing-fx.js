/*
 * BilimLaunch landing page -- interactions (self-hosted, CSP friendly).
 * Scroll reveal, count-up numbers, nav state, mobile menu, hero depth on scroll,
 * the "letter typing" demo, pointer light on cards, and a signed-in shortcut.
 */
(function () {
  "use strict";

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- nav ---------- */
  var nav = $("#nav");
  var toggle = $("#navToggle");
  var links = $("#navLinks");
  function setMenu(open) {
    if (!toggle || !links) return;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    links.classList.toggle("is-open", open);
  }
  if (toggle) {
    toggle.addEventListener("click", function () { setMenu(toggle.getAttribute("aria-expanded") !== "true"); });
    $$("a", links).forEach(function (a) { a.addEventListener("click", function () { setMenu(false); }); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });
    document.addEventListener("click", function (e) { if (!nav.contains(e.target)) setMenu(false); });
  }

  /* ---------- scroll: nav state + hero depth ---------- */
  var frame = $("#heroFrame");
  var ticking = false;
  function onScroll() {
    ticking = false;
    var y = window.scrollY || 0;
    if (nav) nav.classList.toggle("is-scrolled", y > 8);
    if (frame && !reduce) {
      var rect = frame.parentElement.getBoundingClientRect();
      var vh = window.innerHeight || 800;
      // 0 when the image first appears, 1 when it has scrolled well past the middle of the screen
      var t = Math.min(1, Math.max(0, (vh - rect.top) / (vh + rect.height * 0.4)));
      frame.style.setProperty("--sc", (0.94 + 0.06 * Math.min(1, t * 2.4)).toFixed(4));
      frame.style.setProperty("--rx", (6 * (1 - Math.min(1, t * 2.4))).toFixed(3) + "deg");
      frame.style.setProperty("--py", (-18 * Math.max(0, t - 0.5)).toFixed(2) + "px");
    }
  }
  window.addEventListener("scroll", function () {
    if (!ticking) { ticking = true; window.requestAnimationFrame(onScroll); }
  }, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();

  /* ---------- reveal ---------- */
  var revealEls = $$(".reveal");
  function countUp(el) {
    var target = parseInt(el.getAttribute("data-count"), 10);
    if (isNaN(target)) return;
    var suffix = el.getAttribute("data-suffix") || "";
    if (reduce) { el.textContent = target + suffix; return; }
    var start = null, dur = 1400;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased) + suffix;
      if (p < 1) window.requestAnimationFrame(step);
    }
    window.requestAnimationFrame(step);
  }

  var typed = false;
  function typeLetter() {
    var el = $("#typeTarget");
    if (!el || typed) return;
    typed = true;
    var text = el.getAttribute("data-text") || "";
    if (reduce) { el.textContent = text; return; }
    var i = 0;
    el.classList.add("is-typing");
    (function tick() {
      i += 2;
      el.textContent = text.slice(0, i);
      if (i < text.length) window.setTimeout(tick, 22);
      else el.classList.remove("is-typing");
    })();
  }

  function show(el) {
    el.classList.add("is-in");
    // once it has glided in, hand the element back to its normal hover styles
    var delay = (parseFloat(getComputedStyle(el).getPropertyValue("--d")) || 0) * 90;
    window.setTimeout(function () { el.classList.remove("reveal", "is-in"); }, 1200 + delay);
    $$("[data-count]", el).concat(el.hasAttribute("data-count") ? [el] : []).forEach(countUp);
    if ($("#typeTarget", el)) typeLetter();
  }

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { show(entry.target); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(show);
  }
  // the ring in the profile card animates when its card appears
  $$(".ring").forEach(function (ring) {
    var card = ring.closest(".reveal");
    if (!card) { ring.classList.add("is-in"); return; }
    var watch = new MutationObserver(function () {
      if (card.classList.contains("is-in")) { ring.classList.add("is-in"); watch.disconnect(); }
    });
    watch.observe(card, { attributes: true, attributeFilter: ["class"] });
  });

  /* ---------- active nav link ---------- */
  if ("IntersectionObserver" in window && links) {
    var map = {};
    $$("a", links).forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var a = map[entry.target.id];
        if (a && entry.isIntersecting) {
          Object.keys(map).forEach(function (k) { map[k].classList.remove("is-active"); });
          a.classList.add("is-active");
        }
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    Object.keys(map).forEach(function (id) { var s = document.getElementById(id); if (s) spy.observe(s); });
  }

  /* ---------- pointer light on cards ---------- */
  if (!reduce) {
    var raf = 0;
    document.addEventListener("pointermove", function (e) {
      if (e.pointerType === "touch" || !e.target.closest) return;
      var card = e.target.closest(".card");
      if (!card || raf) return;
      var x = e.clientX, y = e.clientY;
      raf = window.requestAnimationFrame(function () {
        raf = 0;
        var r = card.getBoundingClientRect();
        card.style.setProperty("--mx", x - r.left + "px");
        card.style.setProperty("--my", y - r.top + "px");
      });
    }, { passive: true });
  }

  /* ---------- already signed in in this tab? offer the shortcut ---------- */
  try {
    if (window.sessionStorage && window.sessionStorage.getItem("bl_access")) {
      var signIn = $("#navSignIn");
      var start = $("#navStart");
      if (signIn) { signIn.textContent = "Open my profile"; signIn.setAttribute("href", "profile.html"); }
      if (start) { start.textContent = "Universities"; start.setAttribute("href", "universities.html"); }
    }
  } catch (_) { /* storage blocked -- keep the normal buttons */ }
})();
