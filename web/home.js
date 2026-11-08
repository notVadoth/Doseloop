'use strict';
// Participant views: choose who is exercising, today's plan, and the guided session.
(() => {
  const { views, esc, pct, fmtDate, amount, api, toast, act, icon, avatar, ring, feedCard, aiBadge, voice } = DL;
  const DAY = 86400000;

  // ---------- tracker: the wearable over Web Serial, or a built-in demo sensor ----------
  // Both speak the firmware's line protocol, so the session code cannot tell them apart.

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
            if (line) this.onLine(line);
          }
        }
      } catch {
        this.onLine('LOST');
      }
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

    cameraFrame(f) {
      if (this.kind !== 'camera' || !this.counter || !f.fullBody || !f.angles) return;
      const ev = this.counter.update(f.angles, f.t);
      if (ev && ev.type === 'rep') this.onLine(`REP,${ev.count},${ev.tempo},${ev.rom},${ev.quality}`);
      else if (ev) this.onLine(`PART,${ev.rom}`);
    }

    send(line) {
      if (this.kind === 'device') {
        this.writer.write(new TextEncoder().encode(`${line}\n`)).catch(() => this.onLine('LOST'));
      } else if (this.kind === 'sim') {
        this.simCommand(line);
      } else if (this.kind === 'camera') {
        const f = line.split(',');
        if (f[0] === 'EX') this.exercise = line.slice(3);
        else if (f[0] === 'START') {
          this.counter = DLMotion.SIGNALS[this.exercise] ? new DLMotion.RepCounter(this.exercise) : null;
          this.onLine('SET,START');
        } else if (f[0] === 'STOP' && this.counter) {
          const c = this.counter;
          this.counter = null;
          this.onLine(`SET,STOP,${c.count},${c.partials}`);
        }
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

    async close() {
      this.simStop();
      this.counter = null;
      const port = this.port;
      this.port = null;
      this.kind = null;
      if (!port) return;
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
      <div class="person-grid">${rows.map((r) => `<a class="btn person" href="#/home/${r.id}">${avatar(r.name, 'md')}<span><b>${esc(r.name)}</b><span class="muted small" style="display:block">${icon(r.mode === 'home' ? 'home' : 'building')} ${r.mode === 'home' ? 'At home' : 'In clinic'}</span></span></a>`).join('')}</div>`;
  };

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
    const id = Number(parts[1]);
    const o = await api('GET', `/api/participants/${id}`);
    const p = o.participant;
    if (!o.active) throw new Error('No exercise plan has been prescribed yet.');
    const session = await api('POST', '/api/sessions', { participant_id: id, mode: p.mode });

    const steps = [];
    for (const it of o.active.items) for (let s = 1; s <= it.sets; s++) steps.push({ ...it, set: s });

    let idx = 0;
    let source = 'manual'; // 'device' | 'sim' | 'camera' | 'manual'
    let cam = null; // what the camera last reported
    let running = false;
    let cur = null; // live numbers for the set in progress
    let hrNow = null;
    let spo2Now = null; // blood oxygen, from a wearable with a pulse oximeter
    let timer = null;
    let closed = false;
    let lastFrac = 0; // ring position last drawn, so the arc moves on from there
    let fresh = true; // first draw of the current step
    let shown = -1; // count last drawn, so the number only "pops" when it changes
    const tracker = new Tracker((line) => !closed && onLine(line));
    // One canvas for the whole session; each redraw moves it back into its slot.
    const figCanvas = document.createElement('canvas');
    figCanvas.className = 'figure';
    const fig = DL.figure(figCanvas, { exercise: steps[0].name, sensor: steps[0].sensor_site, mode: 'loop' });

    // The camera view is one element for the whole session, like the figure canvas.
    const camBox = document.createElement('div');
    camBox.className = 'cam';
    camBox.innerHTML = '<video playsinline muted></video><canvas aria-hidden="true"></canvas><div class="cam-hud" hidden aria-hidden="true"><div class="hud-ex"></div><div class="hud-count"><span class="hud-n">0</span><span class="hud-of"></span></div><div class="hud-bar"><i></i></div></div><div class="cam-label" aria-live="polite"></div>';
    const camHud = camBox.querySelector('.cam-hud');
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
      <button class="ghost form-retry" hidden>${icon('camera')} Try the camera again</button>`;
    const formStatus = formCard.querySelector('.form-status');
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
        const val = (k, i) => (f.angles && f.landmarks && f.landmarks[i].visibility >= 0.5 ? `${Math.round(f.angles[k])}°` : '–');
        angleCells[`${n}L`].textContent = val(l, il);
        angleCells[`${n}R`].textContent = val(r, ir);
      }
    }

    function onCamFrame(f) {
      if (closed) return;
      tracker.cameraFrame(f);
      if (f.t - lastTable > 200) {
        lastTable = f.t;
        fillAngles(f);
      }
      if (f.t - lastCamMsg > 400) {
        lastCamMsg = f.t;
        const p = f.pred;
        cam = { visible: f.visible, full: f.fullBody, active: p ? p.active : null, prob: p ? Math.round(p.prob * 100) : 0, label: p ? p.label : '', at: performance.now() };
        showCam();
      }
    }

    function startFormCam() {
      if (formCam) return Promise.resolve(formCam);
      if (!formStarting) {
        formStarting = (async () => {
          if (!DL.camera.supported()) throw new Error('This browser cannot use the camera.');
          formRetry.hidden = true;
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
          setFormStatus('Tracking your limbs and joint angles. Video stays on this device.');
          return c;
        })();
        formStarting.catch((e) => {
          formStarting = null;
          if (closed || formOff) return;
          setFormStatus(e && e.name === 'NotAllowedError' ? 'Camera permission was refused, so your form is not being checked.' : `The camera could not start: ${e.message}`, true);
          formRetry.hidden = false;
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

    function showCam() {
      const st = steps[Math.min(idx, steps.length - 1)];
      let text = '', cls = '';
      if (!cam) text = 'Starting the camera…';
      else if (!cam.visible) [text, cls] = ['I can’t see you yet. Step into view.', 'warn'];
      else if (!cam.full) [text, cls] = ['Step back so I can see you from head to feet.', 'warn'];
      else if (source === 'camera' && DLMotion.SIGNALS[st.name] && DLMotion.SIGNALS[st.name].missesSome && !cur) [text, cls] = ['The camera may miss some of these. Check the count, or use the wearable.', 'warn'];
      else if (cam.active === null) text = 'Watching…';
      else if (!cam.active) text = 'Ready. Start moving when you are.';
      else if (cam.label === st.name) [text, cls] = [`✓ ${st.name} · ${cam.prob}% sure`, 'good'];
      else if (cam.prob >= 60) [text, cls] = [`This looks like ${cam.label}. Your plan says ${st.name}.`, 'warn'];
      else text = 'Moving…';
      camLabel.textContent = text;
      camLabel.className = `cam-label ${cls}`;
    }

    const newSet = () => ({ reps: 0, partials: 0, tempo: [], rom: [], quality: [], hr: [], seconds: 0, feedback: null, hrHigh: false });
    const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

    function pushLive(status) {
      const st = steps[Math.min(idx, steps.length - 1)];
      api('POST', '/api/live', { participant_id: id, exercise: st.name, set: st.set, sets: st.sets, reps: st.unit === 'min' ? Math.floor(cur.seconds / 60) : cur.reps, target: st.target, quality: mean(cur.quality), hr: hrNow, status, source }).catch(() => {});
    }

    // Voice coach: the count after each rep, plus the one cue that matters most.
    function sayCount() {
      const st = steps[idx];
      if (cur.reps === st.target) voice.say(`${cur.reps}. Dose reached. Stop here.`);
      else if (cur.reps > st.target) voice.say(`${cur.reps}. Please stop.`);
      else if (cur.feedback && cur.feedback[0] === 'warn') voice.say(`${cur.reps}. ${cur.feedback[1]}`);
      else voice.say(String(cur.reps));
    }

    function onLine(line) {
      const f = line.split(',');
      if (f[0] === 'SPO2') {
        spo2Now = Number(f[1]) || null;
        return draw();
      }
      if (f[0] === 'HR') {
        hrNow = Number(f[1]) || null;
        if (running && hrNow) cur.hr.push(hrNow);
        if (hrNow && hrNow > p.hr_max && cur) {
          if (!cur.hrHigh) voice.say('Your heart rate is high. Stop and rest.', true);
          cur.hrHigh = true;
        }
        if (hrNow && hrNow <= p.hr_max - 5 && cur) cur.hrHigh = false;
        return draw();
      }
      if (f[0] === 'LOST') {
        toast('The sensor was disconnected. You can keep going by counting by hand.', true);
        tracker.close();
        source = 'manual';
        return draw();
      }
      if (f[0] === 'SET' && f[1] === 'START' && !running) return beginSet(true); // button on the wearable
      if (f[0] === 'SET' && f[1] === 'STOP' && running) return finishSet(true);
      if (!running) return;
      const st = steps[idx];
      if (f[0] === 'REP') {
        cur.reps = Number(f[1]);
        cur.tempo.push(Number(f[2]));
        cur.rom.push(Number(f[3]));
        cur.quality.push(Number(f[4]));
        if (Number(f[3]) < st.target_rom_deg * 0.8) cur.feedback = ['warn', 'Try to move through the full range'];
        else if (Number(f[2]) < st.target_tempo_ms * 0.7) cur.feedback = ['warn', 'Slow down and control the movement'];
        else cur.feedback = ['good', 'Good rep'];
        sayCount();
        pushLive('active');
        draw();
      } else if (f[0] === 'PART') {
        cur.partials++;
        cur.feedback = ['warn', 'Too shallow to count. Go a little further'];
        voice.say('Go a little further.');
        draw();
      }
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

    function beginSet(fromDevice) {
      const st = steps[idx];
      cur = newSet();
      running = true;
      if (st.unit === 'min') {
        timer = setInterval(() => {
          if (source === 'camera' && !camActive()) return; // only time the camera sees moving counts
          cur.seconds++;
          if (cur.seconds % 60 === 0) pushLive('active');
          draw();
        }, 1000);
      } else if (source !== 'manual' && !fromDevice) {
        sendCfg();
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
      if (st.unit === 'reps' && source !== 'manual' && fromDevice !== true) tracker.send('STOP');
      const sensed = st.unit === 'reps' && source !== 'manual';
      const done = st.unit === 'min' ? Math.round(cur.seconds / 60) : cur.reps;
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
        });
      } catch (e) {
        running = true; // keep the numbers on screen so the set can be saved again
        draw();
        throw e;
      }
      next();
    });

    function next() {
      idx++;
      cur = null;
      shown = -1;
      lastFrac = 0;
      if (idx >= steps.length) return checkIn();
      sendCfg();
      fresh = true;
      draw();
    }

    const stepper = () => `<div class="progress-steps" aria-hidden="true">${steps.map((_, i) => `<i class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"></i>`).join('')}</div>`;

    const SOURCES = [['camera', 'camera', 'Camera'], ['device', 'sensor', 'Wearable'], ['sim', 'spark', 'Demo sensor'], ['manual', 'hand', 'By hand']];

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
      const fb = cur && cur.feedback ? `<div class="feedback ${cur.feedback[0]}">${icon(cur.feedback[0] === 'good' ? 'check' : 'alert')} ${esc(cur.feedback[1])}</div>` : `<div class="feedback idle">${running ? (isMin ? 'Keep a steady, comfortable pace' : source === 'manual' ? 'Tap +1 after each repetition' : 'Begin when you are ready') : 'Ready when you are'}</div>`;

      el.innerHTML = `
        ${stepper()}
        <div>
          <div class="row spread"><div class="eyebrow" style="margin:0">Exercise ${o.active.items.findIndex((i) => i.exercise_id === st.exercise_id) + 1} of ${o.active.items.length} · set ${st.set} of ${st.sets}</div><span class="row">${hrNow ? `<span class="hr ${hrNow > p.hr_max ? 'alert' : ''}">${icon('heart')}${hrNow} bpm</span>` : ''}${spo2Now ? `<span class="hr ${spo2Now < 90 ? 'alert' : ''}" title="Blood oxygen">O₂ ${spo2Now}%</span>` : ''}${voice.supported ? `<button id="voice" class="voice ${voice.on ? 'on' : ''}" aria-pressed="${voice.on}" aria-label="Voice coach">${icon(voice.on ? 'volume' : 'mute')} Voice</button>` : ''}</span></div>
          <h1 style="margin:6px 0 8px">${esc(st.name)}</h1>
          <p class="muted">${esc(st.cue)}${st.load ? ` <b style="color:var(--ink)">${esc(st.load)}.</b>` : ''}</p>
        </div>

        ${cur && cur.hrHigh ? `<div class="banner alert" role="alert">${icon('heart')}<span>Your heart rate is high. Stop and rest until it settles.</span></div>` : ''}
        ${over ? `<div class="banner alert" role="alert">${icon('alert')}<span>You are well past your dose. Please stop this set now.</span></div>` : reached ? `<div class="banner good" role="status">${icon('check')}<span>Dose reached. ${isMin ? 'You can stop here.' : 'Stop here and finish the set.'}</span></div>` : ''}

        ${
          !running
            ? `<div class="card" style="padding:16px"><h3 style="margin:2px 4px 10px">${isMin ? 'How shall we time it?' : 'How shall we count?'}</h3>
            <div class="seg" role="group" aria-label="Counting method">${(isMin ? SOURCES.filter(([k]) => k === 'camera' || k === 'manual').map(([k, ic, t]) => [k, ic, k === 'manual' ? 'Timer' : t]) : SOURCES).map(([k, ic, t]) => `<button data-src="${k}" class="${source === k ? 'on' : ''}" aria-pressed="${source === k}">${icon(ic)}${t}</button>`).join('')}</div>
            <p class="muted small" style="margin:10px 4px 0">${
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
          <div class="stage-grid">${fig.ok || source === 'camera' ? `<div id="fig-slot" class="fig-slot ${source === 'camera' ? 'cam-slot' : ''}"></div>` : ''}<div aria-live="polite">${ring(frac, { size: 250, w: 18, cls: (over ? 'alert' : reached ? 'good' : 'accent') + (popped ? ' pulse' : ''), from: fromFrac, inner: `<span class="n ${isMin ? 'time' : ''} ${popped ? 'pop' : ''}">${isMin ? mmss : n}</span><span class="of">of ${isMin ? `${st.target} min` : `${st.target} reps`}</span>` })}</div>
          </div>
          <div>${fb}</div>
          ${
            !running
              ? `<button class="primary big" id="go">${icon('play')} Start ${isMin ? 'timer' : 'set'}</button>`
              : `${!isMin && source === 'manual' ? '<div class="row" style="margin-bottom:12px;flex-wrap:nowrap"><button id="minus" style="flex:1" aria-label="Remove one repetition">−1</button><button class="primary" id="plus" style="flex:3;font-size:1.7rem">+1</button></div>' : ''}
                 ${isMin ? `<p><button id="plusmin" class="ghost">${icon('plus')} Add 1 minute done away from the screen</button></p>` : ''}
                 <button class="${reached ? 'primary ' : ''}big" id="finish">${icon('check')} Finish ${isMin ? '' : 'set'}</button>`
          }
        </div>
        <div id="form-slot"></div>
        ${!running ? `<p style="text-align:center"><button id="skip" class="ghost">Skip this set ${icon('next')}</button> <button id="quit" class="ghost danger">End session early</button></p>` : ''}`;
      // Before a set the figure demonstrates the movement on a loop; during a counted
      // set it performs one repetition each time a rep is counted.
      // The camera video sits in the stage when it is counting, otherwise in the form camera card.
      const slot = el.querySelector('#fig-slot');
      if (slot) slot.appendChild(source === 'camera' ? camBox : figCanvas);
      el.querySelector('#form-slot').replaceWith(formCard);
      if (source !== 'camera') formCard.querySelector('.form-cam-slot').appendChild(camBox);
      camBox.classList.toggle('form', source !== 'camera');
      showCam();
      if (source === 'camera') drawCamHud(st, popped);
      else camHud.hidden = true;
      fig.set(st.name, source === 'manual' ? '' : st.sensor_site);
      fig.mode(running && !isMin ? 'manual' : 'loop');
      if (popped) fig.pulse(Math.min(st.target_tempo_ms || 2000, 1600));
      // Only the first draw of a step animates in; redraws during a set must not replay it.
      el.classList.toggle('still', !fresh);
      fresh = false;

      el.querySelectorAll('[data-src]').forEach((b) => (b.onclick = act(() => pickSource(b.dataset.src))));
      const on = (sel, fn) => {
        const b = el.querySelector(sel);
        if (b) b.onclick = fn;
      };
      on('#go', () => beginSet(false));
      on('#finish', () => finishSet(false));
      on('#voice', () => {
        voice.on = !voice.on;
        voice.say('Voice coach on. I will count your repetitions.');
        draw();
      });
      on('#plus', () => {
        cur.reps++;
        cur.feedback = null;
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

    async function pickSource(nextSource) {
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
      } else if (nextSource === 'device') {
        if (!Tracker.serialSupported) throw new Error('This browser cannot talk to the sensor. Use Chrome or Edge on a computer, or count by hand.');
        await tracker.close();
        try {
          await tracker.connectSerial();
        } catch (e) {
          if (e.name === 'NotFoundError') return; // chooser dismissed
          throw new Error('Could not open the sensor. Check the USB cable and that no other program is using it.');
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
      idx = steps.length;
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
        <button class="primary big" id="save" disabled>${icon('check')} Save session</button>`;
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
        <a class="btn primary big" href="#/home/${id}">Done</a>`;
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
    startFormCam().catch(() => {}); // failures are shown in the form camera card
    return () => {
      closed = true;
      stopFormCam();
      fig.destroy();
      clearInterval(timer);
      tracker.close();
    };
  };
})();
