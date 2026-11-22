// Unit tests for the heart-rate projection (firmware/esp32/DoseLoopWaveshareMPU/hr_projection.h).
// Build and run on a PC:
//   g++ -std=c++17 -O1 -I ../esp32/DoseLoopWaveshareMPU test_hr_projection.cpp -o test_hr_projection && ./test_hr_projection
#include <stdio.h>
#include <stdlib.h>
#include "hr_projection.h"

static int failures = 0;
#define CHECK(cond, ...)                                  \
  do {                                                    \
    if (!(cond)) {                                        \
      failures++;                                         \
      printf("FAIL line %d: ", __LINE__);                 \
      printf(__VA_ARGS__);                                \
      printf("\n");                                       \
    }                                                     \
  } while (0)

int main() {
  // --- exertion levels from reps and wrist movement ---
  {
    hrp::Projector p;
    CHECK(p.level(1000) == 0, "still and no reps: resting");
    for (int i = 0; i < 4; i++) p.rep(1000 + i * 7000);  // 4 reps in 30 s = 8 per minute
    CHECK(p.level(30000) == 2, "8 reps/min: moderate (got %d)", p.level(30000));
    for (int i = 0; i < 4; i++) p.rep(31000 + i * 2000);  // now 7 in 30 s = 14/min
    CHECK(p.level(40000) == 3, "14 reps/min: hard (got %d)", p.level(40000));
    CHECK(p.level(200000) == 0, "two minutes later, no reps: resting");
    hrp::Projector w;
    for (int i = 0; i < 2000; i++) w.motion(1.12f, 0, 0);  // 0.12 g of movement for 40 s
    CHECK(w.level(0) == 2, "moving wrist with no reps counted: moderate (move %.3f, level %d)", w.move, w.level(0));
  }

  // --- defaults before anything is learned ---
  {
    hrp::Projector p;
    int sts = p.exercise("Sit-to-stand"), bic = p.exercise("Bicep curl");
    CHECK(p.target(0, 0) == 74, "resting default 74");
    CHECK(p.target(sts, 3) > p.target(bic, 3) + 15, "a hard sit-to-stand projects higher than hard curls (%.0f vs %.0f)", p.target(sts, 3), p.target(bic, 3));
    CHECK(p.exercise("Sit-to-stand") == sts, "the same name maps to the same slot");
  }

  // --- learning: the median of real readings at the same exercise and exertion ---
  {
    hrp::Projector p;
    int sts = p.exercise("Sit-to-stand");
    const int hard[] = {108, 112, 150 /* one bad reading */, 110, 109};
    for (int i = 0; i < 5; i++) p.real(hard[i], 10000 + i * 6000, sts, 3);
    CHECK(p.target(sts, 3) == 110, "median ignores the outlier (got %.1f)", p.target(sts, 3));
    // Readings closer than 5 s to the last one in the same slot are not learned again.
    p.real(140, 35000, sts, 3);
    CHECK(p.m.slot[sts][3].n == 5, "a reading 1 s after the last is not learned (n=%d)", p.m.slot[sts][3].n);
    // Personal resting rate feeds the defaults for slots not yet learned.
    for (int i = 0; i < 3; i++) p.real(62, 100000 + i * 6000, 0, 0);
    int bic = p.exercise("Bicep curl");
    CHECK(p.rest() == 62, "resting median 62");
    CHECK(fabsf(p.target(bic, 1) - (62 + 10 * 0.6f)) < 0.01f, "unlearned light curls: own rest + typical rise (%.1f)", p.target(bic, 1));
    // Only the last 15 are kept: a new trend takes over.
    for (int i = 0; i < 15; i++) p.real(120, 200000 + i * 6000, sts, 3);
    CHECK(p.target(sts, 3) == 120, "after 15 new readings the old ones are gone (%.1f)", p.target(sts, 3));
  }

  // --- kinetics: rises over ~30 s, recovers over ~60 s, a real reading resets it ---
  {
    hrp::Projector p;
    int sts = p.exercise("Sit-to-stand");
    for (int i = 0; i < 3; i++) p.real(70, 1000 + i * 6000, sts, 0);
    for (int i = 0; i < 3; i++) p.real(110, 30000 + i * 6000, sts, 3);
    p.real(70, 60000, sts, 0);  // back at rest
    int at = 0;
    for (int s = 1; s <= 30; s++) at = p.step(60000 + s * 1000, sts, 3);  // 30 s of hard work
    CHECK(at > 92 && at < 98, "after 30 s hard: about 63%% of the way from 70 to 110 (%d)", at);
    for (int s = 31; s <= 150; s++) at = p.step(60000 + s * 1000, sts, 3);
    CHECK(at >= 108, "after 2.5 min hard: close to 110 (%d)", at);
    int peak = at;
    for (int s = 1; s <= 60; s++) at = p.step(210000 + s * 1000, sts, 0);  // rest
    CHECK(at > 82 && at < 88, "after 60 s rest: about 63%% of the way back to 70 (%d from %d)", at, peak);
    p.real(95, 271000, sts, 0);
    CHECK(p.step(271000, sts, 0) == 95, "a real reading resets the projection");
  }

  // --- saving and loading ---
  {
    hrp::Projector p;
    int sts = p.exercise("Sit-to-stand");
    for (int i = 0; i < 4; i++) p.real(100 + i, 10000 + i * 6000, sts, 2);
    unsigned char bytes[sizeof(hrp::Model)];
    memcpy(bytes, &p.m, sizeof(bytes));
    hrp::Projector q;
    CHECK(q.load(bytes, sizeof(bytes)), "loads what was saved");
    CHECK(q.exercise("Sit-to-stand") == sts && q.target(sts, 2) == p.target(sts, 2), "same exercises and medians after loading");
    bytes[0] ^= 0xFF;  // wrong version
    hrp::Projector r;
    CHECK(!r.load(bytes, sizeof(bytes)), "refuses data from another version");
    CHECK(!r.load(bytes, 10), "refuses data of the wrong size");
  }

  if (failures) {
    printf("%d failed\n", failures);
    return 1;
  }
  printf("all heart-rate projection tests passed\n");
  return 0;
}
