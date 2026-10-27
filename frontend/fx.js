/*
 * BilimLaunch — small interface behaviours for the glass design.
 * Self-hosted and CSP-friendly: no inline handlers, no external libraries.
 *   - pointer-following light on glass cards
 *   - show / hide password buttons
 *   - password strength meter + "passwords match" tick
 *   - six-slot verification code display + "Paste code" button
 *   - top bar gets more solid once the page scrolls
 */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- pointer light ---------------- */
  var LIGHT = ".auth-card, .summary-card, .form-section, .info-section, .match-card, .uni-card";
  var frame = 0;
  if (!reduceMotion) {
    document.addEventListener(
      "pointermove",
      function (event) {
        if (event.pointerType === "touch" || !event.target.closest) return;
        var el = event.target.closest(LIGHT);
        if (!el || frame) return;
        var x = event.clientX;
        var y = event.clientY;
        frame = window.requestAnimationFrame(function () {
          frame = 0;
          var r = el.getBoundingClientRect();
          el.style.setProperty("--mx", x - r.left + "px");
          el.style.setProperty("--my", y - r.top + "px");
        });
      },
      { passive: true }
    );
  }

  /* ---------------- sticky bar ---------------- */
  var bar = document.querySelector(".dash-topbar");
  if (bar) {
    var onScroll = function () {
      bar.classList.toggle("is-scrolled", window.scrollY > 6);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------------- show / hide password ---------------- */
  document.querySelectorAll(".pw-toggle").forEach(function (btn) {
    var input = document.getElementById(btn.getAttribute("data-for"));
    if (!input) return;
    btn.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.classList.toggle("is-on", show);
      btn.setAttribute("aria-pressed", show ? "true" : "false");
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      // keep the caret where it was
      var end = input.value.length;
      input.focus({ preventScroll: true });
      try { input.setSelectionRange(end, end); } catch (_) { /* not supported for this type */ }
    });
  });

  /* ---------------- password strength + match ---------------- */
  var meter = document.getElementById("pwStrength");
  var pw = document.getElementById("password");
  var confirm = document.getElementById("confirmPassword");

  function score(value) {
    if (!value) return 0;
    var s = 0;
    if (value.length >= 8) s++;
    if (/[A-Za-z]/.test(value) && /\d/.test(value)) s++;
    if (value.length >= 12) s++;
    if ((/[a-z]/.test(value) && /[A-Z]/.test(value)) || /[^A-Za-z0-9]/.test(value)) s++;
    return value.length < 8 ? Math.min(s, 1) : s;
  }

  if (meter && pw) {
    var labels = ["", "Weak", "Fair", "Good", "Strong"];
    var label = meter.querySelector(".strength__label");
    pw.addEventListener("input", function () {
      var level = score(pw.value);
      meter.classList.toggle("is-active", pw.value.length > 0);
      meter.setAttribute("data-level", String(level));
      if (label) label.textContent = labels[level] || "";
      syncMatch();
    });
  }

  function syncMatch() {
    if (!pw || !confirm) return;
    var field = confirm.closest(".field");
    if (field) field.classList.toggle("is-match", confirm.value.length > 0 && confirm.value === pw.value);
  }
  if (confirm) confirm.addEventListener("input", syncMatch);

  /* ---------------- verification code ---------------- */
  var box = document.querySelector("[data-code-slots]");
  var code = document.getElementById("code");
  if (box && code) {
    var slots = Array.prototype.slice.call(box.querySelectorAll(".code-slots span"));
    var hint = document.getElementById("pasteHint");
    var defaultHint = hint ? hint.textContent : "";

    var paint = function () {
      var digits = code.value.replace(/\D/g, "");
      slots.forEach(function (slot, i) {
        var ch = digits.charAt(i);
        slot.textContent = ch;
        slot.classList.toggle("is-filled", !!ch);
        slot.classList.toggle("is-active", i === Math.min(digits.length, slots.length - 1));
      });
    };
    code.addEventListener("input", paint);
    code.addEventListener("focus", paint);

    // Pull the 6-digit code out of whatever was pasted ("123 456", "Your code is 123456 ...").
    var extract = function (text) {
      var exact = String(text || "").match(/(?:^|\D)(\d{6})(?!\d)/);
      if (exact) return exact[1];
      return String(text || "").replace(/\D/g, "").slice(0, 6);
    };
    var apply = function (digits) {
      code.value = digits;
      code.dispatchEvent(new Event("input", { bubbles: true }));
      code.focus();
    };

    code.addEventListener("paste", function (event) {
      var text = event.clipboardData && event.clipboardData.getData("text");
      if (!text) return;
      event.preventDefault();
      apply(extract(text));
    });

    // Typing in the middle can't happen (the input is invisible); always edit at the end.
    code.addEventListener("click", function () {
      var end = code.value.length;
      try { code.setSelectionRange(end, end); } catch (_) { /* ignore */ }
    });

    var say = function (message, kind) {
      if (!hint) return;
      hint.textContent = message;
      hint.classList.toggle("is-warn", kind === "warn");
      hint.classList.toggle("is-good", kind === "good");
    };

    var pasteBtn = document.getElementById("pasteBtn");
    if (pasteBtn) {
      pasteBtn.addEventListener("click", async function () {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          code.focus();
          say("Your browser won't let us read the clipboard — press Ctrl+V (⌘V on Mac) to paste.", "warn");
          return;
        }
        try {
          var digits = extract(await navigator.clipboard.readText());
          if (digits.length === 6) {
            say("Code pasted.", "good");
            apply(digits);
          } else {
            code.focus();
            say("No 6-digit code on your clipboard yet — copy it from the email first.", "warn");
          }
        } catch (_) {
          code.focus();
          say("Clipboard access was blocked — press Ctrl+V (⌘V on Mac) to paste.", "warn");
        }
      });
    }

    // re-show the default hint as soon as the person starts typing again
    code.addEventListener("input", function () {
      if (hint && hint.classList.contains("is-warn")) say(defaultHint);
    });
    paint();
  }
})();
