'use strict';
// Trains the exercise classifier that runs on camera pose landmarks.
//
//   node ml/train.js            -> writes web/model/exercise-model.json and prints metrics
//
// There is no labelled video of real people doing these exercises, so training uses two
// kinds of data, both cut into 3-second windows and turned into features by web/motion.js
// (the code the browser runs on MediaPipe landmarks):
//   1. Synthetic: joint positions from the same kinematics the 3D figure uses
//      (web/poses.js), varied in body proportions, speed, range of motion, rest between
//      reps, camera angle and landmark noise (heavier along the camera's depth axis, as a
//      single camera's depth estimate is the noisiest), plus a "Not exercising" class.
//   2. MediaPipe recordings (ml/data/*-a.json): real MediaPipe Pose output on the rendered
//      figure from four camera angles, which carry MediaPipe's own noise and geometry.
// Two test sets are reported: held-out synthetic windows, and MediaPipe recordings from
// three other camera angles (ml/data/*-b.json). Neither is real people on a real camera;
// that accuracy is unmeasured until it is tested with people.
const fs = require('node:fs');
const path = require('node:path');
const poses = require('../web/poses');
const motion = require('../web/motion');
const recordings = require('./recordings');
const stills = require('./stills');

const IDLE = motion.IDLE;
const CLASSES = [...Object.keys(poses.EXERCISES), IDLE];

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const uni = (lo, hi) => lo + (hi - lo) * next();
  const gauss = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, uni, gauss, pick: (xs) => xs[Math.floor(next() * xs.length)] };
}

function rotate(p, yaw, pitch) {
  const [x, y, z] = p;
  const x1 = x * Math.cos(yaw) + z * Math.sin(yaw), z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
  return [x1, y * Math.cos(pitch) - z1 * Math.sin(pitch), y * Math.sin(pitch) + z1 * Math.cos(pitch)];
}

// Idle variants: standing or sitting still, swaying, adjusting an arm, small fidgets.
function idlePose(r, kind, t, phase) {
  const { DEG } = poses;
  const P = kind.seated ? poses.seated() : poses.standing();
  P.side = kind.sway * Math.sin(t * kind.swayHz + phase) * DEG;
  P.lean = (kind.seated ? -5 : 0) * DEG + kind.lean * DEG;
  if (kind.gesture) {
    const k = kind.gesture.side;
    P.arms[k] = poses.arm(P.arms[k].f + kind.gesture.f * (0.5 - 0.5 * Math.cos(t * kind.gesture.hz + phase)), P.arms[k].e + kind.gesture.e * (0.5 - 0.5 * Math.cos(t * kind.gesture.hz + phase)), P.arms[k].ab);
  }
  P.pelvis = [P.pelvis[0], P.pelvis[1] + 0.004 * Math.sin(t * 1.6 + phase), P.pelvis[2]];
  return P;
}

function sample(r, label) {
  const scale = () => 1 + 0.07 * r.gauss();
  const B = poses.BODY;
  const body = { T: B.T * scale(), S: B.S * scale(), ANKLE: B.ANKLE, TORSO: B.TORSO * scale(), UPPER: B.UPPER * scale(), FORE: B.FORE * scale(), HIPW: B.HIPW * scale(), SHW: B.SHW * scale() };
  const fps = r.uni(10, 30), dur = 3, n = Math.round(fps * dur);
  const noise = r.uni(0.004, 0.03), depthNoise = noise * r.uni(1, 3.5); // depth (camera z) is the noisiest axis
  const heelOffset = r.uni(-3, 9), leanOffset = r.uni(-6, 10); // MediaPipe places feet and torso a little differently
  const heel2dScale = r.uni(0.35, 1), heel2dOffset = r.uni(-2, 10);
  const yaw = r.uni(-Math.PI, Math.PI), pitch = r.uni(-10, 10) * poses.DEG;
  const t0 = r.uni(0, 20);
  const period = r.uni(1.6, 4.5), amp = r.uni(0.55, 1.05), moveFrac = r.uni(0.55, 0.9), speed = r.uni(0.7, 1.3);
  const idleKind = { seated: r.next() < 0.4, sway: r.uni(0, 4), swayHz: r.uni(0.3, 1.2), lean: r.uni(-4, 6), gesture: r.next() < 0.35 ? { side: r.pick(['L', 'R']), f: r.uni(0, 0.5), e: r.uni(0, 0.7), hz: r.uni(0.3, 1.2) } : null };
  const phase = r.uni(0, 6.28);
  // Half of idle samples use the named idle behaviours the figure was recorded doing.
  const idleVariant = label === IDLE && r.next() < 0.5 ? r.pick(Object.values(poses.IDLE_VARIANTS)) : null;
  const frames = [], times = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fps;
    let P;
    if (idleVariant) P = idleVariant(0, t + phase);
    else if (label === IDLE) P = idlePose(r, idleKind, t, phase);
    else if (poses.CONTINUOUS.has(label)) P = poses.EXERCISES[label](0, t * speed + phase);
    else {
      const k = ((t + phase) % period) / period;
      const p = k < moveFrac ? amp * (0.5 - 0.5 * Math.cos((k / moveFrac) * 2 * Math.PI)) : 0;
      P = poses.EXERCISES[label](p, t);
    }
    const J = poses.joints(P, body);
    const pts = {};
    for (const [k, v] of Object.entries(motion.pointsFromJoints(J))) {
      const q = rotate(v, yaw, pitch);
      pts[k] = [q[0] + noise * r.gauss(), q[1] + noise * r.gauss(), q[2] + depthNoise * r.gauss()];
    }
    // Pitch leaves "up" slightly off true vertical, as a phone propped at an angle would.
    const f = motion.frameAngles(pts);
    f[12] += leanOffset;
    f[13] += heelOffset;
    f[14] = f[14] * heel2dScale + heel2dOffset; // perspective makes the picture's ankle-to-toe gap vary with angle
    frames.push(f);
    times.push(i * (1000 / fps));
  }
  return motion.windowFeatures(frames, times);
}

