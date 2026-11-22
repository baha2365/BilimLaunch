/*
 * BilimLaunch — the admin panel's background humpback whale.
 *
 * A 3D humpback drawn only from thin blue "strings": lines running nose to
 * tail, a few rings around the body, the grooves under the throat, the long
 * knobbly pectoral fins and the flukes. A slowly drifting pattern makes some
 * parts of the body fade out to nothing, so the whale looks partly
 * transparent, and a faint glow moves along it from head to tail.
 *
 * It swims a big, slow loop: away from you, across, then close past the screen,
 * beating its tail once every ~11 seconds. One <canvas> behind the page;
 * no libraries, CSP-friendly. With "reduce motion" switched on it stays still.
 */
(function () {
  "use strict";

  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;
  canvas.className = "whale-sky";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- tuning ---------------- */
  var COLOR = "rgb(64, 156, 255)"; // --blue-hi; the only colour used
  var ORBIT_SECONDS = 150; // one full lap of the loop
  var STROKE_SECONDS = 11; // one up-and-down beat of the tail
  var FPS = 30; // it moves slowly, so 30 frames a second is plenty
  var CAM = 2.6; // camera distance, in whale lengths
  var TILT = 0.32; // camera looks slightly down onto the loop
  var BUCKETS = 14; // alpha steps (one stroke() call each)

  var TAU = Math.PI * 2;
  var W = 0, H = 0, DPR = 1, S = 1, CX = 0, CY = 0, RX = 0.9;
  var phase0 = Math.random() * TAU;

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function smooth(a, b, x) { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); }
  function bump(x, c, w) { var d = (x - c) / w; return Math.exp(-d * d); }

  /* ---------------- the whale's shape (local space) ----------------
     s runs from the snout (0) to the tail stock (1); x points to the head,
     y up, z to the whale's right. One whale length = 1. */

  function girth(s) {
    return s < 0.33 ? Math.pow(s / 0.33, 0.56) : 0.06 + 0.94 * Math.pow(1 - (s - 0.33) / 0.67, 1.15);
  }

  var swim = 0; // tail-beat phase, set every frame

  function spineY(s) {
    return 0.012 * Math.sin(Math.PI * s) +
      0.055 * Math.pow(s, 2.4) * Math.sin(swim - 3.0 * s) -
      0.006 * Math.sin(swim + 0.6) * (1 - s);
  }

  // Point on the body surface at (s, angle th); th = PI/2 is the top of the back.
  function body(s, th, grow, o) {
    var g = girth(s);
    var sn = Math.sin(th);
    var w = 0.1 * g * (1 - 0.55 * smooth(0.72, 1, s)); // tail stock is flattened sideways
    var r;
    if (sn >= 0) {
      r = 0.085 * g * (0.78 + 0.22 * smooth(0.05, 0.4, s)) + // flat-topped head
        0.02 * bump(s, 0.645, 0.035) * Math.pow(sn, 8); // the small dorsal fin on its hump
    } else {
      r = 0.085 * g * (1 + 0.3 * bump(s, 0.24, 0.16)); // deep, pleated throat
    }
    o[0] = 0.5 - s;
    o[1] = spineY(s) + r * sn * grow;
    o[2] = w * Math.cos(th) * grow;
  }

  var FIN_ROOT = 0.3, FIN_LEN = 0.31;
  var finR = [0, 0, 0], finD = [0, 0, 0], finC = [0, 0, 0];

  // Set up the frame of one pectoral fin (side = 1 right, -1 left).
  function finFrame(side, t) {
    body(FIN_ROOT, side > 0 ? -0.5 : Math.PI + 0.5, 1, finR);
    var flap = 0.3 + 0.17 * Math.sin(t * TAU / 17 + side * 0.5);
    var dx = -0.55, dy = -Math.sin(flap) * 0.85, dz = side * Math.cos(flap) * 0.85;
    var n = Math.sqrt(dx * dx + dy * dy + dz * dz);
    finD[0] = dx / n; finD[1] = dy / n; finD[2] = dz / n;
    // chord: "backwards", made perpendicular to the fin's length
    var e = -finD[0];
    var cx = -1 - e * finD[0], cy = -e * finD[1], cz = -e * finD[2];
    n = Math.sqrt(cx * cx + cy * cy + cz * cz);
    finC[0] = cx / n; finC[1] = cy / n; finC[2] = cz / n;
  }

  // u: root (0) to tip (1); k: leading edge (0) to trailing edge (1).
  function fin(u, k, o) {
    var chord = 0.072 * Math.pow(Math.max(0, 1 - Math.pow(u, 1.5)), 0.75);
    var knobs = u > 0.06 ? 0.0055 * Math.pow(Math.max(0, Math.sin(u * Math.PI * 9)), 0.6) * (1 - 0.6 * u) : 0;
    var lead = -0.3 * chord - knobs, trail = 0.7 * chord;
    var across = lead + (trail - lead) * k + 0.05 * u * u; // swept back towards the tip
    var along = u * FIN_LEN;
    o[0] = finR[0] + finD[0] * along + finC[0] * across;
    o[1] = finR[1] + finD[1] * along + finC[1] * across - 0.028 * u * u;
    o[2] = finR[2] + finD[2] * along + finC[2] * across;
  }

  var tailT = [0, 0, 0], tailDir = [0, 0];

  function tailFrame() {
    var y1 = spineY(1), y0 = spineY(0.95);
    var dx = -0.05, dy = y1 - y0, n = Math.sqrt(dx * dx + dy * dy);
    tailT[0] = -0.5; tailT[1] = y1; tailT[2] = 0;
    tailDir[0] = dx / n; tailDir[1] = dy / n;
  }

  // v: left tip (-1) to right tip (1); k: leading (0) to trailing edge (1).
  function fluke(v, k, o) {
    var a = Math.abs(v);
    var lead = -0.035 + 0.12 * Math.pow(a, 1.6);
    var chord = 0.075 * Math.pow(Math.max(0, 1 - a * a), 0.6) * (0.55 + 0.45 * smooth(0, 0.25, a));
    var trail = lead + chord + (a > 0.1 ? 0.0035 * Math.sin(a * 38) * (1 - a) : 0); // ragged edge
    var b = lead + (trail - lead) * k;
    var flex = 0.03 * a * a * Math.sin(swim - 3.8); // tips lag behind the stroke
    o[0] = tailT[0] + tailDir[0] * b;
    o[1] = tailT[1] + tailDir[1] * b + flex;
    o[2] = v * 0.17;
  }

  /* ---------------- placing the whale in the scene ---------------- */

  var M = new Float64Array(9); // local -> camera rotation
  var P = new Float64Array(3); // local origin in camera space

  function orbitPos(phi, o) {
    o[0] = RX * Math.sin(phi);
    o[1] = 0.07 * Math.sin(2 * phi + 0.8) - 0.04;
    o[2] = 0.5 * Math.cos(phi);
  }

  var pA = [0, 0, 0], pB = [0, 0, 0];

  function place(t) {
    var phi = phase0 + t * TAU / ORBIT_SECONDS;
    var dt = 0.5;
    orbitPos(phi, pA);
    orbitPos(phase0 + (t + dt) * TAU / ORBIT_SECONDS, pB);
    var vx = pB[0] - pA[0], vy = pB[1] - pA[1], vz = pB[2] - pA[2];
    var hs = Math.sqrt(vx * vx + vz * vz);
    var hc = vx / hs, hsn = vz / hs; // heading
    var pitch = Math.atan2(vy, hs) * 1.6 + 0.035 * Math.sin(t * 0.31);
    // lean into the turn
    orbitPos(phase0 + (t + 2 * dt) * TAU / ORBIT_SECONDS, pA);
    var wx = pA[0] - pB[0], wz = pA[2] - pB[2];
    var turn = (vx * wz - vz * wx) / (hs * Math.sqrt(wx * wx + wz * wz));
    var roll = clamp(turn * 18, -0.3, 0.3);

    var cr = Math.cos(roll), sr = Math.sin(roll);
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var ct = Math.cos(TILT), st = Math.sin(TILT);
    // R = Tilt * Yaw * Pitch * Roll, written out column by column
    for (var col = 0; col < 3; col++) {
      var x = col === 0 ? 1 : 0, y = col === 1 ? 1 : 0, z = col === 2 ? 1 : 0;
      var y1 = y * cr - z * sr, z1 = y * sr + z * cr; // roll (about x)
      var x2 = x * cp - y1 * sp, y2 = x * sp + y1 * cp; // pitch (about z)
      var x3 = x2 * hc - z1 * hsn, z3 = x2 * hsn + z1 * hc; // yaw (about y)
      M[col] = x3;
      M[3 + col] = y2 * ct + z3 * st; // camera tilt
      M[6 + col] = -y2 * st + z3 * ct;
    }
    orbitPos(phi, pA);
    P[0] = pA[0];
    P[1] = pA[1] * ct + pA[2] * st;
    P[2] = -pA[1] * st + pA[2] * ct;
  }

  /* ---------------- drawing ---------------- */

  var bucket = [];
  for (var bi = 0; bi <= BUCKETS; bi++) bucket.push([]);

  var lp = [0, 0, 0];
  var line = { x: new Float64Array(160), y: new Float64Array(160), a: new Float64Array(160), n: 0 };
  var time = 0;

  // Project one local point into the current line; alpha comes from depth and the drifting see-through pattern.
  function push(o, s) {
    var x = M[0] * o[0] + M[1] * o[1] + M[2] * o[2] + P[0];
    var y = M[3] * o[0] + M[4] * o[1] + M[5] * o[2] + P[1];
    var z = M[6] * o[0] + M[7] * o[1] + M[8] * o[2] + P[2];
    var k = CAM / (CAM + z);
    var i = line.n++;
    line.x[i] = CX + x * k * S;
    line.y[i] = CY - y * k * S;

    var depth = clamp(1 - (z + 1.1) / 2.2, 0, 1);
    var n = Math.sin(o[0] * 11 + time * 0.21) * 0.5 +
      Math.sin(o[1] * 17 - o[0] * 6 + o[2] * 9 + time * 0.13) * 0.35 +
      Math.sin(o[2] * 14 + o[0] * 5 - time * 0.17) * 0.3;
    var see = smooth(-0.62, 0.3, n); // 0 = fully transparent here
    var glow = 1 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(s * 9 - time * 0.55), 8); // light running head -> tail
    line.a[i] = see * (0.3 + 0.7 * depth) * glow;
  }

  function flush(weight, closed) {
    var n = line.n;
    for (var i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
      var j = (i + 1) % n;
      var a = (line.a[i] + line.a[j]) * 0.5 * weight;
      var b = Math.round(clamp(a, 0, 1) * BUCKETS);
      if (b > 0) bucket[b].push(line.x[i], line.y[i], line.x[j], line.y[j]);
    }
    line.n = 0;
  }

  var LON = 30; // strings running nose to tail
  var SEG = 96; // points along each string
  var RINGS = 22;

  function draw(t) {
    time = t;
    swim = t * TAU / STROKE_SECONDS;
    place(t);
    tailFrame();

    var i, j, s, th;

    // body strings, nose to tail
    for (j = 0; j < LON; j++) {
      th = (j / LON) * TAU + 0.07;
      for (i = 0; i <= SEG; i++) {
        s = i / SEG;
        body(s, th, 1, lp);
        push(lp, s);
      }
      flush(0.62, false);
    }
    // a few rings around the body
    for (j = 1; j <= RINGS; j++) {
      s = Math.pow(j / (RINGS + 1), 0.9);
      for (i = 0; i < 48; i++) {
        body(s, (i / 48) * TAU, 1, lp);
        push(lp, s);
      }
      flush(0.34, true);
    }
    // throat grooves: chin to belly button
    for (j = -7; j <= 7; j++) {
      th = Math.PI * 1.5 + j * 0.085;
      var end = 0.47 - 0.07 * Math.abs(j) / 7;
      for (i = 0; i <= 40; i++) {
        s = 0.03 + (end - 0.03) * (i / 40);
        body(s, th, 1.012, lp);
        push(lp, s);
      }
      flush(0.5, false);
    }
    // eyes
    for (var side = -1; side <= 1; side += 2) {
      for (i = 0; i < 14; i++) {
        var q = (i / 14) * TAU;
        body(0.175 + 0.009 * Math.cos(q), (side > 0 ? -0.12 : Math.PI + 0.12) + side * 0.09 * Math.sin(q), 1.01, lp);
        push(lp, 0.175);
      }
      flush(0.9, true);
    }
    // pectoral fins
    for (side = -1; side <= 1; side += 2) {
      finFrame(side, t);
      var ks = [0, 0.18, 0.4, 0.62, 0.82, 1];
      for (j = 0; j < ks.length; j++) {
        for (i = 0; i <= 30; i++) {
          fin(i / 30, ks[j], lp);
          push(lp, FIN_ROOT + 0.15 * i / 30);
        }
        flush(j === 0 || j === ks.length - 1 ? 0.75 : 0.5, false);
      }
      for (j = 1; j <= 9; j++) {
        for (i = 0; i <= 6; i++) {
          fin(j / 10, i / 6, lp);
          push(lp, FIN_ROOT + 0.15 * j / 10);
        }
        flush(0.34, false);
      }
    }
    // flukes
    var fk = [0, 0.33, 0.66, 1];
    for (j = 0; j < fk.length; j++) {
      for (i = 0; i <= 60; i++) {
        fluke(-1 + 2 * i / 60, fk[j], lp);
        push(lp, 1);
      }
      flush(j === 0 || j === fk.length - 1 ? 0.75 : 0.5, false);
    }
    var fv = [0.12, 0.3, 0.48, 0.66, 0.84];
    for (j = 0; j < fv.length; j++) {
      for (side = -1; side <= 1; side += 2) {
        for (i = 0; i <= 6; i++) {
          fluke(side * fv[j], i / 6, lp);
          push(lp, 1);
        }
        flush(0.34, false);
      }
    }

    // paint: one stroke per alpha step
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = COLOR;
    ctx.lineWidth = 1;
    for (var b = 1; b <= BUCKETS; b++) {
      var segs = bucket[b];
      if (!segs.length) continue;
      ctx.globalAlpha = b / BUCKETS;
      ctx.beginPath();
      for (i = 0; i < segs.length; i += 4) {
        ctx.moveTo(segs[i], segs[i + 1]);
        ctx.lineTo(segs[i + 2], segs[i + 3]);
      }
      ctx.stroke();
      segs.length = 0;
    }
  }

  /* ---------------- sizing + loop ---------------- */

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    S = Math.min(W * 0.36, H * 0.62);
    RX = clamp((W / 2 / S) * 0.82, 0.45, 1.25); // wide loop: mostly side-on, turning at the screen edges
    CX = W / 2;
    CY = H * 0.6;
  }

  var start = performance.now();
  var last = 0;
  var still = 38; // the pose shown when motion is reduced

  function frame(now) {
    window.requestAnimationFrame(frame);
    if (now - last < 1000 / FPS - 2) return;
    last = now;
    draw((now - start) / 1000);
  }

  resize();
  window.addEventListener("resize", function () {
    resize();
    if (reduceMotion) draw(still);
  });

  if (reduceMotion) draw(still);
  else window.requestAnimationFrame(frame);
  window.requestAnimationFrame(function () { canvas.classList.add("is-on"); });
})();
