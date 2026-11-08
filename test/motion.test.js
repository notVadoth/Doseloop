'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const poses = require('../web/poses');
const motion = require('../web/motion');
const { dataset, evaluate, CLASSES } = require('../ml/train');

const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'model', 'exercise-model.json'), 'utf8'));

test('the shipped model covers every exercise plus "Not exercising"', () => {
  assert.deepEqual(model.classes, CLASSES);
  assert.equal(model.classes.length, Object.keys(poses.EXERCISES).length + 1);
  assert.equal(model.mean.length, motion.CHANNELS.length * motion.STATS.length);
});

test('the shipped model classifies fresh synthetic windows it never saw', () => {
  const { X, Y } = dataset(777, 25);
  const { accuracy } = evaluate(model, X, Y);
  assert.ok(accuracy >= 0.9, `accuracy ${accuracy}`);
});

test('the shipped model classifies real MediaPipe output it was not trained on', () => {
  const { windows } = require('../ml/recordings');
  // Run "f": camera angles, tempo and range never trained on, including side-on and from behind.
  const all = windows('f', CLASSES, { step: 250 });
  assert.ok(all.X.length > 500, 'held-out MediaPipe recordings are missing');
  assert.ok(evaluate(model, all.X, all.Y).accuracy >= 0.78, 'held-out accuracy');
  // Run "g": facing the camera, as a phone or laptop on a table would be.
  const facing = windows('g', CLASSES, { step: 250 });
  const { accuracy } = evaluate(model, facing.X, facing.Y);
  assert.ok(accuracy >= 0.9, `facing-camera accuracy ${accuracy}`);
});

test('real people (from held-out photos) holding still are not mistaken for exercising', () => {
  const stills = require('../ml/stills');
  const { test: photos } = stills.split(stills.load());
  assert.ok(photos.length >= 20, 'held-out photo measurements are missing');
  const jitter = stills.jitterModel();
  let a = 3, ok = 0, n = 0;
  const rng = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const s of photos) {
    for (let k = 0; k < 5; k++) {
      const p = motion.predict(model, stills.holdStill(s, jitter, rng));
      if (model.classes[p.indexOf(Math.max(...p))] === motion.IDLE) ok++;
      n++;
    }
  }
  assert.ok(ok / n >= 0.9, `${ok} of ${n} called "Not exercising"`);
});

// The facing-the-camera recordings played back to back as one workout.
const WORKOUT = ['bicep-curl-g1', 'not-exercising-g2', 'sit-to-stand-g1', 'lateral-arm-raise-g1', 'treadmill-walk-g1', 'wall-push-up-g1', 'seated-knee-extension-g1', 'standing-hip-abduction-g1', 'stretching-g1', 'recumbent-bike-g1', 'heel-raise-g1'];

test('automatic tracking recognises each exercise in a continuous workout and counts it', () => {
  const dir = path.join(__dirname, '..', 'ml', 'data');
  const tracker = new motion.AutoTracker(model);
  const switches = new Set(), labels = [];
  let offset = 0, expectedReps = 0;
  const timed = {};
  for (const name of WORKOUT) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    labels.push(rec.label);
    const t0 = rec.times[0], span = rec.times[rec.times.length - 1] - t0;
    if (motion.SIGNALS[rec.label]) expectedReps += Math.floor(span / 1000 / rec.cycle);
    else if (rec.label !== motion.IDLE) timed[rec.label] = span / 1000;
    rec.frames.forEach((f, i) => {
      for (const ev of tracker.update(f, offset + rec.times[i] - t0)) if (ev.type === 'switch') switches.add(ev.exercise);
    });
    offset += span + 500;
  }
  for (const name of labels) if (name !== motion.IDLE) assert.ok(switches.has(name), `${name} was never recognised`);
  for (const name of Object.keys(tracker.tallies)) assert.ok(labels.includes(name), `${name} was detected but never done`);
  const reps = Object.entries(tracker.tallies).filter(([k]) => motion.SIGNALS[k]).reduce((a, [, t]) => a + t.reps, 0);
  assert.ok(reps >= expectedReps * 0.8 && reps <= expectedReps * 1.2, `${reps} reps counted, about ${expectedReps} done`);
  for (const [name, secs] of Object.entries(timed)) assert.ok(tracker.tallies[name].seconds >= secs * 0.8, `${name}: ${tracker.tallies[name].seconds}s of ${secs}s`);
});

