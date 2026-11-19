'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, seed, displayName } = require('../server/db');
const { createApp } = require('../server/server');
const engine = require('../server/engine');

let server;
let base;

test.before(async () => {
  const db = open(':memory:');
  seed(db);
  server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => {
  server.closeAllConnections();
  server.close(r);
}));

async function api(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const byName = async (name) => (await api('GET', '/api/participants')).body.find((p) => p.name.startsWith(name));

// ---------- engine ----------

const items = [
  { exercise_id: 1, unit: 'reps', sets: 2, target: 10 },
  { exercise_id: 8, unit: 'min', sets: 1, target: 15 },
];
const mkSession = (completion, rpe, pain, quality = 85, hrOver = false) => ({ rpe, pain, metrics: { completion, quality, hrOver } });

test('session metrics average per-exercise completion and count missing exercises', () => {
  const m = engine.sessionMetrics(items, [
    { exercise_id: 1, target: 10, done: 10, quality: 80, hr_peak: 110 },
    { exercise_id: 1, target: 10, done: 10, quality: 90, hr_peak: 118 },
  ], 120);
  assert.equal(m.completion, 0.5); // walk skipped entirely
  assert.equal(m.quality, 85);
  assert.equal(m.hrPeak, 118);
  assert.equal(m.hrOver, false);
  assert.equal(m.over, false);
});

test('session metrics flag overdose and heart-rate ceiling', () => {
  const m = engine.sessionMetrics(items, [
    { exercise_id: 1, target: 10, done: 14, quality: null, hr_peak: 131 },
    { exercise_id: 1, target: 10, done: 13, quality: null, hr_peak: 125 },
    { exercise_id: 8, target: 15, done: 15, quality: null, hr_peak: null },
  ], 128);
  assert.equal(m.over, true);
  assert.equal(m.hrOver, true);
  assert.equal(m.quality, null);
});

test('recommendation progresses a participant who completes the dose comfortably', () => {
  const r = engine.recommend({ target_rpe: 5, items }, [mkSession(1, 4, 0), mkSession(1, 5, 1), mkSession(0.98, 4, 0)]);
  assert.equal(r.action, 'progress');
  assert.deepEqual(r.proposal.map((i) => i.target), [11, 17]);
});

test('progression adds a set instead of going past 15 reps', () => {
  const r = engine.scaleItem({ unit: 'reps', sets: 2, target: 15 }, 1.1);
  assert.deepEqual([r.sets, r.target], [3, 10]);
});

test('recommendation regresses on pain, high effort or low completion', () => {
  const d = { target_rpe: 4, items };
  assert.equal(engine.recommend(d, [mkSession(1, 4, 7)]).action, 'regress'); // acute pain needs no history
  assert.equal(engine.recommend(d, [mkSession(1, 7, 1), mkSession(1, 6, 1), mkSession(1, 6, 1)]).action, 'regress');
  const low = engine.recommend(d, [mkSession(0.5, 4, 1), mkSession(0.6, 4, 1), mkSession(0.7, 4, 1)]);
  assert.equal(low.action, 'regress');
  assert.deepEqual(low.proposal.map((i) => i.target), [9, 13]);
});

test('recommendation holds with too little data or poor form', () => {
  const d = { target_rpe: 5, items };
  assert.equal(engine.recommend(d, [mkSession(1, 4, 0)]).action, 'hold');
  assert.equal(engine.recommend(d, [mkSession(1, 4, 0, 55), mkSession(1, 4, 0, 60), mkSession(1, 4, 0, 58)]).action, 'hold');
  assert.equal(engine.recommend(null, []).action, 'none');
});

test('adherence compares the last two weeks against prescribed frequency', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const at = (d) => ({ started_at: new Date(now - d * engine.DAY_MS).toISOString() });
  assert.equal(engine.adherence([at(1), at(3), at(8), at(20)], 3, now), 0.5);
  assert.equal(engine.adherence([at(1), at(2), at(3), at(4), at(5), at(6), at(7)], 3, now), 1);
});

test('display names hide surnames', () => {
  assert.equal(displayName('Margaret Okafor'), 'Margaret O.');
  assert.equal(displayName('Cher'), 'Cher');
});

// ---------- seeded scenarios ----------

