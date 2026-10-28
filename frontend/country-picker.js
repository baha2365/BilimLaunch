/*
 * BilimLaunch -- country drop-down with instant search.
 *
 * Turns <input data-country-picker> into a single choice and
 * <input data-country-picker="multi"> into a multiple choice (chips, up to 10).
 * The original <input> stays in the page and always holds the final text
 * ("Italy" or "Italy, Germany"), so the rest of the code keeps working unchanged:
 * reading .value, writing .value, error messages and the server check.
 *
 * Keyboard: type to search, Up/Down to move, Enter to choose, Esc to close.
 * Needs js/countries.js first.
 */
(function () {
  "use strict";

  var C = window.BLCountries;
  if (!C) return;

  var MAX_MULTI = 10;
  var uid = 0;
  var openPicker = null;
  var NS = "http://www.w3.org/2000/svg";

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(kind) {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(NS, "path");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (kind === "chevron") path.setAttribute("d", "M3.5 6l4.5 4.5L12.5 6");
    else if (kind === "check") path.setAttribute("d", "M3 8.5l3.2 3.2L13 4.8");
    else if (kind === "x") path.setAttribute("d", "M4 4l8 8M12 4l-8 8");
    else {
      var circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", "7");
      circle.setAttribute("cy", "7");
      circle.setAttribute("r", "4.6");
      circle.setAttribute("stroke", "currentColor");
      circle.setAttribute("stroke-width", "1.8");
      svg.appendChild(circle);
      path.setAttribute("d", "M10.5 10.5L14 14");
    }
    svg.appendChild(path);
    return svg;
  }

  function Picker(input) {
    var self = this;
    this.input = input;
    this.multi = input.getAttribute("data-country-picker") === "multi";
    this.id = "cp" + ++uid;
    this.placeholder = input.getAttribute("placeholder") || (this.multi ? "Select countries" : "Select a country");
    this.selected = []; // canonical names (or the raw text when it is not in the list)
    this.items = [];
    this.active = 0;
    this.isOpen = false;
    this.query = "";

    /* ---- shell: wrapper, trigger, hidden native input ---- */
    this.root = el("div", "cp" + (this.multi ? " cp--multi" : ""));
    input.parentNode.insertBefore(this.root, input);
    this.root.appendChild(input);
    input.classList.add("cp-native");
    input.setAttribute("tabindex", "-1");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-hidden", "true");

    this.trigger = el("div", "cp__trigger");
    this.trigger.setAttribute("role", "combobox");
    this.trigger.setAttribute("tabindex", "0");
    this.trigger.setAttribute("aria-haspopup", "listbox");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.setAttribute("aria-controls", this.id + "-list");
    var label = input.id && document.querySelector('label[for="' + input.id + '"]');
    if (label) {
      if (!label.id) label.id = this.id + "-label";
      this.trigger.setAttribute("aria-labelledby", label.id);
    }
    this.display = el("div", "cp__display");
    this.chevron = el("span", "cp__chevron");
    this.chevron.appendChild(icon("chevron"));
    this.trigger.appendChild(this.display);
    this.trigger.appendChild(this.chevron);
    this.root.appendChild(this.trigger);

    /* ---- popover (lives in <body> so no card can clip it) ---- */
    this.pop = el("div", "cp-pop");
    var bar = el("div", "cp-pop__search");
    bar.appendChild(icon("search"));
    this.search = el("input", "cp-pop__input");
    this.search.type = "text";
    this.search.placeholder = "Search countries";
    this.search.setAttribute("aria-label", "Search countries");
    this.search.setAttribute("role", "combobox");
    this.search.setAttribute("aria-autocomplete", "list");
    this.search.setAttribute("aria-controls", this.id + "-list");
    this.search.setAttribute("aria-expanded", "true");
    this.search.setAttribute("autocomplete", "off");
    this.search.setAttribute("autocorrect", "off");
    this.search.setAttribute("autocapitalize", "off");
    this.search.setAttribute("spellcheck", "false");
    this.search.setAttribute("enterkeyhint", "go");
    bar.appendChild(this.search);
    this.pop.appendChild(bar);
    this.list = el("div", "cp-pop__list");
    this.list.id = this.id + "-list";
    this.list.setAttribute("role", "listbox");
    if (this.multi) this.list.setAttribute("aria-multiselectable", "true");
    this.pop.appendChild(this.list);
    if (this.multi) {
      var foot = el("div", "cp-pop__foot");
      this.count = el("span", "cp-pop__count");
      var done = el("button", "cp-pop__done", "Done");
      done.type = "button";
      done.addEventListener("click", function () { self.close(true); });
      foot.appendChild(this.count);
      foot.appendChild(done);
      this.pop.appendChild(foot);
    }

    /* ---- make `input.value = "..."` (used by the profile form) update the picker ---- */
    var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    this.rawGet = function () { return desc.get.call(input); };
    this.rawSet = function (v) { desc.set.call(input, v); };
    Object.defineProperty(input, "value", {
      configurable: true,
      get: function () { return self.rawGet(); },
      set: function (v) { self.setFromText(v); }
    });
    var form = input.form;
    if (form) form.addEventListener("reset", function () { window.setTimeout(function () { self.setFromText(self.rawGet()); }, 0); });

    this.bind();
    this.setFromText(this.rawGet());
  }

  Picker.prototype.setFromText = function (text) {
    var parts = this.multi ? String(text || "").split(/[,;\n]/) : [String(text || "")];
    var out = [];
    parts.forEach(function (part) {
      var raw = part.trim();
      if (!raw) return;
      var name = C.canonical(raw) || raw;
      if (out.indexOf(name) < 0) out.push(name);
    });
    this.selected = this.multi ? out : out.slice(0, 1);
    this.commit(false);
  };

  // write the chosen names back into the real input and redraw the trigger
  Picker.prototype.commit = function (notify) {
    this.rawSet(this.selected.join(", "));
    this.renderTrigger();
    if (notify) {
      var input = this.input;
      input.classList.remove("has-error");
      var err = input.id && document.getElementById(input.id + "-error");
      if (err) { err.textContent = ""; err.classList.remove("is-visible"); }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  Picker.prototype.renderTrigger = function () {
    var self = this;
    this.display.textContent = "";
    if (!this.selected.length) {
      this.display.appendChild(el("span", "cp__placeholder", this.placeholder));
    } else if (!this.multi) {
      this.display.appendChild(el("span", "cp__text", this.selected[0]));
    } else {
      this.selected.forEach(function (name) {
        var chip = el("span", "cp-chip");
        chip.appendChild(el("span", "cp-chip__name", name));
        var x = el("button", "cp-chip__x");
        x.type = "button";
        x.setAttribute("aria-label", "Remove " + name);
        x.appendChild(icon("x"));
        x.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
        x.addEventListener("click", function (e) {
          e.stopPropagation();
          self.selected = self.selected.filter(function (n) { return n !== name; });
          self.commit(true);
          if (self.isOpen) self.renderList();
        });
        chip.appendChild(x);
        self.display.appendChild(chip);
      });
    }
    if (this.count) {
      this.count.textContent = this.selected.length + " of " + MAX_MULTI + " selected";
    }
  };

  /* ---------- list ---------- */
  Picker.prototype.compute = function () {
    var q = this.query;
    this.items = [];
    this.sections = [];
    if (!q.trim()) {
      var pop = C.POPULAR;
      this.sections.push({ title: "Popular", from: 0 });
      pop.forEach(function (n) { this.items.push({ name: n, via: "" }); }, this);
      this.sections.push({ title: "All countries", from: this.items.length });
      C.NAMES.forEach(function (n) { this.items.push({ name: n, via: "" }); }, this);
    } else {
      this.items = C.search(q);
    }
  };

  Picker.prototype.renderList = function (keepActive) {
    var self = this;
    this.compute();
    if (!keepActive) {
      this.active = 0;
      if (!this.query.trim() && this.selected.length) {
        var at = -1;
        for (var k = this.items.length - 1; k >= 0; k--) { if (this.items[k].name === this.selected[0]) at = k; }
        if (at >= 0 && !this.multi) this.active = at;
      }
    }
    if (this.active >= this.items.length) this.active = Math.max(0, this.items.length - 1);
    this.list.textContent = "";
    var q = C.fold(this.query).replace(/[.]/g, "");
    var full = this.multi && this.selected.length >= MAX_MULTI;

    if (!this.items.length) {
      this.list.appendChild(el("div", "cp-pop__empty", "No country found for “" + this.query.trim() + "”"));
      this.search.removeAttribute("aria-activedescendant");
      return;
    }
    var sectionAt = {};
    (this.sections || []).forEach(function (s) { sectionAt[s.from] = s.title; });

    this.items.forEach(function (item, i) {
      if (sectionAt[i]) {
        var h = el("div", "cp-pop__heading", sectionAt[i]);
        h.setAttribute("role", "presentation");
        self.list.appendChild(h);
      }
      var isSel = self.selected.indexOf(item.name) >= 0;
      var disabled = full && !isSel;
      var row = el("div", "cp-opt" + (i === self.active ? " is-active" : "") + (isSel ? " is-selected" : "") + (disabled ? " is-disabled" : ""));
      row.id = self.id + "-o" + i;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", isSel ? "true" : "false");
      if (disabled) row.setAttribute("aria-disabled", "true");
      row.setAttribute("data-i", String(i));

      var label = el("span", "cp-opt__name");
      var key = C.fold(item.name);
      if (q && key.indexOf(q) === 0) {
        label.appendChild(el("b", null, item.name.slice(0, q.length)));
        label.appendChild(document.createTextNode(item.name.slice(q.length)));
      } else {
        label.textContent = item.name;
      }
      row.appendChild(label);
      if (item.via) row.appendChild(el("span", "cp-opt__via", item.via.toUpperCase().length <= 4 ? item.via.toUpperCase() : item.via));
      var tick = el("span", "cp-opt__tick");
      if (isSel) tick.appendChild(icon("check"));
      row.appendChild(tick);
      self.list.appendChild(row);
    });
    this.syncActive(false);
  };

  Picker.prototype.syncActive = function (scroll) {
    var rows = this.list.querySelectorAll(".cp-opt");
    var current = null;
    for (var i = 0; i < rows.length; i++) {
      var on = Number(rows[i].getAttribute("data-i")) === this.active;
      rows[i].classList.toggle("is-active", on);
      if (on) current = rows[i];
    }
    if (current) {
      this.search.setAttribute("aria-activedescendant", current.id);
      if (scroll !== false) this.scrollTo(current);
    }
  };

  Picker.prototype.scrollTo = function (row) {
    var list = this.list;
    var top = row.offsetTop - list.offsetTop;
    var bottom = top + row.offsetHeight;
    if (top < list.scrollTop + 4) list.scrollTop = Math.max(0, top - 36 > 0 && row.previousElementSibling && row.previousElementSibling.classList.contains("cp-pop__heading") ? top - 36 : top - 4);
    else if (bottom > list.scrollTop + list.clientHeight - 4) list.scrollTop = bottom - list.clientHeight + 4;
  };

  Picker.prototype.choose = function (index) {
    var item = this.items[index];
    if (!item) return;
    if (this.multi) {
      var at = this.selected.indexOf(item.name);
      if (at >= 0) this.selected.splice(at, 1);
      else if (this.selected.length < MAX_MULTI) this.selected.push(item.name);
      else return;
      this.commit(true);
      this.query = "";
      this.search.value = "";
      this.renderList();
      this.place();
      this.search.focus();
    } else {
      this.selected = [item.name];
      this.commit(true);
      this.close(true);
    }
  };

  /* ---------- open / close / position ---------- */
  Picker.prototype.place = function () {
    var r = this.trigger.getBoundingClientRect();
    var vv = window.visualViewport;
    var vh = vv ? vv.height : window.innerHeight;
    var vTop = vv ? vv.offsetTop : 0;
    var below = vTop + vh - r.bottom - 14;
    var above = r.top - vTop - 14;
    var flip = below < 300 && above > below;
    var room = Math.max(190, Math.min(flip ? above : below, 420));
    var s = this.pop.style;
    s.left = Math.round(r.left) + "px";
    s.width = Math.round(r.width) + "px";
    s.maxHeight = room + "px";
    if (flip) { s.top = "auto"; s.bottom = Math.round(window.innerHeight - r.top + 8) + "px"; this.pop.classList.add("is-up"); }
    else { s.bottom = "auto"; s.top = Math.round(r.bottom + 8) + "px"; this.pop.classList.remove("is-up"); }
  };

  Picker.prototype.open = function (firstChar) {
    if (this.isOpen) return;
    if (openPicker && openPicker !== this) openPicker.close(false);
    openPicker = this;
    this.isOpen = true;
    this.query = firstChar || "";
    this.search.value = this.query;
    document.body.appendChild(this.pop);
    this.root.classList.add("is-open");
    this.trigger.setAttribute("aria-expanded", "true");
    this.renderList();
    this.place();
    this.pop.classList.add("is-open");
    var self = this;
    this.search.focus({ preventScroll: true });
    window.requestAnimationFrame(function () {
      self.place();
      var cur = self.list.querySelector(".is-active");
      if (cur && !self.query) self.scrollTo(cur);
    });
  };

  Picker.prototype.close = function (refocus) {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (openPicker === this) openPicker = null;
    this.root.classList.remove("is-open");
    this.trigger.setAttribute("aria-expanded", "false");
    this.pop.classList.remove("is-open");
    if (this.pop.parentNode) this.pop.parentNode.removeChild(this.pop);
    if (refocus) this.trigger.focus({ preventScroll: true });
  };

  /* ---------- events ---------- */
  Picker.prototype.bind = function () {
    var self = this;

    // clicking the <label>, or code focusing the hidden input (form error), lands on the trigger
    this.input.addEventListener("focus", function () { self.trigger.focus(); });

    this.trigger.addEventListener("click", function () {
      if (self.isOpen) self.close(true); else self.open();
    });
    this.trigger.addEventListener("keydown", function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        self.open();
      } else if (e.key.length === 1) {
        e.preventDefault();
        self.open(e.key);
      } else if (e.key === "Backspace" && self.multi && self.selected.length) {
        e.preventDefault();
        self.selected.pop();
        self.commit(true);
      }
    });

    this.search.addEventListener("input", function () {
      self.query = self.search.value;
      self.renderList();
      self.list.scrollTop = 0;
    });
    this.search.addEventListener("keydown", function (e) {
      var n = self.items.length;
      if (e.key === "ArrowDown") { e.preventDefault(); if (n) { self.active = Math.min(n - 1, self.active + 1); self.syncActive(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (n) { self.active = Math.max(0, self.active - 1); self.syncActive(); } }
      else if (e.key === "PageDown") { e.preventDefault(); if (n) { self.active = Math.min(n - 1, self.active + 8); self.syncActive(); } }
      else if (e.key === "PageUp") { e.preventDefault(); if (n) { self.active = Math.max(0, self.active - 8); self.syncActive(); } }
      else if (e.key === "Enter") { e.preventDefault(); self.choose(self.active); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); self.close(true); }
      else if (e.key === "Tab") { self.close(true); }
      else if (e.key === "Backspace" && self.multi && !self.search.value && self.selected.length) {
        self.selected.pop();
        self.commit(true);
        self.renderList(true);
      }
    });

    this.list.addEventListener("pointerdown", function (e) { e.preventDefault(); }); // keep focus in the search box
    this.list.addEventListener("mousemove", function (e) {
      var row = e.target.closest && e.target.closest(".cp-opt");
      if (!row) return;
      var i = Number(row.getAttribute("data-i"));
      if (i !== self.active) { self.active = i; self.syncActive(false); }
    });
    this.list.addEventListener("click", function (e) {
      var row = e.target.closest && e.target.closest(".cp-opt");
      if (!row || row.classList.contains("is-disabled")) return;
      self.choose(Number(row.getAttribute("data-i")));
    });
    this.pop.addEventListener("pointerdown", function (e) {
      if (e.target !== self.search && !(e.target.closest && e.target.closest(".cp-pop__done"))) e.preventDefault();
    });
  };

  document.addEventListener("pointerdown", function (e) {
    var p = openPicker;
    if (!p) return;
    if (p.pop.contains(e.target) || p.root.contains(e.target)) return;
    p.close(false);
  });
  window.addEventListener("resize", function () { if (openPicker) openPicker.place(); });
  window.addEventListener("scroll", function () { if (openPicker) openPicker.place(); }, true);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", function () { if (openPicker) openPicker.place(); });

  function init() {
    var inputs = document.querySelectorAll("input[data-country-picker]");
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].__bl_picker) inputs[i].__bl_picker = new Picker(inputs[i]);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
