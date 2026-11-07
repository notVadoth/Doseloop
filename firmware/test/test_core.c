/*
 * Host unit tests for the DoseLoop core.
 *   gcc -O2 -Wall -Wextra -I../core test_core.c ../core/doseloop_core.c -lm -o test_core && ./test_core
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "doseloop_core.h"

#define PI 3.14159265f
#define DT_MS (1000 / DL_SAMPLE_HZ)

static int failures;
#define CHECK(cond, ...)                                  \
    do {                                                  \
        if (!(cond)) {                                    \
            failures++;                                   \
            printf("  FAIL %s:%d: ", __FILE__, __LINE__); \
            printf(__VA_ARGS__);                          \
            printf("\n");                                 \
        }                                                 \
    } while (0)

static uint32_t lcg = 12345;
static float noise(float sigma)
{
    float s = 0;
    for (int i = 0; i < 4; i++) {
        lcg = lcg * 1664525u + 1013904223u;
        s += (float)(lcg >> 8) / 16777216.0f - 0.5f;
    }
    return s * sigma * 1.73f; /* sum of 4 uniforms has sigma 0.577 */
}

typedef struct {
    int reps, partials;
    float q_sum, rom_sum, tempo_sum;
} result_t;

/* Simulate `n` smooth reps of `rom` degrees with period `period_ms`, rest 10 degrees. */
static result_t run_reps(rd_t *rd, int n, float rom, int period_ms, int pause_ms, float sigma)
{
    result_t res = {0};
    rd_rep_t rep;
    uint32_t t = 0;
    const float rest = 10.0f;
    int total = 1000 + n * (period_ms + pause_ms) + 1000;
    for (int ms = 0; ms < total; ms += DT_MS, t += DT_MS) {
        float angle = rest;
        int local = ms - 1000;
        if (local >= 0 && local < n * (period_ms + pause_ms)) {
            int phase = local % (period_ms + pause_ms);
            if (phase < period_ms) {
                angle = rest + rom * 0.5f * (1.0f - cosf(2.0f * PI * (float)phase / (float)period_ms));
            }
        }
        float a = angle / 57.29578f;
        rd_event_t ev = rd_update(rd, cosf(a) + noise(sigma), sinf(a) + noise(sigma), noise(sigma), t, &rep);
        if (ev == RD_EVENT_REP) {
            res.reps++;
            res.q_sum += rep.quality;
            res.rom_sum += rep.rom_deg;
            res.tempo_sum += rep.tempo_ms;
        } else if (ev == RD_EVENT_PARTIAL) {
            res.partials++;
        }
    }
    return res;
}

static void test_clean_reps(void)
{
    printf("clean reps\n");
    rd_config_t cfg;
    rd_default_config(&cfg);
    cfg.target_tempo_ms = 2000;
    rd_t rd;
    rd_init(&rd, &cfg);
    result_t r = run_reps(&rd, 10, 80.0f, 2500, 800, 0.02f);
    CHECK(r.reps == 10, "expected 10 reps, got %d", r.reps);
    CHECK(r.partials == 0, "expected 0 partials, got %d", r.partials);
    if (r.reps) {
        float rom = r.rom_sum / r.reps, q = r.q_sum / r.reps, tempo = r.tempo_sum / r.reps;
        printf("  rom %.1f deg, tempo %.0f ms, quality %.0f\n", rom, tempo, q);
        CHECK(rom > 72 && rom < 88, "rom %.1f out of range", rom);
        CHECK(tempo > 1600 && tempo < 2600, "tempo %.0f out of range", tempo);
        CHECK(q >= 85, "quality %.0f too low for clean reps", q);
    }
}

static void test_rest_noise(void)
{
    printf("noise at rest\n");
    rd_config_t cfg;
    rd_default_config(&cfg);
    rd_t rd;
    rd_init(&rd, &cfg);
    result_t r = run_reps(&rd, 0, 0, 1000, 0, 0.06f);
    rd_rep_t rep;
    for (uint32_t t = 2000; t < 22000; t += DT_MS) {
        if (rd_update(&rd, cosf(0.1745f) + noise(0.06f), sinf(0.1745f) + noise(0.06f), noise(0.06f), t, &rep)) {
            r.reps++;
        }
    }
    CHECK(r.reps == 0 && r.partials == 0, "phantom events at rest: %d reps %d partials", r.reps, r.partials);
}

