// Heart-rate projection for the DoseLoop wearable.
//
// The wrist pulse sensor often cannot give a reliable reading (movement, a loose strap, a
// faint pulse). When it cannot, the watch shows a projected heart rate instead (the
// "Measure pulse" screen and the website's live Wearable page; never sent over USB, never
// saved, never used for safety). This file makes that projection follow what the wearer is
// doing, calibrated to their own real readings:
//
//  1. Exertion, every second: 0 resting, 1 light, 2 moderate, 3 hard. The higher of
//       - the rep rate over the last 30 s (any rep counted by the watch), and
//       - how much the wrist is moving (average deviation of the accelerometer from 1 g
//         over about 10 s), so exercise without the app counts too.
//  2. Learning: every reliable real reading is filed under (exercise, exertion level), keeping
//     the last 15 in each slot (at most one every 5 s per slot). The projection's target is
//     the median of that slot once it has 3 readings.
//  3. What is shown stays in a believable band, set by how much the accelerometer sees:
//       - still: about 75 bpm (with the natural wander added by the sketch, 70-80);
//       - moving: rising with the activity (wrist movement or rep rate) up to 120 bpm;
//       - only after several minutes of hard, unbroken activity can it reach 135 (rare).
//     A learned median for this exercise and exertion pulls the target half way towards it
//     (kept within 70-120), so the person's own readings still shape it.
//  4. The projection moves towards the target the way a heart rate does: rising with a time
//     constant of about 30 s, recovering with about 60 s. A real reading resets it.
//
// Pure C++ (no Arduino): unit-tested on a PC by firmware/test/test_hr_projection.cpp.
#pragma once
#include <math.h>
#include <stdint.h>
#include <string.h>

namespace hrp {

const int LEVELS = 4;
const int EXERCISES = 10;  // slot 0 is "general" (no exercise named by the app)
const int KEEP = 15;       // readings kept per slot
const uint16_t VERSION = 1;

// What is saved on the watch (plain data, so it can be stored as bytes).
struct Slot {
  uint8_t n;     // readings kept (up to KEEP)
  uint8_t next;  // where the next one goes (oldest is replaced)
  uint8_t bpm[KEEP];
};
struct Model {
  uint16_t version;
  char names[EXERCISES][24];
  Slot slot[EXERCISES][LEVELS];
};

// Typical rise above resting heart rate per exertion level, for an exercise of average effort.
const float RISE[LEVELS] = {0, 10, 22, 35};
// Rep rate (per minute) and wrist movement (g) at which each level starts (index 1..3).
const float RPM_AT[LEVELS] = {0, 0.5f, 6, 12};
const float MOVE_AT[LEVELS] = {0, 0.03f, 0.08f, 0.18f};
const uint32_t LEARN_EVERY_MS = 5000;
// The band the projection is kept in.
const float BAND_REST = 75;          // still
const float BAND_ACTIVE = 120;       // full activity
const float BAND_TOP = 135;          // only after minutes of hard, unbroken activity
const float BAND_LOW = 70;
const float SUSTAIN_TAU_S = 120;     // how slowly "sustained activity" builds and fades
// Activity 0-1 from wrist movement (g) and rep rate (per minute).
const float MOVE_NONE = 0.02f, MOVE_FULL = 0.18f, RPM_FULL = 12;

// How hard an exercise is, relative to average (scales the default rise).
inline float effortOf(const char *name) {
  struct E { const char *key; float f; };
  static const E table[] = {
      {"Sit-to-stand", 1.3f}, {"Treadmill", 1.2f}, {"bike", 1.1f}, {"Wall push-up", 1.0f}, {"Lateral arm", 0.7f},
      {"hip abduction", 0.8f}, {"Heel raise", 0.8f}, {"knee extension", 0.6f}, {"Bicep", 0.6f}, {"Stretching", 0.4f},
  };
  if (!name || !*name) return 0.9f;
  for (const E &e : table)
    if (strstr(name, e.key)) return e.f;
  return 0.9f;
}

inline float medianOf(const uint8_t *v, int n) {
  uint8_t s[KEEP];
  for (int i = 0; i < n; i++) s[i] = v[i];
  for (int i = 1; i < n; i++)
    for (int j = i; j > 0 && s[j] < s[j - 1]; j--) {
      uint8_t t = s[j];
      s[j] = s[j - 1];
      s[j - 1] = t;
    }
  return n % 2 ? s[n / 2] : (s[n / 2 - 1] + s[n / 2]) / 2.0f;
}

struct Projector {
  Model m;
  bool dirty = false;  // learned something not yet saved
  float proj = 0;      // projected bpm (0 until first step)
  uint32_t lastStep = 0;
  float move = 0;  // wrist movement, g (smoothed over about 10 s)
  float sustained = 0;  // activity averaged over minutes (0-1): only this lets it pass 120
  uint32_t reps[32];
  int nReps = 0, repHead = 0;
  uint32_t lastLearn[EXERCISES][LEVELS];

  Projector() { clear(); }

  void clear() {
    memset(&m, 0, sizeof(m));
    m.version = VERSION;
    memset(lastLearn, 0, sizeof(lastLearn));
    proj = 0;
    sustained = 0;
    dirty = true;
  }

  // Load saved bytes; false (and a fresh model) if they do not match this version.
  bool load(const void *bytes, size_t len) {
    if (len != sizeof(Model)) return false;
    Model tmp;
    memcpy(&tmp, bytes, sizeof(Model));
    if (tmp.version != VERSION) return false;
    for (int e = 0; e < EXERCISES; e++)
      for (int l = 0; l < LEVELS; l++)
        if (tmp.slot[e][l].n > KEEP || tmp.slot[e][l].next >= KEEP) return false;
    m = tmp;
    dirty = false;
    return true;
  }

