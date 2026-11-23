'use strict';
// Participant views: choose who is exercising, today's plan, and the guided session.
(() => {
  const { views, esc, pct, fmtDate, amount, api, toast, act, icon, avatar, ring, feedCard, aiBadge, voice } = DL;
  const DAY = 86400000;

  // ---------- tracker: the wearable over Web Serial or Wi-Fi, or a built-in demo sensor ----------
  // All speak the firmware's line protocol, so the session code cannot tell them apart.

  class Tracker {
    constructor(onLine) {
      this.onLine = onLine;
      this.kind = null; // 'device' | 'sim'
      this.port = null;
      this.timers = [];
      this.cfg = null;
    }

    static get serialSupported() {
      return 'serial' in navigator;
    }

    async connectSerial() {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      this.port = port;
      this.kind = 'device';
      this.writer = port.writable.getWriter();
      this.reader = port.readable.getReader();
      this.readLoop();
    }

    async readLoop() {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            this.lastLineAt = performance.now(); // the watch sends a DATA line every second
            if (line) this.onLine(line);
          }
        }
      } catch {
        this.onLine('LOST');
      }
    }

    // The watch over Wi-Fi (the hosted app, no cable): the server relays the same lines
    // (POST /api/device/<id>/link, a few times a second). Lines from the watch come with the
    // moment they happened, turned into this page's clock, so the session can match them with
    // the camera; commands go back with every poll until the watch has run them.
    async connectWifi() {
      const { devices } = await DL.api('GET', '/api/device');
      const online = devices.filter((d) => d.age_ms < 5000);
      if (!online.length) {
        const e = new Error('No watch is online over Wi-Fi');
        e.name = 'NoWifiWatch';
        throw e;
      }
      this.wifi = { id: online[0].id, cs: Math.random().toString(36).slice(2, 10).padEnd(8, '0'), cmds: [], next: 0, after: new Map(), accAfter: new Map(), primed: false, stamp: 0, timer: null, offline: 0 };
      this.port = { wifi: true, id: online[0].id };
      this.kind = 'device';
      this.lastLineAt = performance.now();
      await this.wifiPoll(true);
    }

    async wifiPoll(first = false) {
      const w = this.wifi;
      if (!w || !this.port || !this.port.wifi) return;
      const sent = performance.now();
      try {
        const r = await DL.api('POST', `/api/device/${encodeURIComponent(w.id)}/link`, { cs: w.cs, cmds: w.cmds.slice(-12), after: w.after.has(w.bootSeen) ? w.after.get(w.bootSeen) : -1, acc_after: w.accAfter.has(w.bootSeen) ? w.accAfter.get(w.bootSeen) : -1, boot: w.bootSeen || null });
        if (this.wifi !== w) return; // closed while waiting
        const got = performance.now();
        const toPerf = (serverT) => got - (got - sent) / 2 - (r.server_now - serverT);
        const boot = r.boot || '';
        w.bootSeen = boot;
        const after = w.after.has(boot) ? w.after.get(boot) : -1;
        const accAfter = w.accAfter.has(boot) ? w.accAfter.get(boot) : -1;
        if (!w.primed) {
          // What the server already had is from before this session: start after it.
          w.after.set(boot, Math.max(after, ...r.lines.map((x) => x.seq)));
          w.accAfter.set(boot, Math.max(accAfter, ...r.acc.map((x) => x.ms)));
          w.primed = true;
        } else {
          for (const x of r.lines) {
            if (x.seq <= (w.after.get(boot) ?? -1)) continue;
            w.after.set(boot, x.seq);
            this.lastLineAt = got;
            this.onLine(x.line, toPerf(x.t));
          }
          for (const a of r.acc) {
            if (a.ms <= (w.accAfter.get(boot) ?? -1)) continue;
            w.accAfter.set(boot, a.ms);
            if (this.onAcc) this.onAcc(a.ms, a.data, toPerf(a.t));
          }
        }
        // The once-a-second reading: heart rate, oxygen and movement, as the USB lines give them.
        const d = r.device;
        if (d && d.age_ms < 6000) {
          w.offline = 0;
          this.lastLineAt = Math.max(this.lastLineAt || 0, got - d.age_ms);
          const stamp = r.server_now - d.age_ms;
          if (stamp > w.stamp + 300) {
            w.stamp = stamp;
            const at = toPerf(stamp);
            if (d.hr && d.finger) this.onLine(`HR,${d.hr}`, at);
            if (d.spo2 && d.finger) this.onLine(`SPO2,${d.spo2}`, at);
            if (d.ax != null) this.onLine(`DATA,wifi=sent,motion=${d.motion_ok ? 'ok' : 'missing'},tilt=${d.tilt ?? ''},ax=${d.ax},ay=${d.ay},az=${d.az},pulse=${d.pulse_ok ? 'ok' : 'missing'},finger=${d.finger ? 1 : 0},hr=${d.hr || 0},spo2=${d.spo2 || 0},reps=${d.reps}`, at);
          }
        } else if (!first) w.offline++;
        // A watch that drops off Wi-Fi (a phone hotspot often does) is not given up on: polling
        // carries on, the session sees it as lost while it is gone (the camera counts alone,
        // and says so), and picks it up again the moment it is back. Only a cable can be pulled.
      } catch {
        /* the next poll tries again */
      }
      if (this.wifi === w) w.timer = setTimeout(() => this.wifiPoll(), 300);
    }

    useSim() {
      this.kind = 'sim';
    }

    // Counting with the camera. The session's form camera is always running; in this mode its
    // frames are fed in here (cameraFrame) and a rep counter turns the joint angles into the
    // same REP/PART lines the wearable sends.
    useCamera() {
      this.kind = 'camera';
      this.counter = null;
    }

    // Watch + camera together: the watch over USB as above, and the camera's rep counter
    // alongside it. The camera's lines are prefixed "CAM," so the session can tell them apart;
    // the session's fusion decides what counts.
    async useFused(connect) {
      await connect();
      this.fused = true;
      this.counter = null;
      this.lastLineAt = performance.now();
    }

    cameraFrame(f) {
      if ((this.kind !== 'camera' && !this.fused) || !this.counter || !f.angles) return;
      if (!DLMotion.countable(this.exercise, f.landmarks, f.fullBody)) return; // its joints are not in view
      if (!DLMotion.postureOk(this.exercise, DLMotion.posture(f.smooth || f.angles, f.landmarks))) return; // seated vs standing: wrong for this exercise
      const ev = this.counter.update(f.angles, f.t);
      const pre = this.fused ? 'CAM,' : '';
      if (ev && ev.type === 'rep') this.onLine(`${pre}REP,${ev.count},${ev.tempo ?? ''},${ev.rom},${ev.quality}`); // empty tempo: not known for this rep
      else if (ev) this.onLine(`${pre}PART,${ev.rom}`);
    }

    // The camera's side of EX / START / STOP. On its own it reports the set starting and
    // stopping; alongside the watch, the watch does that.
    camCommand(line) {
      const f = line.split(',');
      if (f[0] === 'EX') this.exercise = line.slice(3);
      else if (f[0] === 'START') {
        this.counter = DLMotion.SIGNALS[this.exercise] ? new DLMotion.RepCounter(this.exercise) : null;
        if (!this.fused) this.onLine('SET,START');
      } else if (f[0] === 'STOP' && this.counter) {
        const c = this.counter;
        this.counter = null;
        if (!this.fused) this.onLine(`SET,STOP,${c.count},${c.partials}`);
      }
    }

    send(line) {
      if (this.kind === 'device') {
        if (this.port && this.port.wifi) {
          this.wifi.cmds.push([this.wifi.next++, line]);
          clearTimeout(this.wifi.timer);
          this.wifiPoll(); // hand it over now rather than at the next poll
        } else this.writer.write(new TextEncoder().encode(`${line}\n`)).catch(() => this.onLine('LOST'));
        if (this.fused) this.camCommand(line);
      } else if (this.kind === 'sim') {
        this.simCommand(line);
      } else if (this.kind === 'camera') {
        this.camCommand(line);
      }
    }

    simCommand(line) {
      const f = line.split(',');
      if (f[0] === 'CFG') {
        this.cfg = { rom: +f[1], tempo: +f[2], hrMax: +f[4] };
      } else if (f[0] === 'START') {
        this.simStop();
        let n = 0;
        let parts = 0;
        let hr = Math.round((this.cfg.hrMax || 130) * 0.68);
        this.onLine('SET,START');
        const rep = () => {
          if (Math.random() < 0.1) {
            parts++;
            this.onLine(`PART,${Math.round(this.cfg.rom * 0.4)}`);
          } else {
            n++;
            const r = Math.random();
            const rom = Math.round(this.cfg.rom * (r < 0.15 ? 0.7 : 0.92 + Math.random() * 0.1));
            const tempo = Math.round(this.cfg.tempo * (r > 0.88 ? 0.5 : 0.85 + Math.random() * 0.4));
            const q = Math.round(50 * Math.min(1, rom / this.cfg.rom) + (tempo < this.cfg.tempo * 0.7 ? 15 : 30) + 16 + Math.random() * 4);
            this.onLine(`REP,${n},${tempo},${rom},${Math.min(100, q)}`);
          }
          this.timers[0] = setTimeout(rep, this.cfg.tempo * (1.1 + Math.random() * 0.5));
        };
        this.timers[0] = setTimeout(rep, 1800);
        this.timers[1] = setInterval(() => {
          hr = Math.min((this.cfg.hrMax || 130) - 4, hr + Math.round(Math.random() * 3 - 0.8));
          this.onLine(`HR,${hr}`);
        }, 2000);
        this.simCount = () => `SET,STOP,${n},${parts}`;
      } else if (f[0] === 'STOP' && this.simCount) {
        const line2 = this.simCount();
        this.simStop();
        this.onLine(line2);
      }
    }

    simStop() {
      clearTimeout(this.timers[0]);
      clearInterval(this.timers[1]);
      this.simCount = null;
    }

    // Watch + camera, after the watch is unplugged: drop the USB link, keep the camera counting.
    async dropSerial() {
      const port = this.port;
      this.port = null;
      this.kind = 'camera';
      if (this.wifi) {
        clearTimeout(this.wifi.timer);
        this.wifi = null;
      }
      if (!port || port.wifi) return;
      try {
        await this.reader.cancel();
        this.writer.releaseLock();
        await port.close();
      } catch {
        /* already gone */
      }
    }

    async close() {
      this.simStop();
      this.counter = null;
      this.fused = false;
      const port = this.port;
      this.port = null;
      this.kind = null;
      if (this.wifi) {
        clearTimeout(this.wifi.timer);
        this.wifi = null;
      }
      if (!port || port.wifi) return;
      try {
        await this.reader.cancel();
        this.writer.releaseLock();
        await port.close();
      } catch {
        /* port already gone (unplugged) */
      }
    }
  }

  // ---------- who is exercising ----------

  views.homePick = async (el) => {
    const rows = (await api('GET', '/api/participants')).filter((r) => r.dose_version);
    el.innerHTML = `
      <div class="head"><div class="eyebrow">Welcome</div><h1>Who is exercising today?</h1>
      <p>Demo: pick anyone. In service each participant signs in on their own device.</p></div>
      <div class="person-grid">${rows.map((r) => `<a class="btn person" href="#/home/${r.id}">${avatar(r.name, 'md')}<span><b>${esc(r.name)}</b><span class="muted small" style="display:block">${icon(r.mode === 'home' ? 'home' : 'building')} ${r.mode === 'home' ? 'At home' : 'In clinic'}</span></span></a>`).join('')}</div>
      ${DL.dev.on ? `<a class="btn person dev-person" href="#/home/dev/session">${icon('spark')}<span><b>Developer</b><span class="muted small" style="display:block">Any exercise · nothing saved</span></span></a>` : ''}
      <div class="card dev-card" id="dev"></div>
      <p class="staff-link"><a href="#/">${icon('building')} Staff: open the clinic view</a></p>`;
    devPanel(el.querySelector('#dev'));
  };

  // ---------- the developer person ----------
  const DEV_KEY = 'doseloop.dev.person';
  const devGet = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(`${DEV_KEY}.${k}`));
      return v == null ? d : v;
    } catch {
      return d;
    }
  };
  const devSet = (k, v) => {
    try {
      localStorage.setItem(`${DEV_KEY}.${k}`, JSON.stringify(v));
    } catch {
      /* remembered until the page reloads */
    }
  };
  function devItem(e, target, set) {
    const t = target || (e.unit === 'min' ? 2 : 10);
    return { ...e, exercise_id: e.id, target: t, sets: set, set, load: '' };
  }
  function devRemember(step) {
    devSet('exercise', step.exercise_id);
    devSet(`target.${step.exercise_id}`, step.target);
  }
  function devFusionSave(cfg) {
    devSet('fusion', cfg);
  }
  function devPlan(exercises) {
    const e = exercises.find((x) => x.id === devGet('exercise', null)) || exercises[0];
    const item = devItem(e, devGet(`target.${e.id}`, null), 1);
    return {
      participant: { id: 'dev', name: 'Developer', display_name: 'Developer', mode: 'clinic', hr_max: 130, share_feed: 0, fusion: devGet('fusion', null) },
      active: { items: [item], target_rpe: 4 },
    };
  }

  // Developer mode switch (passcode "testing"). While on, sessions record the watch and
  // camera data and can export it to Excel.
  function devPanel(box) {
    const paint = () => {
      if (DL.dev.on) {
        box.innerHTML = `<div class="row spread"><div><b>${icon('spark')} Developer mode is on</b><div class="muted small">Sessions record the watch's readings, joint angles and a pose snapshot at every rep. Download them as an Excel workbook from the session screen.</div></div><button id="dev-off" class="ghost">Turn off</button></div>`;
        box.querySelector('#dev-off').onclick = () => {
          DL.dev.disable();
          toast('Developer mode off');
          DL.render();
        };
      } else {
        box.innerHTML = `<details><summary class="muted small">Developer mode</summary>
          <form id="dev-form" class="row" style="margin-top:10px;align-items:end">
            <label style="flex:1;margin:0">Passcode<input id="dev-code" type="password" autocomplete="off" required></label>
            <button class="primary">Turn on</button>
          </form></details>`;
        box.querySelector('#dev-form').onsubmit = (ev) => {
          ev.preventDefault();
          const input = box.querySelector('#dev-code');
          if (DL.dev.enable(input.value)) {
            toast('Developer mode on');
            DL.render();
          } else {
            input.value = '';
            input.setCustomValidity('Wrong passcode');
            input.reportValidity();
            input.oninput = () => input.setCustomValidity('');
          }
        };
      }
    };
    paint();
  }

  // ---------- today's plan ----------

  views.homeDash = async (el, parts) => {
    const id = Number(parts[1]);
    const o = await api('GET', `/api/participants/${id}`);
    const p = o.participant;
    if (!o.active) throw new Error('No exercise plan has been prescribed yet. Your kinesiologist will set one up.');
    const week = o.sessions.filter((s) => Date.now() - Date.parse(s.started_at) < 7 * DAY).length;
    const freq = o.active.frequency_per_week;
    const last = o.sessions[0];
    const doneToday = last && new Date(last.started_at).toDateString() === new Date().toDateString();
    const first = p.name.split(' ')[0];
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    el.innerHTML = `
      <a class="back" href="#/home">${icon('back')} Change person</a>
      <div class="card welcome">
        <canvas class="figure welcome-fig" id="wfig"></canvas>
        <h1>${greeting}, ${esc(first)}</h1>
        <p>${doneToday ? 'You have already exercised today. Well done — rest is part of the plan.' : week >= freq ? 'You have met your goal for this week. Anything more is a bonus.' : `${freq - week} more session${freq - week === 1 ? '' : 's'} to reach this week's goal.`}</p>
        <div class="welcome-stats">
          ${ring(week / freq, { size: 96, w: 10, inner: `${week}/${freq}<small>this week</small>` })}
          <div class="wstat"><b>${icon('flame')} ${o.streak}</b><span>week${o.streak === 1 ? '' : 's'} in a row</span></div>
          <div class="wstat"><b data-count>${o.sessions.length}</b><span>sessions so far</span></div>
        </div>
      </div>

      <div class="actions">
        <a class="action primary" href="#/home/${id}/session">${icon('play')}<span><b>${doneToday ? 'Exercise again' : 'Start exercising'}</b><small>Step by step, one exercise at a time</small></span></a>
        <a class="action" href="#/home/${id}/track">${icon('camera')}<span><b>Camera coach</b><small>Just start moving. It counts for you.</small></span></a>
      </div>

      <div class="card">
        <h2>Today's exercises</h2>
        ${o.active.items.map((i, k) => `<div class="plan-item" data-k="${k}"><span class="plan-n">${k + 1}</span><div><b>${esc(i.name)}</b><div class="muted small">${esc(i.cue)}</div></div><div class="amt">${amount(i)}${i.load ? `<div class="muted small" style="font-weight:500">${esc(i.load)}</div>` : ''}</div></div>`).join('')}
        <div class="note">${icon('heart')}<span>Aim for an effort of about ${o.active.target_rpe} out of 10. Stop if you feel chest pain, dizziness or unusual shortness of breath.</span></div>
      </div>

      ${last ? `<div class="card"><h2>Last time</h2><div class="row" style="gap:18px;flex-wrap:nowrap">${ring(last.metrics.completion, { size: 72, w: 8, cls: last.metrics.completion >= 0.95 ? 'good' : 'accent', inner: `<span style="font-size:1rem">${pct(last.metrics.completion)}</span>` })}<p style="margin:0">${fmtDate(last.started_at)}: you completed <b>${pct(last.metrics.completion)}</b> of your plan${last.metrics.quality != null ? ` with a movement score of <b>${Math.round(last.metrics.quality)}</b> out of 100` : ''}.</p></div></div>` : ''}
      <div class="card" id="coach">
        <h2>${icon('spark')} Ask your coach</h2>
        <div id="coach-log" class="chat" aria-live="polite"></div>
        <form id="coach-form" class="row" style="flex-wrap:nowrap">
          <input id="coach-q" maxlength="300" placeholder="For example: How am I doing?" style="flex:1;min-width:0" aria-label="Your question">
          <button class="primary">Ask</button>
        </form>
        <p class="muted small" style="margin:10px 0 0">Your coach cannot change your plan or give medical advice. In an emergency call 911.</p>
      </div>
      <div class="card" id="feed"></div>`;

    const history = [];
    const log = el.querySelector('#coach-log');
    const drawChat = (pending) => {
      log.innerHTML = history.map((h) => `<div class="bubble ${h.role}">${esc(h.content)}${h.source ? `<div>${aiBadge(h.source, h.reason)}</div>` : ''}</div>`).join('') + (pending ? '<div class="bubble assistant muted">…</div>' : '');
      log.scrollTop = log.scrollHeight;
    };
    el.querySelector('#coach-form').onsubmit = act(async (ev) => {
      ev.preventDefault();
      const input = el.querySelector('#coach-q');
      const q = input.value.trim();
      if (!q) return;
      if (history.length >= 18) history.splice(0, history.length); // the server caps a conversation; start afresh
      history.push({ role: 'user', content: q });
      input.value = '';
      drawChat(true);
      try {
        const r = await api('POST', `/api/participants/${id}/ai/coach`, { messages: history.map(({ role, content }) => ({ role, content })) });
        history.push({ role: 'assistant', content: r.reply, source: r.source, reason: r.fallback_reason });
      } catch (e) {
        history.pop();
        input.value = q;
        throw e;
      } finally {
        drawChat(false);
      }
    });

    // The figure in the welcome card runs through today's exercises; tapping one shows it.
    const items = o.active.items;
    const fig = DL.figure(el.querySelector('#wfig'), { tone: 'dark', mode: 'loop' });
    let at = -1;
    const showItem = (k) => {
      at = k;
      fig.set(items[k].name, items[k].sensor_site);
      el.querySelectorAll('.plan-item').forEach((d) => d.classList.toggle('on', Number(d.dataset.k) === k));
    };
    showItem(0);
    let cycle = setInterval(() => showItem((at + 1) % items.length), 6400);
    el.querySelectorAll('.plan-item').forEach((d) => {
      d.onclick = () => {
        clearInterval(cycle); // the person chose one: stop cycling
        showItem(Number(d.dataset.k));
      };
    });

    await feedCard(el.querySelector('#feed'), { participantId: p.share_feed ? id : null, staffName: () => 'Guest' });
    return () => {
      clearInterval(cycle);
      fig.destroy();
    };
  };

  // ---------- community (its own tab on phones) ----------
  views.homeCommunity = async (el, parts) => {
    const id = Number(parts[1]);
    const o = await api('GET', `/api/participants/${id}`);
    el.innerHTML = `<div class="head"><div class="eyebrow">Your group</div><h1>People</h1><p>Cheer each other on. Only first names are shown.</p></div><div class="card" id="feed"></div>`;
    await feedCard(el.querySelector('#feed'), { participantId: o.participant.share_feed ? id : null, staffName: () => 'Guest' });
  };

  // ---------- guided session ----------

  const RPE = ['Nothing at all', 'Very light', 'Light', 'Moderate', 'Somewhat hard', 'Hard', 'Hard', 'Very hard', 'Very hard', 'Extremely hard', 'Maximal'];
  const PAIN = ['No pain', 'Mild', 'Mild', 'Mild', 'Moderate', 'Moderate', 'Moderate', 'Severe', 'Severe', 'Severe', 'Worst possible'];

  views.session = async (el, parts) => {
    // The developer person (developer mode): any exercise from a dropdown, as many sets as
    // wanted, and nothing saved to the database. The Excel export is the record.
    const devPerson = parts[1] === 'dev';
    if (devPerson && !DL.dev.on) throw new Error('Turn on developer mode first (on the "Who is exercising today?" screen).');
    const exercises = devPerson ? await api('GET', '/api/exercises') : null;
    const id = devPerson ? 'dev' : Number(parts[1]);
    const o = devPerson ? devPlan(exercises) : await api('GET', `/api/participants/${id}`);
    const p = o.participant;
    if (!o.active) throw new Error('No exercise plan has been prescribed yet.');
    const session = devPerson ? { id: 'dev' } : await api('POST', '/api/sessions', { participant_id: id, mode: p.mode });

    const steps = [];
    for (const it of o.active.items) for (let s = 1; s <= it.sets; s++) steps.push({ ...it, set: s });

    let idx = 0;
    let source = 'manual'; // 'device' | 'sim' | 'camera' | 'manual'; the camera is picked on open
    let cam = null; // what the camera last reported
    let camFailed = false; // the form camera could not start (refused or unavailable)
    let running = false;
    let cur = null; // live numbers for the set in progress
    let hrNow = null;
    let spo2Now = null; // blood oxygen, from a wearable with a pulse oximeter
    let timer = null;
    let closed = false;
    let lastFrac = 0; // ring position last drawn, so the arc moves on from there
    let fresh = true; // first draw of the current step
    let shown = -1; // count last drawn, so the number only "pops" when it changes
    // Watch + camera (see fusion.js): settings and calibration saved for this participant,
    // the rep matcher for the set in progress, and heart rate / oxygen read with movement.
    let fcfg = DLFusion.settings(p.fusion);
    let fusion = null;
    let fmode = 'both'; // who is counting: 'both' | 'watch' | 'camera' | 'none'
    let watchMode = 'tilt'; // how the watch counts this set: 'tilt' (range in degrees) or 'body' (sit-to-stand: rise in cm)
    let camSeenAt = -Infinity; // last frame with the whole body in view
    let calib = null; // result of the last calibration, until saved or discarded
    const bio = new DLFusion.BioMonitor(p.fusion, p.hr_max);
    let safety = { level: 'ok', reasons: [] };
    let safetyTick = null;
    let restOverride = false; // "start anyway" before heart rate has recovered
    let guard = null; // DLMotion.PositionGuard while the camera is counting a set
    let countdownShown = null; // seconds left last drawn in the out-of-position warning
    // A pause of REST_GAP_MS with no new rep (after at least one, while still in position): the
    // coach says "Take a rest.", the set ends (keeping its reps) and the next one waits
    // FATIGUE_REST_S seconds (or until "Start anyway").
    const REST_GAP_MS = 10000;
    const FATIGUE_REST_S = 60;
    let restUntil = 0; // performance.now() time the fatigue rest ends
    let restTick = null;
    // A short countdown between pressing Start and counting, to get into position.
    const GET_READY_S = 5;
    let getReady = null; // { left, timer, opts } while counting down
    const tracker = new Tracker((line, at) => !closed && onLine(line, at));
    tracker.onAcc = (ms, data, at) => rec && rec.accBatch(ms, data, at);
    if (DL.dev.on) window.__dlSession = { tracker, get rec() { return rec; }, get source() { return source; }, get running() { return running; }, get reps() { return cur ? cur.reps : null; } }; // developer mode: inspect a live session from the console
    // One canvas for the whole session; each redraw moves it back into its slot.
    const figCanvas = document.createElement('canvas');
    figCanvas.className = 'figure';
    const fig = DL.figure(figCanvas, { exercise: steps[0].name, sensor: steps[0].sensor_site, mode: 'loop' });

    // The camera view is one element for the whole session, like the figure canvas.
    const camBox = document.createElement('div');
    camBox.className = 'cam';
    camBox.innerHTML = '<video playsinline muted></video><canvas aria-hidden="true"></canvas><div class="cam-hud" hidden aria-hidden="true"><div class="hud-ex"></div><div class="hud-count"><span class="hud-n">0</span><span class="hud-of"></span></div><div class="hud-bar"><i></i></div></div><div class="cam-label" aria-live="polite"></div>';
    const camHud = camBox.querySelector('.cam-hud');
    // Developer mode: records every sensor line, joint angles and pose snapshots for export.
    const rec = DL.dev.on ? new DL.DevRecorder({ participant: p, sessionId: session.id, video: camBox.querySelector('video') }) : null;
    if (rec) rec.setContext({ exercise: steps[0].name, set: steps[0].set, running: false });
    const onSay = (text, urgent, key, spoken) => rec.log('voice', `“${text}”`, `${urgent ? 'urgent: cuts in' : key ? `kind: ${key} (replaces an older line of this kind)` : 'queued'}${spoken ? '' : '; voice coach off, not spoken'}`);
    if (rec) DL.voice.onSay = onSay;
    let endReason = null; // why the set in progress ended, for the coach log
    let gateWas = null; // what counting was doing last frame, logged when it changes
    let postureWas = null;
    // The set's count drawn over the video, so it can be read from where you exercise.
    function drawCamHud(st, popped) {
      camHud.hidden = !cur;
      if (!cur) return;
      const isMin = st.unit === 'min';
      const n = isMin ? cur.seconds : cur.reps;
      const frac = isMin ? n / (st.target * 60) : n / st.target;
      camHud.querySelector('.hud-ex').textContent = `${st.name} · set ${st.set} of ${st.sets}`;
      const num = camHud.querySelector('.hud-n');
      num.textContent = isMin ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : n;
      camHud.querySelector('.hud-of').textContent = isMin ? ` / ${st.target}:00` : ` / ${st.target}`;
      camHud.querySelector('.hud-bar i').style.width = `${Math.min(100, Math.round(frac * 100))}%`;
      camHud.classList.toggle('done', frac >= 1);
      if (popped) {
        num.classList.remove('pop');
        void num.offsetWidth;
        num.classList.add('pop');
      }
    }
    const camLabel = camBox.querySelector('.cam-label');
    const camActive = () => !!(cam && cam.active && performance.now() - cam.at < 2500);

    // ---------- form camera: always tracking limbs and joint angles, whatever is counting ----------
    // It starts with the session and runs alongside the wearable, the demo sensor or counting
    // by hand. When the camera is also chosen to count, the same frames feed the rep counter.
    const LINES_KEY = 'doseloop.formLines';
    let showLines = true;
    try {
      showLines = localStorage.getItem(LINES_KEY) !== '0';
    } catch {
      /* storage blocked: lines stay on */
    }
    // [name, left angle, right angle, left landmark, right landmark]; angles index DLMotion.frameAngles.
    const JOINTS = [['Shoulder', 6, 7, 11, 12], ['Elbow', 4, 5, 13, 14], ['Hip', 2, 3, 23, 24], ['Knee', 0, 1, 25, 26]];
    const formCard = document.createElement('div');
    formCard.className = 'card form-card';
    formCard.innerHTML = `
      <div class="row spread form-head">
        <div><h2 style="margin:0">${icon('camera')} Form camera</h2><p class="muted small form-status">Starting the camera…</p></div>
        <label class="switch"><input type="checkbox" id="form-lines" ${showLines ? 'checked' : ''}><span class="track" aria-hidden="true"></span>Show limb lines</label>
      </div>
      <div class="form-grid">
        <div class="form-cam-slot"></div>
        <table class="angles" aria-label="Joint angles in degrees">
          <thead><tr><th>Joint</th><th>Left</th><th>Right</th></tr></thead>
          <tbody>${JOINTS.map(([n]) => `<tr><th>${n}</th><td data-a="${n}L">–</td><td data-a="${n}R">–</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="form-alert" role="status" aria-live="polite" hidden></div>
      <button class="ghost form-retry" hidden>${icon('camera')} Try the camera again</button>`;
    const formStatus = formCard.querySelector('.form-status');
    const formAlert = formCard.querySelector('.form-alert');
    const formRetry = formCard.querySelector('.form-retry');
    const angleCells = Object.fromEntries([...formCard.querySelectorAll('[data-a]')].map((td) => [td.dataset.a, td]));
    const setFormStatus = (text, warn = false) => {
      formStatus.textContent = text;
      formStatus.classList.toggle('warn-text', warn);
    };
    let formCam = null; // the running camera
    let formStarting = null; // promise while it starts
    let formOff = false; // stopped for good (session over)
    let lastCamMsg = 0;
    let lastTable = 0;

    function fillAngles(f) {
      for (const [n, l, r, il, ir] of JOINTS) {
        const val = (k, i) => (f.smooth && f.landmarks && f.landmarks[i].visibility >= 0.5 ? `${Math.round(f.smooth[k])}°` : '–');
        angleCells[`${n}L`].textContent = val(l, il);
        angleCells[`${n}R`].textContent = val(r, ir);
      }
    }

    // ---------- form checks: per-exercise rules on the camera's joint angles, during a set ----------
    let formCheck = null; // DLMotion.FormChecker for the set in progress
    const lastSaid = {}; // cue id -> when it was last spoken
    const formActive = () => (formCheck ? formCheck.active() : []);

    // While a set runs the whole screen takes a tint: green, amber for a caution (a form cue,
    // fatigue, oxygen a little low, a sensor that lost track), red to stop (heart rate or
    // oxygen out of range, well past the dose).
    function tint() {
      const on = !!(running && cur && !closed && idx < steps.length);
      const cls = document.documentElement.classList;
      cls.toggle('exercising', on);
      cls.toggle('tint-alert', on && safety.level === 'stop');
      cls.toggle('tint-warn', on && safety.level === 'caution');
    }

    // One safety level from everything (fusion.js assess). New reasons are spoken once;
    // form cues are spoken by checkForm with their own timing.
    function evaluate() {
      if (!cur || closed || idx >= steps.length) {
        safety = { level: 'ok', reasons: [] };
        return tint();
      }
      const st = steps[idx];
      const t = performance.now();
      const over = st.unit === 'reps' && cur.reps > st.target * 1.2 && cur.reps - st.target >= 2;
      // In view but in the wrong posture (standing for a seated exercise, or the reverse), or not in view.
      const wrongPosture = cam && cam.visible && !DLMotion.postureOk(st.name, cam.posture);
      const outWhat = wrongPosture ? (DLMotion.SIGNALS[st.name].posture === 'seated' ? 'Please sit down for this exercise' : 'Please stand up for this exercise') : 'I can’t see you. Step back into position';
      const outReason = running && cur.outOfPosition ? [{ level: 'caution', code: 'position', text: `${outWhat}, or the set will end${guard && guard.secondsLeft(t) != null ? ` in ${guard.secondsLeft(t)} seconds` : ''}.` }] : [];
      // The pulse sensor losing contact is not said, shown or tinted (it came up too often to
      // be useful); it is only noted in the coach log.
      const bioNow = bio.reasons(t, { during: running });
      const contactLost = bioNow.some((r) => r.code === 'contact');
      if (rec && contactLost !== !!cur.contactLost) rec.log('sensors', contactLost ? 'Pulse sensor lost contact (not said aloud)' : 'Pulse sensor has contact again', contactLost ? 'pulse sensor reports no finger or wrist contact for over 5 s' : '');
      cur.contactLost = contactLost;
      const next = DLFusion.assess({
        bio: [...bioNow.filter((r) => r.code !== 'contact'), ...outReason],
        formFaults: formActive(),
        fatigue: null, // a shrinking range does not interrupt a set; a long pause between reps does (see the safety tick)
        overDose: over,
        sensors: running && source === 'fused' && fmode === 'none' ? 'none' : null,
      });
      const before = new Set(safety.reasons.map((r) => r.code));
      if (rec) {
        const nowCodes = new Set(next.reasons.map((r) => r.code));
        for (const r of next.reasons) if (!before.has(r.code)) rec.log(r.code.startsWith('form:') ? 'form' : 'safety', `${r.level === 'stop' ? 'STOP' : 'Caution'}: ${r.text}`, reasonWhy(r, t));
        for (const c of before) if (!nowCodes.has(c)) rec.log(c.startsWith('form:') ? 'form' : 'safety', `Cleared: ${c.replace('form:', 'form cue ')}`, '');
      }
      for (const r of next.reasons) if (!before.has(r.code) && !r.code.startsWith('form:') && r.code !== 'overdose') voice.say(r.text, r.level === 'stop', `safety:${r.code}`);
      const changed = next.level !== safety.level || next.reasons.map((r) => r.code).join() !== safety.reasons.map((r) => r.code).join();
      safety = next;
      cur.hrHigh = next.reasons.some((r) => r.code === 'hr');
      tint();
      return changed;
    }

    // The data behind a safety or form reason, in words, for the coach log.
    function reasonWhy(r, t) {
      const st = steps[Math.min(idx, steps.length - 1)];
      const L = formCheck && formCheck.lean;
      const leanTxt = L ? `trunk lean ${L.fwd.toFixed(1)}° forward (${L.fwdRel.toFixed(1)}° beyond rest ${L.restFwd.toFixed(1)}°), ${L.side.toFixed(1)}° sideways (${L.sideRel.toFixed(1)}° beyond rest ${L.restSide.toFixed(1)}°)` : '';
      if (r.code === 'fatigue') return `first 3 reps vs last 3: range ${r.romDrop}% smaller, quality ${r.qualityDrop} points lower, tempo ${r.slower}% slower (limits: 20% / 15 / 40%${fcfg.rateLimited ? ', lower for a heart-rate-limiting medicine' : ''})`;
      if (r.code === 'hr' || r.code === 'hr-check') return `heart rate ${hrNow} bpm, ceiling ${p.hr_max}; wrist ${bio.still(t) ? 'still (reading trusted)' : 'moving (must persist 6 s)'}`;
      if (r.code.startsWith('spo2')) return `blood oxygen ${spo2Now}% (caution under ${fcfg.spo2Caution}, stop under ${fcfg.spo2Stop})`;
      if (r.code === 'contact') return 'pulse sensor reports no finger or wrist contact for over 5 s';
      if (r.code === 'position') return cam && cam.visible ? `in view but posture is ${cam.posture}; this exercise needs ${DLMotion.SIGNALS[st.name] ? DLMotion.SIGNALS[st.name].posture : 'any'}` : 'the joints this exercise is counted from are not in view';
      if (r.code === 'overdose') return `${cur.reps} reps done, dose is ${st.target}`;
      if (r.code === 'sensors') return 'neither the watch nor the camera can follow the person';
      if (r.code.startsWith('form:')) return leanTxt || 'joint angles on this frame';
      return '';
    }

    function showForm() {
      evaluate();
      const active = formActive();
      if (formCam) formCam.setHighlight(active.flatMap((r) => r.joints));
      const st = steps[Math.min(idx, steps.length - 1)];
      if (!running || !st) formAlert.hidden = true;
      else if (!(DLMotion.FORM_RULES[st.name] || []).length) {
        formAlert.hidden = false;
        formAlert.className = 'form-alert';
        formAlert.textContent = 'No form checks for this exercise.';
      } else {
        formAlert.hidden = false;
        const judged = formCheck && formCheck.judged > 15; // about half a second of clear view
        formAlert.className = `form-alert ${active.length ? 'bad' : judged ? 'good' : ''}`;
        formAlert.textContent = active.length ? active.map((r) => r.cue).join(' · ') : judged ? '✓ Form looks good' : 'Checking your form…';
      }
    }

    function checkForm(f) {
      // Each rule checks that its own joints are clearly in view, so the whole body need not
      // be: a bicep curl can be checked from the waist up.
      if (!running || !formCheck || !f.smooth || !f.metrics) return;
      const before = formCheck.judged;
      const events = formCheck.update(f.smooth, f.metrics, f.t, f.landmarks);
      if (before <= 15 && formCheck.judged > 15 && !events.length) showForm();
      if (!events.length) return;
      if (rec) for (const ev of events) rec.cue(ev, formCheck.lean);
      for (const ev of events) {
        if (ev.type !== 'start') continue;
        cur.feedback = ['warn', ev.cue];
        if (!lastSaid[ev.id] || f.t - lastSaid[ev.id] > 6000) {
          lastSaid[ev.id] = f.t;
          voice.say(ev.cue, false, 'cue');
        }
      }
      showForm();
      pushLive('active');
      if (events.some((e) => e.type === 'start')) draw();
    }

    function onCamFrame(f) {
      if (closed) return;
      const stNow = steps[Math.min(idx, steps.length - 1)];
      const pose = DLMotion.posture(f.smooth || f.angles, f.landmarks);
      const canCount = DLMotion.countable(stNow.name, f.landmarks, f.fullBody) && DLMotion.postureOk(stNow.name, pose);
      if (canCount) camSeenAt = performance.now();
      if (fusion && running) fusion.view(performance.now(), canCount); // the watch fills in reps the camera cannot see
      if (rec && running) {
        const gate = !f.visible ? 'no person in view' : !DLMotion.countable(stNow.name, f.landmarks, f.fullBody) ? `joints not in view (needs ${NEED_TEXT[stNow.name] || 'the whole body'})` : !DLMotion.postureOk(stNow.name, pose) ? `wrong posture: ${pose}, exercise needs ${DLMotion.SIGNALS[stNow.name].posture}` : 'ok';
        if (gate !== gateWas) {
          if (gate === 'ok') rec.log('posture', 'Counting resumed', `posture ${pose}`);
          else rec.log('posture', 'Counting paused', gate);
          gateWas = gate;
        }
        if ((pose === 'seated' || pose === 'standing') && pose !== postureWas) {
          const a = f.smooth || f.angles;
          rec.log('posture', `Posture: ${pose}`, a ? `hip ${Math.round((a[2] + a[3]) / 2)}°, knee ${Math.round((a[0] + a[1]) / 2)}° (seated: hip under 135°; standing: hip over 150° and knee over 140°)` : '');
          postureWas = pose;
        }
      }
      if (rec) {
        rec.frame(f, formCheck ? formCheck.lean : null);
        devLive(f);
      }
      tracker.cameraFrame(f);
      checkForm(f);
      if (f.t - lastTable > 200) {
        lastTable = f.t;
        fillAngles(f);
      }
      if (f.t - lastCamMsg > 400) {
        lastCamMsg = f.t;
        const p = f.pred;
        cam = { visible: f.visible, full: f.fullBody, countable: canCount, posture: pose, active: p ? p.active : null, prob: p ? Math.round(p.prob * 100) : 0, label: p ? p.label : '', at: performance.now() };
        showCam();
      }
    }

    function startFormCam() {
      if (formCam) return Promise.resolve(formCam);
      if (!formStarting) {
        formStarting = (async () => {
          if (!DL.camera.supported()) throw new Error('This browser cannot use the camera.');
          formRetry.hidden = true;
          camFailed = false;
          setFormStatus('Starting the camera…');
          const c = await DL.camera.start({
            video: camBox.querySelector('video'),
            overlay: camBox.querySelector('canvas'),
            onFrame: onCamFrame,
            onStatus: (m) => m && setFormStatus(m),
            showOverlay: showLines,
            showAngles: true,
          });
          if (closed || formOff) {
            c.stop();
            throw new Error('The session has ended.');
          }
          camBox.classList.toggle('rear', !c.mirrored);
          formCam = c;
          if (rec) rec.mirrored = c.mirrored;
          setFormStatus('Tracking your limbs and joint angles. Video stays on this device.');
          return c;
        })();
        formStarting.catch((e) => {
          formStarting = null;
          if (closed || formOff) return;
          setFormStatus(e && e.name === 'NotAllowedError' ? 'Camera permission was refused, so your form is not being checked.' : `The camera could not start: ${e.message}`, true);
          formRetry.hidden = false;
          camFailed = true;
          camLabel.textContent = 'Camera off';
        });
      }
      return formStarting;
    }

    function stopFormCam() {
      formOff = true;
      if (formCam) formCam.stop();
      formCam = null;
    }

    formCard.querySelector('#form-lines').onchange = (e) => {
      showLines = e.target.checked;
      try {
        localStorage.setItem(LINES_KEY, showLines ? '1' : '0');
      } catch {
        /* not remembered, still applied */
      }
      if (formCam) formCam.setOverlay(showLines);
    };
    formRetry.onclick = () => startFormCam().catch(() => {});

    // What the camera has to see to count each exercise (DLMotion.COUNT_NEEDS), in words.
    const NEED_TEXT = {
      'Sit-to-stand': 'your shoulder, hip and knee',
      'Seated knee extension': 'your hip, knee and ankle',
      'Bicep curl': 'your shoulder, elbow and hand',
      'Lateral arm raise': 'your shoulder, elbow and hip',
      'Standing hip abduction': 'your hips, knee and ankle',
      'Wall push-up': 'your shoulder, elbow and hand',
      Stretching: 'your shoulder, elbow and hip',
    };

    function showCam() {
      const st = steps[Math.min(idx, steps.length - 1)];
      let text = '', cls = '';
      if (!cam) text = camFailed ? 'Camera off' : 'Starting the camera…';
      else if (!cam.visible) [text, cls] = ['I can’t see you yet. Step into view.', 'warn'];
      else if (!DLMotion.postureOk(st.name, cam.posture)) [text, cls] = [DLMotion.SIGNALS[st.name].posture === 'seated' ? 'Sit down for this exercise.' : 'Stand up for this exercise.', 'warn'];
      else if (!cam.countable) [text, cls] = [`Step back so I can see ${NEED_TEXT[st.name] || 'you from head to feet'}.`, 'warn'];
      else if (!cam.full && !cur) [text, cls] = ['✓ I can count this from here.', 'good'];
      else if (source === 'camera' && DLMotion.SIGNALS[st.name] && DLMotion.SIGNALS[st.name].missesSome && !cur) [text, cls] = ['The camera may miss some of these. Check the count, or use the wearable.', 'warn'];
      else if (cam.active === null) text = 'Watching…';
      else if (!cam.active) text = 'Ready. Start moving when you are.';
      else if (cam.label === st.name) [text, cls] = [`✓ ${st.name} · ${cam.prob}% sure`, 'good'];
      else if (cam.prob >= 60) [text, cls] = [`This looks like ${cam.label}. Your plan says ${st.name}.`, 'warn'];
      else text = 'Moving…';
      camLabel.textContent = text;
      camLabel.className = `cam-label ${cls}`;
    }

    const newSet = () => ({ reps: 0, partials: 0, tempo: [], rom: [], quality: [], repLog: [], hr: [], seconds: 0, feedback: null, hrHigh: false, cheered: [], cheer: null, agree: { confirmed: 0, single: 0, filled: 0 } });
    const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

    function pushLive(status) {
      if (devPerson) return;
      const st = steps[Math.min(idx, steps.length - 1)];
      api('POST', '/api/live', { participant_id: id, exercise: st.name, set: st.set, sets: st.sets, reps: st.unit === 'min' ? Math.floor(cur.seconds / 60) : cur.reps, target: st.target, quality: mean(cur.quality), hr: hrNow, status, source, form: formActive().map((r) => r.cue).join(' · ') || null }).catch(() => {});
    }

    // Encouragement part way through a set: halfway, and near the end of a long set
    // (15+ reps, or timed). Each is said once per set; a set of 3 or fewer gets none.
    const CHEERS = [[0.5, 'Good job! You’re halfway there.'], [0.9, 'Almost there. Great work!']];
    let cheerTimer = null;
    function cheerDue(st) {
      const isMin = st.unit === 'min';
      const total = isMin ? st.target * 60 : st.target;
      const n = isMin ? cur.seconds : cur.reps;
      if (!isMin && total <= 3) return null;
      let due = null;
      for (const [at, text] of CHEERS) {
        if (at === 0.9 && !isMin && total < 15) continue;
        if (n >= Math.ceil(total * at) && n < total && !cur.cheered.includes(at)) {
          cur.cheered.push(at);
          due = text;
        }
      }
      if (due) {
        cur.cheer = due;
        clearTimeout(cheerTimer);
        cheerTimer = setTimeout(() => {
          if (cur && cur.cheer === due) {
            cur.cheer = null;
            draw();
          }
        }, 3500);
      }
      return due;
    }

    // Voice coach: the count after each rep, plus the one cue that matters most. A form or
    // range warning comes before encouragement.
    function sayCount() {
      const st = steps[idx];
      const cheer = cheerDue(st);
      // Each rep's line replaces the previous rep's (key 'rep'), so the count is never stale.
      if (cur.reps === st.target) voice.say(`${cur.reps}. Dose reached. Stop here.`, false, 'rep');
      else if (cur.reps > st.target) voice.say(`${cur.reps}. Please stop.`, false, 'rep');
      else if (cur.feedback && cur.feedback[0] === 'warn') voice.say(`${cur.reps}. ${cur.feedback[1]}`, false, 'rep');
      else if (cheer) voice.say(`${cur.reps}. ${cheer}`, false, 'rep');
      else voice.say(String(cur.reps), false, 'rep');
    }

    // at: when the line happened, on this page's clock (lines relayed over Wi-Fi arrive a
    // little after); otherwise now.
    function onLine(line, at) {
      const f = line.split(',');
      const t = at ?? performance.now();
      if (rec) rec.line(line, source);
      if (f[0] === 'SPO2') {
        spo2Now = Number(f[1]) || null;
        bio.spo2(spo2Now, t);
        evaluate();
        return draw();
      }
      if (f[0] === 'HR') {
        hrNow = Number(f[1]) || null;
        if (running && hrNow) cur.hr.push(hrNow);
        bio.hr(hrNow, t);
        evaluate();
        return draw();
      }
      if (f[0] === 'MODE') {
        watchMode = f[1] === 'body' ? 'body' : 'tilt';
        if (rec) rec.log('sensors', watchMode === 'body' ? 'Watch counts this exercise from the body rising' : 'Watch counts this exercise from the wrist tilting', watchMode === 'body' ? 'standing up barely tilts the wrist; its reps report the rise in cm, not degrees' : 'its reps report the range in degrees');
        return;
      }
      if (f[0] === 'DATA') {
        // The watch's status line, once a second: its accelerometer tells the heart-rate
        // reading whether the wrist was still, and "finger" whether the pulse sensor has contact.
        const kv = Object.fromEntries(f.slice(1).map((x) => x.split('=')));
        bio.accel(Number(kv.ax), Number(kv.ay), Number(kv.az), t);
        if (kv.pulse === 'ok') bio.contact(kv.finger === '1', t);
        return;
      }
      if (f[0] === 'LOST') {
        if (source === 'fused') {
          // The camera can carry on alone.
          toast('The watch was disconnected. The camera keeps counting.', true);
          tracker.dropSerial();
          return draw();
        }
        toast('The sensor was disconnected. You can keep going by counting by hand.', true);
        tracker.close();
        source = 'manual';
        return draw();
      }
      if (f[0] === 'SET' && f[1] === 'START' && !running) {
        cancelCountdown(false);
        return beginSet(true); // button on the wearable
      }
      if (f[0] === 'SET' && f[1] === 'STOP' && running) return finishSet(true);
      if (!running) return;
      if (source === 'fused') {
        // Watch lines and camera ("CAM,") lines both go through the matcher, which says what counts.
        const cam = f[0] === 'CAM';
        const g = cam ? f.slice(1) : f;
        if (!fusion || (g[0] !== 'REP' && g[0] !== 'PART')) return;
        bio.moved(t);
        const rep = g[0] === 'PART' ? { partial: true, rom: Number(g[1]) } : { tempo: g[2] === '' ? null : Number(g[2]), rom: Number(g[3]), quality: Number(g[4]) };
        return fusedEvents(fusion.add(cam ? 'camera' : 'watch', rep, t));
      }
      if (f[0] === 'REP') {
        bio.moved(t);
        applyRep(Number(f[1]), f[2] === '' ? null : Number(f[2]), Number(f[3]), Number(f[4]));
      } else if (f[0] === 'PART') {
        bio.moved(t);
        applyPartial();
      }
    }

    // What the matcher decided: count a rep, report a shallow one, or note agreement.
    function fusedEvents(events) {
      let redraw = false;
      for (const ev of events) {
        if (ev.type === 'rep') {
          if (ev.kind === 'confirmed') cur.agree.confirmed++;
          if (ev.kind === 'filled') {
            cur.agree.filled = (cur.agree.filled || 0) + 1;
            if (rec) rec.log('sensors', `Rep ${ev.count} filled in by the watch`, `the camera could not see the joints it counts with (needs ${NEED_TEXT[steps[idx].name] || 'the whole body'}) when the watch counted it`);
          }
          applyRep(ev.count, ev.tempo, ev.rom, ev.quality, { kind: ev.kind, src: ev.src });
        } else if (ev.type === 'partial') applyPartial(ev.rom);
        else if (ev.type === 'confirm') {
          cur.agree.confirmed++;
          if (ev.late && rec) rec.log('sensors', `Rep ${ev.count} confirmed late by the camera`, 'the camera caught up on a rep the watch had filled in: counted once');
          redraw = true;
        } else if (ev.type === 'unconfirmed' || ev.type === 'possible' || ev.type === 'rejected') {
          if (rec) rec.log('sensors', ev.type === 'unconfirmed' ? `Rep ${ev.count} counted by the ${ev.src} only` : ev.type === 'possible' ? `Possible rep seen only by the ${ev.src}: not counted` : `Rep seen only by the ${ev.src}: not counted ("only reps both saw")`, `no matching rep from the other sensor within ±${fusion.windowMs} ms`);
          cur.agree.single++;
          redraw = true;
        }
      }
      if (redraw) draw();
    }

    function applyRep(count, tempo, rom, quality, how = {}) {
      const st = steps[idx];
      // From the watch counting the body rising (sit-to-stand), the range is a rise in cm:
      // the watch has already judged it (a small rise is a partial rep), and it is not
      // compared with the target in degrees or averaged with camera angles.
      const fromWatch = how.src ? how.src === 'watch' : source === 'device';
      const riseCm = fromWatch && watchMode === 'body' ? rom : null;
      if (riseCm != null) rom = null;
      cur.reps = count;
      cur.lastRepAt = performance.now();
      if (rec) rec.rep({ count, tempo, rom, quality, kind: how.kind || null, src: how.src || (source === 'device' ? 'watch' : source === 'sim' ? 'demo sensor' : source) });
      if (tempo !== null) cur.tempo.push(tempo);
      if (rom != null) cur.rom.push(rom);
      cur.quality.push(quality);
      cur.repLog.push({ rom, tempo, quality });
      // The camera's first rep of a set may be measured from part of a movement already
      // under way, so its range and pace are not judged.
      const judge = !(source === 'camera' && cur.reps === 1);
      if (!judge) cur.feedback = ['good', 'Good rep'];
      else if (rom != null && rom < st.target_rom_deg * 0.8) cur.feedback = ['warn', 'Try to move through the full range'];
      else if (tempo !== null && tempo < st.target_tempo_ms * 0.7) cur.feedback = ['warn', 'Slow down and control the movement'];
      else cur.feedback = ['good', 'Good rep'];
      const fault = formActive()[0];
      if (fault) cur.feedback = ['warn', fault.cue];
      evaluate();
      if (rec) rec.log('count', `Rep ${count} counted`, `by ${how.src || source}${how.kind ? ` (${how.kind})` : ''}; range ${riseCm != null ? `rise ${riseCm} cm (watch)` : `${rom}°`}, tempo ${tempo === null ? 'unknown' : `${tempo} ms`} (target ${st.target_tempo_ms} ms), quality ${quality}; posture ${postureWas || 'not judged'}${cur.feedback ? `; feedback: ${cur.feedback[1]}` : ''}`);
      if (!cur.fatigueStop) sayCount(); // after "Take a rest", no count for the rep that ended the set
      pushLive('active');
      draw();
    }

    function applyPartial(rom = null) {
      cur.lastRepAt = performance.now(); // still moving: a shallow rep is not a pause
      if (rec) rec.log('count', 'Partial rep, not counted', `range ${rom === null ? '?' : `${rom}°`} was under half the prescribed ${steps[idx].target_rom_deg}° or under 60% of the recent movement`);
      cur.partials++;
      cur.feedback = ['warn', 'Too shallow to count. Go a little further'];
      voice.say('Go a little further.', false, 'rep');
      draw();
    }

    // Who can count right now: the watch while its lines keep coming, the camera while it
    // sees the whole body. Said aloud when it changes, so a lost sensor is never silent.
    const FMODE_SAY = {
      watch: 'The camera can’t see you. The watch is counting.',
      camera: 'The watch has gone quiet. The camera is counting.',
      both: 'Watch and camera are both counting again.',
      none: 'I’ve lost track of you. Step into view, or count by hand.',
    };
    function fusionHealth(t) {
      if (!fusion) return false;
      fusion.setHealth({ watch: !!tracker.port && t - (tracker.lastLineAt || 0) < fcfg.watchLostMs, camera: !!formCam && t - camSeenAt < fcfg.camLostMs });
      const m = fusion.mode();
      if (m === fmode) return false;
      fmode = m;
      if (rec) rec.log('sensors', m === 'both' ? 'Watch and camera both counting' : m === 'none' ? 'Neither sensor can follow the person' : `${m === 'watch' ? 'Watch' : 'Camera'} counting alone`, `watch ${fusion.health.watch ? 'sending' : 'silent'}, camera ${fusion.health.camera ? 'sees the joints' : 'cannot see the joints'}`);
      voice.say(FMODE_SAY[m], m === 'none', 'sensors');
      return true;
    }

    // A long pause between reps: end the set (keeping the reps) and hold the next one for a rest.
    function fatigueRest() {
      if (!running || closed) return;
      restUntil = performance.now() + FATIGUE_REST_S * 1000;
      endReason = `${REST_GAP_MS / 1000} s with no new rep: ${FATIGUE_REST_S} s rest before the next set`;
      if (rec) rec.cue({ type: 'start', id: 'rest-pause', cue: `Set ended: ${REST_GAP_MS / 1000} s pause, rest ${FATIGUE_REST_S} s` }, null);
      voice.say('Take a rest.', false, 'rest');
      toast(`No rep for ${REST_GAP_MS / 1000} seconds, so the set has ended. Rest for ${FATIGUE_REST_S} seconds. The reps you did are kept.`);
      clearInterval(restTick);
      restTick = setInterval(() => {
        if (closed || running) return clearInterval(restTick);
        if (performance.now() >= restUntil) {
          clearInterval(restTick);
          restUntil = 0;
          voice.say('Rest done. Start the next set when you are ready.', false, 'rest');
          if (rec) rec.log('set', 'Rest over: Start unlocked', `${FATIGUE_REST_S} s after the fatigue callout`);
        }
        draw();
      }, 1000);
      finishSet(false);
    }

    // Out of position: a warning (counting pauses by itself, as the camera cannot see the
    // joints), back in position, or the set ending with the reps done so far kept.
    // Returns true when the set has ended.
    function positionEvent(ev) {
      if (ev === 'warn') {
        if (source !== 'fused') cur.outOfPosition = true; // watch + camera already says "lost track"
        if (rec) rec.cue({ type: 'start', id: 'out-of-position', cue: 'Out of position' }, null);
      } else if (ev === 'back') {
        cur.outOfPosition = false;
        if (source !== 'fused') voice.say('Good, I can see you again.', false, 'safety:position');
        if (rec) rec.cue({ type: 'end', id: 'out-of-position', cue: 'Back in position' }, null);
      } else if (ev === 'end') {
        endReason = `out of position for ${Math.round(guard.endMs / 1000)} s`;
        cur.outOfPosition = false;
        if (rec) rec.cue({ type: 'start', id: 'set-ended', cue: 'Set ended: out of position' }, null);
        voice.say('The set has ended because I lost sight of you. Start again when you are ready.', true);
        toast(`Set ended: out of position for ${Math.round(guard.endMs / 1000)} seconds. The reps you did are kept.`);
        finishSet(false);
        return true;
      }
      evaluate();
      draw();
      return false;
    }

    // A few times a second during a set: sensor health, reps the other sensor never
    // confirmed, and readings that only stop a set if they persist.
    function startSafetyTick() {
      clearInterval(safetyTick);
      safetyTick = setInterval(() => {
        if (closed || !running || !cur) return;
        const t = performance.now();
        let redraw = false;
        if (source === 'fused' && fusion) {
          redraw = fusionHealth(t);
          fusedEvents(fusion.tick(t));
        }
        if (guard) {
          const ok = source === 'fused' ? !!fusion && fusion.mode() !== 'none' : t - camSeenAt < 600;
          for (const ev of guard.update(ok, t)) if (positionEvent(ev)) return; // the set ended
          // Keep the countdown in the warning current (it is spoken only once).
          const sec = cur.outOfPosition ? guard.secondsLeft(t) : null;
          if (sec !== null && sec !== countdownShown) redraw = true;
          countdownShown = sec;
        }
        const stTick = steps[idx];
        const camCounting = source === 'camera' || source === 'fused';
        const inPosition = !camCounting || t - camSeenAt < 600 || (source === 'fused' && fusion && fusion.health.watch);
        // (Not once the dose is reached: stopping then is right, and Finish ends the set.)
        if (stTick && stTick.unit === 'reps' && !cur.calibrating && cur.reps >= 1 && cur.reps < stTick.target && !cur.fatigueStop && cur.lastRepAt && t - cur.lastRepAt >= REST_GAP_MS && inPosition) {
          cur.fatigueStop = true;
          return fatigueRest();
        }
        if (evaluate() || redraw) draw();
      }, 250);
    }

    // The wearable needs the exercise's targets before a set starts, including one
    // started from its own button, so they are sent whenever the step or sensor changes.
    function sendCfg() {
      const st = steps[idx];
      if (st && source === 'camera') tracker.send(`EX,${st.name}`);
      else if (st && st.unit === 'reps' && source !== 'manual') {
        tracker.send(`EX,${st.name}`); // the ESP32 wearable shows it; the STM32 one ignores it
        tracker.send(`CFG,${st.target_rom_deg},${st.target_tempo_ms},${st.target},${p.hr_max}`);
      }
    }

    // Start pressed: count down GET_READY_S seconds (spoken: "Get ready", then 3, 2, 1, "Go"),
    // then start the set. Nothing is counted during the countdown. A set started from the
    // watch's own button starts at once (the watch is already counting).
    function startCountdown(opts = {}) {
      if (running || getReady) return;
      getReady = { left: GET_READY_S, opts, timer: null };
      if (rec) rec.log('set', `Get-ready countdown: ${GET_READY_S} s`, 'nothing is counted until "Go"');
      voice.say(`Get ready. Starting in ${GET_READY_S} seconds.`, false, 'countdown');
      getReady.timer = setInterval(() => {
        if (closed || !getReady) return cancelCountdown();
        getReady.left--;
        if (getReady.left > 0 && getReady.left <= 3) voice.say(String(getReady.left), false, 'countdown');
        if (getReady.left <= 0) {
          const o = getReady.opts;
          cancelCountdown(false);
          voice.say('Go!', false, 'countdown');
          return beginSet(false, o);
        }
        draw();
      }, 1000);
      draw();
    }
    function cancelCountdown(redraw = true) {
      if (!getReady) return;
      clearInterval(getReady.timer);
      if (rec && getReady.left > 0) rec.log('set', 'Countdown cancelled', `${getReady.left} s left`);
      getReady = null;
      if (redraw && !closed) draw();
    }

    // calibrating: a short set (about 6 slow, full reps) that measures how the watch and
    // camera line up for this person and exercise. It is not saved as part of the dose.
    function beginSet(fromDevice, { calibrating = false } = {}) {
      const st = steps[idx];
      cur = newSet();
      cur.calibrating = calibrating;
      calib = null;
      restOverride = false;
      formCheck = new DLMotion.FormChecker(st.name);
      running = true;
      if (rec) rec.setContext({ exercise: st.name, set: st.set, running: true, source });
      if (rec) {
        const sig = DLMotion.SIGNALS[st.name];
        const i = formCam ? formCam.info() : {};
        rec.log('set', `Set ${st.set} started${calibrating ? ' (calibration)' : ''}${fromDevice ? ' from the watch button' : ''}`, `counting by ${source}; target ${st.target} ${st.unit}${sig ? `; posture ${sig.posture}, rest ${sig.rest || 'learned'}, counts at ${sig.countAt || 'rest'}` : ''}; camera ${i.model || 'off'}${i.gamma && i.gamma !== 'off' ? `, gamma ${i.gamma}` : ''}`);
        gateWas = null;
      }
      // The set ends if the person stays out of the camera's view (in watch + camera mode: if
      // neither sensor can follow them). Watch-only and by-hand sets have nothing to watch.
      guard = source === 'camera' || source === 'fused' ? new DLMotion.PositionGuard() : null;
      cur.outOfPosition = false;
      bio.spo2Min = null;
      safety = { level: 'ok', reasons: [] };
      if (source === 'fused') {
        fusion = new DLFusion.RepFusion(st.name, { cfg: fcfg, tempoMs: st.target_tempo_ms });
        fmode = 'both';
        fusionHealth(performance.now());
        if (fromDevice) tracker.camCommand('START'); // started from the watch's own button
      } else fusion = null;
      startSafetyTick();
      if (st.unit === 'min') {
        timer = setInterval(() => {
          if (source === 'camera' && !camActive()) return; // only time the camera sees moving counts
          cur.seconds++;
          const cheer = cheerDue(st);
          if (cheer) voice.say(cheer, false, 'cheer');
          if (cur.seconds % 60 === 0) pushLive('active');
          draw();
        }, 1000);
      } else if (source !== 'manual' && !fromDevice) {
        sendCfg();
        if (rec && DL.dev.recordMotion && (source === 'device' || source === 'fused')) tracker.send('MOTION,1');
        tracker.send('START');
      }
      pushLive('active');
      draw();
    }

    const finishSet = act(async (fromDevice) => {
      if (!running) return;
      const st = steps[idx];
      running = false;
      clearInterval(timer);
      clearInterval(safetyTick);
      if (rec) {
        rec.log('set', `Set ${st.set} ended`, `${endReason || (fromDevice === true ? 'stopped from the watch' : 'Finish pressed')}; ${st.unit === 'min' ? `${cur.seconds} s` : `${cur.reps} reps, ${cur.partials} partial`}`);
        rec.setContext({ running: false });
      }
      endReason = null;
      if (st.unit === 'reps' && source !== 'manual' && fromDevice !== true) tracker.send('STOP');
      if (rec && DL.dev.recordMotion && (source === 'device' || source === 'fused')) tracker.send('MOTION,0');
      else if (source === 'fused' && fromDevice === true) tracker.camCommand('STOP'); // stopped from the watch
      const fz = source === 'fused' && fusion ? fusion.finish() : null;
      if (fz && rec && !cur.calibrating) {
        const ft = fusion.fatigue();
        rec.log('fatigue', ft.level == null ? 'Fatigue not judged' : ft.level === 'none' ? 'No sign of fatigue' : ft.level === 'likely' ? 'Fatigue likely: both sensors saw the movement fade' : 'Fatigue possible: one sensor saw the movement fade', `${ft.text} Recorded for the clinician; not said aloud.`);
      }
      if (cur.calibrating) {
        calib = DLFusion.calibrate(fusion ? fusion.raw : {}, { exercise: st.name, tempoMs: st.target_tempo_ms, cfg: fcfg });
        voice.say(calib.ok ? 'Calibration done. Check the result and save it.' : 'Calibration did not work. Have a look at the screen.');
        fusion = null;
        cur = null;
        formCheck = null;
        shown = -1;
        lastFrac = 0;
        tint();
        return draw();
      }
      const sensed = st.unit === 'reps' && source !== 'manual';
      const done = st.unit === 'min' ? Math.round(cur.seconds / 60) : cur.reps;
      if (devPerson) {
        toast(`Set ${st.set} done: ${done} ${st.unit === 'min' ? 'min' : 'reps'} (developer: not saved)`);
        return next();
      }
      try {
        await api('POST', `/api/sessions/${session.id}/sets`, {
          exercise_id: st.exercise_id,
          set_no: st.set,
          done,
          partials: cur.partials,
          tempo_ms: sensed ? mean(cur.tempo) : null,
          rom_deg: sensed ? mean(cur.rom) : null,
          quality: sensed ? mean(cur.quality) : null,
          hr_avg: mean(cur.hr),
          hr_peak: cur.hr.length ? Math.max(...cur.hr) : null,
          source: st.unit === 'min' && source !== 'camera' ? 'manual' : source,
          // Only when the camera saw the whole body for a few seconds of the set (~30 frames/s).
          form_issues: formCheck && formCheck.rules.length && formCheck.judged >= 60 ? formCheck.counts : null,
          fusion: fz,
          spo2_min: bio.spo2Min,
        });
      } catch (e) {
        running = true; // keep the numbers on screen so the set can be saved again
        draw();
        throw e;
      }
      next();
    });

    function next() {
      if (devPerson) {
        const st = steps[0];
        steps[0] = { ...st, set: st.set + 1, sets: st.set + 1 };
        return devReset();
      }
      idx++;
      cur = null;
      fusion = null;
      calib = null;
      formCheck = null;
      shown = -1;
      lastFrac = 0;
      if (idx >= steps.length) return checkIn();
      if (rec) rec.setContext({ exercise: steps[idx].name, set: steps[idx].set, running: false });
      sendCfg();
      fresh = true;
      draw();
    }

    // Developer person: switch exercise (or target) between sets.
    function devReset() {
      cancelCountdown(false);
      cur = null;
      fusion = null;
      calib = null;
      formCheck = null;
      shown = -1;
      lastFrac = 0;
      o.active.items[0] = steps[0];
      if (rec) rec.setContext({ exercise: steps[0].name, set: steps[0].set, running: false });
      sendCfg();
      fresh = true;
      draw();
    }
    function devPicker(st) {
      return `<div class="card dev-card dev-picker" style="padding:14px 16px">
        <div class="row" style="align-items:end;gap:12px">
          <label style="flex:2;margin:0">Exercise<select id="dev-ex">${exercises.map((e) => `<option value="${e.id}" ${e.id === st.exercise_id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
          <label style="flex:1;margin:0">${st.unit === 'min' ? 'Minutes' : 'Target reps'}<input id="dev-target" type="number" min="1" max="${st.unit === 'min' ? 60 : 100}" value="${st.target}"></label>
        </div>
        <p class="muted small" style="margin:8px 0 0">Developer: pick any exercise, as many sets as you like. Nothing is saved to the database; download the Excel workbook below.</p>
      </div>`;
    }
    function wireDevPicker(root) {
      const ex = root.querySelector('#dev-ex');
      const tg = root.querySelector('#dev-target');
      if (ex)
        ex.onchange = () => {
          const e = exercises.find((x) => x.id === Number(ex.value));
          steps[0] = devItem(e, null, 1);
          devRemember(steps[0]);
          devReset();
        };
      if (tg)
        tg.onchange = () => {
          const n = Math.max(1, Math.min(steps[0].unit === 'min' ? 60 : 100, Math.round(Number(tg.value)) || steps[0].target));
          steps[0] = { ...steps[0], target: n };
          devRemember(steps[0]);
          devReset();
        };
    }

    const stepper = () => `<div class="progress-steps" aria-hidden="true">${steps.map((_, i) => `<i class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"></i>`).join('')}</div>`;

    const SOURCES = [['fused', 'sensor', 'Watch + camera'], ['camera', 'camera', 'Camera'], ['device', 'sensor', 'Wearable'], ['sim', 'spark', 'Demo sensor'], ['manual', 'hand', 'By hand']];

    // Before a set, with watch + camera: who counts this exercise, its calibration, and the
    // result of a calibration just run.
    function fusedPanel(st) {
      const m = DLFusion.exerciseSettings(fcfg, st.name, st.target_tempo_ms);
      const e = fcfg.exercises[st.name];
      let h = `<p class="muted small" style="margin:10px 4px 0">The <b>${m.primary}</b> counts this exercise and the ${m.primary === 'watch' ? 'camera' : 'watch'} checks each rep. If one loses track, the other takes over. Wear the watch snug on your wrist and stand where the camera sees all of you.</p>
        <div class="fz-cal row spread"><span class="small">${e && e.calibratedAt ? `${icon('check')} Calibrated ${fmtDate(e.calibratedAt)}` : `${icon('alert')} Not calibrated for you yet`}</span><button id="calib" class="ghost">${icon('target')} ${e && e.calibratedAt ? 'Calibrate again' : 'Calibrate'}</button></div>`;
      if (calib) {
        h += `<div class="fz-result ${calib.ok ? 'good' : 'bad'}" role="status">
          <b>${calib.ok ? 'Calibration result' : 'Calibration did not work'}</b>
          <p>${esc(calib.message)}</p>
          <dl class="kv small"><dt>Watch saw</dt><dd>${calib.watchReps} reps</dd><dt>Camera saw</dt><dd>${calib.cameraReps} reps</dd><dt>Matched</dt><dd>${calib.pairs}${calib.agreement != null ? ` (${calib.agreement}%)` : ''}</dd>
          ${calib.offsetMs != null ? `<dt>Camera delay</dt><dd>${calib.offsetMs} ms</dd><dt>Match window</dt><dd>±${calib.windowMs} ms</dd>` : ''}
          ${calib.romScale ? `<dt>Range ratio</dt><dd>${calib.romScale}</dd>` : ''}
          ${calib.suggestedPrimary ? `<dt>Best counter</dt><dd>${calib.suggestedPrimary}</dd>` : ''}</dl>
          <div class="row">${calib.ok ? `<button id="calib-save" class="primary">${icon('check')} Save calibration</button>` : ''}<button id="calib-again">Try again</button><button id="calib-drop" class="ghost">Discard</button></div>
        </div>`;
      }
      return h;
    }

    // Developer mode: what has been recorded so far, and the Excel export.
    function devCard() {
      const s = rec.stats();
      return `<div class="card dev-card" id="dev-card">
        <div class="row spread"><b>${icon('spark')} Developer mode: recording</b><button id="dev-xlsx" class="primary">${icon('download')} Download Excel</button></div>
        <p class="muted small" style="margin:8px 0">${s.watch} watch readings · ${s.lines} sensor lines · ${s.reps} reps · ${s.snaps} pose snapshots · ${s.pose} pose samples · ${s.exercises} exercise${s.exercises === 1 ? '' : 's'}</p>
        <label class="check small"><input type="checkbox" id="dev-video" ${DL.dev.withVideo ? 'checked' : ''}> Include the camera picture in new snapshots (otherwise skeleton only)</label>
        <div class="row" style="margin-top:6px"><label class="check small" style="flex:1"><input type="checkbox" id="dev-motion" ${DL.dev.recordMotion ? 'checked' : ''}> Record raw wrist motion during sets (the watch, for tuning its rep counter)</label>${s.motion ? `<button id="dev-motion-csv" class="ghost small">${icon('download')} Motion CSV (${Math.round(s.motion / 50)} s)</button>` : ''}</div>
        <div class="row dev-cam" style="margin-top:10px">
          <label class="small" style="margin:0">Camera filter (test)<select id="dev-gamma">${[['off', 'Off'], ['auto', 'Gamma: auto'], ['1.4', 'Gamma 1.4'], ['1.8', 'Gamma 1.8'], ['2.2', 'Gamma 2.2']].map(([v, t]) => `<option value="${v}" ${DL.camera.gamma() === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="small" style="margin:0">Pose model (test)<select id="dev-model">${[['auto', 'Auto (full, lite if slow)'], ['heavy', 'Heavy (30 MB)'], ['full', 'Full'], ['lite', 'Lite'], ['movenet', 'MoveNet Thunder (TensorFlow, 2D)']].map(([v, t]) => `<option value="${v}" ${DL.camera.modelChoice() === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <span class="muted small" id="dev-live">Camera: waiting for frames…</span>
        </div>
      </div>`;
    }
    // Live camera numbers on the dev card, twice a second: what the filter is doing and how sure
    // the pose model is of the body.
    let devLiveAt = 0;
    function devLive(f) {
      if (f.t - devLiveAt < 500) return;
      devLiveAt = f.t;
      const box = el.querySelector('#dev-live');
      if (!box) return;
      const L = f.light || {};
      const i = formCam ? formCam.info() : {};
      box.textContent = `Brightness ${L.mean == null ? '–' : Math.round(L.mean * 100) + '%'} · gamma ${L.gamma == null ? '–' : L.gamma.toFixed(2)}${L.filterMs != null ? ` (${L.filterMs.toFixed(1)} ms)` : ''} · joints seen ${f.visible ? Math.round((f.vis || 0) * 100) + '%' : 'no person'} · model ${i.model || '–'}${i.detectMs ? ` ${i.detectMs} ms` : ''}`;
    }
    const devDownload = act(async () => {
      const r = await rec.download();
      toast(`Saved ${r.name}`);
    });
    function wireDev(root) {
      const b = root.querySelector('#dev-xlsx');
      if (b) b.onclick = devDownload;
      const v = root.querySelector('#dev-video');
      if (v) v.onchange = () => (DL.dev.withVideo = v.checked);
      const mo = root.querySelector('#dev-motion');
      if (mo) mo.onchange = () => (DL.dev.recordMotion = mo.checked);
      const mc = root.querySelector('#dev-motion-csv');
      if (mc) mc.onclick = () => rec.downloadMotion();
      const gm = root.querySelector('#dev-gamma');
      if (gm)
        gm.onchange = () => {
          DL.camera.setGamma(gm.value); // applies to the next frame
          rec.log('camera', `Camera filter: ${gm.value === 'off' ? 'off' : `gamma ${gm.value}`}`, 'chosen on the dev card');
        };
      const md = root.querySelector('#dev-model');
      if (md)
        md.onchange = () => {
          DL.camera.setModel(md.value); // the running camera swaps once the model has loaded
          rec.log('camera', `Pose model: ${md.value}`, 'chosen on the dev card; swaps once loaded');
          if (md.value === 'heavy') toast('Loading the heavy model (30 MB, first time only)…');
          if (md.value === 'movenet') toast('Loading TensorFlow.js and MoveNet (about 13 MB, first time only). 2D only: no heel raises, no swing cue.');
        };
    }

    // During a set with watch + camera: who is counting and how well they agree.
    function fusedStatus() {
      if (!fusion) return '';
      const ok = (s) => fusion.health[s];
      const a = cur.agree;
      const seen = a.confirmed + a.single;
      return `<div class="fz-status ${fmode === 'none' ? 'bad' : fmode !== 'both' ? 'warn' : ''}" aria-live="polite">
        <span class="${ok('watch') ? 'on' : 'off'}">${icon('sensor')} Watch${tracker.port && tracker.port.wifi ? ' (Wi-Fi)' : ''} ${ok('watch') ? '✓' : 'lost'}</span>
        <span class="${ok('camera') ? 'on' : 'off'}">${icon('camera')} Camera ${ok('camera') ? '✓' : 'can’t see you'}</span>
        <span class="muted">${fmode === 'both' ? `${fusion.primary} counts` : fmode === 'none' ? 'nobody can count' : `${fmode} counting alone`}${seen ? ` · ${a.confirmed} of ${seen} reps seen by both` : ''}${a.filled ? ` · ${a.filled} filled in by the watch` : ''}</span>
      </div>`;
    }

    function draw() {
      if (closed || idx >= steps.length) return;
      const st = steps[idx];
      const isMin = st.unit === 'min';
      const n = cur ? (isMin ? cur.seconds : cur.reps) : 0;
      const frac = isMin ? n / (st.target * 60) : n / st.target;
      const reached = cur && frac >= 1;
      const over = cur && !isMin && cur.reps > st.target * 1.2 && cur.reps - st.target >= 2;
      const mmss = `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
      const popped = !isMin && n !== shown && n > 0;
      shown = n;
      const fromFrac = lastFrac;
      lastFrac = frac;
      const rest = idx > 0 || cur ? bio.recovery() : null;
      const fatigueLeft = restUntil > performance.now() ? Math.ceil((restUntil - performance.now()) / 1000) : 0;
      const mmssOf = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      // Before a set the demo figure shows how the exercise is done; once the camera is counting,
      // its video takes the stage (and the figure gives way). Otherwise the video sits in the
      // form camera card below.
      const camStage = source === 'camera' && running;
      const fb = cur && cur.calibrating && !cur.feedback ? `<div class="feedback idle">Calibrating: do 6 slow, full reps, then tap Finish</div>` : cur && cur.feedback ?`<div class="feedback ${cur.feedback[0]}">${icon(cur.feedback[0] === 'good' ? 'check' : 'alert')} ${esc(cur.feedback[1])}</div>` : `<div class="feedback idle">${running ? (isMin ? 'Keep a steady, comfortable pace' : source === 'manual' ? 'Tap +1 after each repetition' : 'Begin when you are ready') : 'Ready when you are'}</div>`;

      el.innerHTML = `
        ${stepper()}
        <div>
          <div class="row spread"><div class="eyebrow" style="margin:0">${devPerson ? `Developer · set ${st.set}` : `Exercise ${o.active.items.findIndex((i) => i.exercise_id === st.exercise_id) + 1} of ${o.active.items.length} · set ${st.set} of ${st.sets}`}</div><span class="row">${hrNow ? `<span class="hr ${hrNow > p.hr_max ? 'alert' : ''}">${icon('heart')}${hrNow} bpm</span>` : ''}${spo2Now ? `<span class="hr ${spo2Now < 90 ? 'alert' : ''}" title="Blood oxygen">O₂ ${spo2Now}%</span>` : ''}${voice.supported ? `<button id="voice" class="voice ${voice.on ? 'on' : ''}" aria-pressed="${voice.on}" aria-label="Voice coach">${icon(voice.on ? 'volume' : 'mute')} Voice</button>` : ''}</span></div>
          <h1 style="margin:6px 0 8px">${esc(st.name)}</h1>
          <p class="muted">${esc(st.cue)}${st.load ? ` <b style="color:var(--ink)">${esc(st.load)}.</b>` : ''}</p>
        </div>

        ${cur && cur.cheer ? `<div class="cheer" role="status">${icon('spark')} ${esc(cur.cheer)}</div>` : ''}
        ${(() => {
          // The most serious safety reason that is not already shown elsewhere (form cues
          // are in the feedback line, the dose banner is below).
          const r = running && safety.reasons.find((x) => !x.code.startsWith('form:') && x.code !== 'overdose');
          return r ? `<div class="banner ${r.level === 'stop' ? 'alert' : 'warn'}" role="alert">${icon(r.code.startsWith('hr') ? 'heart' : 'alert')}<span>${esc(r.text)}</span></div>` : '';
        })()}
        ${!running && fatigueLeft && !restOverride ? `<div class="banner warn" role="status">${icon('pause')}<span>Take a rest. The next set can start in ${mmssOf(fatigueLeft)}.</span></div>` : ''}
        ${!running && !fatigueLeft && rest && !rest.ready && !restOverride ? `<div class="banner warn" role="status">${icon('heart')}<span>Rest a little longer: heart rate ${rest.hr} bpm. Start the next set when it is under ${rest.under}.</span></div>` : ''}
        ${over ? `<div class="banner alert" role="alert">${icon('alert')}<span>You are well past your dose. Please stop this set now.</span></div>` : reached ? `<div class="banner good" role="status">${icon('check')}<span>Dose reached. ${isMin ? 'You can stop here.' : 'Stop here and finish the set.'}</span></div>` : ''}

        ${devPerson && !running ? devPicker(st) : ''}
        ${
          !running
            ? `<div class="card" style="padding:16px"><h3 style="margin:2px 4px 10px">${isMin ? 'How shall we time it?' : 'How shall we count?'}</h3>
            <div class="seg" role="group" aria-label="Counting method">${(isMin ? SOURCES.filter(([k]) => k === 'camera' || k === 'manual').map(([k, ic, t]) => [k, ic, k === 'manual' ? 'Timer' : t]) : SOURCES).map(([k, ic, t]) => `<button data-src="${k}" class="${source === k ? 'on' : ''}" aria-pressed="${source === k}">${icon(ic)}${t}</button>`).join('')}</div>
            ${source === 'fused' && !isMin ? fusedPanel(st) : ''}
            <p class="muted small" style="margin:10px 4px 0" ${source === 'fused' && !isMin ? 'hidden' : ''}>${
              source === 'camera'
                ? `The camera watches the movement and counts for you. Prop your phone up so your whole body is in view. <b>Video stays on this device</b>; only joint angles are used.`
                : isMin
                  ? 'A timer counts your minutes.'
                  : source === 'device'
                ? `Sensor connected. Strap it to your <b>${esc((st.sensor_site || 'limb').toLowerCase())}</b>, keep still for a second, then start.`
                : source === 'sim'
                  ? 'A simulated sensor, for trying the app without hardware.'
                  : 'You count: tap +1 after each repetition.'
            }</p></div>`
            : ''
        }

        <div class="card stage">
          <div class="stage-grid">${fig.ok || camStage ? `<div id="fig-slot" class="fig-slot ${camStage ? 'cam-slot' : ''}"></div>` : ''}<div aria-live="polite">${ring(frac, { size: 250, w: 18, cls: (over ? 'alert' : reached ? 'good' : 'accent') + (popped ? ' pulse' : ''), from: fromFrac, inner: `<span class="n ${isMin ? 'time' : ''} ${popped ? 'pop' : ''}">${isMin ? mmss : n}</span><span class="of">of ${isMin ? `${st.target} min` : `${st.target} reps`}</span>` })}</div>
          </div>
          ${running && source === 'fused' ? fusedStatus() : ''}
          <div>${fb}</div>
          ${
            !running
              ? (fatigueLeft || (rest && !rest.ready)) && !restOverride
                ? `<button class="big" id="go" disabled>${icon(fatigueLeft ? 'pause' : 'heart')} Resting… ${fatigueLeft ? mmssOf(fatigueLeft) : `${rest.hr} bpm`}</button><p style="text-align:center;margin:8px 0 0"><button id="go-anyway" class="ghost small">Start anyway</button></p>`
                : getReady
                  ? `<div class="get-ready" role="status" aria-live="assertive"><span>Get into position</span><b>${getReady.left}</b></div><p style="text-align:center;margin:8px 0 0"><button id="go-cancel" class="ghost">Cancel</button></p>`
                  : `<button class="primary big" id="go">${icon('play')} Start ${isMin ? 'timer' : 'set'}</button>`
              : `${!isMin && source === 'manual' ? '<div class="row" style="margin-bottom:12px;flex-wrap:nowrap"><button id="minus" style="flex:1" aria-label="Remove one repetition">−1</button><button class="primary" id="plus" style="flex:3;font-size:1.7rem">+1</button></div>' : ''}
                 ${isMin ? `<p><button id="plusmin" class="ghost">${icon('plus')} Add 1 minute done away from the screen</button></p>` : ''}
                 <button class="${reached || (cur && cur.calibrating) ? 'primary ' : ''}big" id="finish">${icon('check')} Finish ${cur && cur.calibrating ? 'calibration' : isMin ? '' : 'set'}</button>`
          }
        </div>
        <div id="form-slot"></div>
        ${rec ? devCard() : ''}
        ${!running ? `<p style="text-align:center"><button id="skip" class="ghost">Skip this set ${icon('next')}</button> <button id="quit" class="ghost danger">End session early</button></p>` : ''}`;
      // Before a set the figure demonstrates the movement on a loop; during a counted
      // set it performs one repetition each time a rep is counted.
      // The camera video sits in the stage when it is counting, otherwise in the form camera card.
      const slot = el.querySelector('#fig-slot');
      if (slot) slot.appendChild(camStage ? camBox : figCanvas);
      el.querySelector('#form-slot').replaceWith(formCard);
      if (!camStage) formCard.querySelector('.form-cam-slot').appendChild(camBox);
      camBox.classList.toggle('form', !camStage);
      showCam();
      showForm();
      if (camStage) drawCamHud(st, popped);
      else camHud.hidden = true;
      fig.set(st.name, source === 'manual' ? '' : st.sensor_site);
      fig.mode(running && !isMin ? 'manual' : 'loop');
      if (popped) fig.pulse(Math.min(st.target_tempo_ms || 2000, 1600));
      // Only the first draw of a step animates in; redraws during a set must not replay it.
      el.classList.toggle('still', !fresh);
      tint();
      fresh = false;

      el.querySelectorAll('[data-src]').forEach((b) => (b.onclick = act(() => pickSource(b.dataset.src))));
      const on = (sel, fn) => {
        const b = el.querySelector(sel);
        if (b) b.onclick = fn;
      };
      if (rec) wireDev(el);
      if (devPerson) wireDevPicker(el);
      on('#go', () => startCountdown());
      on('#go-cancel', () => cancelCountdown());
      on('#go-anyway', () => {
        restOverride = true;
        restUntil = 0;
        clearInterval(restTick);
        draw();
      });
      on('#finish', () => finishSet(false));
      on('#calib', () => startCountdown({ calibrating: true }));
      on('#calib-again', () => startCountdown({ calibrating: true }));
      on('#calib-drop', () => {
        calib = null;
        draw();
      });
      on(
        '#calib-save',
        act(async () => {
          const saved = DLFusion.applyCalibration(p.fusion, calib);
          if (devPerson) devFusionSave(saved);
          else await api('PUT', `/api/participants/${id}/fusion`, { settings: saved, calibrated: st.name });
          p.fusion = saved;
          fcfg = DLFusion.settings(saved);
          bio.cfg = fcfg;
          calib = null;
          toast(`Calibration saved for ${st.name}`);
          draw();
        })
      );
      on('#voice', () => {
        voice.on = !voice.on;
        voice.say('Voice coach on. I will count your repetitions.');
        draw();
      });
      on('#plus', () => {
        cur.reps++;
        cur.lastRepAt = performance.now();
        cur.feedback = null;
        if (rec) rec.log('count', `Rep ${cur.reps} counted`, 'by hand (+1)');
        if (rec) rec.rep({ count: cur.reps, src: 'by hand' });
        sayCount();
        pushLive('active');
        draw();
        el.querySelector('#plus').focus();
      });
      on('#minus', () => {
        cur.reps = Math.max(0, cur.reps - 1);
        draw();
      });
      on('#plusmin', () => {
        cur.seconds += 60;
        draw();
      });
      on('#skip', next);
      on('#quit', checkIn);
    }

    // The watch: over Wi-Fi when one is online (no cable; works on phones and the hosted app),
    // otherwise over USB.
    async function connectWatch() {
      try {
        await tracker.connectWifi();
        toast(`Watch connected over Wi-Fi (${tracker.port.id})`);
        if (rec) rec.log('sensors', `Watch connected over Wi-Fi: ${tracker.port.id}`, 'its lines are relayed by the server a few times a second');
        return;
      } catch (e) {
        if (e.name !== 'NoWifiWatch') throw e;
      }
      if (!Tracker.serialSupported) {
        const e = new Error('No watch is online over Wi-Fi. Turn on the watch’s Wi-Fi (tap the pill at the top of its screen) and wait for its dot to turn green, then try again.');
        e.name = 'NoWatch';
        throw e;
      }
      await tracker.connectSerial();
      if (rec) rec.log('sensors', 'Watch connected over USB', 'no watch was online over Wi-Fi');
    }

    async function pickSource(nextSource) {
      cancelCountdown(false);
      if (nextSource === source) return;
      if (nextSource === 'camera') {
        if (!DL.camera.supported()) throw new Error('This browser cannot use the camera. Try Chrome or Safari on your phone.');
        await tracker.close();
        hrNow = null;
        source = 'camera';
        draw(); // show the camera panel while it starts
        try {
          await startFormCam();
        } catch (e) {
          source = 'manual';
          draw();
          throw new Error(e && e.name === 'NotAllowedError' ? 'Camera permission was refused. You can count by hand instead.' : `The camera could not start: ${e.message}`);
        }
        if (closed) return;
        tracker.useCamera();
      } else if (nextSource === 'fused') {
        await tracker.close();
        try {
          await tracker.useFused(connectWatch);
        } catch (e) {
          if (e.name === 'NotFoundError') return; // chooser dismissed
          throw e.name === 'NoWatch' ? e : new Error('Could not open the watch. Check the USB cable and that no other program is using it.');
        }
        // The camera is usually already running for form checks; if it cannot start, the
        // watch counts alone and the status line says so.
        startFormCam().catch(() => toast('The camera could not start, so the watch counts alone.', true));
      } else if (nextSource === 'device') {
        await tracker.close();
        try {
          await connectWatch();
        } catch (e) {
          if (e.name === 'NotFoundError') return; // chooser dismissed
          throw e.name === 'NoWatch' ? e : new Error('Could not open the sensor. Check the USB cable and that no other program is using it.');
        }
      } else {
        await tracker.close();
        hrNow = null;
        if (nextSource === 'sim') tracker.useSim();
      }
      source = nextSource;
      sendCfg();
      draw();
    }

    function checkIn() {
      if (devPerson) {
        running = false;
        clearInterval(safetyTick);
        tint();
        stopFormCam();
        el.innerHTML = `<div class="head"><div class="eyebrow">Developer</div><h1>Session ended</h1><p>Nothing was saved to the database. Download the workbook to keep what was recorded.</p></div>
          ${rec ? devCard() : ''}
          <p><a class="btn primary big" href="#/home">Done</a></p>`;
        if (rec) wireDev(el);
        return;
      }
      idx = steps.length;
      running = false;
      clearInterval(safetyTick);
      tint();
      stopFormCam();
      el.classList.remove('still');
      let rpe = null;
      let pain = null;
      // Green at 0 through to red at 10.
      const scale = (name, labels) => `<div class="scale" role="group" aria-label="${name}">${labels.map((l, i) => `<button type="button" data-${name}="${i}" style="--c:hsl(${Math.round(150 - i * 15)} 58% 38%)" aria-label="${i}: ${l}">${i}</button>`).join('')}</div>`;
      el.innerHTML = `
        <div class="progress-steps" aria-hidden="true">${steps.map(() => '<i class="done"></i>').join('')}</div>
        <div class="head"><div class="eyebrow">Almost done</div><h1>How did that feel?</h1></div>
        <div class="card"><h2>How hard was it overall?</h2>${scale('rpe', RPE)}<div class="scale-label muted" id="rpe-label">0 is nothing at all, 10 is the hardest you can imagine</div></div>
        <div class="card"><h2>Any pain while exercising?</h2>${scale('pain', PAIN)}<div class="scale-label muted" id="pain-label">0 is no pain, 10 is the worst possible</div></div>
        <div class="card">
          <label>Anything your kinesiologist should know? (optional)<textarea id="notes" maxlength="500"></textarea></label>
          ${p.share_feed ? '<label class="check"><input type="checkbox" id="share" checked> Tell the group I finished</label>' : ''}
        </div>
        <button class="primary big" id="save" disabled>${icon('check')} Save session</button>
        ${rec ? devCard() : ''}`;
      if (rec) wireDev(el);
      const save = el.querySelector('#save');
      const pick = (name, labels, set) =>
        el.querySelectorAll(`[data-${name}]`).forEach((b) => {
          b.onclick = () => {
            const v = Number(b.dataset[name]);
            set(v);
            el.querySelectorAll(`[data-${name}]`).forEach((x) => {
              x.classList.toggle('on', x === b);
              x.setAttribute('aria-pressed', x === b);
            });
            const lbl = el.querySelector(`#${name}-label`);
            lbl.textContent = `${v} – ${labels[v]}`;
            lbl.classList.remove('muted');
            save.disabled = rpe == null || pain == null;
          };
        });
      pick('rpe', RPE, (v) => (rpe = v));
      pick('pain', PAIN, (v) => (pain = v));
      save.onclick = act(async () => {
        save.disabled = true;
        try {
          const share = el.querySelector('#share');
          const out = await api('POST', `/api/sessions/${session.id}/finish`, { rpe, pain, notes: el.querySelector('#notes').value, share: !!(share && share.checked) });
          summary(out, pain);
        } catch (e) {
          save.disabled = false;
          throw e;
        }
      });
    }

    function summary(out, pain) {
      const c = out.metrics.completion;
      const msg = c >= 0.95 ? 'You completed your full plan.' : c >= 0.7 ? 'You completed most of your plan.' : 'You did part of your plan today. Every bit counts.';
      el.innerHTML = `
        <div class="card" style="text-align:center;padding:34px 24px">
          <div class="done-badge">${icon('check')}</div>
          <div class="eyebrow">Session saved</div>
          <h1>${msg}</h1>
          <div class="result-grid">
            <div class="result"><b>${pct(c)}</b><span>of your plan</span></div>
            ${out.metrics.quality != null ? `<div class="result"><b>${Math.round(out.metrics.quality)}</b><span>movement score</span></div>` : ''}
            <div class="result"><b>${out.sessions_total}</b><span>sessions so far</span></div>
            <div class="result"><b>${icon('flame')} ${out.streak}</b><span>week${out.streak === 1 ? '' : 's'} in a row</span></div>
          </div>
        </div>
        ${out.metrics.over ? `<div class="banner warn">${icon('alert')}<span>You did more than your plan asked for. More is not always better — your plan is set to keep you safe.</span></div>` : ''}
        ${pain >= 5 ? `<div class="banner alert">${icon('alert')}<span>You reported significant pain. It is flagged for your kinesiologist, who will review your plan. If the pain is severe or does not settle, contact your doctor.</span></div>` : ''}
        <div class="card" id="coach-msg" hidden></div>
        <a class="btn primary big" href="#/home/${id}">Done</a>
        ${rec ? devCard() : ''}`;
      if (rec) wireDev(el);
      if (c >= 0.7) DL.confetti();
      // A short message from the coach; the summary above never waits for it.
      api('POST', `/api/participants/${id}/ai/coach`, { messages: [] })
        .then((r) => {
          const box = el.querySelector('#coach-msg');
          if (closed || !box) return;
          box.hidden = false;
          box.innerHTML = `<h2>${icon('spark')} From your coach</h2><p style="font-size:1.1em">${esc(r.reply)}</p>${aiBadge(r.source, r.fallback_reason)}`;
          voice.say(r.reply);
        })
        .catch(() => {});
    }

    cur = null;
    draw();
    // Reps are counted by the camera unless it cannot start; then counting by hand is the
    // fallback, and the form camera card says why and offers to try again.
    if (DL.camera.supported()) pickSource('camera').catch((e) => toast(e.message, true));
    else startFormCam().catch(() => {});
    return () => {
      closed = true;
      cancelCountdown(false);
      if (DL.voice.onSay === onSay) DL.voice.onSay = null;
      clearInterval(restTick);
      clearTimeout(cheerTimer);
      clearInterval(safetyTick);
      document.documentElement.classList.remove('exercising', 'tint-warn', 'tint-alert');
      stopFormCam();
      fig.destroy();
      clearInterval(timer);
      tracker.close();
    };
  };
})();
