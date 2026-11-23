// Unit tests for the body-movement rep counter (firmware/esp32/DoseLoopWaveshareMPU/body_rep.h),
// on simulated wrist movement: gravity in a fixed, tilted direction plus the body's vertical
// movement, sensor noise and a small scale error, sampled 50 times a second.
// Build and run on a PC:
//   g++ -std=c++17 -O1 -I ../esp32/DoseLoopWaveshareMPU test_body_rep.cpp -o test_body_rep && ./test_body_rep
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <vector>
#include "body_rep.h"

static int failures = 0;
#define CHECK(cond, ...)                  \
  do {                                    \
    if (!(cond)) {                        \
      failures++;                         \
      printf("FAIL line %d: ", __LINE__); \
      printf(__VA_ARGS__);                \
      printf("\n");                       \
    }                                     \
  } while (0)

static unsigned rngState = 12345;
static float uni() { return (rngState = rngState * 1664525u + 1013904223u) / 4294967296.0f; }
static float gauss() { return sqrtf(-2 * logf(uni() + 1e-9f)) * cosf(6.2831853f * uni()); }

// Wrist height over time, metres: a list of (duration s, target height m) segments, each a
// smooth (cosine) move from the previous height.
struct Seg { float secs, to; };

struct Sim {
  float gx = 0.25f, gy = -0.3f, gz = -0.92f;  // gravity direction in the watch's axes (tilted wrist)
  // 2% scale error; 0.006 g noise per axis (the MPU6050 datasheet gives about 0.002-0.004 g at
  // this rate: a margin for tremor and a loose strap)
  float scale = 1.02f, noise = 0.006f;
  float sway = 0;                             // horizontal wrist movement, g (arm waving)
  std::vector<float> h;                        // height per sample
  void build(const std::vector<Seg> &segs) {
    float cur = 0;
    for (const Seg &s : segs) {
      int n = (int)(s.secs * 50);
      for (int i = 0; i < n; i++) h.push_back(cur + (s.to - cur) * 0.5f * (1 - cosf(3.14159265f * (i + 1) / n)));
      cur = s.to;
    }
  }
  // Run the counter over the whole movement; returns {reps, partials}.
  void run(body::Counter &c, int &reps, int &parts, std::vector<uint16_t> *cms = nullptr, std::vector<uint32_t> *at = nullptr) {
    float n = sqrtf(gx * gx + gy * gy + gz * gz);
    float ux = gx / n, uy = gy / n, uz = gz / n;  // "down" in the watch's axes
    reps = parts = 0;
    for (size_t i = 0; i < h.size(); i++) {
      float acc = 0;  // vertical acceleration, m/s^2 (second difference of height)
      if (i > 0 && i + 1 < h.size()) acc = (h[i + 1] - 2 * h[i] + h[i - 1]) * 2500;
      float up = acc / 9.81f;
      // Gravity reads as +1 g "up" on an accelerometer; moving up adds to it.
      float k = -(1 + up) * scale;
      float sx = sway * sinf(i * 0.12566f), sy = sway * cosf(i * 0.12566f);  // 1 Hz circles, sideways
      float ax = k * ux + sx * uz + noise * gauss();
      float ay = k * uy + sy + noise * gauss();
      float az = k * uz - sx * ux + noise * gauss();
      body::Result r;
      body::Event e = c.update(ax, ay, az, (uint32_t)(i * 20), r);
      if (e == body::REP) {
        reps++;
        if (cms) cms->push_back(r.rom_cm);
        if (at) at->push_back(i * 20);
      } else if (e == body::PARTIAL) parts++;
    }
  }
};

// Seated (1 s still), then n sit-to-stands: rise `rise` m over `up` s, stand, sit down, pause.
static std::vector<Seg> stands(int n, float rise = 0.4f, float up = 1.0f, float stand = 0.6f, float down = 1.3f, float pause = 0.8f) {
  std::vector<Seg> s = {{1.0f, 0}};
  for (int i = 0; i < n; i++) {
    s.push_back({up, rise});
    s.push_back({stand, rise});
    s.push_back({down, 0});
    s.push_back({pause, 0});
  }
  s.push_back({2.0f, 0});
  return s;
}

