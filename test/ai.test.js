'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { open, seed } = require('../server/db');
const { createApp } = require('../server/server');
const { createAi, localCoach, MODEL } = require('../server/ai');

// A stand-in for the Claude API: records each request and replies with whatever the test queued.
function mockClaude() {
  const seen = [];
  const queue = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
      const next = queue.shift() || { text: 'ok' };
      if (next.status) {
        res.writeHead(next.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock failure' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: next.text }], stop_reason: next.stop_reason || 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
    });
  });
  return { server, seen, queue };
}

async function start(ai) {
  const db = open(':memory:');
  seed(db);
  const server = createApp(db, ai);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const close = () => new Promise((r) => (server.closeAllConnections(), server.close(r)));
  return { api, close };
}

const REFERRAL = 'WRHN FAX REFERRAL\nPatient: Nowak, Irene   DOB: 14/03/1947\nReferring physician: Dr. A. Patel, Stroke Clinic\nDiagnosis: Left MCA ischaemic stroke, mild right hemiparesis\nGoals: walk to the mailbox independently\nPatient is unable to attend in person.';

test('drop-off risk is high for the participant who stopped attending, low for a steady one', async () => {
  const app = await start(createAi({ disabled: true }));
  const rows = (await app.api('GET', '/api/participants')).body;
  const get = (n) => rows.find((r) => r.name.startsWith(n));
  assert.notEqual(get('Walter').risk.level, 'low');
  assert.ok(get('Walter').risk.score > get('Margaret').risk.score + 20);
  assert.match(get('Walter').risk.drivers[0].text, /Attendance/);
  assert.equal(get('Margaret').risk.level, 'low');
  assert.equal(get('Stanley').risk, null); // waitlist
  assert.ok(rows.every((r) => !r.risk || (r.risk.score >= 0 && r.risk.score <= 100)));
  await app.close();
});

test('built-in mode: every AI feature works with no API key', async () => {
  const app = await start(createAi({ disabled: true }));
  assert.equal((await app.api('GET', '/api/ai/status')).body.claude, false);

  const ref = (await app.api('POST', '/api/ai/referral', { text: REFERRAL })).body;
  assert.equal(ref.source, 'built-in');
  assert.deepEqual([ref.fields.name, ref.fields.birth_year, ref.fields.program, ref.fields.mode], ['Irene Nowak', 1947, 'stroke', 'home']);
  assert.match(ref.fields.goals, /mailbox/);

  const note = (await app.api('POST', '/api/participants/2/ai/note', {})).body;
  assert.equal(note.source, 'built-in');
  for (const h of ['Subjective', 'Objective', 'Assessment', 'Plan']) assert.match(note.note, new RegExp(h));
  assert.match(note.note, /reducing the dose/);
  assert.doesNotMatch(note.note, /Harold|Bergstrom/);

  const coach = (await app.api('POST', '/api/participants/9/ai/coach', { messages: [] })).body;
  assert.match(coach.reply, /plan/i);
  const urgent = (await app.api('POST', '/api/participants/9/ai/coach', { messages: [{ role: 'user', content: 'I have chest pain and feel dizzy' }] })).body;
  assert.match(urgent.reply, /911/);
  const more = (await app.api('POST', '/api/participants/9/ai/coach', { messages: [{ role: 'user', content: 'Can I add more reps?' }] })).body;
  assert.match(more.reply, /kinesiologist/);

  const ask = (await app.api('POST', '/api/ai/ask', { question: 'Who reported pain?' })).body;
  assert.match(ask.answer, /Harold Bergstrom/);
  assert.deepEqual(ask.mentions.map((m) => m.name), ['Harold Bergstrom']);

  assert.equal((await app.api('POST', '/api/ai/referral', { text: '' })).status, 400);
  assert.equal((await app.api('POST', '/api/ai/referral', { text: 'x'.repeat(6001) })).status, 400);
  assert.equal((await app.api('POST', '/api/participants/9/ai/coach', { messages: [{ role: 'assistant', content: 'hi' }] })).status, 400);
  await app.close();
});

test('built-in coach never agrees to change the plan', () => {
  const ctx = { recent_sessions: [{ completion: 1.35, quality: 70, pain: 1 }], streak_weeks: 3 };
  assert.match(localCoach(ctx), /more than your plan/);
  assert.match(localCoach(ctx, 'make it harder please'), /cannot change/);
});