  // One accelerometer sample (g), 50 a second.
  void motion(float ax, float ay, float az) {
    float dev = fabsf(sqrtf(ax * ax + ay * ay + az * az) - 1.0f);
    if (dev > 1.5f) dev = 1.5f;  // a knock, not exertion
    move += 0.002f * (dev - move);  // about 10 s at 50 samples a second
  }

  // A rep counted by the watch.
  void rep(uint32_t t) {
    reps[repHead] = t;
    repHead = (repHead + 1) % 32;
    if (nReps < 32) nReps++;
  }

  float repsPerMin(uint32_t t) const {
    int k = 0;
    for (int i = 0; i < nReps; i++)
      if (t - reps[i] <= 30000) k++;
    return k * 2.0f;
  }

  // Activity right now, 0 (still) to 1 (hard): the higher of wrist movement and rep rate.
  float activity(uint32_t t) const {
    float m = (move - MOVE_NONE) / (MOVE_FULL - MOVE_NONE);
    float r = repsPerMin(t) / RPM_FULL;
    float a = m > r ? m : r;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  // Where the shown heart rate is heading: the band for this activity, pulled half way towards
  // the person's own median for this exercise and exertion when there is one, plus (only after
  // minutes of hard activity) up to 15 bpm more.
  float bandTarget(uint32_t t, int ex, int lvl) const {
    float a = activity(t);
    float tgt = BAND_REST + (BAND_ACTIVE - BAND_REST) * a;
    const Slot &s = m.slot[ex][lvl];
    if (s.n >= 3) {
      float own = medianOf(s.bpm, s.n);
      own = own < BAND_LOW ? BAND_LOW : own > BAND_ACTIVE ? BAND_ACTIVE : own;
      tgt = 0.5f * tgt + 0.5f * own;
    }
    float k = (sustained - 0.7f) / 0.3f;  // nothing until the last minutes have averaged 70% activity
    if (k > 0) tgt += (BAND_TOP - BAND_ACTIVE) * (k > 1 ? 1 : k * k) * a;
    return tgt < BAND_LOW ? BAND_LOW : tgt > BAND_TOP ? BAND_TOP : tgt;
  }

  // Exertion level right now: the higher of the rep-rate and wrist-movement levels.
  int level(uint32_t t) const {
    float rpm = repsPerMin(t);
    int a = 0, b = 0;
    for (int l = 1; l < LEVELS; l++) {
      if (rpm >= RPM_AT[l]) a = l;
      if (move >= MOVE_AT[l]) b = l;
    }
    return a > b ? a : b;
  }

  // The slot for an exercise name ("" = general), adding it if there is room.
  int exercise(const char *name) {
    if (!name || !*name) return 0;
    for (int e = 1; e < EXERCISES; e++)
      if (m.names[e][0] && strncmp(m.names[e], name, sizeof(m.names[e]) - 1) == 0) return e;
    for (int e = 1; e < EXERCISES; e++)
      if (!m.names[e][0]) {
        strncpy(m.names[e], name, sizeof(m.names[e]) - 1);
        m.names[e][sizeof(m.names[e]) - 1] = 0;
        dirty = true;
        return e;
      }
    return 0;  // full: learn under general
  }

  // The person's resting heart rate: their own median at rest, else 74.
  float rest() const {
    const Slot &g = m.slot[0][0];
    if (g.n >= 3) return medianOf(g.bpm, g.n);
    for (int e = 1; e < EXERCISES; e++)
      if (m.slot[e][0].n >= 3) return medianOf(m.slot[e][0].bpm, m.slot[e][0].n);
    return 74;
  }

  // Where heart rate is heading for this exercise and exertion.
  float target(int ex, int lvl) const {
    const Slot &s = m.slot[ex][lvl];
    if (s.n >= 3) return medianOf(s.bpm, s.n);
    return rest() + RISE[lvl] * effortOf(ex ? m.names[ex] : "");
  }

  // A reliable real reading: learn it (at most once per 5 s per slot) and restart from it.
  void real(int bpm, uint32_t t, int ex, int lvl) {
    if (bpm < 35 || bpm > 220) return;
    proj = (float)bpm;
    lastStep = t;
    if (lastLearn[ex][lvl] && t - lastLearn[ex][lvl] < LEARN_EVERY_MS) return;
    lastLearn[ex][lvl] = t ? t : 1;
    Slot &s = m.slot[ex][lvl];
    s.bpm[s.next] = (uint8_t)bpm;
    s.next = (s.next + 1) % KEEP;
    if (s.n < KEEP) s.n++;
    dirty = true;
  }

  // Advance the projection to time t; returns it (bpm).
  int step(uint32_t t, int ex, int lvl) {
    float dt = proj > 0 ? (t - lastStep) / 1000.0f : 0;
    if (dt > 0) sustained += (activity(t) - sustained) * (1 - expf(-dt / SUSTAIN_TAU_S));
    float tgt = bandTarget(t, ex, lvl);
    if (proj <= 0) proj = tgt;
    else if (dt > 0) {
      float tau = tgt > proj ? 30.0f : 60.0f;
      proj += (tgt - proj) * (1 - expf(-dt / tau));
    }
    if (proj < BAND_LOW) proj = BAND_LOW;  // a real reading outside the band is shown as itself;
    if (proj > BAND_TOP) proj = BAND_TOP;  // the projection that follows it stays in the band
    lastStep = t;
    return (int)(proj + 0.5f);
  }
};

}  // namespace hrp
