'use strict';
// A 3D figure that performs each exercise and shows where the sensor is worn.
// Plain WebGL with no library: the body is capsules and spheres posed by simple
// forward kinematics, lit in a small shader. DL.figure(canvas, options) returns a handle.
(() => {
  // Exercise kinematics live in poses.js, shared with the ML training script.
  const { DEG, BODY, EXERCISES, CONTINUOUS, idle, joints, add, mulS, lerp3 } = DLPoses;
  const { S, ANKLE } = BODY;

  // Where the wearable sits: [from joint, to joint, position along the bone, bone radius].
  const SENSOR = {
    thigh: ['hipR', 'knR', 0.5, 0.078],
    shin: ['knR', 'anR', 0.45, 0.062],
    ankle: ['knR', 'anR', 0.88, 0.055],
    foot: ['anR', 'toR', 0.4, 0.05],
    wrist: ['elR', 'haR', 0.85, 0.044],
    'upper arm': ['shR', 'elR', 0.5, 0.054],
  };

  // ---------- meshes ----------
  function sphereMesh(rows = 14, cols = 20) {
    const v = [];
    const pt = (i, j) => {
      const th = (i / rows) * Math.PI, ph = (j / cols) * 2 * Math.PI;
      return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    };
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++) {
        const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
        for (const q of [a, b, c, a, c, d]) v.push(...q, ...q); // on a unit sphere the normal is the position
      }
    return new Float32Array(v);
  }
  function cylinderMesh(seg = 20) {
    const v = [];
    for (let j = 0; j < seg; j++) {
      const p0 = (j / seg) * 2 * Math.PI, p1 = ((j + 1) / seg) * 2 * Math.PI;
      const n0 = [Math.cos(p0), 0, Math.sin(p0)], n1 = [Math.cos(p1), 0, Math.sin(p1)];
      const quad = [[n0, 0], [n0, 1], [n1, 1], [n0, 0], [n1, 1], [n1, 0]];
      for (const [n, y] of quad) v.push(n[0], y, n[2], n[0], 0, n[2]);
    }
    return new Float32Array(v);
  }

  // ---------- matrices (column-major) ----------
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  function lookAt(eye, center) {
    const z = norm(sub(eye, center)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  // Unit cylinder (y from 0 to 1) stretched from a to b with radius r.
  function boneMatrix(a, b, r) {
    const d = sub(b, a), len = Math.hypot(d[0], d[1], d[2]) || 1e-6, y = [d[0] / len, d[1] / len, d[2] / len];
    const x = norm(cross(Math.abs(y[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0], y)), z = cross(x, y);
    return [x[0] * r, x[1] * r, x[2] * r, 0, d[0], d[1], d[2], 0, z[0] * r, z[1] * r, z[2] * r, 0, a[0], a[1], a[2], 1];
  }
  const ballMatrix = (c, rx, ry = rx, rz = rx) => [rx, 0, 0, 0, 0, ry, 0, 0, 0, 0, rz, 0, c[0], c[1], c[2], 1];

  const VS = `attribute vec3 aPos; attribute vec3 aNor; uniform mat4 uVP; uniform mat4 uM; varying vec3 vN; varying vec3 vW;
    void main() { vec4 w = uM * vec4(aPos, 1.0); vW = w.xyz; vN = mat3(uM) * aNor; gl_Position = uVP * w; }`;
  const FS = `precision mediump float; uniform vec3 uColor; uniform vec3 uEye; uniform float uEmit; uniform float uAlpha; varying vec3 vN; varying vec3 vW;
    void main() {
      vec3 n = normalize(vN); vec3 v = normalize(uEye - vW); vec3 key = normalize(vec3(0.45, 0.9, 0.6));
      float d1 = max(dot(n, key), 0.0); float d2 = max(dot(n, normalize(vec3(-0.7, 0.25, -0.5))), 0.0);
      float rim = pow(1.0 - max(dot(n, v), 0.0), 2.6); float spec = pow(max(dot(n, normalize(key + v)), 0.0), 42.0);
      vec3 c = uColor * (0.42 + 0.6 * d1 + 0.2 * d2) + vec3(0.95) * rim * 0.22 + vec3(1.0) * spec * 0.22;
      c = mix(c, uColor * 1.25 + 0.12, uEmit);
      gl_FragColor = vec4(c * uAlpha, uAlpha);
    }`;

  const TONES = {
    light: { torso: [0.06, 0.36, 0.3], limb: [0.13, 0.52, 0.44], head: [0.96, 0.82, 0.7], prop: [0.86, 0.88, 0.9], shadow: 0.1 },
    dark: { torso: [0.99, 0.96, 0.9], limb: [0.84, 0.94, 0.89], head: [1.0, 0.86, 0.74], prop: [0.2, 0.42, 0.37], shadow: 0.22 },
  };
  const SENSOR_COLOR = [0.95, 0.42, 0.16];

  function figure(canvas, opts = {}) {
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
    const noop = { set() {}, mode() {}, pulse() {}, turn() {}, renderAt() {}, frame() {}, destroy() {}, ok: false };
    if (!gl) {
      canvas.hidden = true;
      return noop;
    }
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      canvas.hidden = true;
      return noop;
    }
    gl.useProgram(prog);
    const loc = { pos: gl.getAttribLocation(prog, 'aPos'), nor: gl.getAttribLocation(prog, 'aNor') };
    const uni = Object.fromEntries(['uVP', 'uM', 'uColor', 'uEye', 'uEmit', 'uAlpha'].map((n) => [n, gl.getUniformLocation(prog, n)]));
    const mesh = (data) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return { buf, count: data.length / 6 };
    };
    const sphere = mesh(sphereMesh()), cyl = mesh(cylinderMesh());
    gl.enableVertexAttribArray(loc.pos);
    gl.enableVertexAttribArray(loc.nor);
    gl.enable(gl.DEPTH_TEST);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    let bound = null;
    function draw(m, matrix, color, emit = 0, alpha = 1) {
      if (bound !== m) {
        gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
        gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(loc.nor, 3, gl.FLOAT, false, 24, 12);
        bound = m;
      }
      gl.uniformMatrix4fv(uni.uM, false, matrix);
      gl.uniform3fv(uni.uColor, color);
      gl.uniform1f(uni.uEmit, emit);
      gl.uniform1f(uni.uAlpha, alpha);
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
    }
    // A limb: a cylinder with a ball at each end.
    const capsule = (a, b, r, color) => {
      draw(cyl, boneMatrix(a, b, r), color);
      draw(sphere, ballMatrix(a, r), color);
      draw(sphere, ballMatrix(b, r), color);
    };

    const tone = TONES[opts.tone === 'dark' ? 'dark' : 'light'];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let exercise = opts.exercise || null;
    const site = 'wrist'; // the wearable is always on the wrist, whatever the exercise
    let mode = opts.mode || 'loop';
    let pulseAt = -1e9, pulseDur = 2;
    let drag = 0, dragging = null;
    let raf = 0, dead = false;
    const t0 = performance.now();

    function progress(t) {
      if (mode === 'manual') {
        const k = (t - pulseAt) / pulseDur;
        return k >= 0 && k <= 1 ? Math.sin(Math.PI * k) ** 2 : 0;
      }
      // Move for 75% of the cycle, rest for 25%. Recording data varies the cycle and depth.
      const cycle = opts.cycle || 3.2, amp = opts.amp || 1, k = (t % cycle) / cycle;
      return k < 0.75 ? amp * (0.5 - 0.5 * Math.cos((k / 0.75) * 2 * Math.PI)) : 0;
    }

    function frame(now) {
      if (dead) return;
      const t = reduced ? 0.6 : (now - t0) / 1000;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.depthMask(true); // the shadow pass turns depth writes off; clearing needs them on
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const fn = opts.pose || EXERCISES[exercise] || idle; // opts.pose: any (p, t) -> pose, for recording
      const speed = CONTINUOUS.has(exercise) && opts.cycle ? 3.2 / opts.cycle : 1;
      const P = fn(reduced ? 0.6 : progress(t), mode === 'manual' && CONTINUOUS.has(exercise) ? 0 : t * speed);
      const J = joints(P);

      // The camera sways gently around a three-quarter view; dragging turns the figure.
      const yaw = 0.95 + (reduced ? 0 : 0.28 * Math.sin(t * 0.45)) + drag;
      const target = [0, 0.9, J.pelvis[2] * 0.5 + 0.05];
      const dist = 4.6 * Math.max(1, Math.min(1.6, 0.8 / (w / h))); // step back in narrow frames so wide poses fit
      const eye = [target[0] + Math.sin(yaw) * dist, 1.3, target[2] + Math.cos(yaw) * dist];
      gl.uniformMatrix4fv(uni.uVP, false, mul(perspective(28 * DEG, w / h, 0.1, 20), lookAt(eye, target)));
      gl.uniform3fv(uni.uEye, eye);

      gl.disable(gl.BLEND);
      gl.depthMask(true);
      if (P.stool) {
        const seat = [0, S + ANKLE - 0.11, P.stool === true ? -0.2 + (exercise === 'Recumbent bike' ? -0.05 : 0) : 0];
        draw(cyl, boneMatrix(seat, add(seat, [0, 0.045, 0]), 0.24), tone.prop);
        draw(sphere, ballMatrix(add(seat, [0, 0.045, 0]), 0.24, 0.012, 0.24), tone.prop);
        draw(cyl, boneMatrix([seat[0], 0, seat[2]], seat, 0.035), tone.prop);
      }
      // Torso: hips, a tapered trunk, shoulders.
      capsule(J.hipL, J.hipR, 0.085, tone.torso);
      const mid = lerp3(J.pelvis, J.chest, 0.5);
      draw(sphere, ballMatrix(mid, 0.15, 0.3, 0.115), tone.torso);
      capsule(J.shL, J.shR, 0.062, tone.torso);
      capsule(J.chest, J.neck, 0.045, tone.head);
      draw(sphere, ballMatrix(J.head, 0.105, 0.125, 0.112), tone.head);
      for (const k of ['L', 'R']) {
        capsule(J[`hip${k}`], J[`kn${k}`], 0.074, tone.limb);
        capsule(J[`kn${k}`], J[`an${k}`], 0.058, tone.limb);
        capsule(J[`an${k}`], J[`to${k}`], 0.045, tone.torso);
        capsule(J[`sh${k}`], J[`el${k}`], 0.05, tone.limb);
        capsule(J[`el${k}`], J[`ha${k}`], 0.041, tone.limb);
        draw(sphere, ballMatrix(J[`ha${k}`], 0.05), tone.head);
      }
      const band = SENSOR[site];
      if (band) {
        const a = J[band[0]], b = J[band[1]], c = lerp3(a, b, band[2]), half = mulS(norm(sub(b, a)), 0.032);
        const glow = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(t * 5);
        draw(cyl, boneMatrix(sub(c, half), add(c, half), band[3] * (1.32 + 0.1 * glow)), SENSOR_COLOR, 0.55 + 0.45 * glow);
      }
      // Soft contact shadow on the floor.
      gl.enable(gl.BLEND);
      gl.depthMask(false);
      const sz = (J.anL[2] + J.anR[2]) / 2;
      draw(sphere, ballMatrix([0, 0.002, sz], 0.5, 0.001, 0.36), [0, 0, 0], 0, tone.shadow * 0.6);
      draw(sphere, ballMatrix([0, 0.003, sz], 0.32, 0.001, 0.22), [0, 0, 0], 0, tone.shadow);

      if (!reduced && !opts.still) raf = requestAnimationFrame(frame);
    }

    const onDown = (e) => {
      dragging = { x: e.clientX, drag };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (!dragging) return;
      drag = dragging.drag - (e.clientX - dragging.x) * 0.012;
      if (reduced) frame(performance.now());
    };
    const onUp = () => {
      dragging = null;
      canvas.style.cursor = '';
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.setAttribute('role', 'img');
    const label = () => canvas.setAttribute('aria-label', `3D figure${exercise ? ` showing ${exercise}` : ''}${site ? `, sensor on the ${site}` : ''}. Drag to turn.`);
    label();

    frame(performance.now()); // first frame straight away; animation continues when frames are available

    return {
      ok: true,
      set(name) {
        exercise = name;
        label();
        if (reduced) frame(performance.now());
      },
      // Turn the figure to a fixed angle (radians), as dragging does.
      turn(rad) {
        drag = rad;
      },
      mode(m) {
        mode = m;
      },
      // Play one repetition lasting ms.
      pulse(ms) {
        pulseDur = Math.max(0.6, (ms || 2000) / 1000);
        pulseAt = (performance.now() - t0) / 1000;
      },
      frame: () => frame(performance.now()),
      // Draw the pose at t seconds into the animation (used to record training data).
      renderAt: (t) => frame(t0 + t * 1000),
      destroy() {
        dead = true;
        cancelAnimationFrame(raf);
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      },
    };
  }

  DL.figure = figure;
  DL.figureExercises = Object.keys(EXERCISES);
})();
