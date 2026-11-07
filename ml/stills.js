'use strict';
// Real bodies from photos (ml/stills.json, measured by MediaPipe from the Wikimedia Commons
// photos fetched by ml/fetch-commons.js). A photo is a single moment, so it cannot show an
// exercise's movement, but it does show real body proportions and postures, which the 3D
// figure cannot. Two uses:
//   holdStill(): 3 seconds of a real person holding that posture, with MediaPipe's own
//     frame-to-frame jitter (measured from recordings), labelled "Not exercising".
//   transplant(): a recorded movement's ups and downs laid over a real person's posture,
//     so the model learns the movement, not the 3D figure's particular way of standing.
const fs = require('node:fs');
const path = require('node:path');
const motion = require('../web/motion');
const recordings = require('./recordings');

const FILE = path.join(__dirname, 'stills.json');
const FULL_BODY = [6, 7, 8, 9, 10, 11]; // hips, knees, ankles in the stored visibility list

function load() {
  if (!fs.existsSync(FILE)) return [];
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).filter((s) => s.angles && FULL_BODY.every((i) => s.vis[i] > 0.5));
}

// Split photos into training and test sets by photo, deterministically.
function split(stills) {
  const hash = (s) => [...s.file].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return { train: stills.filter((s) => hash(s) % 4 !== 0), test: stills.filter((s) => hash(s) % 4 === 0) };
}

// MediaPipe's frame-to-frame jitter per channel, measured from recordings of the figure
// standing and sitting still: the spread around a 0.5-second moving average.
function jitterModel() {
  const dir = path.join(__dirname, 'data');
  const sums = new Array(motion.CHANNELS.length).fill(0);
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => /^not-exercising-e\d+\.json$/.test(x))) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const F = rec.frames;
    for (let i = 4; i < F.length - 4; i++) {
      for (let c = 0; c < sums.length; c++) {
        let m = 0;
        for (let j = -3; j <= 3; j++) m += F[i + j][c];
        sums[c] += (F[i][c] - m / 7) ** 2;
      }
      n++;
    }
  }
  return sums.map((s) => Math.sqrt(s / Math.max(1, n)));
}

function gauss(rng) {
  return Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
}

// One 3-second window of a real person holding still at ~15 fps.
function holdStill(still, jitter, rng) {
  const fps = 10 + rng() * 15, n = Math.round(fps * 3);
  const sway = 0.5 + rng() * 2, hz = 0.3 + rng() * 0.8, ph = rng() * 6.28;
  const frames = [], times = [];
  for (let i = 0; i < n; i++) {
    const s = Math.sin((i / fps) * hz * 2 * Math.PI + ph);
    frames.push(still.angles.map((v, c) => v + jitter[c] * gauss(rng) + (c === 12 ? sway * s : 0)));
    times.push((i * 1000) / fps);
  }
  return motion.windowFeatures(frames, times);
}

// A recorded movement laid over a real person's posture: each channel keeps the recording's
// movement around its own average but takes its average from the photo. Joint angles are
// kept within 0..180 degrees.
function transplant(still, rec, idx, rng) {
  const frames = idx.map((i) => rec.frames[i]);
  const means = frames[0].map((_, c) => frames.reduce((a, f) => a + f[c], 0) / frames.length);
  const w = 0.5 + rng() * 0.5; // how far toward the photo's posture
  const out = frames.map((f) => f.map((v, c) => {
    const x = v + w * (still.angles[c] - means[c]);
    return c < 8 || c === 12 ? Math.max(0, Math.min(180, x)) : x;
  }));
  return motion.windowFeatures(out, idx.map((i) => rec.times[i]));
}

// Upper-body movements can be done from almost any standing or sitting posture.
const PORTABLE = new Set(['Bicep curl', 'Lateral arm raise', 'Stretching']);

function trainingWindows(classes, stills, { perStill = 6, seed = 5 } = {}) {
  let a = seed;
  const rng = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  const jitter = jitterModel();
  const X = [], Y = [];
  const idle = classes.indexOf(motion.IDLE);
  for (const s of stills) for (let k = 0; k < perStill; k++) (X.push(holdStill(s, jitter, rng)), Y.push(idle));

  // Movements from the training recordings, transplanted onto photos.
  const dir = path.join(__dirname, 'data');
  for (const f of fs.readdirSync(dir).filter((x) => /-e\d+\.json$/.test(x))) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!PORTABLE.has(rec.label)) continue;
    const y = classes.indexOf(rec.label);
    for (const yaw of new Set(rec.yaw)) {
      const idx = rec.yaw.map((v, i) => (v === yaw ? i : -1)).filter((i) => i >= 0);
      const t = idx.map((i) => rec.times[i]);
      for (let st = t[0]; st + 3000 <= t[t.length - 1]; st += 1000) {
        const sel = idx.filter((i, k) => t[k] >= st && t[k] < st + 3000);
        if (sel.length < 8) continue;
        const s = stills[Math.floor(rng() * stills.length)];
        X.push(transplant(s, rec, sel, rng));
        Y.push(y);
      }
    }
  }
  return { X, Y };
}

module.exports = { load, split, jitterModel, holdStill, transplant, trainingWindows };
