'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  birth_year INTEGER,
  program TEXT NOT NULL CHECK (program IN ('general','cancer','stroke','graduate')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('waitlist','active','graduate','discharged')),
  mode TEXT NOT NULL DEFAULT 'clinic' CHECK (mode IN ('clinic','home')),
  conditions TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '',
  referral_source TEXT NOT NULL DEFAULT '',
  hr_max INTEGER,
  share_feed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('reps','min')),
  target_rom_deg INTEGER,
  target_tempo_ms INTEGER,
  sensor_site TEXT,
  cue TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS dosages (
  id INTEGER PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  version INTEGER NOT NULL,
  frequency_per_week INTEGER NOT NULL,
  target_rpe INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dosage_items (
  id INTEGER PRIMARY KEY,
  dosage_id INTEGER NOT NULL REFERENCES dosages(id),
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  sets INTEGER NOT NULL,
  target INTEGER NOT NULL,
  load TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- ids are never reused, so a discarded session cannot be finished by a stale tab
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  dosage_id INTEGER REFERENCES dosages(id),
  mode TEXT NOT NULL CHECK (mode IN ('clinic','home')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  rpe INTEGER,
  pain INTEGER,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS session_sets (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  set_no INTEGER NOT NULL,
  target INTEGER NOT NULL,
  done INTEGER NOT NULL,
  partials INTEGER NOT NULL DEFAULT 0,
  tempo_ms INTEGER,
  rom_deg INTEGER,
  quality INTEGER,
  hr_avg INTEGER,
  hr_peak INTEGER,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('device','sim','camera','manual')),
  form_issues TEXT -- JSON {fault id: times}, when the camera checked form during the set
);
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  date TEXT NOT NULL,
  sit_to_stand_30s INTEGER,
  six_min_walk_m INTEGER,
  tug_s REAL,
  grip_kg REAL,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  participant_id INTEGER REFERENCES participants(id),
  author TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('milestone','message','staff')),
  text TEXT NOT NULL,
  cheers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  participant_id INTEGER,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_participant ON sessions(participant_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sets_session ON session_sets(session_id);
CREATE INDEX IF NOT EXISTS idx_dosages_participant ON dosages(participant_id);
`;

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Databases created before camera tracking allow only three set sources. SQLite cannot
// change a CHECK constraint in place, so that one table is rebuilt with its rows.
// Databases created before form checks get the form_issues column.
const OLD_SET_COLUMNS = 'id, session_id, exercise_id, set_no, target, done, partials, tempo_ms, rom_deg, quality, hr_avg, hr_peak, source';
function migrate(db) {
  // The wearable is worn on the wrist for every exercise (it also reads the pulse there).
  db.exec("UPDATE exercises SET sensor_site = 'Wrist' WHERE sensor_site IS NOT 'Wrist'");
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_sets'").get();
  if (t && !t.sql.includes("'camera'")) rebuildSets(db);
  const cols = db.prepare('PRAGMA table_info(session_sets)').all().map((c) => c.name);
  if (!cols.includes('form_issues')) db.exec('ALTER TABLE session_sets ADD COLUMN form_issues TEXT');
}
function rebuildSets(db) {
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE session_sets RENAME TO session_sets_old');
    db.exec(SCHEMA);
    db.exec(`INSERT INTO session_sets (${OLD_SET_COLUMNS}) SELECT ${OLD_SET_COLUMNS} FROM session_sets_old`);
    db.exec('DROP TABLE session_sets_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sets_session ON session_sets(session_id)');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const EXERCISES = [
  ['Sit-to-stand', 'Strength', 'reps', 80, 2500, 'Wrist', 'Stand up tall without using your hands, then sit down slowly.'],
  ['Seated knee extension', 'Strength', 'reps', 70, 2000, 'Wrist', 'Straighten your knee fully, hold for a moment, lower with control.'],
  ['Bicep curl', 'Strength', 'reps', 110, 2000, 'Wrist', 'Keep your elbow at your side and curl all the way up.'],
  ['Lateral arm raise', 'Strength', 'reps', 80, 2000, 'Wrist', 'Raise your arm out to shoulder height, lower slowly.'],
  ['Standing hip abduction', 'Balance', 'reps', 35, 2000, 'Wrist', 'Hold the rail. Lift your leg out to the side, keep your toes forward.'],
  ['Heel raise', 'Balance', 'reps', 25, 1500, 'Wrist', 'Rise onto your toes, pause, lower slowly.'],
  ['Wall push-up', 'Strength', 'reps', 40, 2500, 'Wrist', 'Hands on the wall at shoulder height. Bend your elbows, push back.'],
  ['Treadmill walk', 'Aerobic', 'min', null, null, 'Wrist', 'Walk at a pace where you can still hold a conversation.'],
  ['Recumbent bike', 'Aerobic', 'min', null, null, 'Wrist', 'Steady pedalling at a comfortable resistance.'],
  ['Stretching', 'Flexibility', 'min', null, null, 'Wrist', 'Hold each stretch for 30 seconds. No bouncing.'],
];

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400000;
const WEEKDAYS = { 2: [1, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5] };

// Each archetype is a recognisable case for the demo: someone ready to progress,
// someone in pain, someone overdoing it at home, someone drifting away, and so on.
const PEOPLE = [
  { name: 'Margaret Okafor', year: 1948, program: 'stroke', mode: 'clinic', ref: 'WRHN fax referral', cond: 'Left-sided weakness following ischaemic stroke (2025)', goals: 'Climb the stairs at home without the rail', freq: 3, rpe: 4, plan: [[1, 2, 10, ''], [2, 2, 12, '1 kg ankle weight'], [5, 2, 10, ''], [9, 1, 12, 'Level 3']], a: { comp: 1.0, rpe: -0.6, pain: 0, q: 86, att: 0.95 } },
  { name: 'Harold Bergstrom', year: 1944, program: 'cancer', mode: 'clinic', ref: 'WRHN fax referral', cond: 'Prostate cancer, on androgen deprivation therapy; osteoarthritis (R knee)', goals: 'Keep strength up through treatment', freq: 2, rpe: 4, plan: [[1, 3, 10, ''], [3, 2, 12, '2 kg'], [7, 2, 10, ''], [8, 1, 15, '3.5 km/h']], a: { comp: 0.8, rpe: 2.3, pain: 5, q: 72, att: 0.9, painRise: true } },
  { name: 'Dorothy Kowalski', year: 1951, program: 'general', mode: 'clinic', ref: 'Self-referred', cond: 'Type 2 diabetes, hypertension (controlled)', goals: 'Walk 30 minutes without stopping', freq: 3, rpe: 5, plan: [[1, 2, 12, ''], [6, 2, 15, ''], [4, 2, 10, '1 kg'], [8, 1, 20, '4.0 km/h']], a: { comp: 0.97, rpe: 0.4, pain: 1, q: 82, att: 0.9, progressed: true } },
  { name: 'Walter Singh', year: 1946, program: 'graduate', mode: 'home', ref: 'Program graduate', cond: 'Coronary artery disease, stent 2024', goals: 'Stay independent; keep up with grandchildren', freq: 3, rpe: 5, plan: [[1, 3, 12, ''], [3, 2, 12, '3 kg'], [6, 2, 15, ''], [10, 1, 8, '']], a: { comp: 0.9, rpe: 0, pain: 1, q: 78, att: 0.85, dropOff: true } },
  { name: 'Eleanor Petit', year: 1953, program: 'graduate', mode: 'home', ref: 'Program graduate', cond: 'Breast cancer survivor (2023); mild lymphoedema (L arm)', goals: 'Return to gardening and curling', freq: 3, rpe: 5, plan: [[1, 3, 12, ''], [4, 2, 10, '1 kg'], [7, 2, 12, ''], [10, 1, 8, '']], a: { comp: 1.32, rpe: 1.6, pain: 2, q: 74, att: 1.0, hrOver: true } },
  { name: 'Frank Delacroix', year: 1942, program: 'stroke', mode: 'clinic', ref: 'WRHN fax referral', cond: 'Right hemiparesis; mild cognitive impairment', goals: 'Transfer from chair independently', freq: 2, rpe: 4, plan: [[1, 2, 8, 'Raised seat'], [2, 2, 10, ''], [3, 2, 10, '1 kg'], [9, 1, 10, 'Level 2']], a: { comp: 0.88, rpe: 0.8, pain: 1, q: 52, att: 0.9 } },
  { name: 'Ruth Mbeki', year: 1950, program: 'cancer', mode: 'home', ref: 'WRHN fax referral', cond: 'Colorectal cancer, post-chemotherapy fatigue', goals: 'Rebuild stamina for daily walks', freq: 3, rpe: 4, plan: [[1, 2, 10, ''], [6, 2, 12, ''], [3, 2, 10, '1 kg'], [10, 1, 10, '']], a: { comp: 0.93, rpe: 0.5, pain: 1, q: 80, att: 0.8 } },
  { name: 'George Tanaka', year: 1940, program: 'general', mode: 'clinic', ref: 'Family physician', cond: 'COPD (moderate), osteoporosis', goals: 'Less breathless carrying groceries', freq: 2, rpe: 4, plan: [[1, 2, 10, ''], [7, 2, 10, ''], [5, 2, 10, ''], [8, 1, 12, '3.0 km/h']], a: { comp: 0.58, rpe: 1.2, pain: 2, q: 70, att: 0.9 } },
  { name: 'Jean Lapointe', year: 1949, program: 'graduate', mode: 'home', ref: 'Program graduate', cond: 'Stroke survivor (2024), full program completed', goals: 'Maintain balance; walk the dog daily', freq: 3, rpe: 5, plan: [[1, 3, 12, ''], [5, 2, 12, ''], [6, 3, 15, ''], [10, 1, 10, '']], a: { comp: 1.0, rpe: 0.2, pain: 0, q: 88, att: 1.0 } },
  { name: 'Arthur Whitfield', year: 1947, program: 'stroke', mode: 'clinic', ref: 'WRHN fax referral', cond: 'Lacunar stroke; atrial fibrillation (anticoagulated)', goals: 'Improve walking speed', freq: 3, rpe: 4, plan: [[1, 2, 10, ''], [2, 2, 12, ''], [6, 2, 12, ''], [8, 1, 15, '3.2 km/h']], a: { comp: 0.9, rpe: 0.9, pain: 2, q: 76, att: 0.85 } },
  { name: 'Betty Castellano', year: 1955, program: 'general', mode: 'clinic', ref: 'Self-referred', cond: 'Hip replacement (L, 2025)', goals: 'Get back to line dancing', freq: 2, rpe: 5, plan: [[1, 3, 10, ''], [5, 3, 12, ''], [6, 2, 15, ''], [9, 1, 15, 'Level 4']], a: { comp: 1.0, rpe: -0.3, pain: 1, q: 84, att: 0.95, short: true } },
  { name: 'Stanley Hruska', year: 1943, program: 'stroke', mode: 'home', status: 'waitlist', ref: 'WRHN fax referral', cond: 'Stroke (Aug 2026); cannot travel to the facility', goals: 'Start supervised exercise at home', plan: null },
];

function seed(db, now = Date.now()) {
  const rnd = mulberry32(198);
  const jitter = (sd) => (rnd() + rnd() + rnd() - 1.5) * sd * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const iso = (t) => new Date(t).toISOString();

  db.exec('BEGIN');
  const insEx = db.prepare('INSERT INTO exercises (name, category, unit, target_rom_deg, target_tempo_ms, sensor_site, cue) VALUES (?,?,?,?,?,?,?)');
  for (const e of EXERCISES) insEx.run(...e);
  const exById = new Map(db.prepare('SELECT * FROM exercises').all().map((e) => [e.id, e]));

  const insP = db.prepare('INSERT INTO participants (name, birth_year, program, status, mode, conditions, goals, referral_source, hr_max, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insD = db.prepare('INSERT INTO dosages (participant_id, version, frequency_per_week, target_rpe, note, created_by, created_at, active) VALUES (?,?,?,?,?,?,?,?)');
  const insI = db.prepare('INSERT INTO dosage_items (dosage_id, exercise_id, sets, target, load) VALUES (?,?,?,?,?)');
  const insS = db.prepare('INSERT INTO sessions (participant_id, dosage_id, mode, started_at, ended_at, rpe, pain, notes) VALUES (?,?,?,?,?,?,?,?)');
  const insSet = db.prepare('INSERT INTO session_sets (session_id, exercise_id, set_no, target, done, partials, tempo_ms, rom_deg, quality, hr_avg, hr_peak, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const insA = db.prepare('INSERT INTO assessments (participant_id, date, sit_to_stand_30s, six_min_walk_m, tug_s, grip_kg, notes) VALUES (?,?,?,?,?,?,?)');
  const insPost = db.prepare('INSERT INTO posts (participant_id, author, kind, text, cheers, created_at) VALUES (?,?,?,?,?,?)');
  const insAudit = db.prepare('INSERT INTO audit (at, actor, action, participant_id, detail) VALUES (?,?,?,?,?)');

  const today = new Date(now);
  today.setHours(10, 0, 0, 0);

  for (const p of PEOPLE) {
    const age = today.getFullYear() - p.year;
    const hrMax = Math.round((220 - age) * 0.8);
    const span = p.a && p.a.short ? 16 : 42;
    const start = today.getTime() - span * DAY;
    const status = p.status || (p.program === 'graduate' ? 'graduate' : 'active');
    const pid = Number(insP.run(p.name, p.year, p.program, status, p.mode, p.cond, p.goals, p.ref, hrMax, iso(start - 3 * DAY)).lastInsertRowid);
    insAudit.run(iso(start - 3 * DAY), 'Intake', 'participant.create', pid, `Referral: ${p.ref}`);
    if (!p.plan) continue;

    const a = p.a;
    const mkDosage = (version, at, items, note, active) => {
      const id = Number(insD.run(pid, version, p.freq, p.rpe, note, 'S. Marsh, R.Kin', iso(at), active ? 1 : 0).lastInsertRowid);
      for (const [ex, sets, target, load] of items) insI.run(id, ex, sets, target, load);
      insAudit.run(iso(at), 'S. Marsh, R.Kin', 'dosage.prescribe', pid, `Version ${version}: ${note}`);
      return { id, at, items };
    };

    const versions = [];
    if (a.progressed) {
      const v1 = p.plan.map(([ex, sets, target, load]) => [ex, sets, Math.max(1, Math.round(target * 0.85)), load]);
      versions.push(mkDosage(1, start, v1, 'Initial dose from intake assessment', false));
      versions.push(mkDosage(2, start + 24 * DAY, p.plan, 'Progressed: full dose completed at RPE below target', true));
    } else {
      versions.push(mkDosage(1, start, p.plan, 'Initial dose from intake assessment', true));
    }

    insA.run(pid, iso(start - DAY).slice(0, 10), 8 + Math.floor(rnd() * 5), 280 + Math.floor(rnd() * 120), +(11 + rnd() * 6).toFixed(1), +(18 + rnd() * 10).toFixed(1), 'Intake assessment');
    if (span > 30) {
      const base = db.prepare('SELECT * FROM assessments WHERE participant_id = ?').get(pid);
      const gain = a.comp >= 0.9 ? 1 : 0;
      insA.run(pid, iso(start + 28 * DAY).slice(0, 10), base.sit_to_stand_30s + 1 + gain, base.six_min_walk_m + 15 + gain * 25, +(base.tug_s - 0.6 - gain * 0.8).toFixed(1), +(base.grip_kg + 0.5 + gain).toFixed(1), '4-week reassessment');
    }

    let count = 0;
    for (let d = 0; d < span; d++) {
      const t = start + d * DAY + Math.floor(rnd() * 3) * 3600000;
      if (!WEEKDAYS[p.freq].includes(new Date(t).getDay())) continue;
      const frac = d / span;
      let att = a.att;
      if (a.dropOff && frac > 0.62) att = 0.12;
      if (rnd() > att) continue;

      const dose = versions.filter((v) => v.at <= t).pop();
      const pain = clamp(Math.round((a.painRise ? a.pain * (0.3 + frac) : a.pain) + jitter(0.7)), 0, 10);
      const rpe = clamp(Math.round(p.rpe + a.rpe + (a.painRise ? frac * 1.2 : 0) + jitter(0.6)), 1, 10);
      const sid = Number(insS.run(pid, dose.id, p.mode, iso(t), iso(t + 45 * 60000), rpe, pain, '').lastInsertRowid);
      for (const [exId, sets, target] of dose.items) {
        const ex = exById.get(exId);
        for (let s = 1; s <= sets; s++) {
          const done = Math.max(0, Math.round(target * (a.comp + jitter(0.05))));
          const hrAvg = Math.round(hrMax * 0.72 + jitter(5));
          const hrPeak = a.hrOver ? hrMax + 3 + Math.floor(rnd() * 8) : Math.min(hrMax - 2, hrAvg + 6 + Math.floor(rnd() * 8));
          if (ex.unit === 'reps') {
            const q = clamp(Math.round(a.q + jitter(5) + frac * 3), 20, 100);
            const partials = q < 65 ? 1 + Math.floor(rnd() * 3) : 0;
            insSet.run(sid, exId, s, target, done, partials, Math.round(ex.target_tempo_ms * (0.9 + rnd() * 0.3)), Math.round(ex.target_rom_deg * clamp(q / 95, 0.5, 1.02)), q, hrAvg, hrPeak, 'device');
          } else {
            insSet.run(sid, exId, s, target, done, 0, null, null, null, hrAvg, hrPeak, 'manual');
          }
        }
      }
      count++;
      if (p.mode === 'home' && count % 5 === 0) {
        insPost.run(pid, displayName(p.name), 'milestone', `completed session ${count} at home`, Math.floor(rnd() * 6), iso(t + 46 * 60000));
      }
    }
  }

  const ago = (h) => iso(now - h * 3600000);
  insPost.run(null, 'Sam (Kinesiologist)', 'staff', 'Virtual group class this Thursday at 10 am. Chairs ready, water nearby!', 7, ago(30));
  insPost.run(9, 'Jean L.', 'message', 'Walked the dog all the way round the park today. Three months ago I could not make it to the corner.', 9, ago(20));
  insPost.run(7, 'Ruth M.', 'message', 'Tired today but did my sit-to-stands anyway. Anyone else find mornings easier?', 4, ago(8));
  insPost.run(5, 'Eleanor P.', 'message', 'Mornings for me too, Ruth. Kettle on, then exercises.', 3, ago(6));
  db.exec('COMMIT');
}

// Feed posts never carry a full name.
function displayName(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

module.exports = { open, seed, displayName };
