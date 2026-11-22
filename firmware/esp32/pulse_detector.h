// Heart rate and SpO2 from MAX30102 red/IR samples (about 100 a second).
//
// Heart rate comes from the repeating rhythm of the last 8 seconds of the infrared signal
// (autocorrelation), not from picking individual peaks: a real pulse wave has a second,
// smaller bump after each beat, and peak picking counts it as an extra beat (reading double).
// Once a second the detector asks "after what delay does this signal best repeat itself?";
// that delay is one heartbeat. A clear repeat also tells it the reading is trustworthy, so
// movement, pressing and an empty sensor give no number rather than a wrong one.
//
// SpO2 comes from how strongly the red signal pulses compared with the infrared one over the
// same 8 seconds (the "ratio of ratios"), mapped with Maxim's calibration curve.
//
// Plain C++ with no Arduino dependency, so it is tested on a computer (firmware/test).
#pragma once
#include <stdint.h>
#include <math.h>

struct PulseDetector {
  static constexpr float FINGER_IR = 10000;   // below this nothing is on the sensor (empty reads ~1,300)
  static constexpr float SATURATED = 250000;  // above this the sensor is flooded (bright light)
  static const int N = 800;                   // 8 s window at 100 samples/s
  static const int MIN_N = 500;               // first estimate after 5 s
  static constexpr float MIN_QUALITY = 0.45f; // rhythm strength needed to report (0-1)
  // A real pulse changes the light by roughly 0.1-2%. Below this it is sensor noise.
  static constexpr float MIN_PULSE = 0.0004f;
  static const uint32_t NO_PULSE_MS = 6000;   // light but no pulse for this long: no finger

  // Outputs.
  int bpm = 0;           // 0 until a clear rhythm is found
  int spo2 = 0;          // 0 until a clear rhythm is found
  bool finger = false;   // something is on the sensor AND it has a pulse
  bool contact = false;  // enough light comes back (a finger, or just a reflection)
  bool moving = false;   // light changing but no clear rhythm: movement or pressing
  bool faint = false;    // something is on the sensor but its pulse is too small to measure
  float quality = 0;     // rhythm strength of the last estimate, 0-1

  // State.
  float dcIr = 0, dcRed = 0, baseIr = 0, baseRed = 0, lpIr = 0, lpRed = 0;
  float x[N], y[N];      // filtered infrared and red; the newest is at head-1
  float cx[N], cy[N];    // the window being analysed, with movement bursts removed
  uint32_t tStamp[N];
  int head = 0, count = 0, sinceEstimate = 0;
  uint32_t contactT = 0, pulseT = 0, settleT = 0;
  int bpmHist[3] = {0}, nBpm = 0;
  float ratioHist[5] = {0};
  int nRatio = 0;

  void reset() {
    bpm = spo2 = 0;
    finger = contact = moving = faint = false;
    quality = 0;
    head = count = sinceEstimate = 0;
    contactT = pulseT = settleT = 0;
    nBpm = nRatio = 0;
    lpIr = lpRed = 0;
  }

