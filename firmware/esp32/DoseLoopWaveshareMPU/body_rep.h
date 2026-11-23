// Body-movement rep counter for the DoseLoop wearable (sit-to-stand).
//
// The wrist-tilt counter in the sketch needs the forearm to rotate through most of the
// prescribed range. Standing up barely rotates the wrist: the whole body rises instead. This
// counter follows that rise:
//
//  1. The size of the acceleration (whatever way the watch is turned) is about 1 g plus the
//     vertical acceleration, so its change from the resting value is the up/down push of the
//     body. The resting value is measured during the first half second of the set (seated,
//     still) and is then the 15-second average of the reading: over whole reps the body ends
//     where it started, so the average push is zero and any error in the first value fades.
//  2. That is integrated into a vertical velocity (with a slow leak against drift) and, during
//     each movement, into a height (from where it began). A movement starts when the velocity
//     passes V_ENTER and ends when it falls back under V_EXIT. Once the wrist has settled (no
//     push, almost no speed) the velocity is set to zero, so leftover drift never builds up.
//  3. A real rise is braked at the top: the body decelerates to a stop. A rise counts only if
//     its braking took off at least BRAKE_FRAC of its peak speed; a knock or a drift has no
//     braking and is ignored. (An accelerometer cannot tell a slow steady rise from standing
//     still, so stillness is never used to stop a movement: slow, frail rises still count.)
//  4. A rise of at least VALID_M is a rep, counted when the rise ends (standing: where the
//     camera counts too). A smaller one of at least PART_M is a partial rep. The next rep
//     counts only after a descent (sitting back down), so standing and shifting never counts twice.
//
// Reports the same Rep as the tilt counter, with the rise height in cm in place of degrees.
// Pure C++ (no Arduino): unit-tested on a PC by firmware/test/test_body_rep.cpp.
#pragma once
#include <math.h>
#include <stdint.h>
#include <string.h>

namespace body {

const float G = 9.81f;
const float DT = 1.0f / 50;             // 50 samples a second
const int CAL_SAMPLES = 25;             // 0.5 s seated and still at the start of the set
const float ACC_ALPHA = 0.25f;          // smoothing of the vertical acceleration (about 3.5 Hz)
const float ACC_CLIP = 6.0f;            // m/s^2: standing up pushes 0.3-3; more is a knock
const float TAU_V = 10.0f;              // very slow leak on the velocity, against drift
const float V_ENTER = 0.10f;            // m/s: a rise or descent has started
const float V_EXIT = 0.03f;             // m/s: ...and has ended
const float REST_TAU = 15.0f;           // s: the resting value is the long-run average (see 1.)
const float SETTLE_V = 0.10f;           // m/s: under this (above the drift a 2-3 s movement leaves; under half a slow rise)...
const float SETTLE_ACC = 0.10f;         // m/s^2: ...with no push over this...
const int SETTLE_N = 20;                // ...for 400 ms: the body has stopped
const float BRAKE_FRAC = 0.5f;          // a rise must be braked by at least half its peak speed
const float VALID_M = 0.15f;            // rise height for a full rep (the wrist rises 30-45 cm standing up)
const float PART_M = 0.05f;             // under this it is not a movement at all
const uint32_t MIN_LOBE_MS = 300;       // shorter pushes are knocks
const uint32_t MAX_LOBE_MS = 5000;      // longer ones are not one movement
const uint32_t STAND_RESET_MS = 12000;  // no descent for this long: assume seated again

struct Result {
  uint16_t count, tempo_ms, rom_cm;
  uint8_t quality;
};
enum Event { NONE, REP, PARTIAL };

struct Counter {
  float target_cm = 35;  // expected rise of the wrist, for the quality score
  uint32_t target_tempo_ms = 2500;
  float rest = 1, cal_sum = 0, acc = 0, slow = 0, vel = 0, height = 0, peak_v = 0, brake = 0, lead = 0;
  int cal_n = 0, quiet_n = 0;
  int dir = 0;            // movement in progress: +1 rising, -1 descending, 0 none
  bool standing = false;  // counted a rise; waiting for the descent
  uint32_t lobe_start = 0, last_rep_ms = 0, stood_at = 0;
  uint16_t count = 0, partials = 0;

  void reset(float targetCm, uint32_t tempoMs) {
    *this = Counter();
    target_cm = targetCm;
    target_tempo_ms = tempoMs;
  }

  static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

