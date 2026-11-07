'use strict';
// Dose logic: session metrics, adherence, flags and the adjustment recommendation.
// Pure functions over plain objects so they can be unit-tested without a database.

const DAY_MS = 86400000;

// items: dosage items [{exercise_id, sets, target}]; sets: logged sets [{exercise_id, target, done, quality, hr_peak}]
function sessionMetrics(items, sets, hrMax) {
  const doneBy = new Map();
  for (const s of sets) doneBy.set(s.exercise_id, (doneBy.get(s.exercise_id) || 0) + s.done);

  // With no prescription to compare against, fall back to the targets logged with each set.
  const plan = items.length
    ? items.map((i) => ({ exercise_id: i.exercise_id, total: i.sets * i.target }))
    : [...new Set(sets.map((s) => s.exercise_id))].map((id) => ({
        exercise_id: id,
        total: sets.filter((s) => s.exercise_id === id).reduce((a, s) => a + s.target, 0),
      }));

  const ratios = plan.filter((p) => p.total > 0).map((p) => (doneBy.get(p.exercise_id) || 0) / p.total);
  const completion = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
  const scored = sets.filter((s) => s.quality != null);
  const quality = scored.length ? scored.reduce((a, s) => a + s.quality, 0) / scored.length : null;
  const hrPeak = sets.reduce((m, s) => Math.max(m, s.hr_peak || 0), 0) || null;

  return {
    completion,
    quality,
    hrPeak,
    over: ratios.some((r) => r > 1.2),
    hrOver: !!(hrMax && hrPeak && hrPeak > hrMax),
  };
}

// Sessions completed in the last 14 days against the prescribed frequency.
function adherence(sessions, frequencyPerWeek, now = Date.now()) {
  if (!frequencyPerWeek) return null;
  const recent = sessions.filter((s) => now - Date.parse(s.started_at) <= 14 * DAY_MS).length;
  return Math.min(1, recent / (frequencyPerWeek * 2));
}

function streakWeeks(sessions, frequencyPerWeek, now = Date.now()) {
  if (!frequencyPerWeek) return 0;
  let streak = 0;
  for (let w = 0; w < 52; w++) {
    const hi = now - w * 7 * DAY_MS;
    const lo = hi - 7 * DAY_MS;
    const n = sessions.filter((s) => {
      const t = Date.parse(s.started_at);
      return t > lo && t <= hi;
    }).length;
    if (n >= frequencyPerWeek) streak++;
    else if (w === 0) continue; // the current week is still in progress
    else break;
  }
  return streak;
}

