'use strict';
// Developer mode for the participant app. While it is on, each session records what the
// watch and the camera report: every line from the watch (its once-a-second readings, reps,
// heart rate and oxygen), the camera's joint angles twice a second, and a pose snapshot at
// every counted rep. "Download Excel" turns that into a workbook with a Summary sheet and one
// sheet per exercise, for testing and tuning. The passcode only keeps it out of
// participants' way; it is not security. Everything stays in this browser until downloaded.
(() => {
  const KEY = 'doseloop.dev';
  const VIDEO_KEY = 'doseloop.dev.video';
  const CODE = 'testing';
  const EXCELJS = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
  const MAX_SNAPSHOTS = 80; // per exercise, to keep the file a sensible size
  const POSE_EVERY_MS = 500;

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch {
        /* storage blocked: dev mode lasts until the page reloads */
      }
    },
  };
  let onNow = store.get(KEY) === '1';

  const dev = {
    get on() {
      return onNow;
    },
    enable(code) {
      if (String(code || '').trim().toLowerCase() !== CODE) return false;
      onNow = true;
      store.set(KEY, '1');
      return true;
    },
    disable() {
      onNow = false;
      store.set(KEY, null);
    },
    // Snapshots show the tracked skeleton; the camera picture is added only when asked for.
    get withVideo() {
      return store.get(VIDEO_KEY) === '1';
    },
    set withVideo(v) {
      store.set(VIDEO_KEY, v ? '1' : null);
    },
    // Raw wrist motion from the watch during sets, for tuning its rep counter (this page only).
    recordMotion: false,
  };

  // MediaPipe pose landmarks joined into a stick figure (as vision.js draws it), plus the face.
  const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32], [27, 29], [29, 31], [28, 30], [30, 32]];
  const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
  const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

  let excelLoading = null;
  function loadExcel() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (!excelLoading) {
      excelLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = EXCELJS;
        s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('The Excel library did not load')));
        s.onerror = () => {
          excelLoading = null;
          reject(new Error('Could not load the Excel library. Check the internet connection.'));
        };
        document.head.appendChild(s);
      });
    }
    return excelLoading;
  }

  class DevRecorder {
    constructor({ participant, sessionId, video }) {
      this.participant = participant;
      this.sessionId = sessionId;
      this.video = video || null;
      this.mirrored = true;
      this.t0 = performance.now();
      this.started = new Date();
      this.ctx = { exercise: null, set: null, running: false, source: null };
      this.byEx = new Map(); // exercise name -> { reps, watch, lines, pose, sets }
      this.last = null; // latest camera frame
      this.lastAt = -Infinity;
      this.events = []; // the coach log: everything the app said or decided, in order
      this.lastPoseAt = -Infinity;
      this.motion = []; // raw wrist motion: [watch ms, ax, ay, az]
      this.motionReps = []; // the watch's REP lines alongside it: [watch ms (approx.), line]
    }

    // Raw motion over Wi-Fi: a batch of readings 20 ms apart, starting at watch time ms.
    accBatch(ms, data) {
      data.split(';').forEach((s, i) => {
        const v = s.split(',').map(Number);
        if (v.length === 3 && v.every(Number.isFinite)) this.motion.push([ms + i * 20, ...v]);
      });
    }

    // For the replay tool (firmware/test/replay_body_rep.cpp): ACC lines, plus the watch's own reps.
    motionCsv() {
      const rows = this.motion.map(([ms, x, y, z]) => [ms, `ACC,${ms},${x},${y},${z}`]);
      for (const [ms, line] of this.motionReps) rows.push([ms, line]);
      rows.sort((a, b) => a[0] - b[0]);
      return rows.map((r) => r[1]).join('\n') + '\n';
    }

    downloadMotion() {
      const blob = new Blob([this.motionCsv()], { type: 'text/csv' });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `doseloop-motion-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    setContext(c) {
      Object.assign(this.ctx, c);
    }

    _ex() {
      const name = this.ctx.exercise || 'Before the first exercise';
      if (!this.byEx.has(name)) this.byEx.set(name, { reps: [], watch: [], lines: [], pose: [], cues: [], sets: new Set(), snaps: 0, cam: { frames: 0, seen: 0, full: 0, vis: 0, modes: new Set() } });
      const e = this.byEx.get(name);
      if (this.ctx.running && this.ctx.set != null) e.sets.add(this.ctx.set);
      return e;
    }

    _t() {
      return Math.round(performance.now() - this.t0) / 1000;
    }

    // Every line the session receives: from the watch, the demo sensor, or the camera's rep
    // counter ("CAM," lines when the watch and camera count together).
    line(line, source) {
      const e = this._ex();
      const t = this._t();
      const f = line.split(',');
      const cam = f[0] === 'CAM';
      const g = cam ? f.slice(1) : f;
      const from = cam || source === 'camera' ? 'camera' : source === 'sim' ? 'demo sensor' : 'watch';
      const set = this.ctx.running ? this.ctx.set : null;
      if (g[0] === 'DATA') {
        const kv = Object.fromEntries(g.slice(1).map((x) => x.split('=')));
        e.watch.push({ t, set, wifi: kv.wifi ?? null, motion: kv.motion ?? null, tilt: num(kv.tilt), ax: num(kv.ax), ay: num(kv.ay), az: num(kv.az), pulse: kv.pulse ?? null, finger: num(kv.finger), ir: num(kv.ir), red: num(kv.red), hr: num(kv.hr) || null, spo2: num(kv.spo2) || null, reps: num(kv.reps) });
        return;
      }
      if (g[0] === 'ACC') {  // raw motion over USB: one reading a line
        const v = g.slice(1).map(Number);
        if (v.length === 4 && v.every(Number.isFinite)) this.motion.push(v);
        return;
      }
      if (g[0] === 'REP' && from === 'watch' && this.motion.length) this.motionReps.push([this.motion[this.motion.length - 1][0], g.join(',')]);
      const row = { t, set, from, type: g[0], line };
      if (g[0] === 'REP') Object.assign(row, { n: num(g[1]), tempo: num(g[2]), rom: num(g[3]), quality: num(g[4]) });
      else if (g[0] === 'PART') row.rom = num(g[1]);
      else if (g[0] === 'HR') row.hr = num(g[1]);
      else if (g[0] === 'SPO2') row.spo2 = num(g[1]);
      e.lines.push(row);
    }

    // Every camera frame; joint angles are kept twice a second while a set is running.
    // lean: FormChecker.lean (the trunk's lean now and at rest), when form is being checked.
    frame(f, lean = null) {
      this.last = f;
      this.lastAt = performance.now();
      if (!this.ctx.running) return;
      // Tracking quality over every frame of the set, for comparing camera settings.
      const q = this._ex().cam;
      q.frames++;
      if (f.visible) q.seen++;
      if (f.fullBody) q.full++;
      q.vis += f.vis || 0;
      if (f.metrics && f.metrics.glitch) q.glitches = (q.glitches || 0) + 1;
      if (f.light || f.perf) q.modes.add(`${f.perf ? f.perf.model : '?'} · ${!f.light || f.light.mode === 'off' ? 'no filter' : `gamma ${f.light.mode}`}`);
      const now = performance.now();
      if (now - this.lastPoseAt < POSE_EVERY_MS) return;
      this.lastPoseAt = now;
      const a = f.smooth || f.angles;
      const L = f.light || {};
      const M = f.metrics || {};
      const d1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
      const P = f.perf || {};
      this._ex().pose.push({ t: this._t(), set: this.ctx.set, model: P.model || null, detectMs: P.detectMs == null ? null : Math.round(P.detectMs * 10) / 10, fwd: d1(M.fwdLean), side: d1(M.sideLean), restFwd: d1(lean && lean.restFwd), restSide: d1(lean && lean.restSide), visible: !!f.visible, fullBody: !!f.fullBody, vis: f.vis == null ? null : Math.round(f.vis * 100) / 100, bright: L.mean == null ? null : Math.round(L.mean * 100), mode: L.mode || null, gamma: L.gamma == null ? null : Math.round(L.gamma * 100) / 100, filterMs: L.filterMs == null ? null : Math.round(L.filterMs * 10) / 10, angles: a ? DLMotion.CHANNELS.map((_, i) => r1(a[i])) : null });
    }

    // The coach log. type: 'set' | 'count' | 'voice' | 'safety' | 'form' | 'posture' |
    // 'position' | 'sensors' | 'fatigue' | 'camera'; what: what the app said or decided; why: the data behind it.
    log(type, what, why = '') {
      this.events.push({ t: this._t(), exercise: this.ctx.exercise, set: this.ctx.running ? this.ctx.set : null, type, what, why });
    }

    // A form cue switching on or off, with the lean the rule judged (now, at rest, difference).
    cue(ev, lean) {
      const d1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
      const L = lean || {};
      this._ex().cues.push({ t: this._t(), set: this.ctx.set, type: ev.type, id: ev.id, cue: ev.cue, fwd: d1(L.fwd), restFwd: d1(L.restFwd), fwdRel: d1(L.fwdRel), side: d1(L.side), restSide: d1(L.restSide), sideRel: d1(L.sideRel) });
    }

    // A counted rep: its numbers, who counted it, the joint angles and a pose snapshot.
    rep({ count, tempo, rom, quality, kind, src }) {
      const e = this._ex();
      const f = this.last;
      const fresh = f && performance.now() - this.lastAt < 1500;
      const a = f && fresh ? f.smooth || f.angles : null;
      let image = null;
      if (e.snaps < MAX_SNAPSHOTS) {
        image = this.snapshot(`${this.ctx.exercise || ''} · set ${this.ctx.set ?? '–'} · rep ${count}`);
        if (image) e.snaps++;
      }
      e.reps.push({ t: this._t(), set: this.ctx.set, count, src: src || this.ctx.source, kind: kind || null, tempo: tempo ?? null, rom: rom ?? null, quality: quality ?? null, angles: a ? DLMotion.CHANNELS.map((_, i) => r1(a[i])) : null, image });
    }

    // The latest pose drawn as a stick figure (over the camera picture if asked for), as JPEG.
    snapshot(label) {
      const f = this.last;
      if (!f || !f.landmarks || performance.now() - this.lastAt > 1500) return null;
      const v = this.video;
      const vw = (v && v.videoWidth) || 640, vh = (v && v.videoHeight) || 480;
      const W = 320, H = Math.round((W * vh) / vw);
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H + 22;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H + 22);
      const mx = (x) => (this.mirrored ? (1 - x) * W : x * W);
      if (dev.withVideo && v && v.readyState >= 2) {
        g.save();
        if (this.mirrored) {
          g.translate(W, 0);
          g.scale(-1, 1);
        }
        g.drawImage(v, 0, 0, W, H);
        g.restore();
      } else {
        g.fillStyle = '#f2f4f3';
        g.fillRect(0, 0, W, H);
      }
      const lm = f.landmarks;
      const ok = (i) => lm[i] && (lm[i].visibility == null || lm[i].visibility >= 0.5);
      g.lineCap = 'round';
      g.lineWidth = 4;
      g.strokeStyle = '#0f6b5a';
      for (const [a, b] of BONES) {
        if (!ok(a) || !ok(b)) continue;
        g.beginPath();
        g.moveTo(mx(lm[a].x), lm[a].y * H);
        g.lineTo(mx(lm[b].x), lm[b].y * H);
        g.stroke();
      }
      g.fillStyle = '#e8763a';
      for (const i of JOINTS) {
        if (!ok(i)) continue;
        g.beginPath();
        g.arc(mx(lm[i].x), lm[i].y * H, i === 0 ? 7 : 4.5, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#1d2327';
      g.font = '600 12px system-ui, sans-serif';
      g.fillText(label, 6, H + 15);
      return c.toDataURL('image/jpeg', 0.82);
    }

    stats() {
      let watch = 0, pose = 0, snaps = 0, reps = 0, lines = 0;
      for (const e of this.byEx.values()) {
        watch += e.watch.length;
        pose += e.pose.length;
        snaps += e.snaps;
        reps += e.reps.length;
        lines += e.lines.length;
      }
      return { watch, pose, snaps, reps, lines, exercises: this.byEx.size, motion: this.motion.length };
    }

    // The workbook: a Summary sheet, then one sheet per exercise with four tables (reps with
    // snapshots, the watch's readings, every sensor line, and pose samples).
    async workbook() {
      const ExcelJS = await loadExcel();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'DoseLoop developer mode';
      wb.created = new Date();
      const CH = DLMotion.CHANNELS;
      const bold = { bold: true };
      const title = (ws, text) => {
        const r = ws.addRow([text]);
        r.font = { bold: true, size: 13, color: { argb: 'FF0F6B5A' } };
        return r;
      };
      const header = (ws, cols) => {
        const r = ws.addRow(cols);
        r.font = bold;
        r.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2F1EE' } }));
        return r;
      };

      const sum = wb.addWorksheet('Summary');
      const coach = wb.addWorksheet('Coach log', { views: [{ state: 'frozen', ySplit: 2 }] });
      sum.columns = [{ width: 30 }, ...Array.from({ length: 10 }, () => ({ width: 14 })), { width: 22 }, { width: 30 }];
      title(sum, 'DoseLoop developer export');
      const p = this.participant || {};
      for (const [k, v] of [['Participant', `${p.display_name || p.name || ''} (#${p.id ?? '?'})`], ['Session', this.sessionId], ['Started', this.started.toLocaleString()], ['Exported', new Date().toLocaleString()], ['Snapshots', dev.withVideo ? 'Skeleton over the camera picture' : 'Skeleton only (no camera picture)']]) {
        const r = sum.addRow([k, v]);
        r.getCell(1).font = bold;
      }
      sum.addRow([]);
      header(sum, ['Exercise', 'Sets', 'Reps counted', 'Snapshots', 'Watch readings', 'Sensor lines', 'Pose samples', 'Camera frames', 'Person seen %', 'Whole body %', 'Avg joint visibility', 'Model · filter', 'Form cues', 'Impossible lean frames ignored']);
      const pc = (a, b) => (b ? Math.round((100 * a) / b) : null);
      for (const [name, e] of this.byEx) {
        const q = e.cam;
        sum.addRow([name, [...e.sets].sort().join(', '), e.reps.length, e.snaps, e.watch.length, e.lines.length, e.pose.length, q.frames, pc(q.seen, q.frames), pc(q.full, q.frames), q.frames ? Math.round((100 * q.vis) / q.frames) / 100 : null, [...q.modes].join(', '), e.cues.filter((c) => c.type === 'start').map((c) => c.id).join(', '), q.glitches || 0]);
      }
      sum.addRow([]);
      sum.addRow(['Times are seconds since the session screen opened. Angles are in degrees (see DLMotion.CHANNELS).']).font = { italic: true, color: { argb: 'FF5D676E' } };
      // What the app did, by type and exercise.
      sum.addRow([]);
      title(sum, 'Coach log: what the app said and decided (details on the "Coach log" sheet)');
      const TYPES = ['set', 'count', 'voice', 'safety', 'form', 'posture', 'position', 'sensors', 'fatigue', 'camera'];
      header(sum, ['Exercise', ...TYPES]);
      const exNames = [...new Set(this.events.map((e) => e.exercise || 'Before the first exercise'))];
      for (const n of exNames) sum.addRow([n, ...TYPES.map((ty) => this.events.filter((e) => (e.exercise || 'Before the first exercise') === n && e.type === ty).length || null)]);
      sum.addRow([]);
      sum.addRow(["Joint visibility: the pose model's average confidence (0-1) in the shoulders, hips, knees and ankles. Brightness: the frame's average, 0-100%."]).font = { italic: true, color: { argb: 'FF5D676E' } };

      // The coach log: one timeline across all exercises.
      coach.columns = [{ width: 10 }, { width: 24 }, { width: 6 }, { width: 10 }, { width: 62 }, { width: 70 }];
      title(coach, 'Coach log: everything the app said or decided, in order');
      header(coach, ['Time (s)', 'Exercise', 'Set', 'Type', 'What the app said or decided', 'Why: the data behind it']);
      const TINT = { set: 'FFE2F1EE', safety: 'FFFDE4E1', position: 'FFFFF1D6', form: 'FFFFF6E0', count: null, voice: 'FFF0F3F7', posture: 'FFEDEBFA', sensors: 'FFEDEBFA', camera: 'FFF0F3F7' };
      if (!this.events.length) coach.addRow(['', '', '', '', 'Nothing logged yet']);
      for (const e of this.events) {
        const r = coach.addRow([e.t, e.exercise || '', e.set, e.type, e.what, e.why]);
        r.alignment = { vertical: 'top', wrapText: true };
        if (TINT[e.type]) r.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT[e.type] } }));
        if (e.type === 'set') r.font = { bold: true };
      }

      const used = new Set(['summary', 'coach log']);
      const sheetName = (name) => {
        let base = name.replace(/[[\]:*?/\\]/g, '-').slice(0, 31) || 'Exercise';
        let n = base, k = 2;
        while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${k++}`;
        used.add(n.toLowerCase());
        return n;
      };

      for (const [name, e] of this.byEx) {
        const ws = wb.addWorksheet(sheetName(name));
        const repCols = ['Time (s)', 'Set', 'Rep', 'Counted by', 'Match', 'Tempo (ms)', 'Range (°)', 'Quality', ...CH, 'Snapshot'];
        ws.columns = repCols.map((_, i) => ({ width: i < 8 ? 12 : i === repCols.length - 1 ? 46 : 9 }));
        const snapCol = repCols.length; // 1-based

        title(ws, `${name}: reps`);
        header(ws, repCols);
        if (!e.reps.length) ws.addRow(['No reps counted']);
        for (const r of e.reps) {
          const row = ws.addRow([r.t, r.set, r.count, r.src, r.kind, r.tempo, r.rom, r.quality, ...(r.angles || CH.map(() => null))]);
          if (r.image) {
            const id = wb.addImage({ base64: r.image, extension: 'jpeg' });
            const w = 320, h = 262; // matches the snapshot canvas (4:3 video + label strip)
            const scale = 0.62;
            row.height = h * scale * 0.75 + 4;
            ws.addImage(id, { tl: { col: snapCol - 1 + 0.05, row: row.number - 1 + 0.05 }, ext: { width: w * scale, height: h * scale } });
          }
        }

        ws.addRow([]);
        title(ws, 'Form cues (on and off), with the trunk lean the rule judged');
        header(ws, ['Time (s)', 'Set', 'On/off', 'Fault', 'Cue', 'Fwd lean (°)', 'Fwd lean at rest', 'Fwd beyond rest', 'Side lean (°)', 'Side lean at rest', 'Side beyond rest']);
        if (!e.cues.length) ws.addRow(['No form cues']);
        for (const c of e.cues) ws.addRow([c.t, c.set, c.type === 'start' ? 'on' : 'off', c.id, c.cue, c.fwd, c.restFwd, c.fwdRel, c.side, c.restSide, c.sideRel]);

        ws.addRow([]);
        title(ws, 'Watch: once-a-second readings');
        header(ws, ['Time (s)', 'Set', 'Tilt (°)', 'ax (g)', 'ay (g)', 'az (g)', 'Heart rate', 'SpO₂ (%)', 'Finger', 'IR', 'Red', 'Watch reps', 'Motion', 'Pulse', 'Wi-Fi']);
        if (!e.watch.length) ws.addRow(['No readings from the watch']);
        for (const w of e.watch) ws.addRow([w.t, w.set, w.tilt, w.ax, w.ay, w.az, w.hr, w.spo2, w.finger, w.ir, w.red, w.reps, w.motion, w.pulse, w.wifi]);

        ws.addRow([]);
        title(ws, 'Every sensor line (reps, partial reps, heart rate, oxygen, set start and stop)');
        header(ws, ['Time (s)', 'Set', 'From', 'Type', 'Rep', 'Tempo (ms)', 'Range (°)', 'Quality', 'Heart rate', 'SpO₂ (%)', 'Raw line']);
        if (!e.lines.length) ws.addRow(['No sensor lines']);
        for (const l of e.lines) ws.addRow([l.t, l.set, l.from, l.type, l.n ?? null, l.tempo ?? null, l.rom ?? null, l.quality ?? null, l.hr ?? null, l.spo2 ?? null, l.line]);

        ws.addRow([]);
        title(ws, 'Camera pose samples (twice a second during sets)');
        header(ws, ['Time (s)', 'Set', 'Model', 'Detect (ms)', 'Person in view', 'Whole body', 'Joint visibility', 'Brightness (%)', 'Filter', 'Gamma', 'Filter (ms)', 'Fwd lean (°)', 'Fwd lean at rest', 'Side lean (°)', 'Side lean at rest', ...CH]);
        if (!e.pose.length) ws.addRow(['No camera frames during sets']);
        for (const s of e.pose) ws.addRow([s.t, s.set, s.model, s.detectMs, s.visible ? 'yes' : 'no', s.fullBody ? 'yes' : 'no', s.vis, s.bright, s.mode, s.gamma, s.filterMs, s.fwd, s.restFwd, s.side, s.restSide, ...(s.angles || CH.map(() => null))]);
      }
      return wb;
    }

    async download() {
      const wb = await this.workbook();
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const d = this.started;
      const pad = (n) => String(n).padStart(2, '0');
      const name = `doseloop-dev-P${this.participant ? this.participant.id : 'x'}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { name, bytes: buf.byteLength };
    }
  }

  DL.dev = dev;
  DL.DevRecorder = DevRecorder;
})();