test('Claude mode: requests are de-identified and answers are re-identified locally', async () => {
  const mock = mockClaude();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const app = await start(createAi({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${mock.server.address().port}` }));
  assert.equal((await app.api('GET', '/api/ai/status')).body.claude, true);

  mock.queue.push({ text: 'Subjective\nMock note.' });
  const note = (await app.api('POST', '/api/participants/2/ai/note', {})).body;
  assert.equal(note.source, 'claude');
  assert.equal(note.note, 'Subjective\nMock note.');
  const sent = mock.seen[0].body;
  assert.equal(sent.model, MODEL);
  assert.equal(sent.fallbacks, 'default');
  assert.match(mock.seen[0].headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.doesNotMatch(JSON.stringify(sent), /Harold|Bergstrom|1944/); // no name, no birth year
  assert.match(JSON.stringify(sent), /androgen deprivation/); // but the clinical content is there

  mock.queue.push({ text: 'Highest risk is [P4], then [P2]. [P999] is unknown.' });
  const ask = (await app.api('POST', '/api/ai/ask', { question: 'Who is most at risk?' })).body;
  assert.equal(ask.answer, 'Highest risk is Walter Singh, then Harold Bergstrom. [P999] is unknown.');
  assert.deepEqual(ask.mentions.map((m) => m.id), [4, 2]);
  assert.doesNotMatch(JSON.stringify(mock.seen[1].body), /Walter|Singh|Okafor/);

  mock.queue.push({ text: JSON.stringify({ name: 'Irene Nowak', birth_year: 1947, program: 'stroke', mode: 'home', conditions: 'Left MCA stroke', goals: 'Walk to the mailbox', referral_source: 'Dr. A. Patel' }) });
  const ref = (await app.api('POST', '/api/ai/referral', { text: REFERRAL })).body;
  assert.equal(ref.source, 'claude');
  assert.equal(ref.fields.name, 'Irene Nowak');
  assert.equal(mock.seen[2].body.output_config.format.type, 'json_schema');

  // Model output is treated as untrusted: bad values are coerced, not stored.
  mock.queue.push({ text: JSON.stringify({ name: 'X'.repeat(200), birth_year: 3000, program: 'yoga', mode: 'moon', conditions: '', goals: '', referral_source: '' }) });
  const odd = (await app.api('POST', '/api/ai/referral', { text: REFERRAL })).body;
  assert.deepEqual([odd.fields.name.length, odd.fields.birth_year, odd.fields.program, odd.fields.mode], [80, null, 'general', 'clinic']);

  mock.queue.push({ text: 'Lovely work today.' });
  const coach = (await app.api('POST', '/api/participants/9/ai/coach', { messages: [{ role: 'user', content: 'How am I doing?' }] })).body;
  assert.equal(coach.reply, 'Lovely work today.');
  const coachReq = mock.seen[4].body;
  assert.match(coachReq.system, /Never change/);
  assert.equal(coachReq.messages.length, 1);
  assert.match(coachReq.messages[0].content, /How am I doing\?/);
  assert.doesNotMatch(JSON.stringify(coachReq), /Jean|Lapointe/);

  await app.close();
  await new Promise((r) => (mock.server.closeAllConnections(), mock.server.close(r)));
});

test('Claude failures fall back to the built-in version and say why', async () => {
  const mock = mockClaude();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const app = await start(createAi({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${mock.server.address().port}` }));

  mock.queue.push({ status: 400 });
  const note = (await app.api('POST', '/api/participants/2/ai/note', {})).body;
  assert.equal(note.source, 'built-in');
  assert.match(note.fallback_reason, /rejected the request/);
  assert.match(note.note, /Subjective/);

  mock.queue.push({ text: '', stop_reason: 'refusal' });
  const coach = (await app.api('POST', '/api/participants/9/ai/coach', { messages: [] })).body;
  assert.equal(coach.source, 'built-in');
  assert.match(coach.fallback_reason, /declined/);

  mock.queue.push({ text: 'this is not json' });
  const ref = (await app.api('POST', '/api/ai/referral', { text: REFERRAL })).body;
  assert.equal(ref.source, 'built-in');
  assert.equal(ref.fields.name, 'Irene Nowak');

  assert.match((await app.api('GET', '/api/ai/status')).body.last_error, /./);
  await app.close();
  await new Promise((r) => (mock.server.closeAllConnections(), mock.server.close(r)));
});
