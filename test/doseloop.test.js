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
