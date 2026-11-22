#include "doseloop_core.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#define RAD_TO_DEG 57.29578f
#define ANGLE_ALPHA 0.2f   /* EMA coefficient, ~90 ms time constant at 50 Hz */
#define CAL_SAMPLES 25     /* 0.5 s of stillness defines the rest angle */
#define ENTER_FRAC 0.35f   /* leave rest when past 35% of prescribed range */
#define EXIT_FRAC 0.15f    /* back at rest when within 15% */
#define VALID_FRAC 0.50f   /* below half range the rep is logged as partial */

static float clampf(float v, float lo, float hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

/* Angle between the sensor X axis and gravity, 0..180 degrees. */
static float tilt_deg(float ax, float ay, float az)
{
    return atan2f(sqrtf(ay * ay + az * az), ax) * RAD_TO_DEG;
}

void rd_default_config(rd_config_t *cfg)
{
    cfg->target_rom_deg = 80.0f;
    cfg->target_tempo_ms = 2000;
    cfg->min_rep_ms = 300;
    cfg->max_rep_ms = 10000;
}

void rd_init(rd_t *s, const rd_config_t *cfg)
{
    memset(s, 0, sizeof(*s));
    s->cfg = *cfg;
}

static uint8_t score_rep(const rd_t *s, float peak, uint32_t tempo_ms, float roughness)
{
    float rom = clampf(peak / s->cfg.target_rom_deg, 0.0f, 1.0f) * 100.0f;

    /* Full marks from 0.7x to 1.5x of prescribed tempo, falling to zero at 0.3x and 3x. */
    float r = (float)tempo_ms / (float)s->cfg.target_tempo_ms;
    float tempo;
    if (r < 0.7f) {
        tempo = clampf((r - 0.3f) / 0.4f, 0.0f, 1.0f) * 100.0f;
    } else if (r > 1.5f) {
        tempo = clampf((3.0f - r) / 1.5f, 0.0f, 1.0f) * 100.0f;
    } else {
        tempo = 100.0f;
    }

    /* Mean deviation from 1 g: <=0.05 g is controlled, >=0.5 g is jerky. */
    float smooth = clampf((0.5f - roughness) / 0.45f, 0.0f, 1.0f) * 100.0f;

    return (uint8_t)(0.5f * rom + 0.3f * tempo + 0.2f * smooth + 0.5f);
}

rd_event_t rd_update(rd_t *s, float ax, float ay, float az, uint32_t t_ms, rd_rep_t *out)
{
    float mag = sqrtf(ax * ax + ay * ay + az * az);
    if (mag < 0.1f) {
        return RD_EVENT_NONE; /* free fall or dead sensor: no usable gravity vector */
    }
    float angle = tilt_deg(ax, ay, az);

    if (s->cal_n < CAL_SAMPLES) {
        s->cal_sum += angle;
        s->cal_n++;
        s->rest_deg = s->cal_sum / (float)s->cal_n;
        s->angle_f = s->rest_deg;
        s->t_rest_ms = t_ms;
        return RD_EVENT_NONE;
    }

    s->angle_f += ANGLE_ALPHA * (angle - s->angle_f);
    float d = fabsf(s->angle_f - s->rest_deg);
    float rom = s->cfg.target_rom_deg;

    if (!s->moving) {
        if (d < EXIT_FRAC * rom) {
            s->t_rest_ms = t_ms;
        } else if (d > ENTER_FRAC * rom) {
            s->moving = true;
            s->peak_deg = d;
            s->rough_sum = 0.0f;
            s->rough_n = 0;
        }
        return RD_EVENT_NONE;
    }

    if (d > s->peak_deg) {
        s->peak_deg = d;
    }
    s->rough_sum += fabsf(mag - 1.0f);
    s->rough_n++;

    if (d >= EXIT_FRAC * rom) {
        return RD_EVENT_NONE;
    }

    /* Returned to rest: classify the excursion. */
    s->moving = false;
    uint32_t tempo = t_ms - s->t_rest_ms;
    s->t_rest_ms = t_ms;
    if (tempo < s->cfg.min_rep_ms || tempo > s->cfg.max_rep_ms) {
        return RD_EVENT_NONE;
    }

    float roughness = s->rough_n ? s->rough_sum / (float)s->rough_n : 0.0f;
    out->tempo_ms = (uint16_t)tempo;
    out->rom_deg = (uint16_t)(s->peak_deg + 0.5f);
    out->quality = score_rep(s, s->peak_deg, tempo, roughness);

    if (s->peak_deg < VALID_FRAC * rom) {
        s->partials++;
        out->count = s->count;
        return RD_EVENT_PARTIAL;
    }
    s->count++;
    out->count = s->count;
    return RD_EVENT_REP;
}

/* ---------- Heart rate ---------- */

#define HR_DC_ALPHA 0.02f
#define HR_ENV_DECAY 0.995f
#define HR_ENV_FLOOR 20.0f /* ADC counts; below this the sensor is off-skin */
#define HR_REFRACTORY_MS 300
#define HR_MAX_IBI_MS 1500

void hr_init(hr_t *s)
{
    memset(s, 0, sizeof(*s));
}

bool hr_update(hr_t *s, uint16_t adc, uint32_t t_ms)
{
    float x = (float)adc;
    if (!s->primed) {
        s->dc = x;
        s->primed = true;
        return false;
    }
    s->dc += HR_DC_ALPHA * (x - s->dc);
    float ac = x - s->dc;

    s->env *= HR_ENV_DECAY;
    if (ac > s->env) {
        s->env = ac;
    }
    if (s->env < HR_ENV_FLOOR) {
        s->above = false;
        return false;
    }

    float thr = 0.5f * s->env;
    if (s->above) {
        if (ac < 0.5f * thr) {
            s->above = false;
        }
        return false;
    }
    if (ac <= thr || (s->last_beat_ms && t_ms - s->last_beat_ms < HR_REFRACTORY_MS)) {
        return false;
    }

    s->above = true;
    uint32_t ibi = s->last_beat_ms ? t_ms - s->last_beat_ms : 0;
    s->last_beat_ms = t_ms;
    if (ibi == 0 || ibi > HR_MAX_IBI_MS) {
        s->n = 0; /* first beat, or a gap: restart the average */
        return true;
    }
    s->ibi[s->idx] = (uint16_t)ibi;
    s->idx = (uint8_t)((s->idx + 1) % 4);
    if (s->n < 4) {
        s->n++;
    }
    if (s->n >= 2) {
        uint32_t sum = 0;
        for (uint8_t i = 0; i < s->n; i++) {
            sum += s->ibi[i];
        }
        s->bpm = (uint8_t)((60000u * s->n + sum / 2) / sum);
    }
    return true;
}

/* ---------- Commands ---------- */

dl_cmd_t dl_parse_line(const char *line, dl_cfg_cmd_t *cfg)
{
    if (strcmp(line, "START") == 0) {
        return DL_CMD_START;
    }
    if (strcmp(line, "STOP") == 0) {
        return DL_CMD_STOP;
    }
    unsigned rom, tempo, reps, hr;
    if (sscanf(line, "CFG,%u,%u,%u,%u", &rom, &tempo, &reps, &hr) == 4) {
        if (rom < 5 || rom > 180 || tempo < 300 || tempo > 10000 || reps > 500 || hr > 250) {
            return DL_CMD_NONE;
        }
        cfg->target_rom_deg = (uint16_t)rom;
        cfg->target_tempo_ms = (uint16_t)tempo;
        cfg->target_reps = (uint16_t)reps;
        cfg->hr_max = (uint16_t)hr;
        return DL_CMD_CFG;
    }
    return DL_CMD_NONE;
}