function dataset(seed, perClass) {
  const r = rng(seed);
  const X = [], Y = [];
  for (let c = 0; c < CLASSES.length; c++) {
    for (let i = 0; i < perClass; i++) {
      X.push(sample(r, CLASSES[c]));
      Y.push(c);
    }
  }
  return { X, Y };
}

// ---------- a small MLP trained with Adam ----------
function train(X, Y, { hidden = 64, epochs = 60, lr = 0.004, batch = 64, seed = 7, l2 = 1e-4 } = {}) {
  const r = rng(seed);
  const nIn = X[0].length, nOut = CLASSES.length;
  const mean = Array(nIn).fill(0), std = Array(nIn).fill(0);
  for (const x of X) x.forEach((v, i) => (mean[i] += v / X.length));
  for (const x of X) x.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / X.length));
  for (let i = 0; i < nIn; i++) std[i] = Math.sqrt(std[i]) || 1;
  const Z = X.map((x) => x.map((v, i) => (v - mean[i]) / std[i]));

  const init = (rows, cols) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => r.gauss() * Math.sqrt(2 / cols)));
  const P = { W1: init(hidden, nIn), b1: Array(hidden).fill(0), W2: init(nOut, hidden), b2: Array(nOut).fill(0) };
  const zeros = (p) => (Array.isArray(p[0]) ? p.map((row) => row.map(() => 0)) : p.map(() => 0));
  const M = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, zeros(v)]));
  const V = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, zeros(v)]));
  let step = 0;
  const idx = X.map((_, i) => i);

  for (let ep = 0; ep < epochs; ep++) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(r.next() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    let loss = 0;
    for (let s = 0; s < idx.length; s += batch) {
      const G = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, zeros(v)]));
      const B = idx.slice(s, s + batch);
      for (const n of B) {
        const z = Z[n];
        const pre = P.W1.map((row, j) => row.reduce((a, w, i) => a + w * z[i], P.b1[j]));
        const h = pre.map((v) => Math.max(0, v));
        const o = P.W2.map((row, k) => row.reduce((a, w, j) => a + w * h[j], P.b2[k]));
        const m = Math.max(...o), e = o.map((v) => Math.exp(v - m)), sum = e.reduce((a, b) => a + b, 0);
        const prob = e.map((v) => v / sum);
        loss -= Math.log(prob[Y[n]] + 1e-12);
        const dO = prob.map((p, k) => p - (k === Y[n] ? 1 : 0));
        const dH = h.map((_, j) => (pre[j] > 0 ? dO.reduce((a, d, k) => a + d * P.W2[k][j], 0) : 0));
        for (let k = 0; k < nOut; k++) {
          G.b2[k] += dO[k];
          for (let j = 0; j < hidden; j++) G.W2[k][j] += dO[k] * h[j];
        }
        for (let j = 0; j < hidden; j++) {
          if (!dH[j]) continue;
          G.b1[j] += dH[j];
          for (let i = 0; i < nIn; i++) G.W1[j][i] += dH[j] * z[i];
        }
      }
      step++;
      const b1c = 1 - 0.9 ** step, b2c = 1 - 0.999 ** step;
      const upd = (p, g, m, v, decay) => {
        for (let i = 0; i < p.length; i++) {
          const gi = g[i] / B.length + (decay ? l2 * p[i] : 0);
          m[i] = 0.9 * m[i] + 0.1 * gi;
          v[i] = 0.999 * v[i] + 0.001 * gi * gi;
          p[i] -= (lr * (m[i] / b1c)) / (Math.sqrt(v[i] / b2c) + 1e-8);
        }
      };
      for (let j = 0; j < hidden; j++) upd(P.W1[j], G.W1[j], M.W1[j], V.W1[j], true);
      for (let k = 0; k < nOut; k++) upd(P.W2[k], G.W2[k], M.W2[k], V.W2[k], true);
      upd(P.b1, G.b1, M.b1, V.b1, false);
      upd(P.b2, G.b2, M.b2, V.b2, false);
    }
    if (process.env.VERBOSE) console.log(`epoch ${ep + 1}: loss ${(loss / idx.length).toFixed(4)}`);
  }
  const round = (a) => (Array.isArray(a[0]) ? a.map(round) : a.map((v) => Math.round(v * 1e5) / 1e5));
  return { classes: CLASSES, features: motion.CHANNELS.flatMap((c) => motion.STATS.map((s) => `${c}.${s}`)), mean: round(mean), std: round(std), W1: round(P.W1), b1: round(P.b1), W2: round(P.W2), b2: round(P.b2) };
}