  uint8_t score(float cm, uint32_t tempo) const {
    float rom = clampf(cm / target_cm, 0, 1) * 100;
    float r = (float)tempo / target_tempo_ms, t;
    if (r < 0.7f) t = clampf((r - 0.3f) / 0.4f, 0, 1) * 100;
    else if (r > 1.5f) t = clampf((3.0f - r) / 1.5f, 0, 1) * 100;
    else t = 100;
    return (uint8_t)(0.6f * rom + 0.4f * t + 0.5f);
  }

  // One accelerometer sample (g) at time t_ms.
  Event update(float ax, float ay, float az, uint32_t t_ms, Result &out) {
    float mag = sqrtf(ax * ax + ay * ay + az * az);
    if (mag < 0.1f) return NONE;
    if (cal_n < CAL_SAMPLES) {
      cal_sum += mag;
      rest = cal_sum / ++cal_n;
      return NONE;
    }
    // Over whole reps the body ends where it started, so the average push is zero and the
    // long-run average of the reading is the resting value: any calibration error fades out.
    rest += (mag - rest) * DT / REST_TAU;
    float a = clampf((mag - rest) * G, -ACC_CLIP, ACC_CLIP);  // vertical acceleration, m/s^2
    acc += ACC_ALPHA * (a - acc);
    slow += 0.08f * (a - slow);  // about 0.7 Hz: what is left once sensor noise is averaged out
    float before = vel;
    vel += acc * DT;
    vel -= vel * DT / TAU_V;
    // Height moved since the velocity last left zero: the part of a movement before it is
    // recognised still counts towards its height.
    if ((before > 0) != (vel > 0) || fabsf(vel) < 0.02f) lead = 0;
    lead += vel * DT - lead * DT / 0.5f;  // only the last half second or so
    // Settled: no push and hardly any speed left, so the body has stopped. The speed is set
    // to zero (the last of a movement's braking and sensor noise would otherwise linger as
    // a false drift). A slow rise is never mistaken for this: its speed stays well above
    // SETTLE_V until it is braked.
    if (fabsf(slow) < SETTLE_ACC && fabsf(acc) < 2 * SETTLE_ACC && fabsf(vel) < SETTLE_V) {
      if (++quiet_n >= SETTLE_N) {
        vel = 0;
        lead = 0;
      }
    } else quiet_n = 0;

    if (standing && t_ms - stood_at > STAND_RESET_MS) standing = false;

    if (dir == 0) {
      if (vel > V_ENTER || vel < -V_ENTER) {
        dir = vel > 0 ? 1 : -1;
        lobe_start = t_ms;
        height = lead;
        peak_v = 0;
        brake = 0;
      }
      return NONE;
    }
    height += vel * DT;
    if (fabsf(vel) > peak_v) peak_v = fabsf(vel);
    if (acc * dir < 0) brake += fabsf(acc) * DT;  // speed taken off by braking
    bool ended = dir > 0 ? vel < V_EXIT : vel > -V_EXIT;
    if (!ended) {
      if (t_ms - lobe_start > MAX_LOBE_MS) dir = 0;  // not one movement: drop it
      return NONE;
    }
    int was = dir;
    dir = 0;
    uint32_t len = t_ms - lobe_start;
    float h = fabsf(height);
#ifdef BODY_DEBUG
    printf("  lobe dir %+d at %u ms: len %u ms, height %.3f m, peak %.3f m/s, brake %.3f, standing %d\n", was, lobe_start, len, height, peak_v, brake, standing);
#endif
    if (len < MIN_LOBE_MS || h < PART_M || brake < BRAKE_FRAC * peak_v) return NONE;
    if (was < 0) {  // sat back down: the next rise can count
      standing = false;
      return NONE;
    }
    if (standing) return NONE;  // a second rise without sitting down: the same stand
    uint32_t tempo = last_rep_ms && t_ms - last_rep_ms < 15000 ? t_ms - last_rep_ms : len * 2;
    out.tempo_ms = (uint16_t)(tempo > 65000 ? 65000 : tempo);
    out.rom_cm = (uint16_t)(h * 100 + 0.5f);
    out.quality = score(h * 100, tempo);
    if (h < VALID_M) {
      partials++;
      out.count = count;
      return PARTIAL;
    }
    standing = true;
    stood_at = t_ms;
    last_rep_ms = t_ms;
    out.count = ++count;
    return REP;
  }
};

// Exercises counted from the body's movement rather than the wrist's tilt.
inline bool usesBody(const char *exercise) { return exercise && strstr(exercise, "Sit-to-stand") != nullptr; }

}  // namespace body
