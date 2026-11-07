'use strict';
// Clinician views: roster, participant record, dose editor, live class board, intake.
(() => {
  const { views, esc, pct, fmtDate, fmtDateTime, amount, api, toast, act, icon, avatar, ring, spark, flagChips, lineChart, feedCard, aiBadge } = DL;

  const PROGRAM = { general: 'General', cancer: 'Cancer', stroke: 'Stroke', graduate: 'Graduate' };
  const staffName = () => {
    try {
      return localStorage.getItem('doseloop.staff') || '';
    } catch {
      return '';
    }
  };
  const rememberStaff = (v) => {
    try {
      localStorage.setItem('doseloop.staff', v);
    } catch {
      /* storage unavailable: the name just is not remembered */
    }
  };

  const level = (v) => (v == null ? '' : v < 0.5 ? 'alert' : v < 0.8 ? 'warn' : '');
  const bar = (v) => {
    if (v == null) return '<span class="muted">–</span>';
    return `<div class="row" style="gap:8px;flex-wrap:nowrap"><div class="bar ${level(v)}" style="flex:1"><i style="width:${Math.round(Math.min(1, v) * 100)}%"></i></div><span class="num small" style="width:2.6em;text-align:right">${pct(v)}</span></div>`;
  };
  const prog = (p) => `<span class="prog ${esc(p)}"><i></i>${PROGRAM[p]}</span>`;
  const riskChip = (r) =>
    r ? `<span class="chip ${r.level === 'high' ? 'alert' : r.level === 'medium' ? 'warn' : 'good'}" title="${esc(r.drivers.map((d) => `${d.text} (+${d.points})`).join('; ') || 'No risk drivers')}">${r.score}</span>` : '<span class="muted">–</span>';
  const ASK_EXAMPLES = ['Who is at risk of dropping off?', 'Who reported pain?', 'Who is ready to progress?', 'Who is overdoing it at home?'];
  const SAMPLE_REFERRAL = `WATERLOO REGIONAL HEALTH NETWORK — FAX REFERRAL
Patient: Nowak, Irene     DOB: 14/03/1947
Referring physician: Dr. A. Patel, Stroke Prevention Clinic
Diagnosis: Left MCA ischaemic stroke (July 2026), mild right hemiparesis, hypertension
Goals: walk to the mailbox independently; return to knitting group
Patient is unable to attend in person (no transport). Requests home-based exercise program.`;
  const today = () => new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });

  // ---------- roster ----------

  views.roster = async (el) => {
    const [rows, stats, alerts] = await Promise.all([api('GET', '/api/participants'), api('GET', '/api/stats'), api('GET', '/api/alerts')]);
    el.innerHTML = `
      <div class="row spread head">
        <div><div class="eyebrow">${esc(today())}</div><h1>Roster</h1><p>Every participant's dose, attendance and flags in one place.</p></div>
        <a class="btn primary" href="#/intake">${icon('userplus')} New intake</a>
      </div>
      <div class="tiles">
        <div class="tile"><div><b data-count>${stats.enrolled}</b><div class="lbl">Enrolled</div><div class="sub">${stats.home} at home · ${stats.waitlist} waitlisted</div></div><span class="tile-ic">${icon('users')}</span></div>
        <div class="tile"><div><b data-count>${stats.sessions_week}</b><div class="lbl">Sessions</div><div class="sub">in the last 7 days</div></div><span class="tile-ic">${icon('calendar')}</span></div>
        <div class="tile"><div><b data-count>${pct(stats.adherence)}</b><div class="lbl">Attendance</div><div class="sub">last 2 weeks, all participants</div></div>${ring(stats.adherence, { size: 46, w: 6, cls: level(stats.adherence) })}</div>
        <div class="tile alert"><div><b data-count>${stats.needs_attention}</b><div class="lbl">Need attention</div><div class="sub">pain, overdose, missed sessions</div></div><span class="tile-ic">${icon('alert')}</span></div>
        <div class="tile good"><div><b data-count>${stats.ready}</b><div class="lbl">Ready to progress</div><div class="sub">dose completed comfortably</div></div><span class="tile-ic">${icon('up')}</span></div>
      </div>
      <div class="card ask">
        <form id="ask-form" class="row" style="flex-wrap:nowrap">
          <span class="tile-ic">${icon('spark')}</span>
          <input id="ask-q" maxlength="500" placeholder="Ask about your roster…" style="flex:1;min-width:0" aria-label="Ask a question about your roster">
          <button class="primary">Ask</button>
        </form>
        <div class="row" style="margin-top:10px;gap:6px">${ASK_EXAMPLES.map((q) => `<button type="button" class="chip plain ask-ex">${esc(q)}</button>`).join('')}</div>
        <div id="ask-out"></div>
      </div>
      <div class="card">
        <h2>Needs review</h2>
        ${
          alerts.length
            ? `<div class="review">${alerts.map((a) => `<a class="${esc(a.level)}" href="#/p/${a.participant_id}">${avatar(a.name)}<span><b>${esc(a.name)}</b><span class="t">${esc(a.text)}</span></span></a>`).join('')}</div>`
            : `<p class="empty">${icon('check')}Nothing needs review right now.</p>`
        }
      </div>
      <div class="card flush">
        <div class="card-head">
          <h2>All participants</h2>
          <div class="toolbar">
            <input id="f-search" type="search" placeholder="Search by name" aria-label="Search by name">
            <select id="f-program" aria-label="Program"><option value="">All programs</option>${Object.entries(PROGRAM).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
            <select id="f-mode" aria-label="Setting"><option value="">Clinic and home</option><option value="clinic">Clinic</option><option value="home">Home</option></select>
            <label class="check"><input type="checkbox" id="f-flag"> Flagged only</label>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Participant</th><th>Program</th><th>Setting</th><th>Dose</th><th style="min-width:140px">Attendance (2 wk)</th><th>Dose done, trend</th><th>Last session</th><th class="r">Quality</th><th title="Transparent weighted score, 0 to 100. Hover a value for its drivers.">Drop-off risk</th><th>Flags</th></tr></thead>
          <tbody id="rows"></tbody>
        </table></div>
      </div>`;

    const askOut = el.querySelector('#ask-out');
    const ask = act(async (question) => {
      askOut.innerHTML = '<p class="muted" style="margin:14px 0 0">Thinking…</p>';
      try {
        const r = await api('POST', '/api/ai/ask', { question });
        // Names in the answer become links to the record.
        let html = esc(r.answer).replace(/\n/g, '<br>');
        for (const m of r.mentions) html = html.replaceAll(esc(m.name), `<a href="#/p/${m.id}"><b>${esc(m.name)}</b></a>`);
        askOut.innerHTML = `<div class="answer"><div>${html}</div><div style="margin-top:8px">${aiBadge(r.source, r.fallback_reason)}</div></div>`;
      } catch (e) {
        askOut.innerHTML = '';
        throw e;
      }
    });
    el.querySelector('#ask-form').onsubmit = (ev) => {
      ev.preventDefault();
      const q = el.querySelector('#ask-q').value.trim();
      if (q) ask(q);
    };
    el.querySelectorAll('.ask-ex').forEach((b) => {
      b.onclick = () => {
        el.querySelector('#ask-q').value = b.textContent;
        ask(b.textContent);
      };
    });

    const draw = () => {
      const q = el.querySelector('#f-search').value.trim().toLowerCase();
      const pr = el.querySelector('#f-program').value;
      const mode = el.querySelector('#f-mode').value;
      const flagged = el.querySelector('#f-flag').checked;
      const shown = rows.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!pr || r.program === pr) && (!mode || r.mode === mode) && (!flagged || r.flags.some((f) => f.level !== 'good')));
      el.querySelector('#rows').innerHTML = shown.length
        ? shown
            .map((r) => {
              const ls = r.last_session;
              return `<tr class="click" data-id="${r.id}">
            <td><div class="who">${avatar(r.name, '', `p${r.id}`)}<div><a href="#/p/${r.id}">${esc(r.name)}</a><div class="muted small">${r.age} yrs</div></div></div></td>
            <td>${prog(r.program)}</td>
            <td>${r.status === 'waitlist' ? '<span class="chip warn">Waitlist</span>' : `<span class="muted">${icon(r.mode === 'home' ? 'home' : 'building')}</span> ${r.mode === 'home' ? 'Home' : 'Clinic'}`}</td>
            <td>${r.dose_version ? `<span class="chip primary plain">v${r.dose_version}</span>` : '<span class="muted">–</span>'}</td>
            <td>${bar(r.adherence)}</td>
            <td><div class="row" style="flex-wrap:nowrap">${spark(r.trend)}<span class="num small">${ls ? pct(ls.completion) : ''}</span></div></td>
            <td class="muted">${ls ? fmtDate(ls.started_at) : '–'}</td>
            <td class="r num">${ls && ls.quality != null ? Math.round(ls.quality) : '–'}</td>
            <td>${riskChip(r.risk)}</td>
            <td>${flagChips(r.flags)}</td>
          </tr>`;
            })
            .join('')
        : `<tr><td colspan="10" class="empty">${icon('users')}No participants match these filters.</td></tr>`;
      el.querySelectorAll('#rows tr.click').forEach((tr) => (tr.onclick = () => (location.hash = `#/p/${tr.dataset.id}`)));
    };
    el.querySelectorAll('#f-search, #f-program, #f-mode, #f-flag').forEach((i) => (i.oninput = draw));
    draw();
  };

  // ---------- participant record ----------

  views.detail = async (el, parts) => {
    const id = Number(parts[1]);
    const [o, exercises] = await Promise.all([api('GET', `/api/participants/${id}`), api('GET', '/api/exercises')]);
    const p = o.participant;
    const rec = o.recommendation;
    const chrono = o.sessions.slice(0, 24).reverse();
    const labels = chrono.map((s) => fmtDate(s.started_at));
    const version = new Map(o.dosages.map((d) => [d.id, d.version]));
    const markers = [];
    chrono.forEach((s, i) => {
      if (i && s.dosage_id !== chrono[i - 1].dosage_id) markers.push({ i, label: `v${version.get(s.dosage_id)}` });
    });
    const REC = { progress: ['up', 'Progress the dose'], regress: ['down', 'Reduce the dose'], hold: ['equal', 'Hold the current dose'], none: ['alert', 'No dose yet'] }[rec.action];
    const last = o.sessions[0];

    const itemRows = (items) => items.map((i, k) => `<tr class="ex-row" data-ex="${esc(i.name)}" data-site="${esc(i.sensor_site || '')}"><td><div class="who"><span class="plan-n" style="width:34px;height:34px;font-size:1rem;border-radius:10px">${k + 1}</span><div><b>${esc(i.name)}</b><div class="muted small">${esc(i.category)}${i.sensor_site ? ` · sensor on ${esc(i.sensor_site.toLowerCase())}` : ''}</div></div></div></td><td><b>${amount(i)}</b></td><td>${esc(i.load) || '<span class="muted">–</span>'}</td></tr>`).join('');

    const proposalRows = () =>
      rec.proposal
        .map((n, k) => {
          const c = o.active.items[k];
          const changed = n.sets !== c.sets || n.target !== c.target;
          const cls = rec.action === 'progress' ? 'up' : 'down';
          return `<tr><td>${esc(n.name)}</td><td class="r" style="white-space:nowrap">${amount(c)}<span class="arrow">→</span><span class="${changed ? cls : ''}">${amount(n)}</span></td></tr>`;
        })
        .join('');

    el.innerHTML = `
      <a class="back no-print" href="#/">${icon('back')} Roster</a>
      <div class="card">
        <div class="hero">
          ${avatar(p.name, 'lg', `p${id}`)}
          <div class="hero-main">
            <h1>${esc(p.name)}</h1>
            <div class="hero-meta">${p.age} yrs · ${PROGRAM[p.program]} program · ${p.mode === 'home' ? 'Home' : 'Clinic'}</div>
            <div><span class="chip ${p.status === 'waitlist' ? 'warn' : 'primary'}">${esc(p.status)}</span>${flagChips(o.flags)}</div>
          </div>
          <div class="row no-print">
            <a class="btn" href="/api/participants/${id}/export.csv" download>${icon('download')} Export CSV</a>
            <button id="print">${icon('print')} Print</button>
            ${o.active ? `<a class="btn primary" href="#/home/${id}">${icon('play')} Participant view</a>` : ''}
          </div>
        </div>
        <div class="stats">
          <div class="stat">${ring(o.adherence, { size: 44, w: 6, cls: level(o.adherence) })}<div><b>${pct(o.adherence)}</b><span>Attendance, 2 wk</span></div></div>
          <div class="stat"><div><b data-count>${o.streak}</b><span>Week streak</span></div></div>
          <div class="stat"><div><b data-count>${o.sessions.length}</b><span>Sessions</span></div></div>
          <div class="stat"><div><b>${last ? pct(last.metrics.completion) : '–'}</b><span>Last dose done</span></div></div>
          <div class="stat"><div><b>${last && last.metrics.quality != null ? Math.round(last.metrics.quality) : '–'}</b><span>Last quality</span></div></div>
          <div class="stat" title="${esc(o.risk ? o.risk.drivers.map((d) => `${d.text} (+${d.points})`).join('; ') || 'No risk drivers' : '')}"><div><b>${o.risk ? o.risk.score : '–'}</b><span>Drop-off risk${o.risk ? `, ${o.risk.level}` : ''}</span></div></div>
        </div>
      </div>

      <div class="grid cols-2">
        <div class="card rec ${esc(rec.action)}">
          <div class="eyebrow">Suggested adjustment</div>
          <div class="rec-badge">${icon(REC[0])} ${REC[1]}</div>
          <ul>${rec.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
          ${rec.proposal ? `<table><tbody>${proposalRows()}</tbody></table><p class="no-print" style="margin-top:16px"><button class="primary" id="use-proposal">${icon('edit')} Review and prescribe</button></p>` : ''}
          <p class="muted small" style="margin:10px 0 0">Based on the last 3 sessions on this dose. A kinesiologist decides.</p>
        </div>
        <div class="card">
          <h2>Profile</h2>
          <dl class="kv">
            <dt>Conditions</dt><dd>${esc(p.conditions) || '–'}</dd>
            <dt>Goals</dt><dd>${esc(p.goals) || '–'}</dd>
            <dt>Referral</dt><dd>${esc(p.referral_source) || '–'}</dd>
          </dl>
          <form id="profile" class="form-grid no-print" style="margin-top:18px;align-items:end">
            <label>Status<select name="status">${['waitlist', 'active', 'graduate', 'discharged'].map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
            <label>Setting<select name="mode"><option value="clinic" ${p.mode === 'clinic' ? 'selected' : ''}>Clinic</option><option value="home" ${p.mode === 'home' ? 'selected' : ''}>Home</option></select></label>
            <label>HR ceiling<input name="hr_max" type="number" min="60" max="220" value="${p.hr_max}"></label>
            <div style="margin-bottom:14px"><button>Update</button></div>
          </form>
        </div>
      </div>

      <div class="card" id="note-card">
        <div class="row spread"><h2 style="margin:0">${icon('spark')} Progress note</h2><button id="note-go" class="primary no-print">Draft note</button></div>
        <p class="muted small" style="margin:8px 0 0">Drafts a SOAP note from this record. The name and birth date are removed before anything is sent to Claude.</p>
        <div id="note-out"></div>
      </div>

      <div class="card" id="dose-card">
        <div class="row spread" style="margin-bottom:10px"><h2 style="margin:0">Current dose ${o.active ? `<span class="chip primary plain">v${o.active.version}</span>` : ''}</h2><button class="no-print" id="edit-dose">${icon(o.active ? 'edit' : 'plus')} ${o.active ? 'Adjust dose' : 'Prescribe dose'}</button></div>
        ${
          o.active
            ? `<div class="row" style="margin-bottom:12px"><span class="chip plain">${icon('calendar')} ${o.active.frequency_per_week}× per week</span><span class="chip plain">${icon('target')} Effort RPE ${o.active.target_rpe}/10</span><span class="muted small">Prescribed ${fmtDate(o.active.created_at)} by ${esc(o.active.created_by)}${o.active.note ? ` · <i>${esc(o.active.note)}</i>` : ''}</span></div>
               <div class="dose-grid"><div class="table-wrap"><table><thead><tr><th>Exercise</th><th>Dose</th><th>Load</th></tr></thead><tbody>${itemRows(o.active.items)}</tbody></table></div>
               <div class="dose-fig no-print"><canvas class="figure" id="dfig"></canvas><div class="cap" id="dfig-cap"></div></div></div>`
            : `<p class="empty">${icon('target')}No dose prescribed yet. Prescribing one moves the participant off the waitlist.</p>`
        }
        <div id="editor"></div>
      </div>

      <div class="grid cols-2">
        <div class="card"><h2>Dose completed and movement quality</h2>${lineChart({ labels, yMax: 150, ref: 100, markers, unit: '%', series: [{ label: 'Dose completed', color: 'var(--s1)', values: chrono.map((s) => s.metrics.completion * 100) }, { label: 'Movement quality', color: 'var(--s2)', values: chrono.map((s) => s.metrics.quality) }] })}</div>
        <div class="card"><h2>Effort and pain</h2>${lineChart({ labels, yMax: 10, ref: o.active ? o.active.target_rpe : null, markers, series: [{ label: 'Effort (RPE)', color: 'var(--s3)', values: chrono.map((s) => s.rpe) }, { label: 'Pain', color: 'var(--s4)', values: chrono.map((s) => s.pain) }] })}</div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Sessions</h2>${o.sessions.length > 12 ? `<span class="muted small">Latest 12 of ${o.sessions.length}. The CSV export has all of them.</span>` : ''}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Setting</th><th>Dose</th><th style="min-width:130px">Done</th><th class="r">Quality</th><th class="r">Peak HR</th><th class="r">RPE</th><th class="r">Pain</th><th>Sets</th></tr></thead>
          <tbody>${
            o.sessions.length
              ? o.sessions
                  .slice(0, 12)
                  .map(
                    (s) => `<tr>
            <td>${fmtDateTime(s.started_at)}</td><td>${s.mode === 'home' ? 'Home' : 'Clinic'}</td><td>v${version.get(s.dosage_id) || '?'}</td>
            <td><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="bar ${s.metrics.over ? 'alert' : s.metrics.completion < 0.7 ? 'warn' : ''}" style="flex:1"><i style="width:${Math.min(100, Math.round(s.metrics.completion * 100))}%"></i></div><span class="num small ${s.metrics.over ? 'down' : ''}">${pct(s.metrics.completion)}</span></div></td>
            <td class="r num">${s.metrics.quality != null ? Math.round(s.metrics.quality) : '–'}</td>
            <td class="r num">${s.metrics.hrPeak ? `<span class="${s.metrics.hrOver ? 'down' : ''}">${s.metrics.hrPeak}</span>` : '–'}</td>
            <td class="r num">${s.rpe ?? '–'}</td><td class="r num">${s.pain >= 5 ? `<span class="down">${s.pain}</span>` : (s.pain ?? '–')}</td>
            <td><details><summary>${s.sets.length} sets</summary><div class="small muted">${s.sets.map((t) => `${esc(t.name)} #${t.set_no}: ${t.done}/${t.target} ${t.unit}${t.quality != null ? `, quality ${t.quality}` : ''}${t.partials ? `, ${t.partials} partial` : ''}`).join('<br>')}${s.notes ? `<br><i>${esc(s.notes)}</i>` : ''}</div></details></td>
          </tr>`
                  )
                  .join('')
              : `<tr><td colspan="9" class="empty">${icon('activity')}No sessions recorded yet.</td></tr>`
          }</tbody>
        </table></div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <h2>Assessments</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Date</th><th class="r">Sit-to-stand</th><th class="r">6-min walk</th><th class="r">TUG</th><th class="r">Grip</th></tr></thead>
            <tbody>${o.assessments.length ? o.assessments.map((a) => `<tr><td>${esc(a.date)}<div class="muted small">${esc(a.notes)}</div></td><td class="r num">${a.sit_to_stand_30s ?? '–'}</td><td class="r num">${a.six_min_walk_m != null ? `${a.six_min_walk_m} m` : '–'}</td><td class="r num">${a.tug_s != null ? `${a.tug_s} s` : '–'}</td><td class="r num">${a.grip_kg != null ? `${a.grip_kg} kg` : '–'}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">No assessments yet.</td></tr>'}</tbody>
          </table></div>
          <details class="no-print" style="margin-top:14px"><summary><b>Record an assessment</b></summary>
            <form id="assess" style="margin-top:12px"><div class="form-grid">
              <label>Date<input name="date" type="date" required value="${new Date().toLocaleDateString('en-CA')}"></label>
              <label>Sit-to-stand, 30 s (reps)<input name="sit_to_stand_30s" type="number" min="0" max="60"></label>
              <label>6-minute walk (m)<input name="six_min_walk_m" type="number" min="0" max="1000"></label>
              <label>Timed up-and-go (s)<input name="tug_s" type="number" min="0" max="120" step="0.1"></label>
              <label>Grip strength (kg)<input name="grip_kg" type="number" min="0" max="100" step="0.1"></label>
              <label>Notes<input name="notes" maxlength="300"></label>
            </div><button class="primary">Save assessment</button></form>
          </details>
        </div>
        <div class="card">
          <h2>Dose history</h2>
          ${o.dosages.length ? o.dosages.map((d) => `<details ${d.active ? 'open' : ''}><summary><b>v${d.version}</b> · ${fmtDate(d.created_at)} · ${esc(d.created_by)} ${d.active ? '<span class="chip primary plain">current</span>' : ''}</summary><div class="small muted" style="margin:4px 0 10px 16px">${d.frequency_per_week}×/week, RPE ${d.target_rpe}${d.note ? ` — <i>${esc(d.note)}</i>` : ''}<br>${d.items.map((i) => `${esc(i.name)}: ${amount(i)}${i.load ? ` (${esc(i.load)})` : ''}`).join('<br>')}</div></details>`).join('') : '<p class="muted">No doses prescribed.</p>'}
          <h2 style="margin-top:22px">Record activity</h2>
          <div class="timeline">${o.audit.map((a) => `<div><b>${esc(a.action)}</b>${a.detail ? ` — ${esc(a.detail)}` : ''}<div class="muted">${fmtDateTime(a.at)} · ${esc(a.actor)}</div></div>`).join('') || '<span class="muted">Nothing yet.</span>'}</div>
        </div>
      </div>`;

    el.querySelector('#print').onclick = () => window.print();

    const noteBtn = el.querySelector('#note-go');
    noteBtn.onclick = act(async () => {
      noteBtn.disabled = true;
      noteBtn.textContent = 'Drafting…';
      try {
        const r = await api('POST', `/api/participants/${id}/ai/note`, { actor: staffName() || 'Staff' });
        el.querySelector('#note-out').innerHTML = `
          <textarea id="note-text" class="note" rows="14" aria-label="Draft progress note">${esc(r.note)}</textarea>
          <div class="row spread no-print">${aiBadge(r.source, r.fallback_reason)}<span class="row"><span class="muted small">Draft. Review and edit before filing.</span><button id="note-copy">${icon('copy')} Copy</button></span></div>`;
        el.querySelector('#note-copy').onclick = act(async () => {
          await navigator.clipboard.writeText(el.querySelector('#note-text').value);
          toast('Note copied');
        });
      } finally {
        noteBtn.disabled = false;
        noteBtn.textContent = 'Draft again';
      }
    });

    el.querySelector('#profile').onsubmit = act(async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      await api('PATCH', `/api/participants/${id}`, { status: f.get('status'), mode: f.get('mode'), hr_max: Number(f.get('hr_max')), actor: staffName() || 'Staff' });
      toast('Profile updated');
      DL.render();
    });

    el.querySelector('#assess').onsubmit = act(async (ev) => {
      ev.preventDefault();
      await api('POST', `/api/participants/${id}/assessments`, { ...Object.fromEntries(new FormData(ev.target)), actor: staffName() || 'Staff' });
      toast('Assessment saved');
      DL.render();
    });

    // ----- dose editor -----
    const exOptions = (sel) => exercises.map((e) => `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.name)} (${e.unit})</option>`).join('');
    const rowHtml = (it) => `<div class="editor-row">
        <select class="e-ex" aria-label="Exercise">${exOptions(it.exercise_id)}</select>
        <input class="e-sets" type="number" min="1" max="10" value="${it.sets}" aria-label="Sets">
        <input class="e-target" type="number" min="1" max="120" value="${it.target}" aria-label="Reps or minutes per set">
        <input class="e-load" maxlength="40" value="${esc(it.load || '')}" placeholder="Load / setting" aria-label="Load">
        <button type="button" class="ghost danger e-del" aria-label="Remove exercise">Remove</button>
      </div>`;

    function openEditor(items, note) {
      const base = o.active || { frequency_per_week: 2, target_rpe: 4 };
      const box = el.querySelector('#editor');
      box.innerHTML = `<form id="dose-form" class="editor">
        <div class="eyebrow">New version</div>
        <h3 style="margin-bottom:14px">Dose ${o.active ? `v${o.active.version + 1}` : 'v1'}</h3>
        <div class="form-grid">
          <label>Sessions per week<input name="freq" type="number" min="1" max="7" value="${base.frequency_per_week}" required></label>
          <label>Target effort (RPE 1–10)<input name="rpe" type="number" min="1" max="10" value="${base.target_rpe}" required></label>
          <label>Prescriber<input name="actor" maxlength="80" value="${esc(staffName())}" placeholder="Name, credentials" required></label>
        </div>
        <div class="editor-row muted small"><b>Exercise</b><b>Sets</b><b>Reps / min</b><b>Load</b><span></span></div>
        <div id="e-rows">${items.map(rowHtml).join('')}</div>
        <p><button type="button" id="e-add">${icon('plus')} Add exercise</button></p>
        <label>Reason for change<input name="note" maxlength="300" value="${esc(note || '')}"></label>
        <div class="row"><button class="primary">${icon('check')} Save as new version</button><button type="button" class="ghost" id="e-cancel">Cancel</button></div>
      </form>`;
      const rows = box.querySelector('#e-rows');
      rows.onclick = (ev) => ev.target.classList.contains('e-del') && ev.target.closest('.editor-row').remove();
      box.querySelector('#e-add').onclick = () => {
        const used = new Set([...rows.querySelectorAll('.e-ex')].map((s) => Number(s.value)));
        const next = exercises.find((e) => !used.has(e.id));
        if (!next) return toast('Every exercise is already in the dose', true);
        rows.insertAdjacentHTML('beforeend', rowHtml({ exercise_id: next.id, sets: next.unit === 'min' ? 1 : 2, target: 10, load: '' }));
      };
      box.querySelector('#e-cancel').onclick = () => (box.innerHTML = '');
      box.querySelector('#dose-form').onsubmit = act(async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        const payload = {
          frequency_per_week: Number(f.get('freq')),
          target_rpe: Number(f.get('rpe')),
          actor: f.get('actor'),
          note: f.get('note'),
          items: [...rows.querySelectorAll('.editor-row')].map((r) => ({ exercise_id: Number(r.querySelector('.e-ex').value), sets: Number(r.querySelector('.e-sets').value), target: Number(r.querySelector('.e-target').value), load: r.querySelector('.e-load').value })),
        };
        const out = await api('POST', `/api/participants/${id}/dosages`, payload);
        rememberStaff(String(f.get('actor')).trim());
        toast(`Dose v${out.version} prescribed`);
        DL.render();
      });
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    el.querySelector('#edit-dose').onclick = () =>
      openEditor(o.active ? o.active.items : [{ exercise_id: 1, sets: 2, target: 8, load: '' }, { exercise_id: 8, sets: 1, target: 10, load: '' }], o.active ? '' : 'Initial dose from intake assessment');
    // 3D demonstration of the selected exercise, with the sensor position highlighted.
    let fig = null;
    const figCanvas = el.querySelector('#dfig');
    if (figCanvas) {
      fig = DL.figure(figCanvas, { mode: 'loop' });
      const show = (row) => {
        el.querySelectorAll('tr.ex-row').forEach((r) => r.classList.toggle('on', r === row));
        fig.set(row.dataset.ex, row.dataset.site);
        el.querySelector('#dfig-cap').innerHTML = `${esc(row.dataset.ex)}${row.dataset.site ? ` · <b>sensor on ${esc(row.dataset.site.toLowerCase())}</b>` : ''}`;
      };
      el.querySelectorAll('tr.ex-row').forEach((r) => (r.onclick = r.onmouseenter = () => show(r)));
      const firstRow = el.querySelector('tr.ex-row');
      if (firstRow) show(firstRow);
    }

    const use = el.querySelector('#use-proposal');
    if (use) use.onclick = () => openEditor(rec.proposal, `${rec.action === 'progress' ? 'Progressed' : 'Reduced'}: ${rec.reasons[0]}`);
    return () => fig && fig.destroy();
  };

  // ---------- live class board ----------

  views.live = async (el) => {
    el.innerHTML = `
      <div class="row spread head">
        <div><div class="eyebrow">In session now</div><h1>Live class</h1><p>One instructor, the whole room: who is on track, who has stopped, who is overdoing it.</p></div>
        <div class="row"><span id="live-state" class="chip plain">Connecting…</span><button id="sim" class="primary">${icon('play')} Start demo class</button></div>
      </div>
      <div id="summary" class="row" style="margin-bottom:16px"></div>
      <div id="board" class="board"></div>`;
    const boardEl = el.querySelector('#board');
    const simBtn = el.querySelector('#sim');
    let simOn = false;
    const rank = (e) => (e.flags.some((f) => f.level === 'alert') ? 0 : e.flags.some((f) => f.level === 'warn') ? 1 : e.status === 'done' ? 3 : 2);

    // What each tile showed last time, so rings move from there and only changed counts pop.
    const shown = new Map();
    let lastBoard = [];

    function draw(data) {
      for (const e of lastBoard) shown.set(e.participant_id, e);
      lastBoard = data.board;
      simOn = data.sim;
      simBtn.innerHTML = simOn ? `${icon('pause')} Stop demo class` : `${icon('play')} Start demo class`;
      const b = [...data.board].sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
      const count = (r) => b.filter((e) => rank(e) === r).length;
      el.querySelector('#summary').innerHTML = b.length
        ? `<span class="chip plain">${b.length} exercising</span>${count(0) ? `<span class="chip alert">${count(0)} need you now</span>` : ''}${count(1) ? `<span class="chip warn">${count(1)} to check</span>` : ''}${count(3) ? `<span class="chip good">${count(3)} finished</span>` : ''}`
        : '';
      boardEl.innerHTML = b.length
        ? b
            .map((e) => {
              const lv = ['alert', 'warn', '', 'good'][rank(e)];
              const over = e.reps > e.target * 1.2;
              return `<div class="live ${lv}">
          <div class="row spread" style="flex-wrap:nowrap"><div class="who">${avatar(e.name)}<a href="#/p/${e.participant_id}">${esc(e.name)}</a></div>${e.hr ? `<span class="hr ${e.hr > e.hr_max ? 'alert' : ''}">${icon('heart')}${e.hr}</span>` : ''}</div>
          <div class="live-body">
            ${ring(e.reps / e.target, { size: 92, w: 9, from: shown.has(e.participant_id) && shown.get(e.participant_id).exercise === e.exercise && shown.get(e.participant_id).set === e.set ? shown.get(e.participant_id).reps / e.target : 0, cls: over ? 'alert' : e.status === 'done' ? 'good' : '', inner: `<b class="${shown.has(e.participant_id) && shown.get(e.participant_id).reps !== e.reps && e.reps > 0 ? 'pop' : ''}">${e.reps}</b><small>of ${e.target}</small>` })}
            <div class="live-meta">
              <div class="ex">${esc(e.exercise)}</div>
              <div class="muted small">Set ${e.set} of ${e.sets} · ${esc(e.source === 'class-sim' ? 'demo' : e.source === 'sim' ? 'demo sensor' : e.source === 'device' ? 'wearable' : e.source === 'camera' ? 'camera' : 'by hand')}</div>
              ${e.quality != null ? `<div class="small" style="margin-top:8px">Quality <b class="num">${e.quality}</b></div><div class="bar ${e.quality < 60 ? 'warn' : ''}"><i style="width:${e.quality}%"></i></div>` : ''}
            </div>
          </div>
          <div style="min-height:1.9em">${flagChips(e.flags)}</div>
        </div>`;
            })
            .join('')
        : `<div class="card empty" style="grid-column:1/-1">${icon('activity')}Nobody is exercising right now.<br>Start the demo class, or begin a session in the Participant view and it will appear here.</div>`;
    }

    const es = new EventSource('/api/live/stream');
    const stateEl = el.querySelector('#live-state');
    es.onopen = () => {
      stateEl.innerHTML = '<span class="pulse-dot"></span>Live';
      stateEl.className = 'chip good plain';
    };
    es.onerror = () => {
      stateEl.textContent = 'Reconnecting…';
      stateEl.className = 'chip warn';
    };
    es.onmessage = (ev) => draw(JSON.parse(ev.data));
    simBtn.onclick = act(() => api('POST', simOn ? '/api/sim/stop' : '/api/sim/start'));
    return () => es.close();
  };

  // ---------- community + intake ----------

  views.feed = async (el) => {
    el.innerHTML = `<div class="head"><div class="eyebrow">Staying connected</div><h1>Community</h1><p>What participants see at home. Only first names and a last initial are ever shown.</p></div>
      <div style="max-width:720px"><div class="card"><label style="margin:0">Posting as<input id="staff" maxlength="60" value="${esc(staffName() || 'CCCARE staff')}"></label></div><div class="card" id="feed"></div></div>`;
    await feedCard(el.querySelector('#feed'), { staffName: () => el.querySelector('#staff').value.trim() || 'CCCARE staff' });
  };

  views.intake = async (el) => {
    el.innerHTML = `
      <a class="back" href="#/">${icon('back')} Roster</a>
      <div class="head"><div class="eyebrow">Referral or self-referral</div><h1>New intake</h1><p>Type a referral or intake assessment in once. It is available everywhere straight away.</p></div>
      <div class="card" style="max-width:860px">
        <h2>${icon('spark')} Start from a referral</h2>
        <label>Paste the faxed or emailed referral text<textarea id="ref-text" maxlength="6000" rows="6" placeholder="Paste the referral here and the form below fills itself in."></textarea></label>
        <div class="row"><button type="button" id="ref-go" class="primary">Extract details</button><button type="button" id="ref-sample" class="ghost">Use a sample referral</button><span id="ref-state"></span></div>
        <p class="muted small" style="margin:10px 0 0">With Claude connected, the pasted text is sent to Claude to be read. Check every field before saving.</p>
      </div>
      <form class="card" id="intake" style="max-width:860px">
        <div class="form-grid">
          <label>Full name<input name="name" maxlength="80" required></label>
          <label>Birth year<input name="birth_year" type="number" min="1900" max="${new Date().getFullYear()}" required></label>
          <label>Program<select name="program">${Object.entries(PROGRAM).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label>Setting<select name="mode"><option value="clinic">Clinic</option><option value="home">Home</option></select></label>
          <label>Status<select name="status"><option value="waitlist">Waitlist</option><option value="active">Active</option></select></label>
          <label>Referral source<input name="referral_source" maxlength="120" placeholder="e.g. WRHN fax referral"></label>
          <label>HR ceiling (bpm, optional)<input name="hr_max" type="number" min="60" max="220" placeholder="Default: 80% of 220 − age"></label>
        </div>
        <label>Conditions and medical history<textarea name="conditions" maxlength="500"></textarea></label>
        <label>Personal goals<textarea name="goals" maxlength="500"></textarea></label>
        <button class="primary">${icon('check')} Create record</button>
      </form>`;
    el.querySelector('#ref-sample').onclick = () => (el.querySelector('#ref-text').value = SAMPLE_REFERRAL);
    const refBtn = el.querySelector('#ref-go');
    refBtn.onclick = act(async () => {
      const t = el.querySelector('#ref-text').value.trim();
      if (!t) throw new Error('Paste the referral text first.');
      refBtn.disabled = true;
      el.querySelector('#ref-state').innerHTML = '<span class="muted">Reading…</span>';
      try {
        const r = await api('POST', '/api/ai/referral', { text: t });
        const form = el.querySelector('#intake');
        let filled = 0;
        for (const [k, v] of Object.entries({ ...r.fields, status: 'waitlist' })) {
          const input = form.elements[k];
          if (!input || v == null || v === '') continue;
          input.value = v;
          input.classList.add('filled');
          if (k !== 'status') filled++;
        }
        el.querySelector('#ref-state').innerHTML = `${aiBadge(r.source, r.fallback_reason)} <span class="muted small">${filled} fields filled. Highlighted fields came from the referral.</span>`;
      } catch (e) {
        el.querySelector('#ref-state').innerHTML = '';
        throw e;
      } finally {
        refBtn.disabled = false;
      }
    });

    el.querySelector('#intake').onsubmit = act(async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(ev.target));
      body.birth_year = Number(body.birth_year);
      body.actor = staffName() || 'Intake';
      const out = await api('POST', '/api/participants', body);
      toast('Record created');
      location.hash = `#/p/${out.id}`;
    });
  };
})();