function scaleItem(item, factor) {
  const up = factor > 1;
  let { sets, target } = item;
  if (item.unit === 'reps' && up && target >= 15 && sets < 4) {
    // Past 15 reps, add a set rather than more reps.
    sets += 1;
    target = 10;
  } else {
    const scaled = target * factor;
    target = up ? Math.max(target + 1, Math.round(scaled)) : Math.max(1, Math.min(target - 1, Math.round(scaled)));
    target = Math.max(1, target);
  }
  return { ...item, sets, target };
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// dosage: {target_rpe, items:[{exercise_id, unit, sets, target}]}
// sessions: completed sessions on this dosage, newest first, each with .metrics, .rpe, .pain
function recommend(dosage, sessions) {
  if (!dosage) return { action: 'none', reasons: ['No active dose prescribed.'], proposal: null };
  const last = sessions.slice(0, 3);
  const pct = (v) => `${Math.round(v * 100)}%`;

  if (last.length && last[0].pain >= 6) {
    return {
      action: 'regress',
      reasons: [`Pain ${last[0].pain}/10 reported in the most recent session.`],
      proposal: dosage.items.map((i) => scaleItem(i, 0.85)),
    };
  }
  if (last.length < 3) {
    return {
      action: 'hold',
      reasons: [`Only ${last.length} session${last.length === 1 ? '' : 's'} on this dose; 3 are needed before adjusting.`],
      proposal: null,
    };
  }

  const completion = avg(last.map((s) => s.metrics.completion));
  const rpe = avg(last.filter((s) => s.rpe != null).map((s) => s.rpe));
  const pain = avg(last.filter((s) => s.pain != null).map((s) => s.pain));
  const maxPain = Math.max(0, ...last.map((s) => s.pain || 0));
  const quality = avg(last.filter((s) => s.metrics.quality != null).map((s) => s.metrics.quality));
  const hrOver = last.filter((s) => s.metrics.hrOver).length;

  const down = [];
  if (pain != null && pain >= 4) down.push(`Average pain ${pain.toFixed(1)}/10 over the last 3 sessions.`);
  if (rpe != null && rpe >= dosage.target_rpe + 2)
    down.push(`Average effort ${rpe.toFixed(1)} is well above the target RPE of ${dosage.target_rpe}.`);
  if (completion < 0.7) down.push(`Only ${pct(completion)} of the dose completed on average.`);
  if (hrOver >= 2) down.push(`Heart rate exceeded the safe ceiling in ${hrOver} of the last 3 sessions.`);
  if (down.length) {
    return { action: 'regress', reasons: down, proposal: dosage.items.map((i) => scaleItem(i, 0.85)) };
  }

  const ready =
    last.every((s) => s.metrics.completion >= 0.95) &&
    (rpe == null || rpe <= dosage.target_rpe) &&
    maxPain <= 2 &&
    (quality == null || quality >= 75) &&
    hrOver === 0;
  if (ready) {
    const reasons = [`Full dose completed in each of the last 3 sessions (${pct(completion)} average).`];
    if (rpe != null) reasons.push(`Average effort ${rpe.toFixed(1)} is at or below the target RPE of ${dosage.target_rpe}.`);
    if (quality != null) reasons.push(`Movement quality averages ${Math.round(quality)}/100.`);
    return { action: 'progress', reasons, proposal: dosage.items.map((i) => scaleItem(i, 1.1)) };
  }

  const hold = [];
  if (!last.every((s) => s.metrics.completion >= 0.95)) hold.push(`Dose completion is ${pct(completion)}; progress once it is consistently above 95%.`);
  if (rpe != null && rpe > dosage.target_rpe) hold.push(`Effort ${rpe.toFixed(1)} is above the target RPE of ${dosage.target_rpe}.`);
  if (maxPain > 2) hold.push(`Pain of ${maxPain}/10 was reported recently.`);
  if (quality != null && quality < 75) hold.push(`Movement quality averages ${Math.round(quality)}/100; work on form before adding load.`);
  if (hrOver) hold.push('Heart rate exceeded the ceiling once recently.');
  return { action: 'hold', reasons: hold, proposal: null };
}

// Flags shown on the roster. sessions: all completed sessions, newest first, with metrics.
function flags({ participant, dosage, sessions, recommendation, now = Date.now() }) {
  const out = [];
  if (!dosage) {
    if (participant.status !== 'waitlist') out.push({ kind: 'nodose', level: 'warn', text: 'No dose prescribed' });
    return out;
  }
  const adh = adherence(sessions, dosage.frequency_per_week, now);
  const age = now - Date.parse(dosage.first_prescribed_at || dosage.created_at);
  if (adh != null && adh < 0.5 && age > 14 * DAY_MS) {
    out.push({ kind: 'missed', level: 'alert', text: `Missed sessions (${Math.round(adh * 100)}% attendance, 2 wk)` });
  }
  const last = sessions[0];
  if (last && now - Date.parse(last.started_at) <= 14 * DAY_MS) {
    if (last.pain >= 5) out.push({ kind: 'pain', level: 'alert', text: `Pain ${last.pain}/10 last session` });
    if (last.metrics.hrOver) out.push({ kind: 'hr', level: 'alert', text: `Heart rate peaked at ${last.metrics.hrPeak} bpm` });
    if (last.metrics.over) out.push({ kind: 'overdose', level: 'alert', text: 'Exceeded prescribed dose' });
    if (last.metrics.completion < 0.7) out.push({ kind: 'underdose', level: 'warn', text: `Under-dosed (${Math.round(last.metrics.completion * 100)}%)` });
    if (last.metrics.quality != null && last.metrics.quality < 60) out.push({ kind: 'quality', level: 'warn', text: `Low movement quality (${Math.round(last.metrics.quality)})` });
  }
  if (recommendation && recommendation.action === 'progress') out.push({ kind: 'ready', level: 'good', text: 'Ready to progress' });
  return out;
}

// Drop-off risk, 0-100. A transparent weighted score (not a trained model): each
// driver contributes a fixed number of points and is reported alongside the score.
function risk({ participant, dosage, sessions, now = Date.now() }) {
  if (!dosage || participant.status === 'waitlist' || participant.status === 'discharged') return null;
  const drivers = [];
  let score = 0;
  const add = (points, text) => {
    if (points <= 0) return;
    score += points;
    drivers.push({ points: Math.round(points), text });
  };
  const age = now - Date.parse(dosage.first_prescribed_at || dosage.created_at);
  const adh = adherence(sessions, dosage.frequency_per_week, now);
  if (age > 14 * DAY_MS && adh != null) add((1 - adh) * 60, `Attendance ${Math.round(adh * 100)}% over 2 weeks`);
  const last = sessions[0];
  if (last) {
    const gap = (now - Date.parse(last.started_at)) / DAY_MS;
    if (gap > 7) add(Math.min(15, (gap - 7) * 2.2), `${Math.round(gap)} days since the last session`);
    const recent = sessions.slice(0, 6);
    if (recent.length >= 4) {
      const half = Math.floor(recent.length / 2);
      const newer = avg(recent.slice(0, half).map((s) => s.metrics.completion));
      const older = avg(recent.slice(half).map((s) => s.metrics.completion));
      if (older - newer > 0.08) add(Math.min(15, (older - newer) * 60), 'Dose completion is trending down');
    }
    const pain = avg(sessions.slice(0, 3).map((s) => s.pain || 0));
    if (pain >= 3) add(Math.min(15, pain * 2.5), `Pain averaging ${pain.toFixed(1)}/10`);
    const rpe = avg(sessions.slice(0, 3).filter((s) => s.rpe != null).map((s) => s.rpe));
    if (rpe != null && rpe >= dosage.target_rpe + 2) add(10, 'Effort well above target');
    if (last.metrics.completion < 0.7) add(8, 'Last session under-dosed');
  } else if (age > 7 * DAY_MS) {
    add(30, 'No sessions since the dose was prescribed');
  }
  if (participant.mode === 'home') add(5, 'Exercising unsupervised at home');
  score = Math.round(Math.min(100, score));
  return { score, level: score >= 55 ? 'high' : score >= 30 ? 'medium' : 'low', drivers: drivers.sort((a, b) => b.points - a.points) };
}

module.exports = { risk, sessionMetrics, adherence, streakWeeks, recommend, flags, scaleItem, DAY_MS };