test('seeded roster shows each demo scenario', async () => {
  const { body } = await api('GET', '/api/participants');
  assert.equal(body.length, 12);
  const kinds = (n) => body.find((p) => p.name.startsWith(n)).flags.map((f) => f.kind);
  assert.ok(kinds('Margaret').includes('ready'));
  assert.ok(kinds('Harold').includes('pain'));
  assert.ok(kinds('Walter').includes('missed'));
  assert.ok(kinds('Eleanor').includes('overdose'));
  assert.ok(kinds('Eleanor').includes('hr'));
  assert.ok(kinds('Frank').includes('quality'));
  assert.ok(kinds('George').includes('underdose'));
  assert.deepEqual(kinds('Stanley'), []);
  assert.equal(body.find((p) => p.name.startsWith('Harold')).recommendation, 'regress');
  assert.equal(body.find((p) => p.name.startsWith('Dorothy')).dose_version, 2);
});

test('stats and alerts summarise the roster', async () => {
  const stats = (await api('GET', '/api/stats')).body;
  assert.equal(stats.enrolled, 11);
  assert.equal(stats.waitlist, 1);
  assert.ok(stats.needs_attention >= 3);
  const alerts = (await api('GET', '/api/alerts')).body;
  assert.ok(alerts.length >= 5);
  assert.equal(alerts[0].level, 'alert');
});

// ---------- workflow ----------

test('intake -> prescribe -> session -> finish -> export', async () => {
  const created = await api('POST', '/api/participants', { name: 'Test Person', birth_year: 1950, program: 'stroke', mode: 'home', status: 'waitlist', referral_source: 'WRHN fax' });
  assert.equal(created.status, 200);
  const id = created.body.id;

  assert.equal((await api('POST', '/api/sessions', { participant_id: id })).status, 409); // no dose yet

  const rx = await api('POST', `/api/participants/${id}/dosages`, { frequency_per_week: 3, target_rpe: 4, actor: 'T. Tester', note: 'Initial', items: [{ exercise_id: 1, sets: 2, target: 8 }, { exercise_id: 8, sets: 1, target: 10 }] });
  assert.equal(rx.body.version, 1);

  let detail = (await api('GET', `/api/participants/${id}`)).body;
  assert.equal(detail.participant.status, 'active'); // prescribing takes them off the waitlist
  assert.equal(detail.participant.hr_max, Math.round((220 - (new Date().getFullYear() - 1950)) * 0.8));
  assert.equal(detail.active.items.length, 2);
  assert.equal(detail.recommendation.action, 'hold');

  const s = (await api('POST', '/api/sessions', { participant_id: id })).body;
  assert.equal((await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 3, set_no: 1, done: 5 })).status, 400); // not prescribed
  for (const set of [1, 2]) {
    const r = await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 1, set_no: set, done: 8, quality: 90, tempo_ms: 2400, rom_deg: 78, hr_avg: 100, hr_peak: 108, source: 'device' });
    assert.equal(r.status, 200);
  }
  await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 8, set_no: 1, done: 10 });
  const fin = await api('POST', `/api/sessions/${s.id}/finish`, { rpe: 3, pain: 0, share: true });
  assert.equal(fin.body.metrics.completion, 1);
  assert.equal(fin.body.metrics.quality, 90);
  assert.equal(fin.body.sessions_total, 1);
  assert.equal((await api('POST', `/api/sessions/${s.id}/finish`, { rpe: 3, pain: 0 })).status, 409);

  const feed = (await api('GET', '/api/feed')).body;
  assert.equal(feed[0].author, 'Test P.');
  assert.match(feed[0].text, /completed session 1/);

  const csv = await (await fetch(`${base}/api/participants/${id}/export.csv`)).text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /Sit-to-stand,1,reps,8,8/);

  // A new version supersedes the old one, which stays on record.
  const rx2 = await api('POST', `/api/participants/${id}/dosages`, { frequency_per_week: 3, target_rpe: 4, actor: 'T. Tester', items: [{ exercise_id: 1, sets: 2, target: 9 }] });
  assert.equal(rx2.body.version, 2);
  detail = (await api('GET', `/api/participants/${id}`)).body;
  assert.equal(detail.dosages.length, 2);
  assert.equal(detail.dosages.filter((d) => d.active).length, 1);
  assert.equal(detail.active.version, 2);
  assert.ok(detail.audit.some((a) => a.action === 'record.export'));
});

test('an abandoned session is discarded when the next one starts', async () => {
  const p = await byName('Jean');
  const before = (await api('GET', `/api/participants/${p.id}`)).body.sessions.length;
  const a = (await api('POST', '/api/sessions', { participant_id: p.id })).body;
  await api('POST', `/api/sessions/${a.id}/sets`, { exercise_id: 1, set_no: 1, done: 3 });
  const b = (await api('POST', '/api/sessions', { participant_id: p.id })).body;
  assert.equal((await api('POST', `/api/sessions/${a.id}/finish`, { rpe: 3, pain: 0 })).status, 404);
  await api('POST', `/api/sessions/${b.id}/finish`, { rpe: 3, pain: 0 });
  assert.equal((await api('GET', `/api/participants/${p.id}`)).body.sessions.length, before + 1);
});

