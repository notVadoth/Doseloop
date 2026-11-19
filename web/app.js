'use strict';
// Shared helpers, visual primitives, router and the community feed. Views register themselves on DL.views.
const DL = (() => {
  const app = document.getElementById('app');
  const views = {};
  let cleanup = null;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  const fmtDateTime = (iso) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function ago(iso) {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
    const d = Math.round(m / 1440);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  const amount = (it) => (it.unit === 'min' ? `${it.sets > 1 ? `${it.sets} × ` : ''}${it.target} min` : `${it.sets} × ${it.target} reps`);

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error('Cannot reach the DoseLoop server. Is it still running?');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), isError ? 5000 : 2500);
  }
  // Wrap an async UI action so failures surface as a toast instead of vanishing.
  const act = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e.message, true);
    }
  };

  // ---------- visual primitives ----------

  const ICONS = {
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.700.8 2.700 2.500 3 5.200"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    chat: '<path d="M4 5h16v11H9.500L4 20z"/>',
    userplus: '<circle cx="10" cy="8" r="3.5"/><path d="M3.500 20c.6-3.600 3.200-5.500 6.500-5.500 1.500 0 2.900.4 4 1.100M18 14v6M15 17h6"/>',
    heart: '<path d="M12 20s-7-4.400-7-10a4 4 0 0 1 7-2.600A4 4 0 0 1 19 10c0 5.600-7 10-7 10z"/>',
    flame: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.200 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/>',
    check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    print: '<path d="M7 9V4h10v5M7 17H4v-7h16v7h-3M7 14h10v6H7z"/>',
    home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
    building: '<path d="M5 20V5h9v15M14 10h5v10M3 20h18M8 9h3M8 13h3"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    next: '<path d="M9 5l7 7-7 7"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.500V12l3 2"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    sensor: '<rect x="7" y="4" width="10" height="16" rx="3"/><path d="M10 9h4M3.500 9c-1 2-1 4 0 6M20.500 9c1 2 1 4 0 6"/>',
    hand: '<path d="M9 11V5.500a1.500 1.500 0 0 1 3 0V11M12 10V4.500a1.500 1.500 0 0 1 3 0V11M15 11V6.500a1.500 1.500 0 0 1 3 0V14c0 4-2.500 6-6 6-3 0-5-1.500-6.500-4.500L4 12.500a1.400 1.400 0 0 1 2.500-1.200L9 14"/>',
    spark: '<path d="M12 4l1.800 5.200L19 11l-5.200 1.800L12 18l-1.800-5.200L5 11l5.200-1.800z"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
    megaphone: '<path d="M4 10v4h3l8 4V6l-8 4zM18 9.500c1 .7 1 4.300 0 5M8 14v4"/>',
    edit: '<path d="M4 20h4l11-11-4-4L4 16zM13.500 6.500l4 4"/>',
    equal: '<path d="M6 9h12M6 15h12"/>',
    volume: '<path d="M4 10v4h3l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    mute: '<path d="M4 10v4h3l5 4V6l-5 4zM16 9.5l5 5M21 9.5l-5 5"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    camera: '<path d="M4 8h3.5l2-3h5l2 3H20v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  };
  const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // vt: a view-transition name, so the same person's avatar morphs between pages.
  function avatar(name, cls = '', vt = '') {
    const parts = String(name).trim().split(/\s+/);
    const initials = (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="avatar ${cls}" style="--h:${h}${vt ? `;view-transition-name:${vt}` : ''}" aria-hidden="true">${esc(initials)}</span>`;
  }

  // Circular progress. v is 0..1 (values above 1 show a full ring). The arc animates
  // from `from` to v, so a view that redraws can pass the previous value and move smoothly.
  function ring(v, { size = 56, w = 6, cls = '', inner = '', from = 0 } = {}) {
    const r = (size - w) / 2;
    const c = 2 * Math.PI * r;
    const clamp = (x) => Math.max(0, Math.min(1, x || 0));
    const m = size / 2;
    return `<span class="ring ${cls}" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="track" cx="${m}" cy="${m}" r="${r}" fill="none" stroke-width="${w}"/><circle class="fill" cx="${m}" cy="${m}" r="${r}" fill="none" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - clamp(v))).toFixed(2)}" style="--from:${(c * (1 - clamp(from))).toFixed(2)}" transform="rotate(-90 ${m} ${m})"/></svg><span class="ring-in">${inner}</span></span>`;
  }

  // Numbers marked data-count roll up from zero. The final text is already in the page,
  // so if animation frames never arrive the right value is still what people see.
  function countUp(root) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    root.querySelectorAll('[data-count]').forEach((el) => {
      const m = /^(\D*)(\d+)(.*)$/s.exec(el.textContent);
      if (!m || el.children.length) return;
      const final = el.textContent;
      const target = Number(m[2]);
      const t0 = performance.now();
      const dur = 700;
      let done = false;
      const finish = () => {
        done = true;
        el.textContent = final;
      };
      const step = (t) => {
        if (done) return;
        const k = Math.min(1, (t - t0) / dur);
        if (k >= 1) return finish();
        el.textContent = m[1] + Math.round(target * (1 - Math.pow(1 - k, 3))) + m[3];
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setTimeout(finish, dur + 400);
    });
  }

  function confetti() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = document.createElement('div');
    box.className = 'confetti';
    box.setAttribute('aria-hidden', 'true');
    const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--good)', '#f2c14e'];
    box.innerHTML = Array.from({ length: 44 }, (_, i) => `<i style="--x:${Math.round(Math.random() * 100)}vw;--dx:${Math.round(Math.random() * 30 - 15)}vw;--r:${Math.round(Math.random() * 900 - 450)}deg;--d:${(Math.random() * 0.5).toFixed(2)}s;--t:${(1.6 + Math.random() * 1.2).toFixed(2)}s;background:${colors[i % colors.length]}"></i>`).join('');
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 3600);
  }

  // Tiny trend line of dose completion (1 = full dose, drawn as a dashed guide).
  function spark(values) {
    if (!values || values.length < 2) return '<span class="muted">–</span>';
    const W = 72, H = 24, min = 0.3, max = 1.4;
    const x = (i) => 3 + (i * (W - 6)) / (values.length - 1);
    const y = (v) => H - 3 - ((Math.max(min, Math.min(v, max)) - min) / (max - min)) * (H - 6);
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Dose completion trend, latest ${Math.round(values[values.length - 1] * 100)}%"><line x1="0" x2="${W}" y1="${y(1)}" y2="${y(1)}"/><path d="${d}"/><circle cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="2.6"/></svg>`;
  }

  const flagChips = (flags) => flags.map((f) => `<span class="chip ${esc(f.level)}">${esc(f.text)}</span>`).join('');

  // SVG line chart. series: [{label, color (CSS colour), values:[number|null]}]; the first series gets an area fill.
  let chartId = 0;
  function lineChart({ series, labels, yMax, ref, markers = [], unit = '' }) {
    const W = 560, H = 200, L = 36, R = 12, T = 14, B = 26;
    const n = labels.length;
    if (!n) return `<p class="empty">${icon('activity')}No sessions yet.</p>`;
    const id = `g${++chartId}`;
    const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
    const y = (v) => T + (1 - Math.min(v, yMax) / yMax) * (H - T - B);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((q) => q.label).join(', '))} over ${n} sessions">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${series[0].color};stop-opacity:.28"/><stop offset="1" style="stop-color:${series[0].color};stop-opacity:0"/></linearGradient></defs>`;
    for (let g = 0; g <= 4; g++) {
      const v = (yMax * g) / 4;
      s += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end">${Math.round(v)}${unit}</text>`;
    }
    if (ref != null) s += `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/>`;
    for (const m of markers) s += `<line class="mark-l" x1="${x(m.i)}" x2="${x(m.i)}" y1="${T}" y2="${H - B}"/><text class="mark-t" x="${x(m.i) + 4}" y="${T + 8}">${esc(m.label)}</text>`;
    series.forEach((q, k) => {
      const pts = q.values.map((v, i) => (v == null ? null : [x(i), y(v), v, i])).filter(Boolean);
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
      if (pts.length > 1) {
        if (k === 0) s += `<path class="area" d="${line}L${pts[pts.length - 1][0].toFixed(1)} ${H - B}L${pts[0][0].toFixed(1)} ${H - B}Z" fill="url(#${id})"/>`;
        s += `<path class="draw" pathLength="1" d="${line}" fill="none" style="stroke:${q.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      for (const p of pts) s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.4" style="fill:${q.color}"><title>${esc(labels[p[3]])}: ${esc(q.label)} ${Math.round(p[2] * 10) / 10}${unit}</title></circle>`;
    });
    s += `<text x="${L}" y="${H - 6}">${esc(labels[0])}</text>`;
    if (n > 1) s += `<text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(labels[n - 1])}</text>`;
    s += '</svg>';
    return s + `<div class="legend">${series.map((q) => `<span><i style="background:${q.color}"></i>${esc(q.label)}</span>`).join('')}${ref != null ? '<span>┄ target</span>' : ''}</div>`;
  }

  // Says which engine produced an AI result; the title explains a fallback.
  const aiBadge = (source, reason) =>
    `<span class="chip ${source === 'claude' ? 'accent' : ''} plain" title="${esc(reason ? `Claude was unavailable: ${reason}` : source === 'claude' ? 'Written by Claude from de-identified data' : 'Built-in rules, no data left this computer')}">${icon('spark')} ${source === 'claude' ? 'Claude' : 'Built-in'}</span>`;

  // Voice coach: the browser's own speech synthesis. On unless the participant turns it off,
  // since people exercising are usually away from the screen.
  const voice = {
    supported: 'speechSynthesis' in window,
    get on() {
      try {
        return localStorage.getItem('doseloop.voice') !== '0';
      } catch {
        return true;
      }
    },
    set on(v) {
      try {
        localStorage.setItem('doseloop.voice', v ? '1' : '0');
      } catch {
        /* storage unavailable: the choice lasts until reload */
      }
      if (!v && this.supported) speechSynthesis.cancel();
    },
    say(text, urgent) {
      if (!this.supported || !this.on) return;
      if (urgent) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      speechSynthesis.speak(u);
    },
  };

  // ---------- community feed (used in both modes) ----------

  async function feedCard(el, { participantId, staffName }) {
    const posts = await api('GET', '/api/feed');
    el.innerHTML = `
      <h2>${icon('chat')} Community</h2>
      <form class="row" id="post-form" style="margin-bottom:6px;flex-wrap:nowrap">
        <input id="post-text" maxlength="280" placeholder="${participantId ? 'Say hello or share how it went' : 'Post an announcement to the group'}" style="flex:1;min-width:0" aria-label="Message">
        <button class="primary">Post</button>
      </form>
      <div>${
        posts.length
          ? posts
              .map((p) => {
                const pic = p.kind === 'milestone' ? `<span class="avatar mile" aria-hidden="true">${icon('spark')}</span>` : p.kind === 'staff' ? `<span class="avatar" style="--h:165" aria-hidden="true">${icon('megaphone')}</span>` : avatar(p.author);
                return `<div class="post ${esc(p.kind)}">${pic}<div class="post-body">
          <div><b>${esc(p.author)}</b> ${p.kind === 'staff' ? '<span class="chip primary plain">Staff</span>' : ''} ${p.kind === 'milestone' ? esc(p.text) : ''} <span class="muted small">· ${ago(p.created_at)}</span></div>
          ${p.kind === 'milestone' ? '' : `<div>${esc(p.text)}</div>`}
          <button class="cheer" data-cheer="${p.id}" aria-label="Cheer this post, ${p.cheers} so far">👏 <span class="num">${p.cheers}</span></button>
        </div></div>`;
              })
              .join('')
          : `<p class="empty">${icon('chat')}No posts yet. Be the first to say hello.</p>`
      }</div>`;
    el.querySelector('#post-form').onsubmit = act(async (ev) => {
      ev.preventDefault();
      const text = el.querySelector('#post-text').value.trim();
      if (!text) return;
      await api('POST', '/api/feed', participantId ? { participant_id: participantId, text } : { author: staffName(), text });
      await feedCard(el, { participantId, staffName });
    });
    el.querySelectorAll('[data-cheer]').forEach((b) => {
      b.onclick = act(async () => {
        const r = await api('POST', `/api/feed/${b.dataset.cheer}/cheer`);
        b.querySelector('span').textContent = r.cheers;
        b.classList.remove('popped');
        void b.offsetWidth; // restart the animation
        b.classList.add('popped');
      });
    });
  }

  // ---------- router ----------

  const NAV = [['#/', 'Roster', 'users'], ['#/live', 'Live class', 'activity'], ['#/feed', 'Community', 'chat'], ['#/intake', 'New intake', 'userplus']];

  async function renderNow() {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const isHome = parts[0] === 'home';
    document.body.classList.toggle('home', isHome);
    document.body.classList.toggle('clinic', !isHome);
    document.getElementById('mode-clinic').classList.toggle('on', !isHome);
    document.getElementById('mode-home').classList.toggle('on', isHome);
    const here = `#/${parts[0] === 'p' ? '' : parts[0] || ''}`;
    document.getElementById('nav').innerHTML = isHome ? '' : NAV.map(([h, t, i]) => `<a href="${h}" class="${h === here ? 'on' : ''}" ${h === here ? 'aria-current="page"' : ''}>${h === here ? '<span class="pill"></span>' : ''}${icon(i)}${t}</a>`).join('');

    drawTabbar(isHome, parts);
    const name = isHome ? ({ session: 'session', track: 'track', community: 'homeCommunity' }[parts[2]] || (parts[1] ? 'homeDash' : 'homePick')) : { '': 'roster', p: 'detail', live: 'live', feed: 'feed', intake: 'intake' }[parts[0] || ''];
    const view = views[name];
    const token = (render.token = {});
    app.classList.remove('still');
    try {
      if (!view) throw new Error('Page not found.');
      const c = await view(app, parts);
      // Navigation happened while this view was loading: drop its resources.
      if (render.token !== token) c && c();
      else cleanup = c || null;
    } catch (e) {
      if (render.token === token) app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="${isHome ? '#/home' : '#/'}">${icon('back')} Go back</a></div>`;
    }
    window.scrollTo(0, 0);
  }

  // Participant tab bar (phones): the four places someone goes, as big labelled buttons.
  // Hidden during a guided session, so a stray tap cannot abandon a set.
  function drawTabbar(isHome, parts) {
    const bar = document.getElementById('tabbar');
    const id = Number(parts[1]);
    const show = isHome && id > 0 && parts[2] !== 'session';
    bar.hidden = !show;
    document.body.classList.toggle('has-tabbar', show);
    if (!show) return;
    const here = parts[2] || '';
    const tabs = [['', 'home', 'Today'], ['session', 'play', 'Exercise'], ['track', 'camera', 'Camera'], ['community', 'users', 'People']];
    bar.innerHTML = tabs.map(([k, ic, label]) => `<a href="#/home/${id}${k ? `/${k}` : ''}" class="${k === here ? 'on' : ''}" ${k === here ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`).join('');
  }

  // Text size for the participant side: normal, large, extra large; remembered per device.
  const SIZES = ['m', 'l', 'xl'];
  function setTextSize(size) {
    document.documentElement.dataset.text = size;
    try {
      localStorage.setItem('doseloop.text', size);
    } catch {
      /* storage unavailable: the size lasts until reload */
    }
  }

  // Route changes run inside a view transition where the browser supports it: pages
  // cross-fade and shared elements (the nav pill, a participant's avatar) glide across.
  async function render() {
    const animate = document.startViewTransition && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (animate) {
      // The browser may never call the update (tab hidden mid-way); if it has not
      // started promptly, render directly so navigation can never stall.
      let run = null;
      const once = () => (run ||= renderNow());
      const t = document.startViewTransition(once);
      t.ready.catch(() => {});
      t.finished.catch(() => {});
      await Promise.race([t.updateCallbackDone.catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
      if (!run) t.skipTransition();
      await once();
    } else {
      await renderNow();
    }
    countUp(app);
  }

  // Cursor spotlight on hoverable surfaces.
  document.addEventListener(
    'pointermove',
    (e) => {
      const t = e.target.closest && e.target.closest('.tile, .person, .review a');
      if (!t) return;
      const r = t.getBoundingClientRect();
      t.style.setProperty('--mx', `${e.clientX - r.left}px`);
      t.style.setProperty('--my', `${e.clientY - r.top}px`);
    },
    { passive: true }
  );

  // Installable app: a service worker for offline use and the browser's install prompt.
  function setupApp() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    const btn = document.getElementById('install');
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      btn.hidden = false;
    });
    btn.onclick = async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice.catch(() => {});
      deferred = null;
      btn.hidden = true;
    };
    window.addEventListener('appinstalled', () => (btn.hidden = true));
  }

  function start() {
    let saved = 'm';
    try {
      saved = localStorage.getItem('doseloop.text') || 'm';
    } catch {
      /* default size */
    }
    setTextSize(SIZES.includes(saved) ? saved : 'm');
    document.getElementById('textsize').onclick = () => {
      const next = SIZES[(SIZES.indexOf(document.documentElement.dataset.text) + 1) % SIZES.length];
      setTextSize(next);
      toast({ m: 'Normal text', l: 'Large text', xl: 'Extra large text' }[next]);
    };
    setupApp();
    api('GET', '/api/ai/status')
      .then((s) => {
        document.getElementById('ai-status').innerHTML = s.claude ? `${icon('spark')} AI: Claude connected` : `${icon('spark')} AI: built-in mode`;
      })
      .catch(() => {});
    window.addEventListener('hashchange', render);
    render();
  }

  return { app, views, esc, pct, fmtDate, fmtDateTime, ago, amount, api, toast, act, icon, avatar, ring, spark, flagChips, lineChart, feedCard, aiBadge, voice, confetti, render, start };
})();
