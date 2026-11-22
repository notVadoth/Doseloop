'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../web/fusion.js');

const rep = (rom = 80, tempo = 2000, quality = 80) => ({ rom, tempo, quality });
const reps = (out) => out.filter((e) => e.type === 'rep');

test('arm exercises count on the watch, leg exercises on the camera, unless calibrated otherwise', () => {
  assert.equal(new F.RepFusion('Bicep curl').primary, 'watch');
  assert.equal(new F.RepFusion('Sit-to-stand').primary, 'camera');
  const cfg = { exercises: { 'Sit-to-stand': { primary: 'watch', offsetMs: 300, windowMs: 500, calibratedAt: '2026-11-19T00:00:00Z' } } };
  const f = new F.RepFusion('Sit-to-stand', { cfg });
  assert.equal(f.primary, 'watch');
  assert.equal(f.offsetMs, 300);
  assert.equal(f.windowMs, 500);
  assert.equal(f.calibrated, true);
});

test('a rep both sensors see counts once and is confirmed', () => {
  const f = new F.RepFusion('Bicep curl', { tempoMs: 2000 }); // watch primary, window 800 ms
  const a = f.add('watch', rep(100), 1000);
  assert.equal(reps(a).length, 1);
  assert.equal(a[0].count, 1);
  const b = f.add('camera', rep(95), 1400);
  assert.deepEqual(b.map((e) => e.type), ['confirm']);
  const s = f.finish(10000);
  assert.equal(f.count, 1);
  assert.equal(s.confirmed, 1);
  assert.equal(s.agreement, 100);
  assert.equal(s.offset_ms, 400);
  assert.equal(s.rom_watch, 100);
  assert.equal(s.rom_camera, 95);
});

test('the primary counts at once; a camera that missed it leaves it unconfirmed', () => {
  const f = new F.RepFusion('Bicep curl', { tempoMs: 2000 });
  assert.equal(reps(f.add('watch', rep(), 1000)).length, 1);
  const later = f.tick(3000);
  assert.deepEqual(later.map((e) => e.type), ['unconfirmed']);
  assert.equal(f.finish().unconfirmed, 1);
  assert.equal(f.count, 1);
});

test('a rep only the secondary saw is logged as possible, not counted', () => {
  const f = new F.RepFusion('Bicep curl', { tempoMs: 2000 });
  assert.equal(reps(f.add('camera', rep(), 1000)).length, 0);
  assert.deepEqual(f.tick(3000).map((e) => e.type), ['possible']);
  assert.equal(f.count, 0);
  assert.equal(f.finish().possible, 1);
});

test('a late primary still pairs with an early secondary and counts once', () => {
  const f = new F.RepFusion('Sit-to-stand', { tempoMs: 2500 }); // camera primary
  assert.equal(reps(f.add('watch', rep(), 1000)).length, 0);
  const b = f.add('camera', rep(), 1600);
  assert.equal(reps(b).length, 1);
  assert.equal(b[0].kind, 'confirmed');
  assert.equal(f.finish().confirmed, 1);
});

test('when the camera loses the person the watch counts alone, then hands back', () => {
  const f = new F.RepFusion('Sit-to-stand', { tempoMs: 2500 });
  f.setHealth({ camera: false });
  assert.equal(f.mode(), 'watch');
  const a = f.add('watch', rep(), 1000);
  assert.equal(a[0].kind, 'failover');
  f.add('watch', rep(), 4000);
  assert.equal(f.count, 2);
  f.setHealth({ camera: true });
  assert.equal(reps(f.add('watch', rep(), 7000)).length, 0); // camera is primary again
  assert.equal(reps(f.add('camera', rep(), 7300)).length, 1);
  const s = f.finish();
  assert.equal(f.count, 3);
  assert.equal(s.failover, 2);
  assert.equal(s.confirmed, 1);
});

