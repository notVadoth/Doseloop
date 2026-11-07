'use strict';
// Accuracy of the shipped model on the held-out recordings, split by how the person faces
// the camera. The figure's camera sits 0.95 rad (54°) round from the front, so a
// recording's "turn" t means a viewing angle of 54° + t in degrees from straight on.
//   node ml/by-view.js [run]
const fs = require('node:fs');
const path = require('node:path');
const motion = require('../web/motion');
const { CLASSES } = require('./train');

const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'model', 'exercise-model.json'), 'utf8'));
const run = process.argv[2] || 'f';
const DIR = path.join(__dirname, 'data');
const view = (turn) => Math.abs(((0.95 + turn) * 180) / Math.PI);
const bucket = (deg) => (deg <= 50 ? 'facing (within 50°)' : deg <= 100 ? 'side-on (50-100°)' : 'from behind (over 100°)');

const stats = {};
for (const f of fs.readdirSync(DIR).filter((n) => new RegExp(`-${run}\\d*\\.json$`).test(n))) {
  const rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const y = CLASSES.indexOf(rec.label);
  for (const turn of new Set(rec.yaw)) {
    const idx = rec.yaw.map((v, i) => (v === turn ? i : -1)).filter((i) => i >= 0);
    const t = idx.map((i) => rec.times[i]);
    const b = bucket(view(turn));
    for (let s = t[0]; s + 3000 <= t[t.length - 1]; s += 250) {
      const sel = idx.filter((i, k) => t[k] >= s && t[k] < s + 3000);
      if (sel.length < 8) continue;
      const p = motion.predict(model, motion.windowFeatures(sel.map((i) => rec.frames[i]), sel.map((i) => rec.times[i])));
      const k = p.indexOf(Math.max(...p));
      const st = (stats[b] ||= { n: 0, ok: 0, perClass: {} });
      const pc = (st.perClass[rec.label] ||= [0, 0]);
      st.n++;
      pc[1]++;
      if (k === y) {
        st.ok++;
        pc[0]++;
      }
    }
  }
}
for (const [b, st] of Object.entries(stats).sort()) {
  console.log(`${b}: ${((st.ok / st.n) * 100).toFixed(1)}% of ${st.n} windows`);
  for (const [c, [ok, n]] of Object.entries(st.perClass)) console.log(`   ${c.padEnd(24)} ${((ok / n) * 100).toFixed(0)}% (${n})`);
}
