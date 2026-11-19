'use strict';
// Watch + camera fusion (phase 1). Two streams come in during a set:
//   motion: rep events from the wrist watch (REP/PART lines) and from the camera's rep counter
//   bio:    heart rate and blood oxygen from the watch, plus its 1 s accelerometer readings
// RepFusion matches the two motion streams rep by rep and decides what counts; BioMonitor
// reads heart rate and oxygen with movement in mind; assess() turns both, plus form and
// fatigue, into one safety level. calibrate() measures how the two sensors line up for one
// person and exercise, so the matching can be tuned. Pure logic with no DOM, shared by the
// browser and Node (tests, server-side validation). Loads as window.DLFusion or module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DLFusion = api;
})(typeof self !== 'undefined' ? self : this, () => {
  // ---------- settings ----------
  // Defaults a clinician can change per participant. Thresholds marked "clinical" need the
  // clinical team's sign-off before use with participants.
  const DEFAULTS = {
    policy: 'primary', // 'primary': the trusted sensor's reps count; 'confirmed': only reps both sensors saw count (while both can see)
    matchMinMs: 600, // two rep events this close (or closer) can be the same rep...
    matchTempoFrac: 0.4, // ...or within this fraction of the target tempo, whichever is wider
    maxMatchMs: 1500,
    camLostMs: 2000, // no clear view for this long: the camera is "lost" and the watch counts alone
    watchLostMs: 4000, // no line from the watch for this long: the watch is "lost" (it sends one every second)
    spo2Caution: 92, // clinical
    spo2Stop: 90, // clinical
    recoveryMargin: 15, // clinical: the next set waits until heart rate is this far under the ceiling
    persistMs: 6000, // a reading taken while moving must persist this long before it stops a set
    stillG: 0.12, // change in the wrist's acceleration between 1 s readings below this = still
    rateLimited: false, // takes a heart-rate-limiting medicine (e.g. a beta-blocker): watch fatigue more closely
    exercises: {}, // per exercise: { primary, offsetMs, windowMs, romScale, calibratedAt, reps }
  };
  // Which sensor's reps count, per exercise. The watch is on the wrist, so it measures arm
  // exercises directly; for leg and balance exercises the camera sees the moving joint.
  const WATCH_PRIMARY = new Set(['Bicep curl', 'Lateral arm raise', 'Wall push-up']);
  const defaultPrimary = (exercise) => (WATCH_PRIMARY.has(exercise) ? 'watch' : 'camera');
  const other = (src) => (src === 'watch' ? 'camera' : 'watch');

  const LIMITS = {
    matchMinMs: [200, 2000],
    matchTempoFrac: [0.1, 1],
    maxMatchMs: [400, 3000],
    camLostMs: [500, 10000],
    watchLostMs: [1500, 20000],
    spo2Caution: [85, 98],
    spo2Stop: [80, 95],
    recoveryMargin: [0, 40],
    persistMs: [0, 20000],
    stillG: [0.02, 1],
  };
  const EX_LIMITS = { offsetMs: [-2000, 2000], windowMs: [200, 3000], romScale: [0.1, 10], reps: [0, 100] };

  // Validates settings from a form or the network; throws Error with a readable message.
  // Unknown keys are dropped; missing keys fall back to the defaults when used.
  function sanitize(input) {
    if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object');
    const out = {};
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      if (input[k] == null || input[k] === '') continue;
      const n = Number(input[k]);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be a number from ${lo} to ${hi}`);
      out[k] = n;
    }
    if (input.policy != null) {
      if (!['primary', 'confirmed'].includes(input.policy)) throw new Error('policy must be primary or confirmed');
      out.policy = input.policy;
    }
    if (input.rateLimited != null) out.rateLimited = input.rateLimited === true || input.rateLimited === 1 || input.rateLimited === '1' || input.rateLimited === 'on';
    if ((out.spo2Stop ?? DEFAULTS.spo2Stop) > (out.spo2Caution ?? DEFAULTS.spo2Caution)) throw new Error('The SpO2 stop level must not be above the caution level');
    if (input.exercises != null) {
      if (typeof input.exercises !== 'object' || Array.isArray(input.exercises)) throw new Error('exercises must be an object');
      const names = Object.keys(input.exercises);
      if (names.length > 20) throw new Error('Too many exercises');
      out.exercises = {};
      for (const name of names) {
        if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new Error('Bad exercise name');
        const e = input.exercises[name] || {};
        const o = {};
        if (e.primary != null) {
          if (!['watch', 'camera'].includes(e.primary)) throw new Error('primary must be watch or camera');
          o.primary = e.primary;
        }
        for (const [k, [lo, hi]] of Object.entries(EX_LIMITS)) {
          if (e[k] == null || e[k] === '') continue;
          const n = Number(e[k]);
          if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name}: ${k} must be a number from ${lo} to ${hi}`);
          o[k] = n;
        }
        if (e.calibratedAt != null) {
          if (typeof e.calibratedAt !== 'string' || Number.isNaN(Date.parse(e.calibratedAt))) throw new Error('calibratedAt must be a date');
          o.calibratedAt = e.calibratedAt;
        }
        if (Object.keys(o).length) out.exercises[name] = o;
      }
    }
    return out;
  }

  // Saved settings (possibly partial or null) over the defaults.
  function settings(saved) {
    const s = saved || {};
    return { ...DEFAULTS, ...s, exercises: { ...(s.exercises || {}) } };
  }

  // What the matcher uses for one exercise: calibrated values where there are some.
  function exerciseSettings(cfg, exercise, tempoMs) {
    const e = (cfg.exercises && cfg.exercises[exercise]) || {};
    const auto = Math.min(cfg.maxMatchMs, Math.max(cfg.matchMinMs, cfg.matchTempoFrac * (tempoMs || 2000)));
    return {
      primary: e.primary || defaultPrimary(exercise),
      offsetMs: e.offsetMs || 0, // the camera's rep events land this long after the watch's
      windowMs: e.windowMs || Math.round(auto),
      romScale: e.romScale || null, // camera range / watch range, for the record
      calibrated: !!e.calibratedAt,
    };
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const round = (v) => (v == null ? null : Math.round(v));

  // ---------- motion: rep matching, failover, what counts ----------
  // Rep events carry the browser's receive time. Watch events are shifted by the calibrated
  // offset onto the camera's timeline, then two events from different sensors within the
  // window are the same rep. The primary sensor's reps count as they arrive (no delay for
  // the person exercising); the other sensor confirms them afterwards. A sensor that is
  // "lost" (camera cannot see the person, watch silent) hands counting to the other one,
  // so the count never silently stops.
  class RepFusion {
    constructor(exercise, { cfg, tempoMs } = {}) {
      this.cfg = settings(cfg);
      const ex = exerciseSettings(this.cfg, exercise, tempoMs);
      this.exercise = exercise;
      this.primary = ex.primary;
      this.secondary = other(ex.primary);
      this.offsetMs = ex.offsetMs;
      this.windowMs = ex.windowMs;
      this.calibrated = ex.calibrated;
      this.policy = this.cfg.policy;
      this.health = { watch: true, camera: true };
      this.pending = []; // events still waiting for a partner
      this.count = 0;
      this.partials = 0;
      this.raw = { watch: [], camera: [] }; // every rep event, for calibration
      this.stats = { confirmed: 0, unconfirmed: 0, possible: 0, failover: 0, rejected: 0, romWatch: [], romCamera: [], offsets: [] };
    }

    setHealth(h) {
      if (h.watch != null) this.health.watch = !!h.watch;
      if (h.camera != null) this.health.camera = !!h.camera;
    }

    // Who is counting right now: 'both', the one sensor that can, or 'none'.
    mode() {
      const { watch, camera } = this.health;
      return watch && camera ? 'both' : watch ? 'watch' : camera ? 'camera' : 'none';
    }

    _emit(src, rep, kind) {
      this.count++;
      return { type: 'rep', count: this.count, tempo: rep.tempo ?? null, rom: rep.rom, quality: rep.quality, kind, src };
    }

    // src: 'watch' | 'camera'; rep: {tempo, rom, quality} or {partial: true, rom}; t in ms.
    // Returns the events the session should act on (each like a REP or PART line).
    add(src, rep, t) {
      const out = [];
      if (rep.partial) {
        // A shallow movement is only reported by the sensor that is counting.
        const counting = this.health[this.primary] ? this.primary : this.secondary;
        if (src === counting) {
          this.partials++;
          out.push({ type: 'partial', rom: rep.rom, src });
        }
        return out;
      }
      this.raw[src].push({ t, rom: rep.rom, tempo: rep.tempo ?? null });
      const at = src === 'watch' ? t + this.offsetMs : t;
      const k = this.pending.findIndex((e) => e.src !== src && Math.abs(e.at - at) <= this.windowMs);
      if (k >= 0) {
        const e = this.pending.splice(k, 1)[0];
        const w = src === 'watch' ? rep : e.rep;
        const c = src === 'camera' ? rep : e.rep;
        this.stats.confirmed++;
        this.stats.romWatch.push(w.rom);
        this.stats.romCamera.push(c.rom);
        this.stats.offsets.push((src === 'camera' ? t : e.t) - (src === 'watch' ? t : e.t));
        if (!e.counted) {
          // Waiting for confirmation (the "confirmed" policy, or the secondary came first):
          // count it now, with the watch's tempo (it samples faster) and the primary's range.
          const p = src === this.primary ? rep : e.rep;
          out.push(this._emit(this.primary, { tempo: w.tempo ?? c.tempo, rom: p.rom, quality: round(mean([w.quality, c.quality].filter((q) => q != null))) }, 'confirmed'));
        } else if (e.counted) {
          out.push({ type: 'confirm', count: e.count, src });
        }
        return out;
      }
      const otherOk = this.health[other(src)];
      const entry = { src, t, at, rep, counted: false, count: null, otherOk };
      if (src === this.primary) {
        if (this.policy === 'primary' || !otherOk) {
          const ev = this._emit(src, rep, otherOk ? 'primary' : 'failover');
          entry.counted = true;
          entry.count = ev.count;
          out.push(ev);
        }
      } else if (!this.health[this.primary]) {
        // The primary sensor is lost: the secondary counts until it is back.
        const ev = this._emit(src, rep, 'failover');
        entry.counted = true;
        entry.count = ev.count;
        out.push(ev);
      }
      this.pending.push(entry);
      return out;
    }

    // Call regularly (a few times a second). Settles events whose partner never came.
    tick(t) {
      const out = [];
      const wait = this.windowMs + Math.abs(this.offsetMs) + 100;
      this.pending = this.pending.filter((e) => {
        if (t - e.t < wait) return true;
        if (e.counted) {
          if (e.src === this.primary && e.otherOk) {
            this.stats.unconfirmed++;
            out.push({ type: 'unconfirmed', count: e.count, src: e.src });
          } else this.stats.failover++;
        } else if (e.src === this.primary) {
          this.stats.rejected++; // "confirmed" policy: the other sensor did not see it
          out.push({ type: 'rejected', src: e.src });
        } else {
          this.stats.possible++; // only the secondary saw it: logged, not counted
          out.push({ type: 'possible', src: e.src });
        }
        return false;
      });
      return out;
    }

    // Settle everything still pending (end of the set) and summarise it for the record.
    finish(t = Infinity) {
      this.tick(t);
      const s = this.stats;
      const judged = s.confirmed + s.unconfirmed + s.possible + s.rejected;
      return {
        primary: this.primary,
        policy: this.policy,
        calibrated: this.calibrated,
        confirmed: s.confirmed,
        unconfirmed: s.unconfirmed,
        possible: s.possible,
        rejected: s.rejected,
        failover: s.failover,
        agreement: judged ? Math.round((100 * s.confirmed) / judged) : null,
        rom_watch: round(mean(s.romWatch)),
        rom_camera: round(mean(s.romCamera)),
        offset_ms: round(median(s.offsets)),
      };
    }
  }

  // ---------- calibration ----------
  // From the rep events of a short calibration set (both sensors running, the person doing
  // about 6 good reps): how far apart the two sensors' events land, how tight that is, the
  // ratio of their ranges, and which sensor saw more of the reps.
  function calibrate(raw, { exercise, tempoMs = 2000, cfg } = {}) {
    const c = settings(cfg);
    const W = raw.watch || [], C = raw.camera || [];
    const res = { exercise, watchReps: W.length, cameraReps: C.length, pairs: 0, ok: false };
    if (W.length < 3 || C.length < 3) {
      res.message = W.length < 3 && C.length < 3 ? 'Neither sensor saw enough reps. Do at least 5 clear reps.' : W.length < 3 ? 'The watch saw too few reps. Check it is on the moving arm and connected.' : 'The camera saw too few reps. Make sure it can see the whole movement.';
      return res;
    }
    // 1. Rough offset: the median gap from each watch rep to its nearest camera rep.
    const near = W.map((w) => C.reduce((b, x) => (Math.abs(x.t - w.t) < Math.abs(b) ? x.t - w.t : b), Infinity)).filter((d) => Math.abs(d) <= c.maxMatchMs);
    const rough = median(near);
    if (rough == null) {
      res.message = 'The two sensors never agreed on a rep. Check the watch is on the moving arm and the camera can see you.';
      return res;
    }
    // 2. Pair each watch rep with one camera rep around that offset (each used once).
    const used = new Set();
    const pairs = [];
    const win = Math.max(c.matchMinMs, 0.5 * tempoMs);
    for (const w of W) {
      let best = -1;
      for (let i = 0; i < C.length; i++) {
        if (used.has(i)) continue;
        const d = Math.abs(C[i].t - w.t - rough);
        if (d <= win && (best < 0 || d < Math.abs(C[best].t - w.t - rough))) best = i;
      }
      if (best >= 0) {
        used.add(best);
        pairs.push({ w, c: C[best], d: C[best].t - w.t });
      }
    }
    res.pairs = pairs.length;
    if (pairs.length < 3) {
      res.message = 'Too few reps lined up between the sensors. Try again with slow, full reps.';
      return res;
    }
    const offset = median(pairs.map((p) => p.d));
    const mad = median(pairs.map((p) => Math.abs(p.d - offset)));
    res.offsetMs = Math.round(offset);
    res.spreadMs = Math.round(1.4826 * mad);
    // Wide enough for 3 standard deviations of the spread, plus room for rounding.
    res.windowMs = Math.round(Math.min(c.maxMatchMs, Math.max(400, 3 * 1.4826 * mad + 250)));
    const ratios = pairs.filter((p) => p.w.rom > 0 && p.c.rom > 0).map((p) => p.c.rom / p.w.rom);
    res.romScale = ratios.length ? Math.round(median(ratios) * 100) / 100 : null;
    res.agreement = Math.round((100 * pairs.length) / Math.max(W.length, C.length));
    // The sensor that missed fewer of the reps the other one saw is the better counter for
    // this person; on a tie, keep the default for the exercise.
    const missW = C.length - pairs.length, missC = W.length - pairs.length;
    res.suggestedPrimary = missW < missC ? 'watch' : missC < missW ? 'camera' : defaultPrimary(exercise);
    res.ok = res.agreement >= 60 && pairs.length >= 4;
    res.message = res.ok
      ? `The sensors agreed on ${pairs.length} reps. The camera's reps land ${Math.abs(res.offsetMs)} ms ${res.offsetMs >= 0 ? 'after' : 'before'} the watch's.`
      : `Only ${res.agreement}% of reps matched. Check the camera view and that the watch is snug, then try again.`;
    return res;
  }

  // The settings to save after a calibration the user accepted.
  function applyCalibration(saved, result, now = new Date()) {
    const s = { ...(saved || {}), exercises: { ...((saved && saved.exercises) || {}) } };
    s.exercises[result.exercise] = {
      ...(s.exercises[result.exercise] || {}),
      primary: result.suggestedPrimary,
      offsetMs: result.offsetMs,
      windowMs: result.windowMs,
      ...(result.romScale ? { romScale: result.romScale } : {}),
      reps: result.pairs,
      calibratedAt: now.toISOString(),
    };
    return s;
  }

  // ---------- bio: heart rate and blood oxygen, read with movement in mind ----------
  // The wrist's pulse sensor reads poorly while the arm moves, so a reading taken while
  // moving only stops a set if it persists; one taken while still acts at once.
  class BioMonitor {
    constructor(cfg, hrMax) {
      this.cfg = settings(cfg);
      this.hrMax = hrMax || null;
      this.lastMoveAt = -Infinity;
      this.lastAcc = null;
      this.hrNow = null;
      this.spo2Now = null;
      this.spo2Min = null;
      this.hrSince = null; // first time the current high heart rate was seen
      this.spo2Since = null;
      this.finger = null;
      this.noContactSince = null;
    }

    // The watch's 1 s accelerometer reading (g).
    accel(ax, ay, az, t) {
      if ([ax, ay, az].some((v) => !Number.isFinite(v))) return;
      if (this.lastAcc) {
        const d = Math.hypot(ax - this.lastAcc[0], ay - this.lastAcc[1], az - this.lastAcc[2]);
        if (d > this.cfg.stillG) this.lastMoveAt = t;
      }
      this.lastAcc = [ax, ay, az];
    }

    // Any rep or shallow movement from either sensor.
    moved(t) {
      this.lastMoveAt = t;
    }

    still(t) {
      return t - this.lastMoveAt > 1500;
    }

    contact(finger, t) {
      this.finger = !!finger;
      if (this.finger) this.noContactSince = null;
      else if (this.noContactSince == null) this.noContactSince = t;
    }

    hr(bpm, t) {
      this.hrNow = bpm || null;
      if (this.hrNow && this.hrMax && this.hrNow > this.hrMax) {
        if (this.hrSince == null) this.hrSince = t;
        this.hrStill = this.still(t);
      } else if (!this.hrNow || !this.hrMax || this.hrNow <= this.hrMax - 5) this.hrSince = null;
    }

    spo2(v, t) {
      this.spo2Now = v || null;
      if (this.spo2Now) this.spo2Min = this.spo2Min == null ? this.spo2Now : Math.min(this.spo2Min, this.spo2Now);
      if (this.spo2Now && this.spo2Now < this.cfg.spo2Stop) {
        if (this.spo2Since == null) this.spo2Since = t;
        this.spo2Still = this.still(t);
      } else this.spo2Since = null;
    }

    // Reasons for caution or stopping, right now.
    reasons(t, { during = true } = {}) {
      const r = [];
      const c = this.cfg;
      if (this.hrSince != null) {
        const sure = this.hrStill || t - this.hrSince >= c.persistMs;
        r.push(sure ? { level: 'stop', code: 'hr', text: 'Your heart rate is high. Stop and rest until it settles.' } : { level: 'caution', code: 'hr-check', text: 'Heart rate reads high. Slow down while it is checked.' });
      }
      if (this.spo2Since != null) {
        const sure = this.spo2Still || t - this.spo2Since >= c.persistMs;
        r.push(sure ? { level: 'stop', code: 'spo2', text: `Blood oxygen is ${this.spo2Now}%. Stop, sit down and breathe slowly.` } : { level: 'caution', code: 'spo2-check', text: 'Blood oxygen reads low. Slow down while it is checked.' });
      } else if (this.spo2Now && this.spo2Now < c.spo2Caution) {
        r.push({ level: 'caution', code: 'spo2-low', text: `Blood oxygen is ${this.spo2Now}%. Take it easy.` });
      }
      if (during && this.noContactSince != null && t - this.noContactSince > 5000) {
        r.push({ level: 'caution', code: 'contact', text: 'The watch cannot read your pulse. Make sure it is snug on your wrist.' });
      }
      return r;
    }

    // Before the next set: has heart rate come back down far enough?
    recovery() {
      if (!this.hrNow || !this.hrMax) return { ready: true, known: false };
      const under = this.hrMax - this.cfg.recoveryMargin;
      return { ready: this.hrNow <= under, known: true, hr: this.hrNow, under };
    }
  }

  // ---------- fatigue: the movement fading across a set ----------
  // reps: [{rom, tempo, quality}] in order. Compares the first three with the last three.
  function fatigue(reps, cfg) {
    const c = settings(cfg);
    if (reps.length < 6) return null;
    const first = reps.slice(0, 3), last = reps.slice(-3);
    const m = (xs, k) => mean(xs.map((x) => x[k]).filter((v) => v != null && Number.isFinite(v)));
    const romDrop = m(first, 'rom') ? 1 - m(last, 'rom') / m(first, 'rom') : 0;
    const qDrop = m(first, 'quality') != null && m(last, 'quality') != null ? m(first, 'quality') - m(last, 'quality') : 0;
    const slow = m(first, 'tempo') && m(last, 'tempo') ? m(last, 'tempo') / m(first, 'tempo') - 1 : 0;
    // A heart-rate-limiting medicine hides effort in the heart rate, so fading movement is
    // the earlier warning: lower thresholds.
    const [romT, qT, slowT] = c.rateLimited ? [0.15, 10, 0.3] : [0.2, 15, 0.4];
    if (romDrop >= romT || qDrop >= qT || slow >= slowT) {
      return { level: 'caution', code: 'fatigue', text: 'Your movement is getting smaller. Finish this rep and rest.', romDrop: Math.round(romDrop * 100), qualityDrop: Math.round(qDrop), slower: Math.round(slow * 100) };
    }
    return null;
  }

  // ---------- one safety level from everything ----------
  // Stop outranks caution outranks ok; every level carries its reasons, most serious first.
  function assess({ bio = [], formFaults = [], fatigue: tired = null, overDose = false, sensors = null } = {}) {
    const reasons = [...bio];
    if (overDose) reasons.push({ level: 'stop', code: 'overdose', text: 'You are well past your dose. Please stop this set now.' });
    if (tired) reasons.push(tired);
    for (const f of formFaults) reasons.push({ level: 'caution', code: `form:${f.id}`, text: f.cue });
    if (sensors === 'none') reasons.push({ level: 'caution', code: 'sensors', text: 'Neither the watch nor the camera can follow you. Count by hand or step back into view.' });
    const rank = { stop: 2, caution: 1 };
    reasons.sort((a, b) => rank[b.level] - rank[a.level]);
    return { level: reasons.length ? reasons[0].level : 'ok', reasons };
  }

  return { DEFAULTS, WATCH_PRIMARY, defaultPrimary, sanitize, settings, exerciseSettings, RepFusion, calibrate, applyCalibration, BioMonitor, fatigue, assess };
});
