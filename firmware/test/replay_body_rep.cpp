// Replays a recording from the watch through the body-movement rep counter (body_rep.h), to
// tune it on real movement without uploading firmware each time.
// Record on the watch with MOTION,1 (ACC,<ms>,<ax>,<ay>,<az> lines; REP lines are the watch's
// own counts at the time), then:
//   g++ -std=c++17 -O1 -DBODY_DEBUG -I ../esp32/DoseLoopWaveshareMPU replay_body_rep.cpp -o replay && ./replay motion.csv
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "body_rep.h"

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: replay <recording>\n");
    return 2;
  }
  FILE *f = fopen(argv[1], "r");
  if (!f) {
    perror(argv[1]);
    return 2;
  }
  body::Counter c;
  c.reset(35, 2500);
  char line[160];
  int samples = 0, reps = 0, parts = 0, watchReps = 0;
  unsigned long t0 = 0;
  while (fgets(line, sizeof(line), f)) {
    unsigned long t;
    float ax, ay, az;
    if (sscanf(line, "ACC,%lu,%f,%f,%f", &t, &ax, &ay, &az) == 4) {
      if (!samples) t0 = t;
      samples++;
      body::Result r;
      body::Event e = c.update(ax, ay, az, (uint32_t)(t - t0), r);
      if (e == body::REP) {
        reps++;
        printf("REP %u at %.2f s: rise %u cm, tempo %u ms, quality %u\n", r.count, (t - t0) / 1000.0, r.rom_cm, r.tempo_ms, r.quality);
      } else if (e == body::PARTIAL) {
        parts++;
        printf("PART at %.2f s: rise %u cm\n", (t - t0) / 1000.0, r.rom_cm);
      }
    } else if (strncmp(line, "REP,", 4) == 0) {
      watchReps++;
    }
  }
  fclose(f);
  printf("%d samples (%.1f s): %d reps, %d partial (the watch counted %d at the time)\n", samples, samples / 50.0, reps, parts, watchReps);
  return 0;
}
