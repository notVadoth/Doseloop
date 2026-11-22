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
      this.lastPoseAt = -Infinity;
    }

    setContext(c) {
      Object.assign(this.ctx, c);
    }

    _ex() {
      const name = this.ctx.exercise || 'Before the first exercise';
      if (!this.byEx.has(name)) this.byEx.set(name, { reps: [], watch: [], lines: [], pose: [], sets: new Set(), snaps: 0 });
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
      const row = { t, set, from, type: g[0], line };
      if (g[0] === 'REP') Object.assign(row, { n: num(g[1]), tempo: num(g[2]), rom: num(g[3]), quality: num(g[4]) });
      else if (g[0] === 'PART') row.rom = num(g[1]);
      else if (g[0] === 'HR') row.hr = num(g[1]);
      else if (g[0] === 'SPO2') row.spo2 = num(g[1]);
      e.lines.push(row);
    }

    // Every camera frame; joint angles are kept twice a second while a set is running.
    frame(f) {
      this.last = f;
      this.lastAt = performance.now();
      if (!this.ctx.running) return;
      const now = performance.now();
      if (now - this.lastPoseAt < POSE_EVERY_MS) return;
      this.lastPoseAt = now;
      const a = f.smooth || f.angles;
      this._ex().pose.push({ t: this._t(), set: this.ctx.set, visible: !!f.visible, fullBody: !!f.fullBody, angles: a ? DLMotion.CHANNELS.map((_, i) => r1(a[i])) : null });
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
      return { watch, pose, snaps, reps, lines, exercises: this.byEx.size };
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
      sum.columns = [{ width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
      title(sum, 'DoseLoop developer export');
      const p = this.participant || {};
      for (const [k, v] of [['Participant', `${p.display_name || p.name || ''} (#${p.id ?? '?'})`], ['Session', this.sessionId], ['Started', this.started.toLocaleString()], ['Exported', new Date().toLocaleString()], ['Snapshots', dev.withVideo ? 'Skeleton over the camera picture' : 'Skeleton only (no camera picture)']]) {
        const r = sum.addRow([k, v]);
        r.getCell(1).font = bold;
      }
      sum.addRow([]);
      header(sum, ['Exercise', 'Sets', 'Reps counted', 'Snapshots', 'Watch readings', 'Sensor lines', 'Pose samples']);
      for (const [name, e] of this.byEx) sum.addRow([name, [...e.sets].sort().join(', '), e.reps.length, e.snaps, e.watch.length, e.lines.length, e.pose.length]);
      sum.addRow([]);
      sum.addRow(['Times are seconds since the session screen opened. Angles are in degrees (see DLMotion.CHANNELS).']).font = { italic: true, color: { argb: 'FF5D676E' } };

      const used = new Set(['summary']);
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
        header(ws, ['Time (s)', 'Set', 'Person in view', 'Whole body', ...CH]);
        if (!e.pose.length) ws.addRow(['No camera frames during sets']);
        for (const s of e.pose) ws.addRow([s.t, s.set, s.visible ? 'yes' : 'no', s.fullBody ? 'yes' : 'no', ...(s.angles || CH.map(() => null))]);
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