function evaluate(model, X, Y) {
  const conf = CLASSES.map(() => CLASSES.map(() => 0));
  let ok = 0;
  X.forEach((x, n) => {
    const p = motion.predict(model, x);
    const k = p.indexOf(Math.max(...p));
    conf[Y[n]][k]++;
    if (k === Y[n]) ok++;
  });
  return { accuracy: ok / X.length, confusion: conf };
}

// Held-out photos of real people, each held still for 3 seconds (8 variations each).
function stillTest(test) {
  let a = 99;
  const rng = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  const jitter = stills.jitterModel();
  const X = [], Y = [];
  for (const s of test) for (let k = 0; k < 8; k++) (X.push(stills.holdStill(s, jitter, rng)), Y.push(CLASSES.indexOf(IDLE)));
  return { X, Y };
}

function main() {
  const t = Date.now();
  const syn = dataset(198, 500);
  // MediaPipe recordings for training, run "e": every exercise fast and full from five
  // angles and slow and shallow from four, plus seven ways of being idle from three.
  // Windows every 250 ms, plus copies with frames dropped to mimic slower cameras.
  const r = rng(11);
  const mp = ['e'].flatMap((run) => [recordings.windows(run, CLASSES, { step: 250 }), recordings.windows(run, CLASSES, { step: 250, keep: 0.6, rng: r.next }), recordings.windows(run, CLASSES, { step: 250, keep: 0.4, rng: r.next })]);
  const mpX = mp.flatMap((d) => d.X), mpY = mp.flatMap((d) => d.Y);
  // Real bodies from photos (three quarters of them; the rest are kept for testing).
  const photos = stills.split(stills.load());
  const real = stills.trainingWindows(CLASSES, photos.train);
  const X = [...syn.X, ...mpX, ...real.X], Y = [...syn.Y, ...mpY, ...real.Y];

  // Test sets, never trained on: held-out synthetic, and MediaPipe run "f" (other camera
  // angles, a 3-second tempo, 85% range, and every idle behaviour).
  const tests = { synthetic: dataset(2026, 120), mediapipe: recordings.windows('f', CLASSES, { step: 250 }), facing_camera: recordings.windows('g', CLASSES, { step: 250 }), real_people_holding_still: stillTest(photos.test) };
  const model = train(X, Y);
  const perClass = (res) => Object.fromEntries(CLASSES.map((c, i) => [c, Math.round((res.confusion[i][i] / Math.max(1, res.confusion[i].reduce((a, b) => a + b, 0))) * 1000) / 1000]));
  const results = Object.fromEntries(Object.entries(tests).filter(([, d]) => d.X.length).map(([k, d]) => [k, { n: d.X.length, ...evaluate(model, d.X, d.Y) }]));
  model.trained = {
    on: 'synthetic pose windows from web/poses.js and MediaPipe Pose output on the rendered figure',
    train_windows: { synthetic: syn.X.length, mediapipe: mpX.length, real_body_photos: real.X.length, photos: photos.train.length },
    test: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { windows: v.n, accuracy: Math.round(v.accuracy * 1000) / 1000, per_class: perClass(v) }])),
  };
  const out = path.join(__dirname, '..', 'web', 'model', 'exercise-model.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(model));
  console.log(`Trained in ${((Date.now() - t) / 1000).toFixed(1)} s on ${syn.X.length} synthetic + ${mpX.length} MediaPipe windows.`);
  for (const [k, v] of Object.entries(results)) {
    console.log(`
${k}: ${(v.accuracy * 100).toFixed(1)}% of ${v.n}`);
    if (k === 'synthetic') continue;
    for (const [c, a] of Object.entries(perClass(v))) console.log(`  ${c.padEnd(24)} ${(a * 100).toFixed(1)}%`);
    const worst = [];
    v.confusion.forEach((row, i) => row.forEach((n, j) => i !== j && n && worst.push([n, CLASSES[i], CLASSES[j]])));
    worst.sort((a, b) => b[0] - a[0]);
    if (worst.length) console.log('  Most confused:', worst.slice(0, 4).map(([n, a, b]) => `${a} -> ${b} (${n})`).join('; '));
  }
  console.log(`
Wrote ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}

if (require.main === module) main();
module.exports = { sample, dataset, train, evaluate, CLASSES };
