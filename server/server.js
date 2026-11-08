'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, seed, displayName } = require('./db');
const engine = require('./engine');
const { createAi } = require('./ai');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function int(v, name, lo, hi) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${name} must be a whole number from ${lo} to ${hi}`);
  return n;
}
function optInt(v, name, lo, hi) {
  return v == null || v === '' ? null : int(v, name, lo, hi);
}
function optNum(v, name, lo, hi) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${name} must be a number from ${lo} to ${hi}`);
  return n;
}
function text(v, name, max, required) {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long (max ${max} characters)`);
  return s;
}
// Form faults counted by the camera during a set: {fault id: times}, stored as JSON.
function formIssues(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('Form issues must be an object');
  const out = {};
  for (const [k, n] of Object.entries(v)) {
    if (!/^[a-z-]{1,24}$/.test(k)) throw bad('Unknown form issue');
    out[k] = int(n, 'Form issue count', 0, 500);
  }
  if (Object.keys(out).length > 10) throw bad('Too many form issues');
  return JSON.stringify(out);
}
function oneOf(v, name, options) {
  if (!options.includes(v)) throw bad(`${name} must be one of: ${options.join(', ')}`);
  return v;
}

function createApp(db, ai = createAi()) {
  const nowIso = () => new Date().toISOString();
  const audit = (actor, action, pid, detail) =>
    db.prepare('INSERT INTO audit (at, actor, action, participant_id, detail) VALUES (?,?,?,?,?)').run(nowIso(), actor, action, pid, detail || '');

  // ---------- queries ----------

  function getParticipant(id) {
    const p = db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Participant not found');
    return p;
  }

  function dosageItems(dosageId) {
    return db
      .prepare(
        `SELECT i.exercise_id, i.sets, i.target, i.load, e.name, e.unit, e.category, e.cue, e.target_rom_deg, e.target_tempo_ms, e.sensor_site
         FROM dosage_items i JOIN exercises e ON e.id = i.exercise_id WHERE i.dosage_id = ? ORDER BY i.id`
      )
      .all(dosageId);
  }

  function dosages(pid) {
    const rows = db.prepare('SELECT * FROM dosages WHERE participant_id = ? ORDER BY version DESC').all(pid);
    for (const d of rows) d.items = dosageItems(d.id);
    const first = rows.length ? rows[rows.length - 1].created_at : null;
    for (const d of rows) d.first_prescribed_at = first;
    return rows;
  }

  // Completed sessions, newest first, each with its sets and computed metrics.
  function sessions(p, allDosages) {
    const rows = db.prepare('SELECT * FROM sessions WHERE participant_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC').all(p.id);
    const sets = db
      .prepare(
        `SELECT ss.*, e.name, e.unit FROM session_sets ss
         JOIN sessions s ON s.id = ss.session_id JOIN exercises e ON e.id = ss.exercise_id
         WHERE s.participant_id = ? ORDER BY ss.id`
      )
      .all(p.id);
    const bySession = new Map();
    for (const s of sets) {
      s.form_issues = s.form_issues ? JSON.parse(s.form_issues) : null;
      if (!bySession.has(s.session_id)) bySession.set(s.session_id, []);
      bySession.get(s.session_id).push(s);
    }
    const itemsByDosage = new Map(allDosages.map((d) => [d.id, d.items]));
    for (const s of rows) {
      s.sets = bySession.get(s.id) || [];
      s.metrics = engine.sessionMetrics(itemsByDosage.get(s.dosage_id) || [], s.sets, p.hr_max);
    }
    return rows;
  }

  function overview(p) {
    const ds = dosages(p.id);
    const active = ds.find((d) => d.active) || null;
    const ss = sessions(p, ds);
    const onDose = active ? ss.filter((s) => s.dosage_id === active.id) : [];
    const recommendation = engine.recommend(active, onDose);
    return {
      participant: p,
      dosages: ds,
      active,
      sessions: ss,
      recommendation,
      adherence: active ? engine.adherence(ss, active.frequency_per_week) : null,
      streak: active ? engine.streakWeeks(ss, active.frequency_per_week) : 0,
      flags: engine.flags({ participant: p, dosage: active, sessions: ss, recommendation }),
      risk: engine.risk({ participant: p, dosage: active, sessions: ss }),
    };
  }

  function rosterRow(p) {
    const o = overview(p);
    const last = o.sessions[0] || null;
    return {
      ...p,
      age: new Date().getFullYear() - p.birth_year,
      dose_version: o.active ? o.active.version : null,
      adherence: o.adherence,
      streak: o.streak,
      sessions_total: o.sessions.length,
      trend: o.sessions.slice(0, 8).reverse().map((x) => Math.round(x.metrics.completion * 100) / 100),
      last_session: last && { started_at: last.started_at, completion: last.metrics.completion, quality: last.metrics.quality, rpe: last.rpe, pain: last.pain },
      flags: o.flags,
      risk: o.risk,
      recommendation: o.recommendation.action,
    };
  }

  // ---------- live class board (in memory) ----------

  const live = new Map();
  const streams = new Set();
  let sim = null;

  function liveFlags(e, now) {
    const f = [];
    if (e.hr_max && e.hr && e.hr > e.hr_max) f.push({ kind: 'hr', level: 'alert', text: `HR ${e.hr} over ${e.hr_max}` });
    if (e.status === 'active' && e.target && e.reps > e.target * 1.2 && e.reps - e.target >= 2) f.push({ kind: 'overdose', level: 'alert', text: 'Past prescribed dose' });
    if (e.status === 'active' && now - e.updated > 45000) f.push({ kind: 'idle', level: 'warn', text: `No movement for ${Math.round((now - e.updated) / 1000)} s` });
    if (e.status === 'active' && e.form) f.push({ kind: 'form', level: 'warn', text: e.form });
    else if (e.quality != null && e.quality < 60 && e.reps >= 3) f.push({ kind: 'quality', level: 'warn', text: 'Check form' });
    if (e.status === 'done') f.push({ kind: 'done', level: 'good', text: 'Finished' });
    return f;
  }

  function board() {
    const now = Date.now();
    for (const [id, e] of live) if (now - e.updated > 10 * 60000) live.delete(id);
    return [...live.values()].map((e) => ({ ...e, flags: liveFlags(e, now), idle_s: Math.round((now - e.updated) / 1000) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  function broadcast() {
    if (!streams.size) return;
    const msg = `data: ${JSON.stringify({ board: board(), sim: !!sim })}\n\n`;
    for (const res of streams) res.write(msg);
  }
  const heartbeat = setInterval(broadcast, 5000);
  heartbeat.unref();

  function simStart() {
    simStop();
    const people = db.prepare("SELECT * FROM participants WHERE mode = 'clinic' AND status = 'active'").all();
    const actors = [];
    people.forEach((p, idx) => {
      const d = dosages(p.id).find((x) => x.active);
      if (!d) return;
      const queue = [];
      for (const it of d.items.filter((i) => i.unit === 'reps')) for (let s = 1; s <= it.sets; s++) queue.push({ ...it, set: s });
      // A few scripted behaviours so the board shows every kind of flag.
      const style = ['steady', 'over', 'steady', 'stall', 'sloppy', 'hr'][idx % 6];
      actors.push({ p, queue, step: 0, reps: 0, rest: idx % 4, style, hr: Math.round(p.hr_max * 0.7), q: [] });
      live.set(p.id, { participant_id: p.id, name: p.name, exercise: queue[0].name, set: 1, sets: queue[0].sets, reps: 0, target: queue[0].target, quality: null, hr: Math.round(p.hr_max * 0.7), hr_max: p.hr_max, status: 'active', source: 'class-sim', updated: Date.now() });
    });
    const timer = setInterval(() => {
      for (const a of actors) {
        const e = live.get(a.p.id);
        if (!e || a.step >= a.queue.length) continue;
        const cur = a.queue[a.step];
        a.hr += Math.round((Math.random() - 0.45) * 3);
        const ceiling = a.style === 'hr' ? a.p.hr_max + 9 : a.p.hr_max - 6;
        a.hr = Math.max(Math.round(a.p.hr_max * 0.6), Math.min(ceiling, a.hr + (a.style === 'hr' ? 1 : 0)));
        e.hr = a.hr;
        if (a.rest > 0) {
          a.rest--;
          e.updated = Date.now();
          continue;
        }
        if (a.style === 'stall' && a.step === 1 && a.reps === 4) continue; // stops mid-set, never updates
        if (Math.random() < 0.45) {
          a.reps++;
          const base = a.style === 'sloppy' ? 50 : 84;
          a.q.push(Math.max(20, Math.min(100, Math.round(base + (Math.random() - 0.5) * 16))));
          e.reps = a.reps;
          e.quality = Math.round(a.q.reduce((x, y) => x + y, 0) / a.q.length);
          e.updated = Date.now();
          const stopAt = a.style === 'over' ? Math.ceil(cur.target * 1.5) : cur.target;
          if (a.reps >= stopAt) {
            a.step++;
            a.reps = 0;
            a.q = [];
            a.rest = 5;
            if (a.step >= a.queue.length) {
              e.status = 'done';
            } else {
              const nx = a.queue[a.step];
              Object.assign(e, { exercise: nx.name, set: nx.set, sets: nx.sets, reps: 0, target: nx.target, quality: null });
            }
          }
        }
      }
      broadcast();
    }, 1000);
    timer.unref();
    sim = { timer, ids: actors.map((a) => a.p.id) };
  }

  function simStop() {
    if (!sim) return;
    clearInterval(sim.timer);
    for (const id of sim.ids) if (live.get(id) && live.get(id).source === 'class-sim') live.delete(id);
    sim = null;
  }

  // ---------- routes ----------

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

  route('GET', '/api/exercises', () => db.prepare('SELECT * FROM exercises ORDER BY category, name').all());

  route('GET', '/api/participants', () =>
    db.prepare('SELECT * FROM participants ORDER BY name').all().map(rosterRow)
  );

  route('GET', '/api/stats', () => {
    const rows = db.prepare('SELECT * FROM participants').all().map(rosterRow);
    const enrolled = rows.filter((r) => r.status !== 'waitlist' && r.status !== 'discharged');
    const weekAgo = new Date(Date.now() - 7 * engine.DAY_MS).toISOString();
    const adh = enrolled.filter((r) => r.adherence != null);
    return {
      enrolled: enrolled.length,
      waitlist: rows.filter((r) => r.status === 'waitlist').length,
      home: enrolled.filter((r) => r.mode === 'home').length,
      sessions_week: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NOT NULL AND started_at >= ?').get(weekAgo).n,
      adherence: adh.length ? adh.reduce((a, r) => a + r.adherence, 0) / adh.length : null,
      needs_attention: rows.filter((r) => r.flags.some((f) => f.level === 'alert')).length,
      ready: rows.filter((r) => r.recommendation === 'progress').length,
    };
  });

  route('POST', '/api/participants', (_m, body) => {
    const name = text(body.name, 'Name', 80, true);
    const birthYear = int(body.birth_year, 'Birth year', 1900, new Date().getFullYear());
    const program = oneOf(body.program, 'Program', ['general', 'cancer', 'stroke', 'graduate']);
    const mode = oneOf(body.mode || 'clinic', 'Mode', ['clinic', 'home']);
    const status = oneOf(body.status || 'active', 'Status', ['waitlist', 'active', 'graduate', 'discharged']);
    const age = new Date().getFullYear() - birthYear;
    const hrMax = optInt(body.hr_max, 'Heart-rate ceiling', 60, 220) || Math.round((220 - age) * 0.8);
    const r = db
      .prepare('INSERT INTO participants (name, birth_year, program, status, mode, conditions, goals, referral_source, hr_max, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(name, birthYear, program, status, mode, text(body.conditions, 'Conditions', 500), text(body.goals, 'Goals', 500), text(body.referral_source, 'Referral source', 120), hrMax, nowIso());
    const id = Number(r.lastInsertRowid);
    audit(text(body.actor, 'Actor', 80) || 'Staff', 'participant.create', id, `Referral: ${body.referral_source || 'n/a'}`);
    return { id };
  });

  route('GET', '/api/participants/(\\d+)', (m) => {
    const p = getParticipant(Number(m[1]));
    const o = overview(p);
    return {
      ...o,
      participant: { ...p, age: new Date().getFullYear() - p.birth_year, display_name: displayName(p.name) },
      assessments: db.prepare('SELECT * FROM assessments WHERE participant_id = ? ORDER BY date').all(p.id),
      audit: db.prepare('SELECT * FROM audit WHERE participant_id = ? ORDER BY at DESC LIMIT 30').all(p.id),
    };
  });

  route('PATCH', '/api/participants/(\\d+)', (m, body) => {
    const p = getParticipant(Number(m[1]));
    const next = {
      status: body.status != null ? oneOf(body.status, 'Status', ['waitlist', 'active', 'graduate', 'discharged']) : p.status,
      mode: body.mode != null ? oneOf(body.mode, 'Mode', ['clinic', 'home']) : p.mode,
      conditions: body.conditions != null ? text(body.conditions, 'Conditions', 500) : p.conditions,
      goals: body.goals != null ? text(body.goals, 'Goals', 500) : p.goals,
      hr_max: body.hr_max != null ? int(body.hr_max, 'Heart-rate ceiling', 60, 220) : p.hr_max,
      share_feed: body.share_feed != null ? (body.share_feed ? 1 : 0) : p.share_feed,
    };
    db.prepare('UPDATE participants SET status=?, mode=?, conditions=?, goals=?, hr_max=?, share_feed=? WHERE id=?').run(next.status, next.mode, next.conditions, next.goals, next.hr_max, next.share_feed, p.id);
    const changed = Object.keys(next).filter((k) => next[k] !== p[k]);
    if (changed.length) audit(text(body.actor, 'Actor', 80) || 'Staff', 'participant.update', p.id, changed.map((k) => `${k}: ${p[k]} -> ${next[k]}`).join('; '));
    return { ok: true };
  });

  // Prescribing always creates a new version; old versions are kept for the record.
  route('POST', '/api/participants/(\\d+)/dosages', (m, body) => {
    const p = getParticipant(Number(m[1]));
    const freq = int(body.frequency_per_week, 'Sessions per week', 1, 7);
    const rpe = int(body.target_rpe, 'Target RPE', 1, 10);
    const note = text(body.note, 'Note', 300);
    const actor = text(body.actor, 'Prescriber', 80, true);
    if (!Array.isArray(body.items) || !body.items.length) throw bad('A dose needs at least one exercise');
    if (body.items.length > 12) throw bad('A dose can have at most 12 exercises');
    const seen = new Set();
    const items = body.items.map((it) => {
      const ex = db.prepare('SELECT id FROM exercises WHERE id = ?').get(Number(it.exercise_id));
      if (!ex) throw bad('Unknown exercise in dose');
      if (seen.has(ex.id)) throw bad('Each exercise can appear only once in a dose');
      seen.add(ex.id);
      return { exercise_id: ex.id, sets: int(it.sets, 'Sets', 1, 10), target: int(it.target, 'Target', 1, 120), load: text(it.load, 'Load', 40) };
    });
    const prev = db.prepare('SELECT MAX(version) AS v FROM dosages WHERE participant_id = ?').get(p.id).v || 0;
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE dosages SET active = 0 WHERE participant_id = ?').run(p.id);
      const id = Number(db.prepare('INSERT INTO dosages (participant_id, version, frequency_per_week, target_rpe, note, created_by, created_at, active) VALUES (?,?,?,?,?,?,?,1)').run(p.id, prev + 1, freq, rpe, note, actor, nowIso()).lastInsertRowid);
      const ins = db.prepare('INSERT INTO dosage_items (dosage_id, exercise_id, sets, target, load) VALUES (?,?,?,?,?)');
      for (const it of items) ins.run(id, it.exercise_id, it.sets, it.target, it.load);
      if (p.status === 'waitlist') db.prepare("UPDATE participants SET status = 'active' WHERE id = ?").run(p.id);
      audit(actor, 'dosage.prescribe', p.id, `Version ${prev + 1}${note ? `: ${note}` : ''}`);
      db.exec('COMMIT');
      return { id, version: prev + 1 };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  route('POST', '/api/participants/(\\d+)/assessments', (m, body) => {
    const p = getParticipant(Number(m[1]));
    const date = text(body.date, 'Date', 10, true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw bad('Date must be YYYY-MM-DD');
    const vals = [optInt(body.sit_to_stand_30s, '30-second sit-to-stand', 0, 60), optInt(body.six_min_walk_m, '6-minute walk', 0, 1000), optNum(body.tug_s, 'Timed up-and-go', 0, 120), optNum(body.grip_kg, 'Grip strength', 0, 100)];
    if (vals.every((v) => v == null)) throw bad('Enter at least one measurement');
    const r = db.prepare('INSERT INTO assessments (participant_id, date, sit_to_stand_30s, six_min_walk_m, tug_s, grip_kg, notes) VALUES (?,?,?,?,?,?,?)').run(p.id, date, ...vals, text(body.notes, 'Notes', 300));
    audit(text(body.actor, 'Actor', 80) || 'Staff', 'assessment.record', p.id, date);
    return { id: Number(r.lastInsertRowid) };
  });

  route('POST', '/api/sessions', (_m, body) => {
    const p = getParticipant(Number(body.participant_id));
    const active = db.prepare('SELECT id FROM dosages WHERE participant_id = ? AND active = 1').get(p.id);
    if (!active) throw new HttpError(409, 'This participant has no active dose');
    const mode = oneOf(body.mode || p.mode, 'Mode', ['clinic', 'home']);
    // An abandoned session (never finished) is discarded when a new one starts.
    const stale = db.prepare('SELECT id FROM sessions WHERE participant_id = ? AND ended_at IS NULL').all(p.id);
    for (const s of stale) {
      db.prepare('DELETE FROM session_sets WHERE session_id = ?').run(s.id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    }
    const r = db.prepare('INSERT INTO sessions (participant_id, dosage_id, mode, started_at) VALUES (?,?,?,?)').run(p.id, active.id, mode, nowIso());
    return { id: Number(r.lastInsertRowid), dosage_id: active.id };
  });

  function openSession(id) {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Session not found');
    if (s.ended_at) throw new HttpError(409, 'Session is already finished');
    return s;
  }

  route('POST', '/api/sessions/(\\d+)/sets', (m, body) => {
    const s = openSession(Number(m[1]));
    const item = db.prepare('SELECT * FROM dosage_items WHERE dosage_id = ? AND exercise_id = ?').get(s.dosage_id, Number(body.exercise_id));
    if (!item) throw bad('Exercise is not part of the prescribed dose');
    const setNo = int(body.set_no, 'Set number', 1, 10);
    const r = db
      .prepare('INSERT INTO session_sets (session_id, exercise_id, set_no, target, done, partials, tempo_ms, rom_deg, quality, hr_avg, hr_peak, source, form_issues) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(s.id, item.exercise_id, setNo, item.target, int(body.done, 'Amount done', 0, 500), optInt(body.partials, 'Partial reps', 0, 500) || 0, optInt(body.tempo_ms, 'Tempo', 0, 20000), optInt(body.rom_deg, 'Range', 0, 180), optInt(body.quality, 'Quality', 0, 100), optInt(body.hr_avg, 'Average HR', 30, 230), optInt(body.hr_peak, 'Peak HR', 30, 230), oneOf(body.source || 'manual', 'Source', ['device', 'sim', 'camera', 'manual']), formIssues(body.form_issues));
    return { id: Number(r.lastInsertRowid) };
  });

  route('POST', '/api/sessions/(\\d+)/finish', (m, body) => {
    const s = openSession(Number(m[1]));
    const p = getParticipant(s.participant_id);
    const rpe = int(body.rpe, 'Effort (RPE)', 0, 10);
    const pain = int(body.pain, 'Pain', 0, 10);
    db.prepare('UPDATE sessions SET ended_at = ?, rpe = ?, pain = ?, notes = ? WHERE id = ?').run(nowIso(), rpe, pain, text(body.notes, 'Notes', 500), s.id);
    const o = overview(p);
    const done = o.sessions.find((x) => x.id === s.id);
    if (body.share && p.share_feed) {
      db.prepare('INSERT INTO posts (participant_id, author, kind, text, created_at) VALUES (?,?,?,?,?)').run(p.id, displayName(p.name), 'milestone', `completed session ${o.sessions.length}${o.streak > 1 ? `, ${o.streak} weeks in a row` : ''}`, nowIso());
    }
    const e = live.get(p.id);
    if (e && e.source !== 'class-sim') {
      e.status = 'done';
      e.updated = Date.now();
      broadcast();
    }
    return { metrics: done.metrics, streak: o.streak, adherence: o.adherence, sessions_total: o.sessions.length, flags: o.flags };
  });

  route('GET', '/api/alerts', () =>
    db
      .prepare('SELECT * FROM participants ORDER BY name')
      .all()
      .map(rosterRow)
      .flatMap((r) => r.flags.filter((f) => f.level !== 'good').map((f) => ({ ...f, participant_id: r.id, name: r.name })))
      .sort((a, b) => (a.level === b.level ? 0 : a.level === 'alert' ? -1 : 1))
  );

  route('GET', '/api/feed', () => db.prepare('SELECT id, participant_id, author, kind, text, cheers, created_at FROM posts ORDER BY created_at DESC LIMIT 40').all());

  route('POST', '/api/feed', (_m, body) => {
    const msg = text(body.text, 'Message', 280, true);
    let author;
    let kind = 'message';
    let pid = null;
    if (body.participant_id != null) {
      const p = getParticipant(Number(body.participant_id));
      author = displayName(p.name);
      pid = p.id;
    } else {
      author = text(body.author, 'Author', 60, true);
      kind = 'staff';
    }
    const r = db.prepare('INSERT INTO posts (participant_id, author, kind, text, created_at) VALUES (?,?,?,?,?)').run(pid, author, kind, msg, nowIso());
    return { id: Number(r.lastInsertRowid) };
  });

  route('POST', '/api/feed/(\\d+)/cheer', (m) => {
    const r = db.prepare('UPDATE posts SET cheers = cheers + 1 WHERE id = ?').run(Number(m[1]));
    if (!r.changes) throw new HttpError(404, 'Post not found');
    return db.prepare('SELECT cheers FROM posts WHERE id = ?').get(Number(m[1]));
  });

  // ---------- AI ----------

  const amountText = (i) => (i.unit === 'min' ? `${i.sets > 1 ? `${i.sets} x ` : ''}${i.target} min` : `${i.sets} x ${i.target} reps`);
  const sessionBrief = (s) => ({ date: s.started_at.slice(0, 10), setting: s.mode, completion: Math.round(s.metrics.completion * 100) / 100, quality: s.metrics.quality == null ? null : Math.round(s.metrics.quality), rpe: s.rpe, pain: s.pain, hr_over_ceiling: s.metrics.hrOver, notes: s.notes || undefined });

  // What leaves this machine for a participant: no name, no birth date, no ids.
  function deidentified(p, o) {
    return {
      age: new Date().getFullYear() - p.birth_year,
      program: p.program,
      setting: p.mode,
      conditions: p.conditions,
      goals: p.goals,
      hr_ceiling: p.hr_max,
      dose: o.active && { version: o.active.version, frequency_per_week: o.active.frequency_per_week, target_rpe: o.active.target_rpe, items: o.active.items.map((i) => ({ exercise: i.name, amount: amountText(i), load: i.load || undefined })) },
      attendance_2wk: o.adherence,
      streak_weeks: o.streak,
      sessions_total: o.sessions.length,
      recent_sessions: o.sessions.slice(0, 6).map(sessionBrief),
      assessments: db.prepare('SELECT date, sit_to_stand_30s, six_min_walk_m, tug_s, grip_kg FROM assessments WHERE participant_id = ? ORDER BY date').all(p.id),
      flags: o.flags.map((f) => f.text),
      dropoff_risk: o.risk || { score: 0, level: 'n/a' },
      suggestion: { action: o.recommendation.action, reasons: o.recommendation.reasons },
    };
  }

  route('GET', '/api/ai/status', () => ai.status());

  route('POST', '/api/ai/referral', async (_m, body) => {
    const t = text(body.text, 'Referral text', 6000, true);
    const out = await ai.parseReferral(t);
    const f = out.fields;
    const year = Number.isInteger(f.birth_year) && f.birth_year >= 1900 && f.birth_year <= new Date().getFullYear() ? f.birth_year : null;
    // Model output is untrusted input: coerce it to the same shapes the intake form accepts.
    return {
      source: out.source,
      fallback_reason: out.fallback_reason,
      fields: {
        name: String(f.name || '').slice(0, 80),
        birth_year: year,
        program: ['general', 'cancer', 'stroke'].includes(f.program) ? f.program : 'general',
        mode: f.mode === 'home' ? 'home' : 'clinic',
        conditions: String(f.conditions || '').slice(0, 500),
        goals: String(f.goals || '').slice(0, 500),
        referral_source: String(f.referral_source || '').slice(0, 120),
      },
    };
  });

  route('POST', '/api/participants/(\\d+)/ai/note', async (m, body) => {
    const p = getParticipant(Number(m[1]));
    const out = await ai.progressNote(deidentified(p, overview(p)));
    audit(text(body.actor, 'Actor', 80) || 'Staff', 'ai.note', p.id, out.source === 'claude' ? 'Drafted by Claude (de-identified record)' : 'Drafted by built-in template');
    return { note: out.note, source: out.source, fallback_reason: out.fallback_reason };
  });

  route('POST', '/api/participants/(\\d+)/ai/coach', async (m, body) => {
    const p = getParticipant(Number(m[1]));
    const history = Array.isArray(body.messages) ? body.messages : [];
    if (history.length > 20) throw bad('This conversation is too long. Please start a new one.');
    const clean = history.map((h) => ({ role: oneOf(h && h.role, 'Role', ['user', 'assistant']), content: text(h.content, 'Message', 1000, true) }));
    if (clean.length && (clean[0].role !== 'user' || clean[clean.length - 1].role !== 'user')) throw bad('A conversation must start and end with your message');
    const d = deidentified(p, overview(p));
    const out = await ai.coach({ program: d.program, dose: d.dose, streak_weeks: d.streak_weeks, sessions_total: d.sessions_total, recent_sessions: d.recent_sessions }, clean);
    return { reply: out.reply, source: out.source, fallback_reason: out.fallback_reason };
  });

  route('POST', '/api/ai/ask', async (_m, body) => {
    const question = text(body.question, 'Question', 500, true);
    const people = db.prepare('SELECT * FROM participants ORDER BY id').all();
    const rows = people.map((p) => {
      const r = rosterRow(p);
      return { code: `P${p.id}`, age: r.age, program: p.program, setting: p.mode, status: p.status, attendance_2wk: r.adherence, streak_weeks: r.streak, sessions_total: r.sessions_total, last_session: r.last_session && { date: r.last_session.started_at.slice(0, 10), completion: Math.round(r.last_session.completion * 100) / 100, quality: r.last_session.quality == null ? null : Math.round(r.last_session.quality), rpe: r.last_session.rpe, pain: r.last_session.pain }, flags: r.flags.map((f) => ({ kind: f.kind, level: f.level, text: f.text })), risk: r.risk && { score: r.risk.score, level: r.risk.level }, suggestion: r.recommendation };
    });
    const out = await ai.ask(question, rows);
    // Codes become names here, on this machine.
    const byId = new Map(people.map((p) => [p.id, p]));
    const mentions = [];
    const answer = out.answer.replace(/\[P(\d+)\]/g, (all, id) => {
      const p = byId.get(Number(id));
      if (!p) return all;
      if (!mentions.some((x) => x.id === p.id)) mentions.push({ id: p.id, name: p.name });
      return p.name;
    });
    return { answer, mentions, source: out.source, fallback_reason: out.fallback_reason };
  });

  route('GET', '/api/live', () => ({ board: board(), sim: !!sim }));

  route('POST', '/api/live', (_m, body) => {
    const p = getParticipant(Number(body.participant_id));
    live.set(p.id, {
      participant_id: p.id,
      name: p.name,
      exercise: text(body.exercise, 'Exercise', 60, true),
      set: int(body.set, 'Set', 1, 10),
      sets: int(body.sets, 'Sets', 1, 10),
      reps: int(body.reps, 'Reps', 0, 500),
      target: int(body.target, 'Target', 1, 500),
      quality: optInt(body.quality, 'Quality', 0, 100),
      hr: optInt(body.hr, 'HR', 30, 230),
      hr_max: p.hr_max,
      status: oneOf(body.status || 'active', 'Status', ['active', 'resting', 'done']),
      source: oneOf(body.source || 'manual', 'Source', ['device', 'sim', 'camera', 'manual']),
      form: text(body.form, 'Form', 120) || null,
      updated: Date.now(),
    });
    broadcast();
    return { ok: true };
  });

  route('POST', '/api/sim/start', () => {
    simStart();
    broadcast();
    return { sim: true };
  });
  route('POST', '/api/sim/stop', () => {
    simStop();
    broadcast();
    return { sim: false };
  });

  function csv(pid) {
    const p = getParticipant(pid);
    const o = overview(p);
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [['session_id', 'date', 'mode', 'dose_version', 'exercise', 'set', 'unit', 'target', 'done', 'partial_reps', 'tempo_ms', 'range_deg', 'quality', 'hr_avg', 'hr_peak', 'source', 'form_issues', 'session_rpe', 'session_pain', 'session_completion_pct'].join(',')];
    const version = new Map(o.dosages.map((d) => [d.id, d.version]));
    for (const s of [...o.sessions].reverse()) {
      for (const t of s.sets) {
        lines.push([s.id, s.started_at, s.mode, version.get(s.dosage_id), t.name, t.set_no, t.unit, t.target, t.done, t.partials, t.tempo_ms, t.rom_deg, t.quality, t.hr_avg, t.hr_peak, t.source, t.form_issues ? Object.entries(t.form_issues).map(([k, n]) => `${k} x${n}`).join('; ') : '', s.rpe, s.pain, Math.round(s.metrics.completion * 100)].map(q).join(','));
      }
    }
    return { name: p.name, body: lines.join('\r\n') + '\r\n' };
  }

  // ---------- http ----------

  function readBody(req) {
    return new Promise((resolve, reject) => {
      // Vercel parses request bodies itself and exposes the result as req.body.
      if ('body' in req) {
        try {
          const v = req.body;
          if (v == null || v === '') return resolve({});
          const o = typeof v === 'string' || Buffer.isBuffer(v) ? JSON.parse(String(v)) : v;
          if (!o || typeof o !== 'object' || Array.isArray(o)) return reject(bad('Body must be a JSON object'));
          return resolve(o);
        } catch {
          return reject(bad('Body is not valid JSON'));
        }
      }
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 100000) {
          reject(new HttpError(413, 'Request too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(bad('Body must be a JSON object'));
          resolve(v);
        } catch {
          reject(bad('Body is not valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(WEB_DIR, rel);
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/api/live/stream' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ board: board(), sim: !!sim })}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      const exp = /^\/api\/participants\/(\d+)\/export\.csv$/.exec(pathname);
      if (exp && req.method === 'GET') {
        const out = csv(Number(exp[1]));
        audit('Staff', 'record.export', Number(exp[1]), 'CSV');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="doseloop-${out.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.csv"` });
        return res.end(out.body);
      }
      if (pathname.startsWith('/api/')) {
        for (const r of routes) {
          const m = r.method === req.method && r.re.exec(pathname);
          if (!m) continue;
          const body = req.method === 'GET' ? {} : await readBody(req);
          const out = await r.handler(m, body);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify(out));
        }
        throw new HttpError(404, 'No such endpoint');
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      serveStatic(pathname, res);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Internal server error' : e.message }));
    }
  }

  const server = http.createServer(handle);
  server.handle = handle; // for platforms that pass (req, res) themselves, such as Vercel
  server.on('close', () => {
    clearInterval(heartbeat);
    simStop();
    for (const res of streams) res.end();
  });
  return server;
}

if (require.main === module) {
  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = process.env.DOSELOOP_DB || path.join(dataDir, 'doseloop.db');
  if (process.argv.includes('--reset')) for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const db = open(file);
  if (db.prepare('SELECT COUNT(*) AS n FROM participants').get().n === 0) {
    seed(db);
    console.log('Seeded demo data.');
  }
  // Loopback only: the demo has no login, so it must not be reachable from the network.
  const port = Number(process.env.PORT) || 4198;
  // Only this computer can reach the app unless HOST=0.0.0.0 is set (for example so a Wi-Fi
  // wearable on the same network can post to it). The app has no login: do that only on a
  // network you trust.
  const host = process.env.HOST || '127.0.0.1';
  createApp(db).listen(port, host, () => console.log(`DoseLoop running at http://localhost:${port}${host === '127.0.0.1' ? '' : ` (also reachable on the network via ${host})`}`));
}

module.exports = { createApp };