  template <class T>
  static T median(const T *v, int n) {
    T s[8];
    for (int i = 0; i < n; i++) s[i] = v[i];
    for (int i = 1; i < n; i++)
      for (int j = i; j > 0 && s[j] < s[j - 1]; j--) {
        T t = s[j];
        s[j] = s[j - 1];
        s[j - 1] = t;
      }
    return n % 2 ? s[n / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // One sample. Returns true when a new heart-rate estimate was made.
  bool update(uint32_t ir, uint32_t red, uint32_t t_ms) {
    if (ir < FINGER_IR || ir > SATURATED) {
      if (contact) reset();
      return false;
    }
    if (!contact) {  // something just arrived: start the filters at its level
      contact = true;
      contactT = settleT = t_ms;
      dcIr = baseIr = ir;
      dcRed = baseRed = red;
    }
    // A sudden change of level (the finger shifted or was pressed) spoils the window: start again.
    if (fabsf(ir - dcIr) > 0.08f * dcIr) {
      dcIr = baseIr = ir;
      dcRed = baseRed = red;
      lpIr = lpRed = 0;
      head = count = sinceEstimate = 0;
      nRatio = 0;  // oxygen measured before the shift no longer applies
      spo2 = 0;
      settleT = t_ms;
      moving = true;
    }
    finger = t_ms - contactT < NO_PULSE_MS || (pulseT && t_ms - pulseT < NO_PULSE_MS);
    if (!finger) bpm = spo2 = 0;

    dcIr += 0.01f * (ir - dcIr);  // level, about 1 s
    dcRed += 0.01f * (red - dcRed);
    baseIr += 0.04f * (ir - baseIr);  // baseline, about 0.25 s: follows pressure changes
    baseRed += 0.04f * (red - baseRed);
    lpIr += 0.3f * ((baseIr - ir) - lpIr);  // inverted (more blood = less light) and smoothed
    lpRed += 0.3f * ((baseRed - red) - lpRed);

    if (t_ms - settleT < 1500) return false;  // let the filters settle first
    x[head] = lpIr;
    y[head] = lpRed;
    tStamp[head] = t_ms;
    head = (head + 1) % N;
    if (count < N) count++;
    if (++sinceEstimate < 100 || count < MIN_N) return false;
    sinceEstimate = 0;
    return estimate();
  }


  // Heart rate and SpO2 from the samples in the window.
  bool estimate() {
    int n = count, start = (head - n + N) % N;
    // The real time between samples (the sensor's clock is not exactly 100 a second).
    float period = (float)(tStamp[(head - 1 + N) % N] - tStamp[start]) / (n - 1);
    float mx = 0, my = 0;
    for (int i = 0; i < n; i++) {
      cx[i] = x[(start + i) % N];
      cy[i] = y[(start + i) % N];
      mx += cx[i];
      my += cy[i];
    }
    mx /= n;
    my /= n;
    // Typical pulse size: the median of the size in each second of the window. A short jolt
    // only spoils one or two seconds, so it barely moves the median.
    float blk[8];
    int nb = 0;
    for (int b0 = 0; b0 + 100 <= n && nb < 8; b0 += 100, nb++) {
      float s = 0;
      for (int i = b0; i < b0 + 100; i++) s += (cx[i] - mx) * (cx[i] - mx);
      blk[nb] = sqrtf(s / 100);
    }
    float typical = median(blk, nb);
    faint = period > 0 && typical < MIN_PULSE * dcIr;  // usually a finger pressed too hard
    if (period <= 0 || faint) {  // flat: nothing pulsing (or not skin)
      quality = 0;
      moving = false;
      return false;
    }
    // Samples far bigger than that are movement: leave them out (as zero) of both channels.
    float sxx = 0, sxy = 0;
    for (int i = 0; i < n; i++) {
      float a = cx[i] - mx, b = cy[i] - my;
      if (fabsf(a) > 3 * typical) a = b = 0;
      cx[i] = a;
      cy[i] = b;
      sxx += a * a;
      sxy += a * b;
    }
    float sd = sqrtf(sxx / n);

    // Autocorrelation for delays between 40 and 180 beats a minute; the strongest repeat wins.
    int lagMin = (int)(60000.0f / 180 / period), lagMax = (int)(60000.0f / 40 / period) + 1;
    if (lagMax > n / 2) lagMax = n / 2;
    float r[260];
    if (lagMax + 1 >= 260) lagMax = 258;
    for (int lag = lagMin - 1; lag <= lagMax + 1; lag++) {
      float s = 0;
      for (int i = 0; i + lag < n; i++) s += cx[i] * cx[i + lag];
      r[lag] = s / ((n - lag) * sd * sd);
    }
    float best = -1;
    int bestLag = 0;
    for (int lag = lagMin; lag <= lagMax; lag++)
      if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] > best) {
        best = r[lag];
        bestLag = lag;
      }
    // Half-rate check: a slow answer whose half-length also repeats strongly is really two
    // beats (the strongest repeat skipped one). Use the half-length beat instead.
    if (bestLag) {
      int half = (bestLag + 1) / 2;
      float rh = -1;
      int hl = 0;
      for (int lag = half - 2; lag <= half + 2; lag++)
        if (lag >= lagMin && lag <= lagMax && r[lag] > rh) {
          rh = r[lag];
          hl = lag;
        }
      if (hl && hl > lagMin && hl < lagMax && r[hl] >= r[hl - 1] && r[hl] >= r[hl + 1] && rh > 0.75f * best) {
        bestLag = hl;
        best = rh;
      }
    }
    quality = best > 0 ? best : 0;
    moving = quality < 0.25f;
    if (quality < MIN_QUALITY || !bestLag) return false;
    pulseT = tStamp[(head - 1 + N) % N];

    // Refine the beat length between samples with a parabola through the peak.
    float a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1], den = a - 2 * b + c;
    float shift = den < 0 ? 0.5f * (a - c) / den : 0;
    int est = (int)(60000.0f / ((bestLag + shift) * period) + 0.5f);
    for (int k = 2; k > 0; k--) bpmHist[k] = bpmHist[k - 1];
    bpmHist[0] = est;
    if (nBpm < 3) nBpm++;
    bpm = median(bpmHist, nBpm);

    // SpO2: R = (red pulse / red level) / (infrared pulse / infrared level), with the red pulse
    // measured as how strongly it follows the infrared one (sensor noise averages out).
    float R = (sxy / sxx) * dcIr / dcRed;
    // Oxygen only from very clear stretches: a muddier rhythm still gives a sound heart rate,
    // but the red/infrared ratio is easily skewed by movement.
    if (quality >= 0.55f && R > 0.2f && R < 1.8f) {
      for (int k = 4; k > 0; k--) ratioHist[k] = ratioHist[k - 1];
      ratioHist[0] = R;
      if (nRatio < 5) nRatio++;
      float rr = median(ratioHist, nRatio);
      float s = -45.060f * rr * rr + 30.354f * rr + 94.845f;  // Maxim's calibration
      spo2 = s > 100 ? 100 : (s < 70 ? 0 : (int)(s + 0.5f));
    }
    return true;
  }
};