static void test_partial_reps(void)
{
    printf("partial range\n");
    rd_config_t cfg;
    rd_default_config(&cfg);
    rd_t rd;
    rd_init(&rd, &cfg);
    result_t r = run_reps(&rd, 6, 34.0f, 2000, 800, 0.02f);
    CHECK(r.reps == 0, "shallow reps must not count, got %d", r.reps);
    CHECK(r.partials == 6, "expected 6 partials, got %d", r.partials);
}

static void test_rushed_reps(void)
{
    printf("rushed reps\n");
    rd_config_t cfg;
    rd_default_config(&cfg);
    rd_t rd;
    rd_init(&rd, &cfg);
    result_t r = run_reps(&rd, 8, 80.0f, 700, 500, 0.02f);
    CHECK(r.reps == 8, "expected 8 rushed reps counted, got %d", r.reps);
    if (r.reps) {
        float q = r.q_sum / r.reps;
        printf("  quality %.0f\n", q);
        CHECK(q < 75, "rushed reps should score below 75, got %.0f", q);
    }
}

static void test_posture_change(void)
{
    printf("posture change\n");
    rd_config_t cfg;
    rd_default_config(&cfg);
    rd_t rd;
    rd_init(&rd, &cfg);
    /* One 14 s excursion: longer than max_rep_ms, so it is not a rep. */
    result_t r = run_reps(&rd, 1, 80.0f, 14000, 500, 0.02f);
    CHECK(r.reps == 0 && r.partials == 0, "slow posture change counted: %d/%d", r.reps, r.partials);
}

static int run_hr(int bpm, int seconds)
{
    hr_t hr;
    hr_init(&hr);
    float period = 60000.0f / (float)bpm;
    for (uint32_t t = 0; t < (uint32_t)seconds * 1000; t += DT_MS) {
        float ph = fmodf((float)t, period) / period;
        float pulse = sinf(PI * ph);
        pulse = ph < 0.4f ? powf(sinf(PI * ph / 0.4f), 2.0f) : 0.0f;
        float drift = 80.0f * sinf(2.0f * PI * (float)t / 9000.0f);
        hr_update(&hr, (uint16_t)(2000.0f + 300.0f * pulse + drift + noise(8.0f)), t);
    }
    return hr.bpm;
}

static void test_heart_rate(void)
{
    printf("heart rate\n");
    int rates[] = {55, 72, 96, 120, 150};
    for (unsigned i = 0; i < sizeof(rates) / sizeof(rates[0]); i++) {
        int got = run_hr(rates[i], 20);
        printf("  %d bpm -> %d\n", rates[i], got);
        CHECK(abs(got - rates[i]) <= 4, "bpm %d measured as %d", rates[i], got);
    }
    /* Sensor off the skin: flat line with noise must not report a rate. */
    hr_t hr;
    hr_init(&hr);
    for (uint32_t t = 0; t < 10000; t += DT_MS) {
        hr_update(&hr, (uint16_t)(2000.0f + noise(4.0f)), t);
    }
    CHECK(hr.bpm == 0, "off-skin sensor reported %d bpm", hr.bpm);
}

static void test_commands(void)
{
    printf("commands\n");
    dl_cfg_cmd_t c = {0};
    CHECK(dl_parse_line("START", &c) == DL_CMD_START, "START");
    CHECK(dl_parse_line("STOP", &c) == DL_CMD_STOP, "STOP");
    CHECK(dl_parse_line("CFG,80,2000,12,130", &c) == DL_CMD_CFG, "CFG");
    CHECK(c.target_rom_deg == 80 && c.target_tempo_ms == 2000 && c.target_reps == 12 && c.hr_max == 130, "CFG fields");
    CHECK(dl_parse_line("CFG,0,2000,12,130", &c) == DL_CMD_NONE, "CFG rejects zero range");
    CHECK(dl_parse_line("CFG,80,2000", &c) == DL_CMD_NONE, "CFG rejects short line");
    CHECK(dl_parse_line("garbage", &c) == DL_CMD_NONE, "garbage");
}

int main(void)
{
    test_clean_reps();
    test_rest_noise();
    test_partial_reps();
    test_rushed_reps();
    test_posture_change();
    test_heart_rate();
    test_commands();
    printf(failures ? "\n%d FAILED\n" : "\nall tests passed\n", failures);
    return failures ? 1 : 0;
}