test('a brief misdetection while changing exercise does not keep its reps', () => {
  const fakeModel = { classes: ['A', 'B', motion.IDLE] };
  const tracker = new motion.AutoTracker(fakeModel);
  // Drive decide() directly with labelled predictions.
  const feed = (label, t) => {
    tracker.pred = { label, prob: 0.9 };
    tracker.history.push(tracker.pred);
    const events = [];
    tracker.decide(t, events);
    return events;
  };
  feed('A', 0); feed('A', 500); feed('A', 1000); // A confirmed at 1 s
  tracker.count('A', { type: 'rep', quality: 80, tempo: 2000, rom: 60 }, []);
  feed('B', 1500); feed('B', 2000);
  const ev = feed('B', 2500); // B confirmed 1.5 s after A: A was a misfire
  assert.ok(ev.some((e) => e.type === 'retract' && e.exercise === 'A' && e.reps === 1));
  assert.equal(tracker.tallies.A, undefined);
  assert.equal(tracker.current, 'B');
});

test('the camera rep counter counts real MediaPipe reps without double counting', () => {
  const dir = path.join(__dirname, '..', 'ml', 'data');
  let found = 0, expected = 0;
  for (const f of fs.readdirSync(dir).filter((n) => /-g1.json$/.test(n))) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!motion.SIGNALS[rec.label]) continue;
    for (const turn of new Set(rec.yaw)) {
      const idx = rec.yaw.map((v, i) => (v === turn ? i : -1)).filter((i) => i >= 0);
      const rc = new motion.RepCounter(rec.label);
      let reps = 0;
      for (const i of idx) {
        const ev = rc.update(rec.frames[i], rec.times[i]);
        if (ev && ev.type === 'rep') reps++;
      }
      const exp = Math.floor((rec.times[idx[idx.length - 1]] - rec.times[idx[0]]) / 1000 / rec.cycle);
      assert.ok(reps <= exp + 1, `${rec.label}: counted ${reps} for ${exp} reps`);
      found += Math.min(reps, exp);
      expected += exp;
    }
  }
  assert.ok(found / expected >= 0.85, `found ${found} of ${expected}`);
});

// Mirror a skeleton left-to-right (as if the other leg or arm were used).
function mirrored(P) {
  const out = {};
  for (const [k, v] of Object.entries(P)) {
    const other = k.endsWith('L') ? `${k.slice(0, -1)}R` : `${k.slice(0, -1)}L`;
    out[other] = [-v[0], v[1], v[2]];
  }
  return out;
}

test('features do not depend on which side moves or where the camera stands', () => {
  const frames = [], framesMirror = [], framesTurned = [], times = [];
  const turn = (v) => [v[0] * Math.cos(1.1) + v[2] * Math.sin(1.1), v[1], -v[0] * Math.sin(1.1) + v[2] * Math.cos(1.1)];
  for (let i = 0; i < 40; i++) {
    const p = 0.5 - 0.5 * Math.cos((i / 40) * 2 * Math.PI);
    const pts = motion.pointsFromJoints(poses.joints(poses.EXERCISES['Seated knee extension'](p, i / 20)));
    frames.push(motion.frameAngles(pts));
    framesMirror.push(motion.frameAngles(mirrored(pts)));
    framesTurned.push(motion.frameAngles(Object.fromEntries(Object.entries(pts).map(([k, v]) => [k, turn(v)]))));
    times.push(i * 50);
  }
  const a = motion.windowFeatures(frames, times), b = motion.windowFeatures(framesMirror, times), c = motion.windowFeatures(framesTurned, times);
  a.forEach((v, i) => {
    assert.ok(Math.abs(v - b[i]) < 1e-6, `mirror differs at ${model.features[i]}`);
    // heel2d is measured in the picture, so it is meant to change with the camera angle.
    if (!model.features[i].startsWith('heel2d')) assert.ok(Math.abs(v - c[i]) < 1e-6, `rotation differs at ${model.features[i]}`);
  });
});