int main() {
  // --- ten ordinary sit-to-stands ---
  {
    Sim sim;
    sim.build(stands(10));
    body::Counter c;
    c.reset(35, 2500);
    int reps, parts;
    std::vector<uint16_t> cms;
    std::vector<uint32_t> at;
    sim.run(c, reps, parts, &cms, &at);
    CHECK(reps == 10, "10 sit-to-stands: counted %d (partials %d)", reps, parts);
    CHECK(parts == 0, "no partial reps (%d)", parts);
    for (uint16_t cm : cms) CHECK(cm >= 15 && cm <= 50, "rise height %u cm is plausible", cm);
    // Counted at the top: each count lands near the end of the rise (1 s up starts after 1 s seated, then every 3.7 s).
    for (size_t i = 0; i < at.size(); i++) {
      float top = 1000 + i * 3700 + 1000;
      CHECK(fabsf(at[i] - top) < 700, "rep %zu counted at %u ms, top of the rise at %.0f ms", i + 1, at[i], top);
    }
  }

  // --- slow, frail movement: 2 s up, 2.5 s down, rise 30 cm ---
  {
    Sim sim;
    sim.build(stands(6, 0.3f, 2.0f, 1.0f, 2.5f, 1.5f));
    body::Counter c;
    c.reset(35, 2500);
    int reps, parts;
    sim.run(c, reps, parts);
    CHECK(reps == 6, "slow sit-to-stands: counted %d (partials %d)", reps, parts);
  }

  // --- the watch held another way, more noise, bigger scale error ---
  {
    Sim sim;
    sim.gx = -0.9f; sim.gy = 0.2f; sim.gz = 0.3f;
    sim.scale = 0.97f;
    sim.noise = 0.012f;  // twice the usual
    sim.build(stands(8));
    body::Counter c;
    c.reset(35, 2500);
    int reps, parts;
    sim.run(c, reps, parts);
    CHECK(reps == 8, "other orientation, noisier: counted %d (partials %d)", reps, parts);
  }

  // --- part-way up and back: partial reps, not reps ---
  {
    Sim sim;
    sim.build(stands(4, 0.09f, 0.8f, 0.3f, 0.8f, 0.8f));
    body::Counter c;
    c.reset(35, 2500);
    int reps, parts;
    sim.run(c, reps, parts);
    CHECK(reps == 0, "small rises are not reps (%d)", reps);
    CHECK(parts >= 3, "small rises are partial reps (%d)", parts);
  }

  // --- standing still, swaying a little, and waving the arm: nothing counted ---
  {
    Sim sim;
    std::vector<Seg> s = {{1.0f, 0}};
    for (int i = 0; i < 10; i++) { s.push_back({0.7f, 0.02f}); s.push_back({0.7f, -0.02f}); }  // 2 cm sway
    sim.build(s);
    sim.sway = 0.25f;  // and the arm circling sideways
    body::Counter c;
    c.reset(35, 2500);
    int reps, parts;
    sim.run(c, reps, parts);
    CHECK(reps == 0, "sway and arm waving: no reps (%d)", reps);
  }

  // --- a knock on the watch while seated ---
  {
    body::Counter c;
    c.reset(35, 2500);
    body::Result r;
    int reps = 0;
    for (int i = 0; i < 200; i++) {
      float k = (i == 80) ? 3.0f : (i == 81 ? -1.0f : 1.0f);
      if (c.update(0, 0, -k, i * 20, r) == body::REP) reps++;
    }
    CHECK(reps == 0, "a knock is not a rep (%d)", reps);
  }

  // --- standing up and staying up: one rep, not more ---
  {
    Sim sim;
    sim.build({{1.0f, 0}, {1.0f, 0.4f}, {6.0f, 0.4f}, {0.8f, 0.45f}, {3.0f, 0.45f}});
    body::Counter c;
    c.reset(35, 2500);
    int reps, parts;
    sim.run(c, reps, parts);
    CHECK(reps == 1, "standing up once (then shifting) is one rep (%d)", reps);
  }

  // --- the same cases over many noise patterns: not lucky with one ---
  {
    int bad[4] = {0};
    for (unsigned seed = 1; seed <= 100; seed++) {
      rngState = seed * 7919u;
      int r, p;
      { Sim s; s.build(stands(10)); body::Counter c; c.reset(35, 2500); s.run(c, r, p); if (r != 10) bad[0]++; }
      { Sim s; s.build(stands(6, 0.3f, 2.0f, 1.0f, 2.5f, 1.5f)); body::Counter c; c.reset(35, 2500); s.run(c, r, p); if (r != 6) bad[1]++; }
      { Sim s; s.gx = -0.9f; s.gy = 0.2f; s.gz = 0.3f; s.scale = 0.97f; s.noise = 0.012f; s.build(stands(8)); body::Counter c; c.reset(35, 2500); s.run(c, r, p); if (r != 8) bad[2]++; }
      { Sim s; s.build(stands(4, 0.09f, 0.8f, 0.3f, 0.8f, 0.8f)); body::Counter c; c.reset(35, 2500); s.run(c, r, p); if (r != 0) bad[3]++; }
    }
    CHECK(bad[0] == 0, "ordinary sit-to-stands miscounted in %d of 100 noise patterns", bad[0]);
    CHECK(bad[1] <= 3, "slow sit-to-stands miscounted in %d of 100 noise patterns (allowed 3)", bad[1]);
    CHECK(bad[2] <= 3, "noisy, other orientation miscounted in %d of 100 (allowed 3)", bad[2]);
    CHECK(bad[3] <= 3, "small rises counted as reps in %d of 100 (allowed 3)", bad[3]);
  }

  // --- choosing the counter by exercise ---
  CHECK(body::usesBody("Sit-to-stand"), "sit-to-stand uses the body counter");
  CHECK(!body::usesBody("Bicep curl"), "curls keep the tilt counter");

  if (failures) {
    printf("%d failed\n", failures);
    return 1;
  }
  printf("all body-movement rep tests passed\n");
  return 0;
}