test('"confirmed" policy: only reps both sensors saw count while both can see', () => {
  const cfg = { policy: 'confirmed' };
  const f = new F.RepFusion('Bicep curl', { cfg, tempoMs: 2000 });
  assert.equal(reps(f.add('watch', rep(), 1000)).length, 0); // waits for the camera
  assert.equal(reps(f.add('camera', rep(), 1300)).length, 1);
  assert.equal(reps(f.add('watch', rep(), 5000)).length, 0);
  assert.deepEqual(f.tick(8000).map((e) => e.type), ['rejected']);
  assert.equal(f.count, 1);
  // With the camera lost, the watch counts on its own even under this policy.
  f.setHealth({ camera: false });
  assert.equal(reps(f.add('watch', rep(), 9000)).length, 1);
});

test('partial reps are reported only by the sensor doing the counting', () => {
  const f = new F.RepFusion('Bicep curl');
  assert.equal(f.add('camera', { partial: true, rom: 30 }, 1000).length, 0);
  assert.equal(f.add('watch', { partial: true, rom: 30 }, 1000).length, 1);
  f.setHealth({ watch: false });
  assert.equal(f.add('camera', { partial: true, rom: 30 }, 2000).length, 1);
  assert.equal(f.partials, 2);
});

test('calibration finds the delay between sensors, a matching window and the range ratio', () => {
  // The camera reports each rep ~350 ms after the watch, give or take 40 ms, with a range
  // 0.8x the watch's. The camera misses one rep; the watch misses none.
  const W = [], C = [];
  const jitter = [20, -30, 40, -10, 0, 30, -40];
  for (let i = 0; i < 7; i++) {
    W.push({ t: 1000 + i * 2500, rom: 100 });
    if (i !== 3) C.push({ t: 1000 + i * 2500 + 350 + jitter[i], rom: 80 });
  }
  const r = F.calibrate({ watch: W, camera: C }, { exercise: 'Bicep curl', tempoMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.pairs, 6);
  assert.ok(Math.abs(r.offsetMs - 350) <= 25, `offset ${r.offsetMs}`);
  assert.ok(r.windowMs >= 400 && r.windowMs <= 800, `window ${r.windowMs}`);
  assert.equal(r.romScale, 0.8);
  assert.equal(r.suggestedPrimary, 'watch');
  // Saved, it drives the matcher.
  const saved = F.applyCalibration(null, r, new Date('2026-11-19T12:00:00Z'));
  assert.deepEqual(F.sanitize(saved), saved);
  const f = new F.RepFusion('Bicep curl', { cfg: saved });
  assert.equal(f.offsetMs, r.offsetMs);
  assert.equal(f.windowMs, r.windowMs);
});

test('calibration says what went wrong when the sensors do not line up', () => {
  const few = F.calibrate({ watch: [{ t: 1, rom: 1 }], camera: [] }, { exercise: 'Bicep curl' });
  assert.equal(few.ok, false);
  assert.match(few.message, /Neither sensor/);
  const W = [0, 2500, 5000, 7500].map((t) => ({ t, rom: 90 }));
  const C = [20000, 22000, 24000, 26000].map((t) => ({ t, rom: 90 })); // never near the watch
  const r = F.calibrate({ watch: W, camera: C }, { exercise: 'Bicep curl' });
  assert.equal(r.ok, false);
  assert.match(r.message, /never agreed/);
});

test('heart rate read while moving cautions first and only stops if it persists', () => {
  const b = new F.BioMonitor(null, 120);
  b.moved(1000);
  b.hr(130, 1500);
  assert.deepEqual(b.reasons(1500).map((r) => [r.level, r.code]), [['caution', 'hr-check']]);
  b.moved(3500); // still exercising
  b.hr(131, 4000);
  assert.equal(b.reasons(4000)[0].level, 'caution');
  b.moved(7000);
  b.hr(132, 7600);
  assert.equal(b.reasons(7600)[0].code, 'hr'); // 6 s later: stop
  // Read while still: stop straight away.
  const s = new F.BioMonitor(null, 120);
  s.hr(130, 5000);
  assert.equal(s.reasons(5000)[0].level, 'stop');
  // Back under the ceiling (with 5 bpm of hysteresis) clears it.
  s.hr(118, 6000);
  assert.equal(s.reasons(6000)[0].level, 'stop');
  s.hr(114, 7000);
  assert.equal(s.reasons(7000).length, 0);
});

test('blood oxygen: caution under 92, stop under 90, levels set per participant', () => {
  const b = new F.BioMonitor(null, 130);
  b.spo2(91, 5000);
  assert.deepEqual(b.reasons(5000).map((r) => r.code), ['spo2-low']);
  b.spo2(88, 6000);
  assert.equal(b.reasons(6000)[0].code, 'spo2');
  assert.equal(b.spo2Min, 88);
  const custom = new F.BioMonitor({ spo2Caution: 90, spo2Stop: 86 }, 130);
  custom.spo2(88, 5000);
  assert.deepEqual(custom.reasons(5000).map((r) => r.code), ['spo2-low']);
});

test('the wrist accelerometer decides whether a reading was taken still', () => {
  const b = new F.BioMonitor(null, 120);
  b.accel(0, 0, 1, 1000);
  b.accel(0.5, 0, 0.8, 2000); // moved
  assert.equal(b.still(2500), false);
  b.accel(0.5, 0.01, 0.8, 3000);
  b.accel(0.5, 0.01, 0.8, 4000);
  assert.equal(b.still(4000), true);
});

test('next set waits for heart rate to recover', () => {
  const b = new F.BioMonitor({ recoveryMargin: 15 }, 130);
  assert.equal(b.recovery().ready, true);
  b.hr(122, 0);
  assert.deepEqual(b.recovery(), { ready: false, known: true, hr: 122, under: 115 });
  b.hr(110, 1000);
  assert.equal(b.recovery().ready, true);
});

test('a fading set is flagged as fatigue, earlier with a rate-limiting medicine', () => {
  const steady = Array.from({ length: 8 }, () => ({ rom: 100, tempo: 2000, quality: 85 }));
  assert.equal(F.fatigue(steady), null);
  const fading = [100, 100, 100, 95, 92, 88, 84, 83].map((rom) => ({ rom, tempo: 2000, quality: 85 }));
  assert.equal(F.fatigue(fading), null); // 15% smaller: not yet
  assert.equal(F.fatigue(fading, { rateLimited: true }).code, 'fatigue');
  const tired = [100, 100, 100, 90, 85, 78, 75, 74].map((rom) => ({ rom, tempo: 2000, quality: 85 }));
  assert.equal(F.fatigue(tired).code, 'fatigue');
});

test('the safety level puts stop before caution and keeps every reason', () => {
  const a = F.assess({ bio: [{ level: 'caution', code: 'spo2-low', text: 'x' }], formFaults: [{ id: 'lean', cue: 'Stand tall' }], overDose: true });
  assert.equal(a.level, 'stop');
  assert.deepEqual(a.reasons.map((r) => r.code), ['overdose', 'spo2-low', 'form:lean']);
  assert.equal(F.assess({}).level, 'ok');
  assert.equal(F.assess({ sensors: 'none' }).level, 'caution');
});

test('settings are validated before they are saved', () => {
  assert.deepEqual(F.sanitize({ spo2Caution: '93', policy: 'confirmed', rateLimited: 'on', junk: 1 }), { spo2Caution: 93, policy: 'confirmed', rateLimited: true });
  assert.throws(() => F.sanitize({ spo2Stop: 93, spo2Caution: 91 }), /stop level/);
  assert.throws(() => F.sanitize({ spo2Caution: 120 }), /from 85 to 98/);
  assert.throws(() => F.sanitize({ exercises: { 'Bicep curl': { primary: 'nose' } } }), /watch or camera/);
  assert.throws(() => F.sanitize([]), /object/);
});