test('validation rejects bad input with a clear message', async () => {
  const cases = [
    ['/api/participants', { name: '', birth_year: 1950, program: 'stroke' }, /Name is required/],
    ['/api/participants', { name: 'X', birth_year: 1950, program: 'yoga' }, /Program must be one of/],
    ['/api/participants/1/dosages', { frequency_per_week: 3, target_rpe: 4, actor: 'A', items: [] }, /at least one exercise/],
    ['/api/participants/1/dosages', { frequency_per_week: 9, target_rpe: 4, actor: 'A', items: [{ exercise_id: 1, sets: 1, target: 1 }] }, /Sessions per week/],
    ['/api/participants/1/dosages', { frequency_per_week: 3, target_rpe: 4, actor: 'A', items: [{ exercise_id: 1, sets: 1, target: 5 }, { exercise_id: 1, sets: 1, target: 5 }] }, /only once/],
    ['/api/participants/1/assessments', { date: '2026-10-01' }, /at least one measurement/],
    ['/api/feed', { participant_id: 1, text: '' }, /Message is required/],
  ];
  for (const [url, body, re] of cases) {
    const r = await api('POST', url, body);
    assert.equal(r.status, 400, url);
    assert.match(r.body.error, re);
  }
  assert.equal((await api('GET', '/api/participants/9999')).status, 404);
  assert.equal((await fetch(`${base}/api/feed`, { method: 'POST', body: '{nope' })).status, 400);
  assert.equal((await fetch(`${base}/..%2fserver%2fdb.js`)).status, 403);
});

test('feed posts and cheers', async () => {
  const p = await byName('Ruth');
  const post = await api('POST', '/api/feed', { participant_id: p.id, text: 'Hello group' });
  const cheer = await api('POST', `/api/feed/${post.body.id}/cheer`);
  assert.equal(cheer.body.cheers, 1);
  const feed = (await api('GET', '/api/feed')).body;
  assert.equal(feed[0].author, 'Ruth M.');
  assert.ok(feed.every((f) => !/Mbeki|Lapointe|Petit/.test(f.author)));
});

test('live board flags overdose and heart rate, and the class simulator runs', async () => {
  const p = await byName('Margaret');
  await api('POST', '/api/live', { participant_id: p.id, exercise: 'Sit-to-stand', set: 1, sets: 2, reps: 14, target: 10, quality: 82, hr: p.hr_max + 5, source: 'device' });
  let live = (await api('GET', '/api/live')).body;
  const e = live.board.find((x) => x.participant_id === p.id);
  assert.deepEqual(e.flags.map((f) => f.kind).sort(), ['hr', 'overdose']);

  assert.equal((await api('POST', '/api/sim/start')).body.sim, true);
  live = (await api('GET', '/api/live')).body;
  assert.ok(live.board.length >= 6);
  await api('POST', '/api/sim/stop');
  live = (await api('GET', '/api/live')).body;
  assert.equal(live.sim, false);
  assert.equal(live.board.length, 0);
});

test('static app shell is served', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /DoseLoop/);
});

// ---------- wearable over Wi-Fi ----------

test('wearable readings posted over Wi-Fi are listed and kept as a short history', async () => {
  const post = (b) => api('POST', '/api/device', { device: 'wearable-test', motion: 1, pulse: 1, ...b });
  assert.equal((await post({ finger: 1, hr: 72, spo2: 97, tilt: 12.5, ax: 0.98, ay: 0.02, az: -0.1, reps: 0 })).status, 200);
  assert.equal((await post({ finger: 1, hr: 75, spo2: 98, tilt: 80, reps: 1, set_active: 1, target: 10, quality: 88, exercise: 'Bicep curl' })).status, 200);
  const list = (await api('GET', '/api/device')).body.devices;
  const d = list.find((x) => x.id === 'wearable-test');
  assert.ok(d && d.age_ms < 5000);
  assert.equal(d.hr, 75);
  assert.equal(d.reps, 1);
  assert.equal(d.exercise, 'Bicep curl');
  const detail = (await api('GET', '/api/device/wearable-test')).body;
  assert.deepEqual(detail.history.map((h) => h.hr), [72, 75]);
  // No finger: heart rate and oxygen are blank, not zero.
  await post({ finger: 0, hr: 0, spo2: 0 });
  const off = (await api('GET', '/api/device/wearable-test')).body.device;
  assert.equal(off.finger, false);
  assert.equal(off.hr, null);
  assert.equal(off.spo2, null);
});

