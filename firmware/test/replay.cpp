// Replays a RAW capture (lines "R,<ir>,<red>", from sending RAW,1 to the wearable) through the
// pulse detector. Build: g++ -std=c++17 -O2 -I../esp32 replay.cpp -o replay && ./replay capture.txt
#include <stdio.h>
#include <string.h>
#include "pulse_detector.h"
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "r"); char line[128]; PulseDetector pd; double t = 0; int n = 0, beats = 0, moves = 0; bool wasMoving = false;
  while (fgets(line, sizeof line, f)) { unsigned long ir, red; if (sscanf(line, "R,%lu,%lu", &ir, &red) != 2) continue;
    t += 1000.0 / 103.5; bool b = pd.update(ir, red, (uint32_t)t); n++; beats += b; if (pd.moving && !wasMoving) moves++; wasMoving = pd.moving;
    if (n % 207 == 0) printf("t=%4.1fs finger=%d contact=%d bpm=%d spo2=%d moving=%d accepted_beats=%d\n", t / 1000, pd.finger, pd.contact, pd.bpm, pd.spo2, pd.moving, beats); }
  printf("movement events: %d\n", moves); }
