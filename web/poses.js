'use strict';
// Body kinematics for the ten prescribed exercises, shared by the 3D figure (browser)
// and the ML training script (Node), so the model learns from the same movements the
// figure demonstrates. Loads as window.DLPoses in the browser and module.exports in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DLPoses = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const DEG = Math.PI / 180;
  // Segment lengths in metres. joints() accepts a scaled copy to vary body proportions.
  const BODY = { T: 0.42, S: 0.42, ANKLE: 0.07, TORSO: 0.5, UPPER: 0.28, FORE: 0.26, HIPW: 0.1, SHW: 0.19 };
  const { T, S, ANKLE } = BODY;
  const STAND = T + S + ANKLE;

  // Each exercise maps p (0 = rest, 1 = peak of the movement) and time t (seconds) to a pose.
  // Angles are radians: a = thigh forward from vertical, b = shin forward from vertical,
  // ab = abduction out to the side, f = shoulder flexion forward, e = elbow bend.
  const leg = (a = 0, b = 0, ab = 0) => ({ a, b, ab });
  const arm = (f = 0, e = 0.25, ab = 0.1) => ({ f, e, ab });
  const standing = () => ({ pelvis: [0, STAND, 0], lean: 0, side: 0, heel: 0, legs: { L: leg(), R: leg() }, arms: { L: arm(), R: arm() }, stool: false });
  const seated = (z = -0.2) => ({ ...standing(), pelvis: [0, S + ANKLE, z], legs: { L: leg(90 * DEG), R: leg(90 * DEG) }, arms: { L: arm(25 * DEG, 0.6), R: arm(25 * DEG, 0.6) }, stool: true });

  const EXERCISES = {
    'Sit-to-stand': (p) => {
      const a = 90 * DEG * (1 - p);
      const P = seated();
      P.pelvis = [0, S + ANKLE + T * Math.cos(a), -0.2 + T * (1 - Math.sin(a))];
      P.lean = 32 * DEG * Math.sin(Math.PI * p);
      P.legs = { L: leg(a), R: leg(a) };
      P.arms = { L: arm(20 * DEG + P.lean, 0.5), R: arm(20 * DEG + P.lean, 0.5) };
      return P;
    },
    'Seated knee extension': (p) => {
      const P = seated();
      P.legs.R = leg(90 * DEG, 82 * DEG * p);
      return P;
    },
    'Bicep curl': (p) => {
      const P = standing();
      const e = (10 + 125 * p) * DEG;
      P.arms = { L: arm(0, e, 0.12), R: arm(0, e, 0.12) };
      return P;
    },
    'Lateral arm raise': (p) => {
      const P = standing();
      const ab = (8 + 80 * p) * DEG;
      P.arms = { L: arm(0, 0.12, ab), R: arm(0, 0.12, ab) };
      return P;
    },
    'Standing hip abduction': (p) => {
      const P = standing();
      P.legs.R = leg(0, 0, 32 * DEG * p);
      P.side = -4 * DEG * p;
      P.arms.L = arm(35 * DEG, 0.5, 0.35); // steadying on a rail
      return P;
    },
    'Heel raise': (p) => {
      const P = standing();
      P.heel = 0.085 * p;
      P.pelvis = [0, STAND + P.heel, 0];
      return P;
    },
    'Wall push-up': (p) => {
      const P = standing();
      P.lean = (9 + 13 * p) * DEG;
      P.pelvis = [0, STAND - 0.01, -0.12];
      const f = (72 - 22 * p) * DEG, e = (12 + 62 * p) * DEG;
      P.arms = { L: arm(f, e, 0.3 + 0.25 * p), R: arm(f, e, 0.3 + 0.25 * p) };
      return P;
    },
    'Treadmill walk': (_p, t) => {
      const P = standing();
      const s = Math.sin(t * 4.2), c = Math.cos(t * 4.2);
      P.pelvis = [0, STAND - 0.015 + 0.015 * Math.abs(c), 0];
      P.legs = { L: leg(26 * DEG * s, 26 * DEG * s - 34 * DEG * Math.max(0, -c)), R: leg(-26 * DEG * s, -26 * DEG * s - 34 * DEG * Math.max(0, c)) };
      P.arms = { L: arm(-24 * DEG * s, 0.5), R: arm(24 * DEG * s, 0.5) };
      P.lean = 4 * DEG;
      return P;
    },
    'Recumbent bike': (_p, t) => {
      const P = seated(-0.25);
      P.lean = -14 * DEG;
      const s = Math.sin(t * 4), c = Math.cos(t * 4);
      P.legs = { L: leg((66 + 18 * s) * DEG, (26 + 24 * c) * DEG), R: leg((66 - 18 * s) * DEG, (26 - 24 * c) * DEG) };
      P.arms = { L: arm(30 * DEG, 0.4), R: arm(30 * DEG, 0.4) };
      return P;
    },
    Stretching: (p, t) => {
      const P = standing();
      const up = (15 + 155 * p) * DEG;
      P.side = 12 * DEG * Math.sin(t * 0.9) * p;
      P.arms = { L: arm(up, 0.15, 0.2), R: arm(up, 0.15, 0.2) };
      return P;
    },
  };
  const CONTINUOUS = new Set(['Treadmill walk', 'Recumbent bike']);
  const idle = (_p, t) => {
    const P = standing();
    P.pelvis = [0, STAND + 0.004 * Math.sin(t * 1.6), 0];
    return P;
  };

  // Ways of not exercising, for teaching the model what "idle" looks like: standing or
  // sitting still, swaying, shifting weight, adjusting an arm, fidgeting in a chair.
  const IDLE_VARIANTS = {
    'standing still': idle,
    'standing, swaying': (_p, t) => {
      const P = standing();
      P.side = 3 * DEG * Math.sin(t * 0.7);
      P.lean = 2 * DEG * Math.sin(t * 0.45);
      return P;
    },
    'standing, shifting weight': (_p, t) => {
      const P = standing();
      const w = Math.sin(t * 0.5);
      P.side = 4 * DEG * w;
      P.legs.L = leg(0, 0, Math.max(0, w) * 5 * DEG);
      P.legs.R = leg(0, 0, Math.max(0, -w) * 5 * DEG);
      return P;
    },
    'standing, adjusting an arm': (_p, t) => {
      const P = standing();
      const k = 0.5 - 0.5 * Math.cos(t * 0.6);
      P.arms.R = arm(40 * DEG * k, 0.25 + 1.1 * k, 0.15);
      return P;
    },
    'standing, hands on hips': () => {
      const P = standing();
      P.arms = { L: arm(-10 * DEG, 1.6, 0.6), R: arm(-10 * DEG, 1.6, 0.6) };
      return P;
    },
    'sitting still': (_p, t) => {
      const P = seated();
      P.lean = (-4 + Math.sin(t * 0.4)) * DEG;
      return P;
    },
    'sitting, fidgeting': (_p, t) => {
      const P = seated();
      P.legs.L = leg(90 * DEG, 8 * DEG * Math.sin(t * 0.8));
      P.arms.R = arm((25 + 15 * Math.sin(t * 0.5)) * DEG, 0.6 + 0.3 * Math.sin(t * 0.7));
      return P;
    },
  };

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mulS = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

  // Forward kinematics: pose -> joint positions (y up, +z forward, +x to the figure's right).
  function joints(P, body = BODY) {
    const { T: t, S: s0, ANKLE: ank, TORSO, UPPER, FORE, HIPW, SHW } = body;
    const J = { pelvis: P.pelvis };
    const up = [Math.sin(P.side), Math.cos(P.lean) * Math.cos(P.side), Math.sin(P.lean)];
    J.chest = add(P.pelvis, mulS(up, TORSO));
    J.neck = add(J.chest, mulS(up, 0.1));
    J.head = add(J.chest, mulS(up, 0.25));
    for (const [k, s] of [['L', -1], ['R', 1]]) {
      const l = P.legs[k], r = P.arms[k];
      const hip = add(P.pelvis, [s * HIPW, 0, 0]);
      const kn = add(hip, mulS([s * Math.sin(l.ab), -Math.cos(l.ab) * Math.cos(l.a), Math.cos(l.ab) * Math.sin(l.a)], t));
      const an = add(kn, mulS([s * Math.sin(l.ab), -Math.cos(l.ab) * Math.cos(l.b), Math.cos(l.ab) * Math.sin(l.b)], s0));
      const lifted = an[1] > ank + 0.03 + P.heel; // a foot in the air hangs from the shin
      const to = lifted ? add(an, [0, -0.05, 0.16]) : [an[0], 0.035, an[2] + 0.17];
      const sh = add(J.chest, [s * SHW, -0.03, 0]);
      const el = add(sh, mulS([s * Math.sin(r.ab), -Math.cos(r.ab) * Math.cos(r.f), Math.cos(r.ab) * Math.sin(r.f)], UPPER));
      const ha = add(el, mulS([s * Math.sin(r.ab) * 0.6, -Math.cos(r.ab) * Math.cos(r.f + r.e), Math.cos(r.ab) * Math.sin(r.f + r.e)], FORE));
      Object.assign(J, { [`hip${k}`]: hip, [`kn${k}`]: kn, [`an${k}`]: an, [`to${k}`]: to, [`sh${k}`]: sh, [`el${k}`]: el, [`ha${k}`]: ha });
    }
    return J;
  }

  return { DEG, BODY, STAND, EXERCISES, CONTINUOUS, IDLE_VARIANTS, idle, standing, seated, leg, arm, joints, add, mulS, lerp3 };
});