test('wearable endpoint rejects bad device names and unknown devices', async () => {
  assert.equal((await api('POST', '/api/device', { hr: 70 })).status, 400);
  assert.equal((await api('POST', '/api/device', { device: '!!!' })).status, 400);
  assert.equal((await api('GET', '/api/device/nobody')).status, 404);
});

test('form faults from the camera are saved per set, flagged and exported', async () => {
  const created = await api('POST', '/api/participants', { name: 'Form Check', birth_year: 1950, program: 'general', mode: 'home', status: 'waitlist', referral_source: 'Self' });
  const id = created.body.id;
  await api('POST', `/api/participants/${id}/dosages`, { frequency_per_week: 3, target_rpe: 4, actor: 'T. Tester', items: [{ exercise_id: 1, sets: 2, target: 8 }] });
  const s = (await api('POST', '/api/sessions', { participant_id: id })).body;
  assert.equal((await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 1, set_no: 1, done: 8, form_issues: { 'knees-in': 'x' } })).status, 400);
  assert.equal((await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 1, set_no: 1, done: 8, form_issues: ['knees-in'] })).status, 400);
  await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 1, set_no: 1, done: 8, source: 'camera', form_issues: { 'knees-in': 2, lean: 1 } });
  await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 1, set_no: 2, done: 8, source: 'device', form_issues: {} });
  await api('POST', `/api/sessions/${s.id}/finish`, { rpe: 3, pain: 0 });

  const detail = (await api('GET', `/api/participants/${id}`)).body;
  const sets = detail.sessions[0].sets;
  assert.deepEqual(sets.map((t) => t.form_issues), [{ 'knees-in': 2, lean: 1 }, {}]);
  assert.ok(detail.flags.some((f) => f.kind === 'form' && /3 times/.test(f.text)));

  const csv = await (await fetch(`${base}/api/participants/${id}/export.csv`)).text();
  assert.match(csv, /knees-in x2; lean x1/);
});

test('live board shows the form fault the camera sees right now', async () => {
  const p = await byName('Ruth');
  await api('POST', '/api/live', { participant_id: p.id, exercise: 'Bicep curl', set: 1, sets: 2, reps: 3, target: 10, quality: 40, source: 'camera', form: 'Keep your elbow at your side' });
  let e = (await api('GET', '/api/live')).body.board.find((x) => x.participant_id === p.id);
  assert.deepEqual(e.flags.map((f) => [f.kind, f.text]), [['form', 'Keep your elbow at your side']]);
  await api('POST', '/api/live', { participant_id: p.id, exercise: 'Bicep curl', set: 1, sets: 2, reps: 4, target: 10, quality: 90, source: 'camera' });
  e = (await api('GET', '/api/live')).body.board.find((x) => x.participant_id === p.id);
  assert.equal(e.flags.length, 0);
});

