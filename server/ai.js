'use strict';
// AI features. Each one runs on Claude when credentials are configured and on a
// built-in, rule-based version otherwise, so the app never depends on the network.
// Every result carries `source: 'claude' | 'built-in'` and the UI shows which it was.
//
// Privacy: participant names are never sent. Records go out as "the participant" or
// as codes like [P3], which are swapped back for names on this machine. The one
// exception is referral text, which is sent as pasted because the name is in it.

const MODEL = 'claude-opus-5-5';

function loadSdk() {
  try {
    const m = require('@anthropic-ai/sdk');
    return m.default || m;
  } catch {
    return null; // optional dependency not installed: built-in mode
  }
}

const NOTE_SYSTEM = `You draft progress notes for kinesiologists at a community exercise clinic for older adults.
You are given one participant's de-identified record as JSON. Write a concise SOAP-style note in plain text with the
headings Subjective, Objective, Assessment and Plan. Use only facts in the record; if something is not recorded, do not
invent it. Refer to the person as "the participant". Quote numbers exactly. In Plan, describe the system's suggested
dose adjustment as a suggestion for the kinesiologist to confirm. Keep it under 220 words. No markdown.`;

const COACH_SYSTEM = `You are a warm, encouraging exercise coach inside an app used by older adults doing a prescribed
exercise plan, some after stroke or cancer treatment. You are given their plan and recent sessions as JSON.
Rules you must always follow:
- Speak plainly and kindly, in 2 to 4 short sentences. No jargon, no lists, no markdown.
- Never change, add to or reduce their prescribed plan, and never give medical advice or diagnose. If they ask to
  change the plan or about symptoms or medication, tell them their kinesiologist decides that and will see their message.
- If they mention chest pain, severe breathlessness, fainting, sudden weakness, trouble speaking or a fall with injury,
  tell them to stop exercising and call 911 or their doctor right away.
- Base anything you say about their progress only on the data provided.`;

const ASK_SYSTEM = `You answer questions from clinic staff about a roster of exercise-program participants, given as JSON.
Each participant has a code such as P3. Refer to participants only by their code in square brackets, like [P3]; never
guess names. Answer from the data only, in at most 5 short sentences or a short list. If the data cannot answer the
question, say so. No markdown headings.`;

const REFERRAL_SYSTEM = `You extract structured intake data from a faxed or typed referral to a community exercise clinic.
Return only what the text states. Use an empty string or null when a field is not stated; never guess.
program: "stroke" for stroke/CVA/TIA referrals, "cancer" for oncology referrals, otherwise "general".
mode: "home" only if the text says the person cannot attend in person or asks for home-based exercise, otherwise "clinic".`;

const REFERRAL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    birth_year: { type: ['integer', 'null'] },
    program: { type: 'string', enum: ['general', 'cancer', 'stroke'] },
    mode: { type: 'string', enum: ['clinic', 'home'] },
    conditions: { type: 'string' },
    goals: { type: 'string' },
    referral_source: { type: 'string' },
  },
  required: ['name', 'birth_year', 'program', 'mode', 'conditions', 'goals', 'referral_source'],
  additionalProperties: false,
};

// ---------- built-in versions ----------

