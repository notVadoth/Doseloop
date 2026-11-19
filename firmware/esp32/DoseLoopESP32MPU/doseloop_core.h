/*
 * DoseLoop core - portable signal processing for the wearable tracker.
 *
 * No HAL dependencies: this file builds for the STM32 target and for the host
 * unit tests (firmware/test/test_core.c) unchanged.
 */
#ifndef DOSELOOP_CORE_H
#define DOSELOOP_CORE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" { /* usable from the Arduino (C++) sketch */
#endif

#define DL_SAMPLE_HZ 50

/* ---------- Repetition detector (accelerometer tilt) ---------- */

typedef struct {
    float target_rom_deg;     /* prescribed range of motion for the exercise */
    uint16_t target_tempo_ms; /* prescribed time under movement per rep */
    uint16_t min_rep_ms;      /* anything faster is treated as a bump, not a rep */
    uint16_t max_rep_ms;      /* anything slower is a posture change, not a rep */
} rd_config_t;

typedef struct {
    uint16_t count;    /* running count of valid reps in this set */
    uint16_t tempo_ms; /* time under movement of this rep */
    uint16_t rom_deg;  /* peak displacement from rest */
    uint8_t quality;   /* 0-100: 50% range, 30% tempo, 20% smoothness */
} rd_rep_t;

typedef enum { RD_EVENT_NONE = 0, RD_EVENT_REP, RD_EVENT_PARTIAL } rd_event_t;

typedef struct {
    rd_config_t cfg;
    float angle_f;      /* low-pass filtered tilt angle, degrees */
    float rest_deg;     /* tilt at rest, captured at start of set */
    float cal_sum;
    uint16_t cal_n;
    bool moving;
    float peak_deg;
    float rough_sum;    /* accumulated |‖a‖ - 1g| while moving */
    uint16_t rough_n;
    uint32_t t_rest_ms; /* last time the limb was at rest */
    uint16_t count;
    uint16_t partials;
} rd_t;

void rd_default_config(rd_config_t *cfg);
void rd_init(rd_t *s, const rd_config_t *cfg);
/* Feed one accelerometer sample (in g). Fills *out for REP and PARTIAL events. */
rd_event_t rd_update(rd_t *s, float ax, float ay, float az, uint32_t t_ms, rd_rep_t *out);

/* ---------- Heart-rate detector (analog pulse sensor) ---------- */

typedef struct {
    float dc;
    float env;
    bool primed;
    bool above;
    uint32_t last_beat_ms;
    uint16_t ibi[4];
    uint8_t n;
    uint8_t idx;
    uint8_t bpm; /* 0 until two consecutive plausible beats are seen */
} hr_t;

void hr_init(hr_t *s);
/* Feed one ADC sample. Returns true on a detected beat (s->bpm is then current). */
bool hr_update(hr_t *s, uint16_t adc, uint32_t t_ms);

/* ---------- Host -> device command parsing ---------- */

typedef struct {
    uint16_t target_rom_deg;
    uint16_t target_tempo_ms;
    uint16_t target_reps;
    uint16_t hr_max;
} dl_cfg_cmd_t;

typedef enum { DL_CMD_NONE = 0, DL_CMD_CFG, DL_CMD_START, DL_CMD_STOP } dl_cmd_t;

/* Parses one line (no trailing newline). Fills *cfg for DL_CMD_CFG. */
dl_cmd_t dl_parse_line(const char *line, dl_cfg_cmd_t *cfg);

#ifdef __cplusplus
}
#endif

#endif