test('an older database gains the form_issues column and keeps its sets', () => {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doseloop-'));
  const file = path.join(dir, 'old.db');
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE session_sets (id INTEGER PRIMARY KEY, session_id INTEGER, exercise_id INTEGER, set_no INTEGER, target INTEGER, done INTEGER, partials INTEGER, tempo_ms INTEGER, rom_deg INTEGER, quality INTEGER, hr_avg INTEGER, hr_peak INTEGER, source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('device','sim','camera','manual')))");
  raw.exec("INSERT INTO session_sets VALUES (1, 1, 1, 1, 10, 10, 0, 2000, 70, 80, 100, 110, 'device')");
  raw.close();
  const db = open(file);
  const cols = db.prepare('PRAGMA table_info(session_sets)').all().map((c) => c.name);
  assert.ok(cols.includes('form_issues'));
  assert.equal(db.prepare('SELECT done FROM session_sets WHERE id = 1').get().done, 10);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- watch + camera fusion ----------

test('watch + camera settings are validated, saved per participant and audited', async () => {
  const p = await byName('Ruth');
  const url = `/api/participants/${p.id}/fusion`;
  assert.equal((await api('PUT', url, { settings: { spo2Stop: 93, spo2Caution: 91 } })).status, 400);
  assert.equal((await api('PUT', url, { settings: { exercises: { 'Bicep curl': { primary: 'elbow' } } } })).status, 400);
  const settings = { policy: 'confirmed', spo2Caution: 93, rateLimited: true, exercises: { 'Bicep curl': { primary: 'watch', offsetMs: 320, windowMs: 520, romScale: 0.85, reps: 6, calibratedAt: '2026-11-19T10:00:00.000Z' } } };
  const r = await api('PUT', url, { settings, calibrated: 'Bicep curl' });
  assert.equal(r.status, 200);
  const got = (await api('GET', `/api/participants/${p.id}`)).body;
  assert.deepEqual(got.participant.fusion, settings);
  assert.equal(got.participant.fusion_cfg, undefined);
  assert.ok(got.audit.some((a) => a.action === 'fusion' && /Calibrated watch \+ camera for Bicep curl/.test(a.detail)));
  await api('PUT', url, { settings: null });
  assert.equal((await api('GET', `/api/participants/${p.id}`)).body.participant.fusion, null);
});

test('a set counted by watch + camera keeps its fusion summary, SpO2 and flags disagreement', async () => {
  const created = await api('POST', '/api/participants', { name: 'Fusion Check', birth_year: 1949, program: 'general', mode: 'home', status: 'waitlist', referral_source: 'Self' });
  const id = created.body.id;
  await api('POST', `/api/participants/${id}/dosages`, { frequency_per_week: 3, target_rpe: 4, actor: 'T. Tester', items: [{ exercise_id: 3, sets: 1, target: 10 }] });
  const s = (await api('POST', '/api/sessions', { participant_id: id })).body;
  assert.equal((await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 3, set_no: 1, done: 8, source: 'fused', fusion: { primary: 'nose' } })).status, 400);
  const fusion = { primary: 'watch', policy: 'primary', calibrated: true, confirmed: 3, unconfirmed: 5, possible: 1, rejected: 0, failover: 0, agreement: 33, rom_watch: 104, rom_camera: 88, offset_ms: 310 };
  assert.equal((await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: 3, set_no: 1, done: 8, source: 'fused', fusion, spo2_min: 89, hr_avg: 100, hr_peak: 110 })).status, 200);
  await api('POST', `/api/sessions/${s.id}/finish`, { rpe: 4, pain: 0 });
  const detail = (await api('GET', `/api/participants/${id}`)).body;
  const set = detail.sessions[0].sets[0];
  assert.equal(set.source, 'fused');
  assert.deepEqual(set.fusion, fusion);
  assert.equal(set.spo2_min, 89);
  assert.ok(detail.flags.some((f) => f.kind === 'sensors' && /disagreed on 6 of 9 reps/.test(f.text)));
  assert.ok(detail.flags.some((f) => f.kind === 'spo2' && /89%/.test(f.text)));
  const csv = await (await fetch(`${base}/api/participants/${id}/export.csv`)).text();
  const rows = csv.split(/\r?\n/);
  assert.match(rows[0], /counted_by,reps_confirmed,reps_unconfirmed,reps_possible,sensor_agreement_pct,spo2_min$/);
  assert.match(rows[1], /,watch,3,5,1,33,89$/);
});

test('a database from before fusion keeps its sets and accepts fused ones', () => {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doseloop-'));
  const file = path.join(dir, 'old.db');
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE participants (id INTEGER PRIMARY KEY, name TEXT NOT NULL, birth_year INTEGER, program TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', mode TEXT NOT NULL DEFAULT 'clinic', conditions TEXT NOT NULL DEFAULT '', goals TEXT NOT NULL DEFAULT '', referral_source TEXT NOT NULL DEFAULT '', hr_max INTEGER, share_feed INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)");
  raw.exec("CREATE TABLE session_sets (id INTEGER PRIMARY KEY, session_id INTEGER, exercise_id INTEGER, set_no INTEGER, target INTEGER, done INTEGER, partials INTEGER, tempo_ms INTEGER, rom_deg INTEGER, quality INTEGER, hr_avg INTEGER, hr_peak INTEGER, source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('device','sim','camera','manual')), form_issues TEXT)");
  raw.exec(`INSERT INTO session_sets VALUES (1, 1, 1, 1, 10, 10, 0, 2000, 70, 80, 100, 110, 'camera', '{"lean":1}')`);
  raw.close();
  const db = open(file);
  const cols = db.prepare('PRAGMA table_info(session_sets)').all().map((c) => c.name);
  assert.ok(cols.includes('fusion') && cols.includes('spo2_min'));
  assert.ok(db.prepare('PRAGMA table_info(participants)').all().some((c) => c.name === 'fusion_cfg'));
  assert.equal(db.prepare('SELECT form_issues FROM session_sets WHERE id = 1').get().form_issues, '{"lean":1}');
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_sets'").get().sql, /'fused'/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
