'use strict';
// MediaPipe recordings: real MediaPipe Pose output on the rendered 3D figure performing each
// exercise from several camera angles (made in the browser, saved by ml/capture-server.js).
// They carry MediaPipe's own noise and body geometry, which synthetic joints do not.
const fs = require('node:fs');
const path = require('node:path');
const motion = require('../web/motion');

const DIR = path.join(__dirname, 'data');

// Cut each recording into 3-second windows, stepping `step` ms, within one camera angle.
// `keep` < 1 randomly drops frames to mimic a slower camera.
function windows(run, classes, { step = 500, keep = 1, rng = Math.random } = {}) {
  const X = [], Y = [];
  if (!fs.existsSync(DIR)) return { X, Y };
  // Run "c" matches c.json, c1.json, c2.json ... (several recording passes of one run).
  for (const f of fs.readdirSync(DIR).filter((n) => new RegExp(`-${run}\\d*\\.json$`).test(n))) {
    const rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const y = classes.indexOf(rec.label);
    if (y < 0) continue;
    for (const yaw of new Set(rec.yaw)) {
      const idx = rec.yaw.map((v, i) => (v === yaw ? i : -1)).filter((i) => i >= 0);
      const t = idx.map((i) => rec.times[i]);
      for (let start = t[0]; start + 3000 <= t[t.length - 1]; start += step) {
        const sel = idx.filter((i, k) => t[k] >= start && t[k] < start + 3000 && (keep >= 1 || rng() < keep));
        if (sel.length < 8) continue;
        X.push(motion.windowFeatures(sel.map((i) => rec.frames[i]), sel.map((i) => rec.times[i])));
        Y.push(y);
      }
    }
  }
  return { X, Y };
}

module.exports = { windows, DIR };
