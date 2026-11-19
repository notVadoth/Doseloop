'use strict';
// Wearable page: live readings sent over Wi-Fi by the ESP32 wearable (MPU6050 + MAX30102),
// refreshed every second: heart rate, blood oxygen, reps, arm tilt and the raw accelerometer,
// with the last five minutes drawn as traces.
(() => {
  const { views, esc, api, icon } = DL;

  const ONLINE_MS = 5000; // no update for this long: shown as offline

  // A small live trace: values over the last 5 minutes, newest on the right.
  function trace(points, key, { min, max, color, unit, ref }) {
    const W = 520, H = 120, L = 34, R = 8, T = 10, B = 18, span = 300000;
    const x = (ago) => L + (1 - Math.min(ago, span) / span) * (W - L - R);
    const y = (v) => T + (1 - (Math.min(max, Math.max(min, v)) - min) / (max - min)) * (H - T - B);
    let s = `<svg class="dev-trace" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(key)} over the last 5 minutes">`;
    for (let g = 0; g <= 2; g++) {
      const v = min + ((max - min) * g) / 2;
      s += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${Math.round(v)}${unit}</text>`;
    }
    if (ref != null) s += `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/>`;
    // Break the line wherever there was no reading (finger off, sensor missing).
    let d = '', pen = false;
    for (const p of points) {
      const v = p[key];
      if (v == null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(p.ago_ms).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    }
    if (d) s += `<path d="${d}" fill="none" style="stroke:${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    else s += `<text x="${(L + W - R) / 2}" y="${H / 2}" text-anchor="middle" class="dev-none">No readings yet</text>`;
    s += `<text x="${L}" y="${H - 4}">5 min ago</text><text x="${W - R}" y="${H - 4}" text-anchor="end">now</text></svg>`;
    return s;
  }

  // One accelerometer axis as a bar from the centre, -1 g to +1 g.
  const axis = (label, v) => {
    const c = Math.max(-1, Math.min(1, v || 0)) * 50;
    return `<div class="dev-axis"><span>${label}</span><div class="dev-axis-bar"><i style="left:${c < 0 ? 50 + c : 50}%;width:${Math.abs(c)}%"></i></div><b class="num">${v == null ? '–' : (v >= 0 ? '+' : '') + v.toFixed(2)}</b></div>`;
  };

  const ago = (ms) => (ms < 2000 ? 'just now' : ms < 60000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60000)} min ago`);

  function setupHelp() {
    const url = location.origin;
    return `<div class="card dev-help">
      <h2>${icon('sensor')} Connect the wearable</h2>
      <p>No wearable has sent readings to this site in the last 10 minutes. To connect one:</p>
      <ol>
        <li>Open the wearable sketch in the Arduino IDE and fill in the three settings at the top:
          <pre>const char *WIFI_SSID = "your network";
const char *WIFI_PASS = "your password";
const char *DOSELOOP_URL = "${esc(url)}";</pre></li>
        <li>Upload it. The board joins the Wi-Fi (2.4 GHz networks only; a phone hotspot works) and the dot in the top-right corner of its screen turns green.</li>
        <li>This page fills in by itself within a few seconds.</li>
      </ol>
      <p class="muted small">Readings shown here are live only and are not saved to anyone's record. To save sets, use the participant's session with the <b>Wearable</b> option over USB.</p>
    </div>`;
  }

  views.device = async (el) => {
    el.innerHTML = `
      <div class="row spread head">
        <div><div class="eyebrow">Live over Wi-Fi</div><h1>Wearable</h1><p>Heart rate, blood oxygen and movement from the wrist wearable, updated every second.</p></div>
        <div class="row"><select id="dev-pick" aria-label="Wearable" hidden></select><span id="dev-state" class="chip plain">Connecting…</span></div>
      </div>
      <div id="dev-body"></div>`;
    const body = el.querySelector('#dev-body'), pick = el.querySelector('#dev-pick'), state = el.querySelector('#dev-state');
    let chosen = null, closed = false, timer = null, built = false;
    let shownId = null, shownStamp = 0; // which reading is on screen, by when the device sent it

    function build() {
      body.innerHTML = `
        <div class="dev-tiles">
          <div class="tile dev-tile" id="t-hr"><div><span class="eyebrow">Heart rate</span><b class="num" data-v>–</b><small data-s></small></div>${icon('heart')}</div>
          <div class="tile dev-tile" id="t-spo2"><div><span class="eyebrow">Blood oxygen</span><b class="num" data-v>–</b><small data-s></small></div>${icon('activity')}</div>
          <div class="tile dev-tile" id="t-reps"><div><span class="eyebrow">Reps</span><b class="num" data-v>0</b><small data-s></small></div>${icon('check')}</div>
          <div class="tile dev-tile" id="t-tilt"><div><span class="eyebrow">Arm tilt</span><b class="num" data-v>–</b><small data-s></small></div>${icon('sensor')}</div>
        </div>
        <div class="dev-grid">
          <div class="card"><h2>Heart rate</h2><div id="c-hr"></div></div>
          <div class="card"><h2>Blood oxygen</h2><div id="c-spo2"></div></div>
          <div class="card"><h2>Arm tilt</h2><div id="c-tilt"></div></div>
          <div class="card"><h2>Motion sensor</h2><div id="axes"></div><div id="dev-info" class="muted small" style="margin-top:12px"></div></div>
        </div>`;
      built = true;
    }

    function tile(id, value, sub, cls) {
      const t = body.querySelector(`#${id}`);
      const v = t.querySelector('[data-v]');
      if (v.textContent !== String(value)) {
        v.textContent = value;
        v.classList.remove('pop');
        void v.offsetWidth;
        v.classList.add('pop');
      }
      t.querySelector('[data-s]').textContent = sub;
      t.className = `tile dev-tile ${cls || ''}`;
    }

    function draw(list, detail) {
      // Device picker, only when there is more than one.
      pick.hidden = list.length < 2;
      if (list.length > 1) pick.innerHTML = list.map((d) => `<option value="${esc(d.id)}" ${d.id === chosen ? 'selected' : ''}>${esc(d.id)}</option>`).join('');
      if (!detail) {
        built = false;
        body.innerHTML = setupHelp();
        state.className = 'chip plain';
        state.textContent = 'No wearable';
        return;
      }
      if (!built) build();
      const d = detail.device, online = d.age_ms < ONLINE_MS;
      state.className = `chip ${online ? 'good' : 'warn'}`;
      state.textContent = online ? `${d.id} · online` : `${d.id} · last seen ${ago(d.age_ms)}`;

      const high = d.hr && d.hr_max && d.hr > d.hr_max;
      tile('t-hr', d.hr || '–', !d.pulse_ok ? 'Pulse sensor not found' : !d.finger ? 'No finger on the sensor' : d.hr ? `bpm${d.hr_max ? ` · limit ${d.hr_max}` : ''}` : 'Reading pulse…', high ? 'alert' : '');
      tile('t-spo2', d.spo2 ? `${d.spo2}%` : '–', !d.finger ? 'No finger on the sensor' : d.spo2 ? (d.spo2 < 90 ? 'Low: check the reading' : 'SpO₂') : 'Reading…', d.spo2 && d.spo2 < 90 ? 'alert' : '');
      tile('t-reps', d.reps, d.set_active ? `${d.exercise ? `${d.exercise} · ` : ''}${d.target ? `of ${d.target}` : 'set in progress'}${d.quality ? ` · form ${d.quality}` : ''}` : 'Press BOOT on the wearable to start a set', d.target && d.reps >= d.target ? 'good' : '');
      tile('t-tilt', d.tilt == null ? '–' : `${Math.round(d.tilt)}°`, d.motion_ok ? 'from vertical' : 'Motion sensor not found', '');

      const h = detail.history;
      body.querySelector('#c-hr').innerHTML = trace(h, 'hr', { min: 40, max: 180, color: 'var(--alert)', unit: '', ref: d.hr_max });
      body.querySelector('#c-spo2').innerHTML = trace(h, 'spo2', { min: 80, max: 100, color: 'var(--primary)', unit: '%' });
      body.querySelector('#c-tilt').innerHTML = trace(h, 'tilt', { min: 0, max: 180, color: 'var(--accent)', unit: '°' });
      body.querySelector('#axes').innerHTML = axis('X', d.ax) + axis('Y', d.ay) + axis('Z', d.az);
      body.querySelector('#dev-info').textContent = [
        d.ir != null ? `Pulse sensor light ${Math.round(d.ir).toLocaleString()}` : null,
        d.rssi != null ? `Wi-Fi ${d.rssi} dBm` : null,
        d.uptime_s != null ? `on for ${Math.floor(d.uptime_s / 60)} min` : null,
        `updated ${ago(d.age_ms)}`,
      ].filter(Boolean).join(' · ');
    }

    async function tick() {
      if (closed) return;
      try {
        const { devices } = await api('GET', '/api/device');
        if (!devices.some((d) => d.id === chosen)) chosen = devices.length ? devices[0].id : null;
        const detail = chosen ? await api('GET', `/api/device/${encodeURIComponent(chosen)}`).catch(() => null) : null;
        // The online demo can run on more than one server copy, each with its own memory, so
        // an answer can be older than the one already shown. Keep the newer one.
        const stamp = detail ? Date.now() - detail.device.age_ms : 0;
        const stale = detail && shownId === chosen && stamp < shownStamp - 500;
        if (!closed && !stale) {
          draw(devices, detail);
          shownId = chosen;
          shownStamp = stamp;
        }
      } catch (e) {
        state.className = 'chip warn';
        state.textContent = 'Cannot reach the server';
      }
      if (!closed) timer = setTimeout(tick, 1000);
    }

    pick.onchange = () => {
      chosen = pick.value;
      clearTimeout(timer);
      tick();
    };
    await tick();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  };
})();