test('MediaPipe landmarks map onto the same points (y flipped to up)', () => {
  const world = Array.from({ length: 33 }, (_, i) => ({ x: i, y: -i, z: 0.5 }));
  const P = motion.pointsFromLandmarks(world);
  assert.deepEqual(P.knL, [25, 25, 0.5]);
  assert.deepEqual(P.toR, [32, 32, 0.5]);
});

function runReps(exercise, amp, noise, seed = 3) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const g = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;
  const rc = new motion.RepCounter(exercise);
  let reps = 0, partials = 0;
  const roms = [];
  const fps = 20, period = 3, n = 8;
  for (let i = 0; i < fps * (2 + n * period); i++) {
    const t = i / fps, k = t - 1, ph = k % period;
    const p = k > 0 && k < n * period && ph < period * 0.75 ? amp * (0.5 - 0.5 * Math.cos((2 * Math.PI * ph) / (period * 0.75))) : 0;
    const pts = {};
    for (const [key, v] of Object.entries(motion.pointsFromJoints(poses.joints(poses.EXERCISES[exercise](p, t))))) pts[key] = v.map((x) => x + noise * g());
    const ev = rc.update(motion.frameAngles(pts), t * 1000);
    if (ev && ev.type === 'rep') {
      reps++;
      roms.push(ev.rom);
    } else if (ev) partials++;
  }
  return { reps, partials, rom: roms.length ? roms.reduce((a, b) => a + b) / roms.length : 0 };
}

test('the camera rep counter counts full reps and rejects shallow ones', () => {
  for (const ex of Object.keys(motion.SIGNALS)) {
    const full = runReps(ex, 1, 0.01);
    assert.equal(full.reps, 8, `${ex}: full reps`);
    // Shallow: a third of the counting target (targets are set in MediaPipe's units).
    const amp = Math.min(0.35, (0.33 * motion.SIGNALS[ex].target) / full.rom);
    assert.equal(runReps(ex, amp, 0.01).reps, 0, `${ex}: shallow reps must not count`);
  }
});

test('databases from before camera tracking are migrated, keeping their sets', () => {
  const { open, seed } = require('../server/db');
  const file = path.join(require('node:os').tmpdir(), `doseloop-migrate-${process.pid}.db`);
  const clean = () => [file, `${file}-wal`, `${file}-shm`].forEach((f) => fs.rmSync(f, { force: true }));
  clean();
  // Build a seeded database, then put session_sets back to the old three-source definition.
  let db = open(file);
  seed(db);
  const before = db.prepare('SELECT COUNT(*) AS n FROM session_sets').get().n;
  const oldSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_sets'").get().sql.replace("'device','sim','camera','manual'", "'device','sim','manual'");
  db.exec(`PRAGMA foreign_keys = OFF; BEGIN; CREATE TABLE ss_copy AS SELECT * FROM session_sets; DROP TABLE session_sets; ${oldSql}; INSERT INTO session_sets SELECT * FROM ss_copy; DROP TABLE ss_copy; COMMIT; PRAGMA foreign_keys = ON;`);
  assert.throws(() => db.prepare("INSERT INTO session_sets (session_id, exercise_id, set_no, target, done, source) VALUES (1, 1, 9, 10, 10, 'camera')").run());
  db.close();

  db = open(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_sets').get().n, before);
  db.prepare("INSERT INTO session_sets (session_id, exercise_id, set_no, target, done, source) VALUES (1, 1, 9, 10, 10, 'camera')").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM session_sets WHERE source = 'camera'").get().n, 1);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_sets_session'").get());
  db.close();
  clean();
});

