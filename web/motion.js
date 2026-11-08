'use strict';
// Motion features, the exercise classifier's forward pass, and a camera rep counter.
// Shared by the browser (camera tracking) and Node (training and tests) so the model sees
// exactly the same features in both. Loads as window.DLMotion or module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DLMotion = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const RAD = 180 / Math.PI;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]) || 1e-9;
  const unit = (a) => {
    const l = len(a);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * RAD;
  const asinDeg = (x) => Math.asin(Math.max(-1, Math.min(1, x))) * RAD;

  // MediaPipe Pose landmark indices for the points the features use.
  const MP = { shL: 11, shR: 12, elL: 13, elR: 14, haL: 15, haR: 16, hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, toL: 31, toR: 32 };
  const POINTS = Object.keys(MP);

  // MediaPipe world landmarks are metres with y pointing down; flip to y up.
  // Note MediaPipe's "left" is the person's left, the same convention as poses.js.
  function pointsFromLandmarks(world) {
    const P = {};
    for (const k of POINTS) {
      const w = world[MP[k]];
      P[k] = [w.x, -w.y, w.z];
    }
    return P;
  }
  const pointsFromJoints = (J) => Object.fromEntries(POINTS.map((k) => [k, J[k]]));
  // MediaPipe's 2D landmarks (0..1 of the picture) in pixels, y pointing down.
  function pointsFromImage(img, width, height) {
    const P = {};
    for (const k of POINTS) P[k] = [img[MP[k]].x * width, img[MP[k]].y * height];
    return P;
  }
  // Without a picture (synthetic training data), project the 3D points straight onto the
  // camera's image plane: x stays, y flips to point down.
  const project = (P) => Object.fromEntries(POINTS.map((k) => [k, [P[k][0], -P[k][1]]]));

  // Per-frame channels. Paired channels are [left, right].
  const CHANNELS = ['kneeL', 'kneeR', 'hipFlexL', 'hipFlexR', 'elbowL', 'elbowR', 'shElevL', 'shElevR', 'armSideL', 'armSideR', 'legSideL', 'legSideR', 'lean', 'heel', 'heel2d'];
  const PAIRS = [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]];
  const UP = [0, 1, 0];

  // P: 3D points (metres, y up). P2: the same points in the picture (pixels, y down), which
  // show a heel raise far better: MediaPipe centres its 3D points on the hips, so the body
  // rising a few centimetres barely registers there, while in the picture the ankles
  // visibly lift away from the toes.
  function frameAngles(P, P2 = project(P)) {
    const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const leg2d = (d2(P2.hipL, P2.anL) + d2(P2.hipR, P2.anR)) / 2 || 1e-9;
    const heel2d = ((P2.toL[1] - P2.anL[1] + (P2.toR[1] - P2.anR[1])) / 2 / leg2d) * 100;
    const shM = mid(P.shL, P.shR), hipM = mid(P.hipL, P.hipR);
    const torsoUp = sub(shM, hipM), torsoDown = sub(hipM, shM);
    const outShL = unit(sub(P.shL, P.shR)), outShR = [-outShL[0], -outShL[1], -outShL[2]];
    const outHipL = unit(sub(P.hipL, P.hipR)), outHipR = [-outHipL[0], -outHipL[1], -outHipL[2]];
    const legLen = (len(sub(P.knL, P.hipL)) + len(sub(P.anL, P.knL)) + len(sub(P.knR, P.hipR)) + len(sub(P.anR, P.knR))) / 2;
    const heel = ((dot(sub(P.anL, P.toL), UP) + dot(sub(P.anR, P.toR), UP)) / 2 / legLen) * 100;
    return [
      angle(sub(P.hipL, P.knL), sub(P.anL, P.knL)),
      angle(sub(P.hipR, P.knR), sub(P.anR, P.knR)),
      angle(torsoUp, sub(P.knL, P.hipL)),
      angle(torsoUp, sub(P.knR, P.hipR)),
      angle(sub(P.shL, P.elL), sub(P.haL, P.elL)),
      angle(sub(P.shR, P.elR), sub(P.haR, P.elR)),
      angle(torsoDown, sub(P.elL, P.shL)),
      angle(torsoDown, sub(P.elR, P.shR)),
      asinDeg(dot(unit(sub(P.elL, P.shL)), outShL)),
      asinDeg(dot(unit(sub(P.elR, P.shR)), outShR)),
      asinDeg(dot(unit(sub(P.knL, P.hipL)), outHipL)),
      asinDeg(dot(unit(sub(P.knR, P.hipR)), outHipR)),
      angle(torsoUp, UP),
      heel,
      heel2d,
    ];
  }

  // A window of frames -> one feature vector. For each channel: mean, min, max, movement
  // per second, and "deliberateness": how far the smoothed angle travels compared with the
  // frame-to-frame jitter around it (log scale). A real rep is a large smooth change;
  // standing still is small random wobble, even when the wobble is as big as a heel raise.
  // Left/right pairs are ordered by which side moved more, so an exercise done with either
  // leg or arm looks the same to the model.
  const STATS = ['mean', 'min', 'max', 'speed', 'deliberate'];
  function windowFeatures(frames, times) {
    const n = frames.length, C = CHANNELS.length;
    const dur = Math.max(0.2, (times[n - 1] - times[0]) / 1000);
    const st = [];
    // Movement is measured on a 3-frame moving average, so landmark jitter does not read as motion.
    const sm = (i, c) => (frames[Math.max(0, i - 1)][c] + frames[i][c] + frames[Math.min(n - 1, i + 1)][c]) / 3;
    // A wider, time-based average (±0.25 s) separates the movement from the jitter.
    const wide = (i, c) => {
      let s = 0, k = 0;
      for (let j = i; j >= 0 && times[i] - times[j] <= 250; j--) (s += frames[j][c]), k++;
      for (let j = i + 1; j < n && times[j] - times[i] <= 250; j++) (s += frames[j][c]), k++;
      return s / k;
    };
    for (let c = 0; c < C; c++) {
      let sum = 0, lo = Infinity, hi = -Infinity, travel = 0, wlo = Infinity, whi = -Infinity, jitter = 0;
      for (let i = 0; i < n; i++) {
        const v = frames[i][c];
        sum += v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        if (i) travel += Math.abs(sm(i, c) - sm(i - 1, c));
        const w = wide(i, c);
        if (w < wlo) wlo = w;
        if (w > whi) whi = w;
        jitter += (v - w) ** 2;
      }
      const deliberate = Math.log1p((whi - wlo) / (Math.sqrt(jitter / n) + 0.3));
      st.push([sum / n, lo, hi, travel / dur, deliberate]);
    }
    for (const [l, r] of PAIRS) if (st[r][2] - st[r][1] > st[l][2] - st[l][1]) [st[l], st[r]] = [st[r], st[l]];
    return st.flat();
  }

  // ---------- classifier (one hidden layer, ReLU, softmax) ----------
  function predict(model, x) {
    const z = x.map((v, i) => (v - model.mean[i]) / model.std[i]);
    const h = model.W1.map((row, j) => Math.max(0, row.reduce((a, w, i) => a + w * z[i], model.b1[j])));
    const o = model.W2.map((row, k) => row.reduce((a, w, j) => a + w * h[j], model.b2[k]));
    const m = Math.max(...o);
    const e = o.map((v) => Math.exp(v - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / s);
  }

  // ---------- camera rep counting ----------
  // Which joint angle tracks each exercise, its prescribed range in degrees (heel raise is
  // % of leg length) and tempo. Walking and cycling are timed, not counted.
  const SIGNALS = {
    'Sit-to-stand': { ch: [2, 3], target: 70, tempo: 2500 },
    'Seated knee extension': { ch: [0, 1], target: 45, tempo: 2000 },
    'Bicep curl': { ch: [4, 5], target: 100, tempo: 2000 },
    'Lateral arm raise': { ch: [6, 7], target: 65, tempo: 2000 },
    'Standing hip abduction': { ch: [10, 11], target: 30, tempo: 2000 },
    'Heel raise': { ch: [14], target: 5, tempo: 1500, missesSome: true }, // counts about 2 in 3 in testing // measured in the picture: ankle lift, % of leg length
    'Wall push-up': { ch: [4, 5], target: 38, tempo: 2500 },
    Stretching: { ch: [6, 7], target: 110, tempo: 3000 },
  };

  // Counts reps from a joint angle. Unlike the wearable, a camera rarely gets a clean
  // still start, so the counter learns the movement's range from the last 8 seconds
  // (5th to 95th percentile) rather than fixing a rest position up front. Each angle is
  // placed on that range (0 = rest end, 1 = far end): a rep leaves past 40%, returns
  // below 20%, and counts if it reached 60% of the recent range and at least half the
  // prescribed range in degrees. Smaller excursions are reported as partial reps.
  const WINDOW_MS = 8000;
  class RepCounter {
    constructor(exercise, opts = {}) {
      const sig = SIGNALS[exercise];
      this.sig = sig || null;
      this.target = opts.target || (sig && sig.target) || 60;
      this.tempo = opts.tempo || (sig && sig.tempo) || 2000;
      this.reset();
    }
    reset() {
      this.buf = [];
      this.smooth = null;
      this.out = false;
      this.peak = 0;
      this.restAt = null;
      this.restLow = null; // which end of the range is rest, decided once per bout of movement
      this.count = 0;
      this.partials = 0;
    }
    // frame: channel values from frameAngles(); returns null or {type: 'rep'|'partial', ...}.
    update(frame, tMs) {
      if (!this.sig) return null;
      const vals = this.sig.ch.map((c) => frame[c]);
      this.smooth = this.smooth ? this.smooth.map((s, i) => s + 0.35 * (vals[i] - s)) : vals.slice();
      this.buf.push([tMs, ...this.smooth]);
      while (tMs - this.buf[0][0] > WINDOW_MS) this.buf.shift();
      if (this.restAt === null) this.restAt = tMs;
      if (this.buf.length < 6) return null;

      // Follow whichever side (left or right) is doing the moving.
      let best = null;
      for (let i = 0; i < vals.length; i++) {
        const xs = this.buf.map((b) => b[i + 1]).sort((a, b) => a - b);
        const lo = xs[Math.floor(xs.length * 0.05)], hi = xs[Math.ceil(xs.length * 0.95) - 1], med = xs[xs.length >> 1];
        if (!best || hi - lo > best.hi - best.lo) best = { i, lo, hi, med };
      }
      const range = best.hi - best.lo, R = this.target;
      if (range < 0.25 * R) {
        this.out = false; // barely moving: nothing to count
        this.restAt = tMs;
        this.restLow = null;
        return null;
      }
      // Rest is the end the person lingers at: compare the time spent in the bottom and top
      // quarter of the range. Once chosen it only changes if the other end clearly wins
      // (1.5x the time), and never mid-rep; flipping freely counts half-reps.
      const ys = this.buf.map((b) => b[best.i + 1]);
      const low = ys.filter((v) => v < best.lo + 0.25 * range).length, high = ys.filter((v) => v > best.hi - 0.25 * range).length;
      if (this.restLow === null) this.restLow = low >= high;
      else if (!this.out && (this.restLow ? high > 1.5 * low : low > 1.5 * high)) this.restLow = !this.restLow;
      const restLow = this.restLow;
      const v = this.smooth[best.i];
      const s = (restLow ? v - best.lo : best.hi - v) / range;
      if (!this.out) {
        if (s > 0.4) {
          this.out = true;
          this.peak = s;
        } else this.restAt = tMs;
        return null;
      }
      if (s > this.peak) this.peak = s;
      if (s > 0.2) return null;
      this.out = false;
      const tempo = tMs - this.restAt;
      this.restAt = tMs;
      if (tempo < 400 || tempo > 10000) return null;
      const rom = Math.round(range * Math.min(1, this.peak));
      const r = tempo / this.tempo;
      const tempoScore = r < 0.7 ? Math.max(0, (r - 0.3) / 0.4) : r > 1.5 ? Math.max(0, (3 - r) / 1.5) : 1;
      if (this.peak < 0.6 || rom < 0.5 * R) {
        this.partials++;
        return { type: 'partial', rom };
      }
      this.count++;
      return { type: 'rep', count: this.count, tempo, rom, quality: Math.round(60 * Math.min(1, rom / R) + 40 * tempoScore) };
    }
  }

  // ---------- form checks ----------
  // Measurements that joint angles alone do not capture, from the same 3D points (metres, y up).
  //   kneeRatio: knee width / ankle width. Below ~0.75 the knees are caving in (valgus).
  //   sideLean: trunk tilt to the side, degrees (always positive).
  //   fwdLean: trunk tilt forward or back, degrees (always positive), not counting side tilt.
  //   bodyLine: shoulder-hip-ankle angle, degrees. 180 is a straight plank.
  function formMetrics(P) {
    const shM = mid(P.shL, P.shR), hipM = mid(P.hipL, P.hipR), anM = mid(P.anL, P.anR);
    const torso = unit(sub(shM, hipM));
    // The person's sideways direction, from the hips but flattened to the horizontal: only
    // its compass heading is used, so a noisy hip landmark barely changes the tilt measured.
    const hips = sub(P.hipL, P.hipR);
    const sideDir = unit([hips[0], 0, hips[2]]);
    const fwdDir = [-sideDir[2], 0, sideDir[0]];
    const vert = dot(torso, UP);
    return {
      kneeRatio: len(sub(P.knL, P.knR)) / len(sub(P.anL, P.anR)),
      sideLean: Math.atan2(Math.abs(dot(torso, sideDir)), vert) * RAD,
      fwdLean: Math.atan2(Math.abs(dot(torso, fwdDir)), vert) * RAD,
      bodyLine: angle(sub(shM, hipM), sub(anM, hipM)),
    };
  }

  // Per-exercise form rules. test(a, m) gets frameAngles() and formMetrics() for one frame and
  // is true while the fault is showing. joints are MediaPipe landmarks to highlight on screen.
  // Thresholds are deliberately loose: a cue should mean something is clearly off, and older
  // adults' normal movement (e.g. leaning forward to stand up) must not trigger one.
  const L = 0, R = 1;
  const side = (a, l, r) => (a[l] <= a[r] ? L : R); // the side bent further
  const FORM_RULES = {
    'Sit-to-stand': [
      { id: 'knees-in', cue: 'Push your knees out over your toes', joints: [25, 26], test: (a, m) => Math.min(a[0], a[1]) < 160 && m.kneeRatio < 0.75 },
      { id: 'lean', cue: 'Keep your chest up as you stand', joints: [11, 12, 23, 24], test: (a, m) => m.fwdLean > 60 },
    ],
    'Seated knee extension': [{ id: 'slouch', cue: 'Sit up tall against the chair', joints: [11, 12, 23, 24], test: (a, m) => m.fwdLean > 30 }],
    'Bicep curl': [
      {
        id: 'elbow-drift',
        cue: 'Keep your elbow at your side',
        joints: [13, 14],
        test: (a) => {
          const s = side(a, 4, 5);
          return a[4 + s] < 120 && a[6 + s] > 40;
        },
      },
      { id: 'swing', cue: 'Keep your body still. No swinging', joints: [11, 12, 23, 24], test: (a, m) => m.fwdLean > 15 },
    ],
    'Lateral arm raise': [
      { id: 'too-high', cue: 'Stop at shoulder height', joints: [13, 14, 15, 16], test: (a) => Math.max(a[6], a[7]) > 110 },
      { id: 'side-lean', cue: 'Stand tall. Don’t lean to the side', joints: [11, 12, 23, 24], test: (a, m) => m.sideLean > 12 },
    ],
    'Standing hip abduction': [
      { id: 'side-lean', cue: 'Keep your body upright and lift from the hip', joints: [11, 12, 23, 24], test: (a, m) => m.sideLean > 15 },
      { id: 'lean', cue: 'Stand tall. Don’t bend forward', joints: [11, 12, 23, 24], test: (a, m) => m.fwdLean > 20 },
    ],
    'Heel raise': [{ id: 'lean', cue: 'Stand tall and keep your weight over your toes', joints: [11, 12, 23, 24], test: (a, m) => m.fwdLean > 15 }],
    'Wall push-up': [{ id: 'body-line', cue: 'Keep your body straight from head to heels', joints: [23, 24], test: (a, m) => m.bodyLine < 145 }],
  };

  // Landmarks each kind of rule needs to see clearly, as alternatives: one side of the body is
  // enough for most rules, so a person turned partly away is still checked. Knees caving in
  // compares both knees, so it needs both legs. A rule is not judged without its landmarks.
  const TRUNK = [[11, 23], [12, 24]];
  const NEEDS = {
    'knees-in': [[23, 24, 25, 26, 27, 28]],
    'elbow-drift': [[11, 13, 15], [12, 14, 16]],
    'too-high': [[11, 13, 23], [12, 14, 24]],
    'body-line': [[11, 23, 27], [12, 24, 28]],
  };
  const needs = (r) => NEEDS[r.id] || TRUNK;

  // Turns frame-by-frame rule results into steady cues.
  //  - Evidence for a fault rises while frames show it and falls while they do not, at the
  //    same rate (holdMs to go from none to full), so it switches on only when most recent
  //    frames agree. One noisy frame neither starts a cue nor cuts one short.
  //  - Once on, it stays on until clearMs pass without the evidence being at least half
  //    way up. clearMs is longer than a rep, so a fault that comes back every rep reads as
  //    one steady cue rather than flashing on and off.
  //  - Frames where the rule's joints cannot be seen clearly are skipped, not judged.
  // counts[id] is how many separate times each fault happened, for the set's record.
  class FormChecker {
    constructor(exercise, { holdMs = 400, clearMs = 2500, minVisibility = 0.6 } = {}) {
      this.rules = FORM_RULES[exercise] || [];
      this.opts = { holdMs, clearMs, minVisibility };
      this.state = Object.fromEntries(this.rules.map((r) => [r.id, { on: false, evidence: 0, seenAt: -Infinity }]));
      this.counts = {};
      this.judged = 0; // frames where at least one rule could be judged
      this.lastT = null;
    }
    // landmarks (optional): MediaPipe's per-landmark visibility, to skip joints it cannot see.
    // Returns [{type: 'start'|'end', id, cue, joints}].
    update(angles, metrics, t, landmarks = null) {
      const o = this.opts, events = [];
      const dt = this.lastT === null ? 0 : Math.min(200, Math.max(0, t - this.lastT));
      this.lastT = t;
      let judged = false;
      for (const r of this.rules) {
        const s = this.state[r.id];
        const clear = (i) => landmarks[i] && landmarks[i].visibility >= o.minVisibility;
        const seen = !landmarks || needs(r).some((group) => group.every(clear));
        if (seen) {
          judged = true;
          const bad = !!r.test(angles, metrics);
          s.evidence = Math.max(0, Math.min(1, s.evidence + (bad ? dt : -dt) / o.holdMs));
        }
        if (!s.on && s.evidence >= 1) {
          s.on = true;
          s.seenAt = t;
          this.counts[r.id] = (this.counts[r.id] || 0) + 1;
          events.push({ type: 'start', id: r.id, cue: r.cue, joints: r.joints });
        } else if (s.on) {
          if (s.evidence >= 0.5) s.seenAt = t;
          else if (t - s.seenAt > o.clearMs) {
            s.on = false;
            events.push({ type: 'end', id: r.id, cue: r.cue, joints: r.joints });
          }
        }
      }
      if (judged) this.judged++;
      return events;
    }
    active() {
      return this.rules.filter((r) => this.state[r.id].on);
    }
  }

  // ---------- smoothing ----------
  // One Euro filter (Casiez et al., 2012): a low-pass filter whose cutoff rises with speed,
  // so jitter is removed while the person holds still or moves slowly, but real movement
  // is followed with little lag. Used for what is shown and judged (angle labels, the angle
  // table, form checks); the classifier and rep counter keep the raw angles they were
  // trained and tested on.
  class OneEuro {
    constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1 } = {}) {
      Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: null });
    }
    static alpha(cutoff, dt) {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }
    filter(v, tMs) {
      if (this.x === null || this.t === null || tMs - this.t > 500) {
        this.x = v; // first value, or after a gap: start again rather than glide from stale data
        this.dx = 0;
        this.t = tMs;
        return v;
      }
      const dt = Math.max(1e-3, (tMs - this.t) / 1000);
      this.t = tMs;
      const dx = (v - this.x) / dt;
      this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
      this.x += OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
      return this.x;
    }
  }

  // Smooths a frame's angles (degrees) and formMetrics() together.
  class Smoother {
    constructor() {
      this.angles = CHANNELS.map(() => new OneEuro({ minCutoff: 1.2, beta: 0.02 }));
      this.metrics = {};
    }
    update(angles, metrics, tMs) {
      const out = {};
      for (const [k, v] of Object.entries(metrics)) {
        // kneeRatio is a ratio near 1, not degrees: its speed is tiny, so beta must be larger.
        const f = (this.metrics[k] ||= new OneEuro(k === 'kneeRatio' ? { minCutoff: 1.2, beta: 2 } : { minCutoff: 1.2, beta: 0.02 }));
        out[k] = f.filter(v, tMs);
      }
      return { angles: angles.map((v, i) => this.angles[i].filter(v, tMs)), metrics: out };
    }
    reset() {
      for (const f of this.angles) f.x = null;
      for (const f of Object.values(this.metrics)) f.x = null;
    }
  }

  // ---------- automatic tracking ----------
  // Works out which exercise is being done and counts it, with nothing chosen up front.
  // Every half-second the classifier labels the last 3 seconds. An exercise is "confirmed"
  // after 3 agreeing labels in a row (about 1.5 s); the frames from just before that are
  // replayed into its rep counter, so the reps it took to recognise the movement still count.
  // 4 "Not exercising" labels in a row pause tracking. Timed exercises (walking, cycling)
  // accumulate seconds instead of reps. update() returns events for the interface.
  //
  // While one exercise changes to another, the 3-second window holds a mix of both and can
  // briefly look like a third. So a newly confirmed exercise is provisional for 5 seconds:
  // if a different one is confirmed in that time, the reps counted for the provisional one
  // are withdrawn (a "retract" event). Heel raises, which the classifier confuses with
  // standing still, need 6 agreeing labels at 75% confidence.
  const IDLE = 'Not exercising';
  const STRICT = { 'Heel raise': { confirm: 6, minProb: 0.75 } };
  class AutoTracker {
    constructor(model, { confirm = 3, minProb = 0.55, idleConfirm = 4, every = 500, replayMs = 3500, provisionalMs = 5000 } = {}) {
      this.model = model;
      this.opts = { confirm, minProb, idleConfirm, every, replayMs, provisionalMs };
      this.switchAt = -Infinity;
      this.sinceSwitch = null; // what was added to the current tally since it was confirmed
      this.frames = []; // [angles, t] for the last few seconds
      this.history = []; // recent {label, prob}
      this.current = null;
      this.counter = null;
      this.lastPredAt = -Infinity;
      this.lastT = null;
      this.pred = null;
      this.tallies = {}; // exercise -> {reps, partials, seconds, quality: [], tempo: [], rom: []}
    }
    tally(name) {
      return (this.tallies[name] ||= { reps: 0, partials: 0, seconds: 0, quality: [], tempo: [], rom: [] });
    }
    count(name, ev, events) {
      const tl = this.tally(name);
      if (ev.type === 'rep') {
        tl.reps++;
        tl.quality.push(ev.quality);
        tl.tempo.push(ev.tempo);
        tl.rom.push(ev.rom);
        if (this.sinceSwitch) this.sinceSwitch.reps++;
        events.push({ type: 'rep', exercise: name, reps: tl.reps, quality: ev.quality, tempo: ev.tempo, rom: ev.rom });
      } else {
        tl.partials++;
        if (this.sinceSwitch) this.sinceSwitch.partials++;
        events.push({ type: 'partial', exercise: name, rom: ev.rom });
      }
    }
    // Undo what a provisional exercise counted, and forget it if that was all it had.
    retract(events) {
      const name = this.current, s = this.sinceSwitch, tl = this.tallies[name];
      if (!tl || !s) return;
      tl.reps -= s.reps;
      tl.partials -= s.partials;
      tl.seconds = Math.max(0, tl.seconds - s.seconds);
      for (const k of ['quality', 'tempo', 'rom']) tl[k].length -= Math.min(tl[k].length, s.reps);
      if (s.isNew) delete this.tallies[name];
      events.push({ type: 'retract', exercise: name, reps: s.reps });
    }
    // angles: frameAngles() of a frame where the whole body is visible.
    update(angles, t) {
      const o = this.opts, events = [];
      const dt = this.lastT === null ? 0 : Math.min(1000, t - this.lastT);
      this.lastT = t;
      this.frames.push([angles, t]);
      while (t - this.frames[0][1] > Math.max(3000, o.replayMs)) this.frames.shift();

      if (this.current) {
        if (this.counter) {
          const ev = this.counter.update(angles, t);
          if (ev) this.count(this.current, ev, events);
        } else if (this.pred && this.pred.label === this.current) {
          this.tally(this.current).seconds += dt / 1000; // timed exercise, only while it is seen
          if (this.sinceSwitch) this.sinceSwitch.seconds += dt / 1000;
        }
      }

      if (t - this.lastPredAt >= o.every) {
        const win = this.frames.filter(([, ft]) => t - ft <= 3000);
        if (win.length >= 6 && t - win[0][1] >= 1500) {
          this.lastPredAt = t;
          // Average the last three predictions (1.5 s) so one odd window does not flip the label.
          this.probs = [...(this.probs || []).slice(-2), predict(this.model, windowFeatures(win.map((f) => f[0]), win.map((f) => f[1])))];
          const p = this.probs[0].map((_, j) => this.probs.reduce((acc, q) => acc + q[j], 0) / this.probs.length);
          const k = p.indexOf(Math.max(...p));
          this.pred = { label: this.model.classes[k], prob: p[k] };
          this.history.push(this.pred);
          if (this.history.length > 8) this.history.shift();
          events.push({ type: 'prediction', ...this.pred });
          this.decide(t, events);
        }
      }
      return events;
    }
    decide(t, events) {
      const o = this.opts, h = this.history;
      const agree = (n, test) => h.length >= n && h.slice(-n).every(test);
      const label = this.pred.label;
      if (label === IDLE) {
        if (this.current && agree(o.idleConfirm, (x) => x.label === IDLE)) {
          events.push({ type: 'pause', exercise: this.current });
          this.current = null;
          this.counter = null;
        }
        return;
      }
      if (label === this.current) return;
      const need = STRICT[label] || { confirm: o.confirm, minProb: o.minProb };
      if (!agree(need.confirm, (x) => x.label === label && x.prob >= need.minProb)) return;
      if (this.current && t - this.switchAt < o.provisionalMs) this.retract(events);
      this.current = label;
      this.sinceSwitch = { reps: 0, partials: 0, seconds: 0, isNew: !this.tallies[label] };
      this.switchAt = t;
      this.tally(label);
      this.counter = SIGNALS[label] ? new RepCounter(label) : null;
      events.push({ type: 'switch', exercise: label, prob: this.pred.prob });
      const recent = this.frames.filter(([, ft]) => t - ft <= o.replayMs);
      if (this.counter) {
        for (const [a, ft] of recent) {
          const ev = this.counter.update(a, ft);
          if (ev) this.count(label, ev, events);
        }
      } else if (recent.length) {
        // A timed exercise was already under way while it was being recognised.
        const secs = (t - recent[0][1]) / 1000;
        this.tally(label).seconds += secs;
        this.sinceSwitch.seconds += secs;
      }
    }
  }

  return { CHANNELS, STATS, MP, POINTS, pointsFromLandmarks, pointsFromJoints, pointsFromImage, frameAngles, windowFeatures, predict, SIGNALS, RepCounter, AutoTracker, IDLE, formMetrics, FORM_RULES, FormChecker, OneEuro, Smoother };
});
