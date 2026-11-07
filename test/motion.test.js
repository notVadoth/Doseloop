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