function localReferral(text) {
  const grab = (re) => {
    const m = re.exec(text);
    return m ? m[1].trim().replace(/\s+/g, ' ') : '';
  };
  const label = '(?:patient(?:\\s+name)?|name|re)\\s*[:\\-]\\s*';
  const word = "[A-Z][A-Za-z'’-]+";
  let name = '';
  const surnameFirst = new RegExp(label + '(' + word + '),[ \\t]*(' + word + ')', 'i').exec(text); // "Surname, Given"
  const plain = new RegExp(label + '(' + word + '(?:[ \\t]+' + word + '){1,2})', 'i').exec(text);
  if (surnameFirst) name = surnameFirst[2] + ' ' + surnameFirst[1];
  else if (plain) name = plain[1].replace(/\s+(DOB|Date|Age|Born)$/i, '');
  let year = null;
  const dob = /(?:d\.?o\.?b\.?|date of birth|born)\D{0,12}(?:\d{1,2}[\/\-. ]\w{1,9}[\/\-. ,]+)?((?:19|20)\d{2})/i.exec(text) || /(?:d\.?o\.?b\.?|date of birth|born)\D{0,6}((?:19|20)\d{2})/i.exec(text);
  if (dob) year = Number(dob[1]);
  else {
    const age = /\bage[d:]?\s*(\d{2,3})\b/i.exec(text) || /\b(\d{2,3})\s*-?\s*(?:y\/?o|years?[- ]old)\b/i.exec(text);
    const n = age && Number(age[1]);
    if (n >= 18 && n <= 110) year = new Date().getFullYear() - n;
  }
  const program = /\b(stroke|cva|tia|hemipar|hemipleg)/i.test(text) ? 'stroke' : /\b(cancer|oncolog|chemo|carcinoma|tumou?r|lymphoma|radiation)/i.test(text) ? 'cancer' : 'general';
  const mode = /(cannot|can't|unable to|not able to)\s+(travel|attend|come)|home[- ]based|at[- ]home|remote/i.test(text) ? 'home' : 'clinic';
  const conditions = grab(/(?:diagnos[ie]s|dx|reason for referral|medical history|history|conditions?)\s*[:\-]\s*([^\n]+)/i);
  const goals = grab(/(?:patient\s+)?goals?\s*[:\-]\s*([^\n]+)/i);
  const source = grab(/(?:referr(?:ed|ing)\s+(?:by|physician|provider|from)|from|referral source)\s*[:\-]\s*([^\n]+)/i) || (/\bWRHN\b|Waterloo Regional Health/i.test(text) ? 'WRHN fax referral' : /\bGRH\b|Grand River/i.test(text) ? 'GRH referral' : '');
  return { name, birth_year: year, program, mode, conditions, goals, referral_source: source };
}

const pctText = (v) => `${Math.round(v * 100)}%`;

function localNote(r) {
  const s = r.recent_sessions;
  const last = s[0];
  const avg = (k) => (s.length ? s.reduce((a, x) => a + (x[k] ?? 0), 0) / s.length : null);
  const lines = [];
  lines.push('Subjective');
  lines.push(last ? `Reported effort ${last.rpe ?? 'n/a'}/10 and pain ${last.pain ?? 'n/a'}/10 at the most recent session (${last.date}).${last.notes ? ` Participant note: "${last.notes}"` : ''}` : 'No sessions recorded yet.');
  lines.push('', 'Objective');
  if (r.dose) lines.push(`Dose v${r.dose.version}: ${r.dose.frequency_per_week}x/week, target RPE ${r.dose.target_rpe}. ${r.dose.items.map((i) => `${i.exercise} ${i.amount}`).join('; ')}.`);
  if (s.length) lines.push(`Last ${s.length} sessions: average ${pctText(avg('completion'))} of dose completed${s.some((x) => x.quality != null) ? `, movement quality ${Math.round(s.filter((x) => x.quality != null).reduce((a, x) => a + x.quality, 0) / s.filter((x) => x.quality != null).length)}/100` : ''}. Attendance over 2 weeks: ${r.attendance_2wk == null ? 'n/a' : pctText(r.attendance_2wk)}.`);
  if (s.some((x) => x.hr_over_ceiling)) lines.push(`Heart rate exceeded the ${r.hr_ceiling} bpm ceiling in ${s.filter((x) => x.hr_over_ceiling).length} of these sessions.`);
  const a = r.assessments;
  if (a.length > 1) {
    const f = a[0], l = a[a.length - 1];
    const d = [];
    if (f.sit_to_stand_30s != null && l.sit_to_stand_30s != null) d.push(`30 s sit-to-stand ${f.sit_to_stand_30s} to ${l.sit_to_stand_30s}`);
    if (f.six_min_walk_m != null && l.six_min_walk_m != null) d.push(`6-minute walk ${f.six_min_walk_m} m to ${l.six_min_walk_m} m`);
    if (d.length) lines.push(`Assessments (${f.date} to ${l.date}): ${d.join(', ')}.`);
  }
  lines.push('', 'Assessment');
  lines.push(r.flags.length ? `Flags: ${r.flags.join('; ')}.` : 'No flags raised.');
  lines.push(`Drop-off risk: ${r.dropoff_risk.level} (${r.dropoff_risk.score}/100).`);
  lines.push('', 'Plan');
  const verb = { progress: 'progressing', regress: 'reducing', hold: 'holding', none: 'prescribing' }[r.suggestion.action];
  lines.push(`System suggests ${verb} the dose: ${r.suggestion.reasons.join(' ')} For kinesiologist review.`);
  return lines.join('\n');
}

const RED_FLAGS = /chest (pain|tight)|can'?t breathe|short(ness)? of breath|faint|passed out|dizz|black(ed)? out|numb|slurr|trouble speaking|fell|fall/i;

function localCoach(ctx, question) {
  if (question) {
    if (RED_FLAGS.test(question)) return 'Please stop exercising now and rest. If this is chest pain, trouble breathing, fainting, sudden weakness or trouble speaking, call 911 or your doctor right away. Your kinesiologist will see this message.';
    if (/pain|sore|hurt|ache/i.test(question)) return 'A little muscle soreness a day or two after exercise is common. Sharp pain, or pain that gets worse as you go, is a signal to stop. Please record it at the end of your session so your kinesiologist can review your plan.';
    if (/more|harder|add|increase|extra|easier|less|skip|change/i.test(question)) return 'Your plan is set by your kinesiologist to keep you safe, so I cannot change it. Doing exactly the prescribed amount is the goal. They review your results and will adjust the plan when you are ready.';
    if (/tired|fatigue|no energy|motivat/i.test(question)) return 'Tired days happen to everyone. Try just the first exercise and see how you feel; doing part of your plan still counts. Many people in the group find mornings easiest.';
    if (/how (am i|have i)|progress|doing/i.test(question)) return localCoach(ctx);
    return 'I can help with questions about your exercise plan and how you are doing. For anything about symptoms, medication or changing your plan, your kinesiologist is the right person, and they will see this message.';
  }
  const last = ctx.recent_sessions[0];
  if (!last) return 'Welcome! Your plan is ready whenever you are. Take it steady and stop if anything hurts.';
  const bits = [];
  if (last.completion > 1.2) bits.push('You did more than your plan asked for last time. Your plan is set to keep you safe, so try to stop when you reach your dose.');
  else if (last.completion >= 0.95) bits.push('You completed your full plan last time. That is exactly what we are aiming for.');
  else if (last.completion >= 0.7) bits.push(`You completed ${pctText(last.completion)} of your plan last time, which is a solid session.`);
  else bits.push('You did part of your plan last time, and every bit counts.');
  if (last.quality != null) bits.push(last.quality >= 80 ? `Your movement score was ${last.quality} out of 100, so your form is looking good.` : `Your movement score was ${last.quality} out of 100. Slower, fuller movements will bring that up.`);
  if (last.pain >= 5) bits.push('You reported quite a bit of pain, so your kinesiologist will review your plan. Go gently today.');
  else if (ctx.streak_weeks >= 2) bits.push(`That is ${ctx.streak_weeks} weeks in a row. Keep it going!`);
  return bits.join(' ');
}

function localAsk(question, rows) {
  const names = (list) => (list.length ? list.map((r) => `[${r.code}]`).join(', ') : 'nobody');
  const has = (kind) => rows.filter((r) => r.flags.some((f) => f.kind === kind));
  const q = question.toLowerCase();
  if (/pain|hurt|sore/.test(q)) return `Reporting significant pain in their last session: ${names(has('pain'))}.`;
  if (/miss|attend|absent|drop|risk|disengag/.test(q)) return `Missed sessions recently: ${names(has('missed'))}. High drop-off risk: ${names(rows.filter((r) => r.risk && r.risk.level === 'high'))}.`;
  if (/ready|progress|advance|increase/.test(q)) return `Ready to progress: ${names(rows.filter((r) => r.suggestion === 'progress'))}.`;
  if (/reduc|regress|too hard|struggl/.test(q)) return `Suggested for a reduced dose: ${names(rows.filter((r) => r.suggestion === 'regress'))}.`;
  if (/over|too much|heart|hr\b/.test(q)) return `Exceeded their dose: ${names(has('overdose'))}. Heart rate over the ceiling: ${names(has('hr'))}.`;
  if (/quality|form|technique/.test(q)) return `Low movement quality in their last session: ${names(has('quality'))}.`;
  if (/under|incomplete|not finish/.test(q)) return `Under-dosed in their last session: ${names(has('underdose'))}.`;
  if (/wait/.test(q)) return `On the waitlist: ${names(rows.filter((r) => r.status === 'waitlist'))}.`;
  if (/home|remote/.test(q)) return `Exercising at home: ${names(rows.filter((r) => r.setting === 'home' && r.status !== 'waitlist'))}.`;
  const flagged = rows.filter((r) => r.flags.some((f) => f.level === 'alert'));
  return `Needing attention now: ${names(flagged)}. Built-in mode understands questions about pain, attendance, readiness to progress, overdoing it, form, the waitlist and home participants. Connect Claude for free-form questions.`;
}

// ---------- Claude ----------

function createAi(opts = {}) {
  const Anthropic = loadSdk();
  const hasCreds = !!(opts.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const client = Anthropic && hasCreds && !opts.disabled ? new Anthropic({ ...(opts.apiKey && { apiKey: opts.apiKey }), ...(opts.baseURL && { baseURL: opts.baseURL }), timeout: 60_000, maxRetries: 1 }) : null;
  let lastError = null;

  async function call({ system, messages, effort = 'low', schema }) {
    // Server-side refusal fallback is on: if the model declines, the API reruns the
    // request on a fallback model within the same call.
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages,
      output_config: { effort, ...(schema && { format: { type: 'json_schema', schema } }) },
    });
    if (res.stop_reason === 'refusal') throw new Error('The model declined this request.');
    if (res.stop_reason === 'max_tokens') throw new Error('The response was cut off.');
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) throw new Error('The model returned no text.');
    return text;
  }

  function describe(e) {
    if (!Anthropic) return e.message;
    if (e instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key.';
    if (e instanceof Anthropic.RateLimitError) return 'Claude is rate limited right now.';
    if (e instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${e.message}`;
    if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Claude (no internet?).';
    if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}.`;
    return e.message;
  }

  // Run the Claude version; on any failure, use the built-in one and say why.
  async function run(viaClaude, builtIn) {
    if (!client) return { ...builtIn(), source: 'built-in' };
    try {
      const out = await viaClaude();
      lastError = null;
      return { ...out, source: 'claude' };
    } catch (e) {
      lastError = describe(e);
      console.warn(`AI fell back to built-in: ${lastError}`);
      return { ...builtIn(), source: 'built-in', fallback_reason: lastError };
    }
  }

  return {
    status: () => ({ claude: !!client, model: client ? MODEL : null, sdk_installed: !!Anthropic, last_error: lastError }),

    parseReferral: (text) =>
      run(
        async () => {
          const fields = JSON.parse(await call({ system: REFERRAL_SYSTEM, schema: REFERRAL_SCHEMA, messages: [{ role: 'user', content: text }] }));
          for (const k of REFERRAL_SCHEMA.required) if (!(k in fields)) throw new Error(`Extraction is missing "${k}".`);
          return { fields };
        },
        () => ({ fields: localReferral(text) })
      ),

    progressNote: (record) =>
      run(
        async () => ({ note: await call({ system: NOTE_SYSTEM, effort: 'medium', messages: [{ role: 'user', content: JSON.stringify(record) }] }) }),
        () => ({ note: localNote(record) })
      ),

    // history: [{role: 'user'|'assistant', content}]; empty history asks for a post-session message.
    coach: (ctx, history) => {
      const question = history.length ? history[history.length - 1].content : null;
      const first = { role: 'user', content: `My plan and recent sessions:\n${JSON.stringify(ctx)}\n\n${history.length ? history[0].content : 'I just finished a session. Give me a short, encouraging message about how I am doing.'}` };
      return run(
        async () => ({ reply: await call({ system: COACH_SYSTEM, messages: [first, ...history.slice(1)] }) }),
        () => ({ reply: localCoach(ctx, question) })
      );
    },

    // rows carry codes (P1, P2, ...) instead of names; the caller swaps names back in.
    ask: (question, rows) =>
      run(
        async () => ({ answer: await call({ system: ASK_SYSTEM, messages: [{ role: 'user', content: `Roster:\n${JSON.stringify(rows)}\n\nQuestion: ${question}` }] }) }),
        () => ({ answer: localAsk(question, rows) })
      ),
  };
}

module.exports = { createAi, localReferral, localNote, localCoach, localAsk, MODEL };