test('the Vercel entry point serves the API from a seeded in-memory database', async () => {
  const handler = require('../api/index.js');
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const stats = await (await fetch(`${base}/api/stats`)).json();
    // Vercel delivers /api/participants/1 as /api/index?__path=participants/1.
    const p = await (await fetch(`${base}/api/index?__path=participants/1`)).json();
    assert.equal(p.participant.id, 1);
    assert.equal(handler.originalUrl('/api/index?__path=participants%2F2%2Fexport.csv&x=1'), '/api/participants/2/export.csv?x=1');
    assert.equal(handler.originalUrl('/api/stats'), '/api/stats');
    assert.equal(stats.enrolled, 11);
    // Vercel hands over an already-parsed body as req.body.
    const res = await new Promise((resolve) => {
      const req = Object.assign(new (require('node:events'))(), { method: 'POST', url: '/api/feed', headers: {}, body: { author: 'Tester', text: 'hello' } });
      const chunks = [];
      const fake = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(b) { chunks.push(b); resolve({ status: this.status, body: JSON.parse(chunks.join('')) }); }, write() {} };
      handler(req, fake);
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.id > 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('the app shell, model, manifest and icons are served with the right types', async () => {
  const { open, seed } = require('../server/db');
  const db = open(':memory:');
  seed(db);
  const server = require('../server/server').createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [p, type] of [['/manifest.webmanifest', 'application/manifest+json'], ['/model/exercise-model.json', 'application/json'], ['/icons/icon-192.png', 'image/png'], ['/sw.js', 'text/javascript'], ['/vision.js', 'text/javascript']]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.ok(r.headers.get('content-type').startsWith(type), `${p}: ${r.headers.get('content-type')}`);
    }
    const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

// ---------- form checks ----------

// Run the rules over one rep of the demo figure's movement; mod(P, p) adds a fault.
function formHits(exercise, mod) {
  const hits = {};
  for (let i = 0; i <= 40; i++) {
    const p = 0.5 - 0.5 * Math.cos((Math.PI * i) / 20);
    const P = poses.EXERCISES[exercise](p, i * 0.1);
    if (mod) mod(P, p);
    const J = motion.pointsFromJoints(poses.joints(P));
    const a = motion.frameAngles(J), m = motion.formMetrics(J);
    for (const r of motion.FORM_RULES[exercise]) if (r.test(a, m)) hits[r.id] = (hits[r.id] || 0) + 1;
  }
  return hits;
}

test('form checks stay quiet for every exercise done well', () => {
  for (const ex of Object.keys(motion.FORM_RULES)) assert.deepEqual(formHits(ex), {}, ex);
});

test('form checks catch each fault they are written for', () => {
  const D = poses.DEG;
  const cases = [
    ['Sit-to-stand', 'knees-in', (P) => (P.legs.L.ab = P.legs.R.ab = -14 * D)],
    ['Sit-to-stand', 'lean', (P, p) => (P.lean = 70 * D * Math.sin(Math.PI * p))],
    ['Seated knee extension', 'slouch', (P) => (P.lean = 40 * D)],
    ['Bicep curl', 'elbow-drift', (P, p) => (P.arms.L.f = P.arms.R.f = 60 * D * p)],
    ['Bicep curl', 'swing', (P, p) => (P.lean = 25 * D * p)],
    ['Lateral arm raise', 'too-high', (P, p) => (P.arms.L.ab = P.arms.R.ab = (8 + 120 * p) * D)],
    ['Lateral arm raise', 'side-lean', (P, p) => (P.side = 18 * D * p)],
    ['Standing hip abduction', 'side-lean', (P, p) => (P.side = -22 * D * p)],
    ['Heel raise', 'lean', (P, p) => (P.lean = 25 * D * p)],
    ['Wall push-up', 'body-line', (P) => (P.lean = 45 * D)],
  ];
  for (const [ex, id, mod] of cases) assert.ok(formHits(ex, mod)[id] >= 3, `${ex}: ${id}`);
  // Leaning sideways is not also reported as bending forward.
  assert.equal(formHits('Standing hip abduction', (P, p) => (P.side = -22 * D * p)).lean, undefined);
});

test('a fault must last before it is reported, and is counted once per occurrence', () => {
  const fc = new motion.FormChecker('Bicep curl', { holdMs: 500, clearMs: 800 });
  const ok = new Array(motion.CHANNELS.length).fill(170);
  ok[6] = ok[7] = 5;
  const swing = { kneeRatio: 1, sideLean: 0, fwdLean: 30, bodyLine: 180 };
  const still = { ...swing, fwdLean: 2 };
  let ev = [];
  for (let t = 0; t <= 300; t += 100) ev.push(...fc.update(ok, swing, t)); // too brief
  for (let t = 400; t <= 600; t += 100) ev.push(...fc.update(ok, still, t));
  assert.equal(ev.length, 0);
  for (let t = 700; t <= 1300; t += 100) ev.push(...fc.update(ok, swing, t));
  assert.deepEqual(ev.map((e) => [e.type, e.id]), [['start', 'swing']]);
  assert.deepEqual(fc.active().map((r) => r.id), ['swing']);
  for (let t = 1400; t <= 2300; t += 100) ev.push(...fc.update(ok, still, t));
  for (let t = 2400; t <= 3000; t += 100) ev.push(...fc.update(ok, swing, t));
  assert.deepEqual(ev.map((e) => e.type), ['start', 'end', 'start']);
  assert.deepEqual(fc.counts, { swing: 2 });
  assert.equal(new motion.FormChecker('Treadmill walk').rules.length, 0);
});

// ---------- tracking reliability under camera-like noise ----------

// Webcam pose estimates wobble by a few centimetres, most of all in depth. Simulate a minute of
// each exercise at 30 fps with that noise, smoothed as the app does, and judge form throughout.
function noisyRun(exercise, mod, noise, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const fc = new motion.FormChecker(exercise);
  const sm = new motion.Smoother();
  let starts = 0, truly = 0, shown = 0, jitter = 0, rawJitter = 0, prev = null, prevRaw = null;
  for (let i = 0; i < 30 * 60; i++) {
    const t = i * 33.3;
    const p = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 2500);
    const P = poses.EXERCISES[exercise](p, t / 1000);
    if (mod) mod(P, p);
    const J0 = motion.pointsFromJoints(poses.joints(P));
    const J = Object.fromEntries(Object.entries(J0).map(([k, v]) => [k, v.map((x, d) => x + gauss() * noise * (d === 2 ? 2 : 1))]));
    const raw = motion.frameAngles(J);
    const { angles, metrics } = sm.update(raw, motion.formMetrics(J), t);
    if (prev) (jitter += Math.abs(angles[4] - prev[4])), (rawJitter += Math.abs(raw[4] - prevRaw[4]));
    prev = angles;
    prevRaw = raw;
    for (const ev of fc.update(angles, metrics, t)) if (ev.type === 'start') starts++;
    const id = mod && mod.id;
    if (id && motion.FORM_RULES[exercise].find((r) => r.id === id).test(motion.frameAngles(J0), motion.formMetrics(J0))) {
      truly++;
      if (fc.active().some((r) => r.id === id)) shown++;
    }
  }
  return { starts, shown: truly ? shown / truly : null, jitter, rawJitter };
}

test('smoothing removes most frame-to-frame jitter from the angles', () => {
  const { jitter, rawJitter } = noisyRun('Bicep curl', null, 0.02);
  assert.ok(jitter < rawJitter * 0.5, `smoothed ${jitter.toFixed(0)} vs raw ${rawJitter.toFixed(0)}`);
});

test('no false form cues on good movement, even with heavy camera noise', () => {
  for (const ex of Object.keys(motion.FORM_RULES)) {
    for (const noise of [0.02, 0.04]) assert.equal(noisyRun(ex, null, noise).starts, 0, `${ex} at ${noise} m`);
  }
});

test('with camera noise, a fault that comes back every rep is shown steadily as one cue', () => {
  const D = poses.DEG;
  const fault = (id, fn) => Object.assign(fn, { id });
  const cases = [
    ['Sit-to-stand', fault('knees-in', (P) => (P.legs.L.ab = P.legs.R.ab = -14 * D))],
    ['Bicep curl', fault('elbow-drift', (P, p) => (P.arms.L.f = P.arms.R.f = 60 * D * p))],
    ['Bicep curl', fault('swing', (P, p) => (P.lean = 25 * D * p))],
    ['Lateral arm raise', fault('too-high', (P, p) => (P.arms.L.ab = P.arms.R.ab = (8 + 120 * p) * D))],
    ['Standing hip abduction', fault('side-lean', (P, p) => (P.side = -22 * D * p))],
    ['Heel raise', fault('lean', (P, p) => (P.lean = 25 * D * p))],
    ['Wall push-up', fault('body-line', (P) => (P.lean = 45 * D))],
  ];
  for (const [ex, mod] of cases) {
    const r = noisyRun(ex, mod, 0.03);
    assert.ok(r.shown >= 0.9, `${ex}/${mod.id} shown ${Math.round(r.shown * 100)}% of the time`);
    assert.equal(r.starts, 1, `${ex}/${mod.id} flickered: ${r.starts} separate cues`);
  }
});

test('form is not judged from joints the camera cannot see', () => {
  const fc = new motion.FormChecker('Sit-to-stand', { holdMs: 400 });
  const a = new Array(motion.CHANNELS.length).fill(120);
  const knees = { kneeRatio: 0.5, sideLean: 0, fwdLean: 10, bodyLine: 180 };
  const lm = Array.from({ length: 33 }, () => ({ visibility: 0.95 }));
  const hidden = lm.map((l, i) => (i >= 25 && i <= 28 ? { visibility: 0.2 } : l));
  let ev = [];
  for (let t = 0; t <= 1000; t += 33) ev.push(...fc.update(a, knees, t, hidden));
  assert.equal(ev.length, 0); // knees and ankles out of view: no verdict
  for (let t = 1033; t <= 1600; t += 33) ev.push(...fc.update(a, knees, t, lm));
  assert.deepEqual(ev.map((e) => e.id), ['knees-in']);
});

test('the One Euro filter follows a real movement closely', () => {
  const f = new motion.OneEuro({ minCutoff: 1.2, beta: 0.02 });
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    const t = i * 33.3;
    const v = 90 + 50 * Math.sin((2 * Math.PI * t) / 2000); // a 2-second rep through 100 degrees
    const out = f.filter(v, t);
    if (i > 30) worst = Math.max(worst, Math.abs(out - v));
  }
  assert.ok(worst < 12, `lags the movement by up to ${worst.toFixed(1)} degrees`);
});

test('the camera rep counter reports the whole rep as its tempo, never a wrong one', () => {
  for (const ex of Object.keys(motion.SIGNALS)) {
    for (const period of [1500, 2500, 4000]) {
      const rc = new motion.RepCounter(ex);
      const tempos = [];
      for (let i = 0; i < 30 * 30; i++) {
        const t = i * 33.3;
        const p = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / period);
        const ev = rc.update(motion.frameAngles(motion.pointsFromJoints(poses.joints(poses.EXERCISES[ex](p, t / 1000)))), t);
        if (ev && ev.type === 'rep') tempos.push(ev.tempo);
      }
      assert.equal(tempos[0], null, `${ex}: first rep has nothing to time against`);
      const known = tempos.filter((x) => x !== null);
      assert.ok(known.length >= tempos.length - 2, `${ex} at ${period} ms: too many unknown: ${tempos.join(', ')}`);
      for (const x of known) assert.ok(Math.abs(x - period) / period <= 0.1, `${ex} at ${period} ms: ${tempos.join(', ')}`);
    }
  }
});
