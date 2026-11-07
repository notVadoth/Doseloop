'use strict';
// Camera coach: point a phone or laptop camera at yourself and start exercising. The
// app recognises which exercise you are doing, counts the reps (or minutes, for walking
// and cycling) and keeps a tally you can save to your record. Nothing is chosen up front.
(() => {
  const { views, esc, api, toast, act, icon, ring, voice } = DL;

  views.track = async (el, parts) => {
    const id = Number(parts[1]);
    const [o, model] = await Promise.all([api('GET', `/api/participants/${id}`), DL.camera.model()]);
    const p = o.participant;
    const plan = new Map((o.active ? o.active.items : []).map((i) => [i.name, i]));
    const goal = (name) => {
      const it = plan.get(name);
      return it ? it.sets * it.target : null;
    };
    const timed = (name) => !DLMotion.SIGNALS[name];

    const tracker = new DLMotion.AutoTracker(model);
    let cam = null;
    let choice = 'facing:user';
    let lastSeen = null; // last onFrame status
    let saved = false;
    let closed = false;
    let lastShown = null;

    el.innerHTML = `
      <a class="back" href="#/home/${id}">${icon('back')} Today’s plan</a>
      <div class="head"><div class="eyebrow">Camera coach</div><h1>Just start exercising</h1>
        <p>I’ll recognise the exercise and count your reps. Prop your phone or laptop up so I can see you from head to feet, then do your exercises in any order.</p></div>
      <div class="track-grid">
        <div class="card track-cam">
          <div class="cam big" id="cam">
            <video playsinline muted></video><canvas aria-hidden="true"></canvas>
            <div class="cam-hud" id="hud" hidden aria-hidden="true"><div class="hud-ex"></div><div class="hud-count"><span class="hud-n">0</span><span class="hud-of"></span></div><div class="hud-bar"><i></i></div></div>
            <div class="cam-mini" id="mini" hidden aria-hidden="true"><canvas></canvas><span></span></div>
            <button class="cam-full" id="full" aria-label="Full screen">${icon('expand')}</button>
            <div class="cam-label" aria-live="polite"></div>
            <div class="cam-off" id="cam-off">${icon('camera')}<b>Camera is off</b><span>Video stays on this device. Only joint angles are used.</span></div>
          </div>
          <div class="row cam-controls">
            <button class="primary" id="start">${icon('play')} Start camera</button>
            <select id="which" aria-label="Which camera"><option value="facing:user">Front camera</option><option value="facing:environment">Back camera</option></select>
            ${voice.supported ? `<button id="voice" class="voice ${voice.on ? 'on' : ''}" aria-pressed="${voice.on}">${icon(voice.on ? 'volume' : 'mute')} Voice</button>` : ''}
          </div>
        </div>
        <div class="track-side">
          <div class="card now" id="now"></div>
          <div class="card"><h2>This workout</h2><div id="tally"></div></div>
          <div class="card" id="save-card"></div>
        </div>
      </div>`;

    const camEl = el.querySelector('#cam');
    const video = camEl.querySelector('video'), overlay = camEl.querySelector('canvas'), label = camEl.querySelector('.cam-label');
    const startBtn = el.querySelector('#start'), which = el.querySelector('#which');

    // ---------- drawing ----------
    // The count drawn over the video, readable from across the room.
    const hud = camEl.querySelector('#hud');
    function drawHud(popped) {
      const cur = tracker.current;
      hud.hidden = !cur || !cam;
      drawMini(hud.hidden ? null : cur);
      if (hud.hidden) return;
      const tl = tracker.tallies[cur] || { reps: 0, seconds: 0 };
      const g = goal(cur), isTimed = timed(cur);
      const n = isTimed ? Math.floor(tl.seconds) : tl.reps;
      const frac = g ? (isTimed ? n / (g * 60) : n / g) : 0;
      hud.querySelector('.hud-ex').textContent = cur;
      const num = hud.querySelector('.hud-n');
      num.textContent = isTimed ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : n;
      hud.querySelector('.hud-of').textContent = g ? (isTimed ? ` / ${g}:00` : ` / ${g}`) : isTimed ? '' : ' reps';
      hud.querySelector('.hud-bar').hidden = !g;
      hud.querySelector('.hud-bar i').style.width = `${Math.min(100, Math.round(frac * 100))}%`;
      hud.classList.toggle('done', frac >= 1);
      if (popped) {
        num.classList.remove('pop');
        void num.offsetWidth; // restart the animation
        num.classList.add('pop');
      }
    }

    // A small 3D figure doing the recognised exercise, so the person can check their form.
    // Created on first use (WebGL is not free on older phones) and only for exercises it knows.
    const mini = camEl.querySelector('#mini');
    let miniFig = null, miniEx = null;
    function drawMini(name) {
      const show = !!name && DL.figureExercises.includes(name);
      mini.hidden = !show;
      if (!show || name === miniEx) return;
      if (!miniFig) miniFig = DL.figure(mini.querySelector('canvas'), { mode: 'loop' });
      if (miniFig.ok === false) return void (mini.hidden = true);
      miniFig.set(name);
      miniEx = name;
      mini.querySelector('span').textContent = name;
    }

    function drawNow(popped) {
      drawHud(popped);
      const cur = tracker.current, pred = tracker.pred;
      const box = el.querySelector('#now');
      if (!cur) {
        box.innerHTML = `<div class="eyebrow">Now</div><h2 class="now-name">${cam ? (lastShown ? 'Paused' : 'Waiting for movement') : 'Start the camera'}</h2>
          <p class="muted">${cam ? 'Start any exercise from your plan. It takes a couple of seconds to recognise.' : 'Then begin any exercise. You don’t need to choose it first.'}</p>`;
        return;
      }
      const tl = tracker.tallies[cur] || { reps: 0, seconds: 0 };
      const g = goal(cur);
      const isTimed = timed(cur);
      const n = isTimed ? Math.floor(tl.seconds) : tl.reps;
      const mmss = `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
      const of = g ? (isTimed ? `of ${g} min` : `of ${g} reps`) : isTimed ? 'active time' : 'reps';
      const frac = g ? (isTimed ? n / (g * 60) : n / g) : 0;
      const conf = pred && pred.label === cur ? Math.round(pred.prob * 100) : null;
      box.innerHTML = `<div class="eyebrow">Now</div><h2 class="now-name">${esc(cur)}</h2>
        <div class="now-body">${ring(frac, { size: 150, w: 13, cls: (frac >= 1 ? 'good' : 'accent') + (popped ? ' pulse' : ''), inner: `<span class="n ${popped ? 'pop' : ''}">${isTimed ? mmss : n}</span><span class="of">${of}</span>` })}
          <div class="now-meta">${plan.has(cur) ? '' : '<span class="chip warn">Not in your plan</span>'}
            ${conf !== null ? `<div class="small muted">Recognised · ${conf}% sure</div><div class="bar"><i style="width:${conf}%"></i></div>` : ''}
            ${DLMotion.SIGNALS[cur] && DLMotion.SIGNALS[cur].missesSome ? '<p class="small" style="color:var(--warn);margin-top:8px">The camera may miss some of these. Check the count, or use the wearable.</p>' : ''}
            ${g && frac >= 1 ? `<p class="small" style="color:var(--good);margin-top:8px;font-weight:700">${icon('check')} Dose reached</p>` : ''}</div></div>`;
    }

    function drawTally() {
      const names = Object.keys(tracker.tallies);
      const box = el.querySelector('#tally');
      if (!names.length) {
        box.innerHTML = '<p class="muted small" style="margin:0">Exercises you do will appear here.</p>';
        return;
      }
      box.innerHTML = names
        .map((name) => {
          const tl = tracker.tallies[name], g = goal(name), isTimed = timed(name);
          const amount = isTimed ? `${Math.floor(tl.seconds / 60)}:${String(Math.floor(tl.seconds % 60)).padStart(2, '0')}${g ? ` / ${g}:00` : ''}` : `${tl.reps}${g ? ` / ${g}` : ''} reps`;
          const frac = g ? (isTimed ? tl.seconds / (g * 60) : tl.reps / g) : 0;
          const q = tl.quality.length ? Math.round(tl.quality.reduce((a, b) => a + b, 0) / tl.quality.length) : null;
          return `<div class="tally-row ${name === tracker.current ? 'on' : ''}">
            <div><b>${esc(name)}</b><div class="muted small">${plan.has(name) ? (q !== null ? `Movement score ${q}` : isTimed ? 'Timed' : '') : 'Not in your plan'}${tl.partials ? ` · ${tl.partials} too shallow` : ''}</div></div>
            <div class="tally-amt"><b class="num">${amount}</b>${g ? `<div class="bar"><i style="width:${Math.min(100, Math.round(frac * 100))}%"></i></div>` : ''}</div>
          </div>`;
        })
        .join('');
    }

    const RPE = ['Nothing', 'Very light', 'Light', 'Moderate', 'Somewhat hard', 'Hard', 'Hard', 'Very hard', 'Very hard', 'Extremely hard', 'Maximal'];
    const PAIN = ['None', 'Mild', 'Mild', 'Mild', 'Moderate', 'Moderate', 'Moderate', 'Severe', 'Severe', 'Severe', 'Worst'];
    function drawSave() {
      const box = el.querySelector('#save-card');
      const savable = Object.keys(tracker.tallies).filter((n) => plan.has(n) && (tracker.tallies[n].reps > 0 || tracker.tallies[n].seconds >= 30));
      if (saved) {
        box.innerHTML = `<h2>${icon('check')} Saved to your record</h2><p class="muted">Your kinesiologist can see this workout.</p><a class="btn primary" href="#/home/${id}">Done</a>`;
        return;
      }
      box.innerHTML = `<h2>Save to my record</h2>
        ${o.active ? '' : '<p class="muted">You don’t have a plan yet, so there is nothing to save to.</p>'}
        <div class="form-grid" style="grid-template-columns:1fr 1fr">
          <label>How hard was it?<select id="rpe">${RPE.map((l, i) => `<option value="${i}" ${i === 4 ? 'selected' : ''}>${i} – ${l}</option>`).join('')}</select></label>
          <label>Any pain?<select id="pain">${PAIN.map((l, i) => `<option value="${i}">${i} – ${l}</option>`).join('')}</select></label>
        </div>
        <button class="primary" id="save" ${savable.length && o.active ? '' : 'disabled'}>${icon('check')} Save ${savable.length ? `${savable.length} exercise${savable.length === 1 ? '' : 's'}` : 'workout'}</button>
        ${!savable.length ? '<p class="muted small" style="margin:8px 0 0">Do at least one exercise from your plan first.</p>' : ''}`;
      const btn = box.querySelector('#save');
      if (btn) btn.onclick = act(save);
    }

    function drawLabel() {
      const f = lastSeen, cur = tracker.current;
      let text = '', cls = '';
      if (!cam) text = '';
      else if (!f || !f.visible) [text, cls] = ['I can’t see you yet. Step into view.', 'warn'];
      else if (!f.fullBody) [text, cls] = ['Step back so I can see you from head to feet.', 'warn'];
      else if (f.sideOn && !cur) [text, cls] = ['Turn to face the camera for the most accurate tracking.', 'warn'];
      else if (cur) [text, cls] = [`✓ ${cur}`, 'good'];
      else text = tracker.pred && tracker.pred.label !== DLMotion.IDLE ? `Looks like ${tracker.pred.label}…` : 'Watching…';
      label.textContent = text;
      label.className = `cam-label ${cls}`;
    }

    function pushLive() {
      const name = tracker.current || lastShown;
      if (!name) return;
      const tl = tracker.tallies[name];
      if (!tl) return;
      const amount = timed(name) ? Math.floor(tl.seconds / 60) : tl.reps;
      api('POST', '/api/live', { participant_id: id, exercise: name, set: 1, sets: 1, reps: amount, target: Math.max(1, goal(name) || amount || 1), quality: tl.quality.length ? Math.round(tl.quality.reduce((a, b) => a + b, 0) / tl.quality.length) : null, status: tracker.current ? 'active' : 'resting', source: 'camera' }).catch(() => {});
    }

    // ---------- tracking ----------
    let lastTimedDraw = 0;
    function onFrame(f) {
      if (closed) return;
      lastSeen = f;
      let popped = false, changed = false;
      if (f.fullBody && f.angles) {
        for (const ev of tracker.update(f.angles, f.t)) {
          if (ev.type === 'switch') {
            lastShown = ev.exercise;
            voice.say(ev.exercise, true);
            changed = true;
            pushLive();
          } else if (ev.type === 'rep') {
            popped = true;
            const g = goal(ev.exercise);
            voice.say(g && ev.reps === g ? `${ev.reps}. Dose reached.` : String(ev.reps));
            pushLive();
          } else if (ev.type === 'retract' || ev.type === 'pause' || ev.type === 'partial') {
            changed = true;
            if (ev.type === 'pause') pushLive();
          }
        }
      }
      // Timed exercises tick every second; everything else redraws when something happens.
      const tickTimed = tracker.current && timed(tracker.current) && f.t - lastTimedDraw > 1000;
      if (tickTimed) lastTimedDraw = f.t;
      if (popped || changed || tickTimed) {
        drawNow(popped);
        drawTally();
        if (changed || popped) drawSave();
      }
      drawLabel();
    }

    async function startCamera() {
      if (!DL.camera.supported()) throw new Error('This browser cannot use the camera. Try Chrome or Safari.');
      stopCamera();
      startBtn.disabled = true;
      el.querySelector('#cam-off').hidden = true;
      label.textContent = 'Starting the camera…';
      label.className = 'cam-label';
      try {
        const [kind, value] = [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)];
        const c = await DL.camera.start({ video, overlay, onFrame, onStatus: (m) => m && (label.textContent = m), ...(kind === 'dev' ? { deviceId: value } : { facing: value }) });
        if (closed) return c.stop();
        cam = c;
        camEl.classList.toggle('rear', !c.mirrored);
        startBtn.innerHTML = `${icon('pause')} Stop camera`;
        await listCameras(c.label);
        drawNow();
      } catch (e) {
        el.querySelector('#cam-off').hidden = false;
        label.textContent = '';
        throw new Error(e && e.name === 'NotAllowedError' ? 'Camera permission was refused. Allow the camera in your browser’s site settings and try again.' : e && e.name === 'OverconstrainedError' ? 'That camera is not available on this device.' : `The camera could not start: ${e.message}`);
      } finally {
        startBtn.disabled = false;
      }
    }
    function stopCamera() {
      if (cam) cam.stop();
      cam = null;
      lastSeen = null;
      startBtn.innerHTML = `${icon('play')} Start camera`;
      el.querySelector('#cam-off').hidden = false;
      overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
      drawLabel();
      drawNow();
    }
    // Once permission is given, list the real cameras by name (laptops with several webcams).
    async function listCameras(activeLabel) {
      const list = await DL.camera.cameras().catch(() => []);
      if (list.length < 2) return;
      which.innerHTML = list.map((c) => `<option value="dev:${esc(c.id)}" ${c.label === activeLabel ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
      choice = which.value;
    }

    async function save() {
      const rpe = Number(el.querySelector('#rpe').value), pain = Number(el.querySelector('#pain').value);
      const btn = el.querySelector('#save');
      btn.disabled = true;
      try {
        const s = await api('POST', '/api/sessions', { participant_id: id, mode: p.mode });
        const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
        for (const it of o.active.items) {
          const tl = tracker.tallies[it.name];
          if (!tl) continue;
          // Spread the total over the prescribed sets: full sets first, the rest on the last.
          let left = it.unit === 'min' ? Math.round(tl.seconds / 60) : tl.reps;
          for (let k = 1; k <= it.sets && left > 0; k++) {
            const done = k === it.sets ? left : Math.min(left, it.target);
            left -= done;
            await api('POST', `/api/sessions/${s.id}/sets`, { exercise_id: it.exercise_id, set_no: k, done, partials: k === 1 ? tl.partials : 0, quality: it.unit === 'reps' ? mean(tl.quality) : null, tempo_ms: it.unit === 'reps' ? mean(tl.tempo) : null, source: 'camera' });
          }
        }
        await api('POST', `/api/sessions/${s.id}/finish`, { rpe, pain, notes: 'Tracked automatically by the camera coach.', share: !!p.share_feed });
        saved = true;
        DL.confetti();
        toast('Workout saved');
        drawSave();
      } catch (e) {
        btn.disabled = false;
        throw e;
      }
    }

    // ---------- controls ----------
    startBtn.onclick = act(() => (cam ? stopCamera() : startCamera()));
    el.querySelector('#full').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (camEl.requestFullscreen) camEl.requestFullscreen().catch(() => {});
    };
    which.onchange = act(async () => {
      choice = which.value;
      if (cam) await startCamera();
    });
    const vb = el.querySelector('#voice');
    if (vb)
      vb.onclick = () => {
        voice.on = !voice.on;
        vb.classList.toggle('on', voice.on);
        vb.setAttribute('aria-pressed', voice.on);
        vb.innerHTML = `${icon(voice.on ? 'volume' : 'mute')} Voice`;
        voice.say('Voice coach on. I will name each exercise and count your reps.');
      };

    drawNow();
    drawTally();
    drawSave();
    DL.camera.preload().catch(() => {}); // fetch the pose model while the person gets ready

    return () => {
      closed = true;
      if (cam) cam.stop();
      if (miniFig) miniFig.destroy();
      if (tracker.current) {
        tracker.current = null;
        pushLive();
      }
    };
  };
})();
