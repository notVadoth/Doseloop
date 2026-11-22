/*
 * DoseLoop wearable, MPU6050 only, single file (nothing else to copy).
 * Works on a standard ESP32 ("ESP32 Dev Module") or an ESP32-S3 ("ESP32S3 Dev Module");
 * the pins are picked automatically for the chip you compile for.
 *
 * Counts reps from the MPU6050 worn on the wrist and sends them over USB to the DoseLoop
 * app's "Wearable" option (Chrome or Edge), which saves each set to the participant's record.
 *
 * Wiring                 ESP32      ESP32-S3
 *   MPU6050 VCC  ->      3V3        3V3        (never 5V)
 *   MPU6050 GND  ->      GND        GND
 *   MPU6050 SDA  ->      GPIO21     GPIO8
 *   MPU6050 SCL  ->      GPIO22     GPIO9
 *   MPU6050 AD0  ->      GND        GND        (address 0x68; XDA, XCL, INT not connected)
 *   buzzer +     ->      GPIO25     GPIO5      (optional active buzzer, - to GND)
 * ESP32-S3: set Tools -> USB CDC On Boot: Enabled, or nothing reaches the app.
 *
 * Serial (115200):  board -> app  HELLO,DOSELOOP,1 | SET,START | REP,<n>,<tempo_ms>,<rom_deg>,<quality>
 *                                 PART,<rom_deg> | SET,STOP,<reps>,<partials> | WARN,MPU6050_NOT_FOUND
 *                   app -> board  EX,<name> | CFG,<rom_deg>,<tempo_ms>,<target_reps>,<hr_max> | START | STOP
 */
#include <Arduino.h>
#include <Wire.h>
#include <math.h>

#if CONFIG_IDF_TARGET_ESP32S3
#define I2C_SDA 8
#define I2C_SCL 9
#define PIN_BUZZER 5
#else
#define I2C_SDA 21
#define I2C_SCL 22
#define PIN_BUZZER 25
#endif
#ifdef LED_BUILTIN
#define PIN_LED LED_BUILTIN  // onboard LED (an RGB LED on S3 boards, driven the same way)
#else
#define PIN_LED 2
#endif
#define PIN_BUTTON 0  // BOOT button: start / stop a set
#define MPU 0x68

// ======================= rep detector (DoseLoop core, firmware/core) =======================
#define DL_SAMPLE_HZ 50
#define ANGLE_ALPHA 0.2f   // smoothing, ~90 ms at 50 Hz
#define CAL_SAMPLES 25     // 0.5 s of stillness at the start of a set defines "rest"
#define ENTER_FRAC 0.35f   // moving once past 35% of the prescribed range
#define EXIT_FRAC 0.15f    // back at rest within 15%
#define VALID_FRAC 0.50f   // under half the range counts as a partial rep

struct RepConfig {
  float target_rom_deg = 80;       // prescribed range of motion
  uint16_t target_tempo_ms = 2000; // prescribed time per rep
  uint16_t min_rep_ms = 300;       // faster is a bump, not a rep
  uint16_t max_rep_ms = 10000;     // slower is a posture change, not a rep
};

struct Rep {
  uint16_t count, tempo_ms, rom_deg;
  uint8_t quality;  // 0-100: 50% range, 30% tempo, 20% smoothness
};

enum RepEvent { EV_NONE, EV_REP, EV_PARTIAL };

struct RepDetector {
  RepConfig cfg;
  float angle_f = 0, rest_deg = 0, cal_sum = 0, peak_deg = 0, rough_sum = 0;
  uint16_t cal_n = 0, rough_n = 0, count = 0, partials = 0;
  bool moving = false;
  uint32_t t_rest_ms = 0;

  void reset(const RepConfig &c) {
    *this = RepDetector();
    cfg = c;
  }

  static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

  uint8_t score(float peak, uint32_t tempo_ms, float roughness) const {
    float rom = clampf(peak / cfg.target_rom_deg, 0, 1) * 100;
    float r = (float)tempo_ms / cfg.target_tempo_ms, tempo;
    if (r < 0.7f) tempo = clampf((r - 0.3f) / 0.4f, 0, 1) * 100;
    else if (r > 1.5f) tempo = clampf((3.0f - r) / 1.5f, 0, 1) * 100;
    else tempo = 100;
    float smooth = clampf((0.5f - roughness) / 0.45f, 0, 1) * 100;
    return (uint8_t)(0.5f * rom + 0.3f * tempo + 0.2f * smooth + 0.5f);
  }

  // One accelerometer sample in g. Fills out on EV_REP and EV_PARTIAL.
  RepEvent update(float ax, float ay, float az, uint32_t t_ms, Rep &out) {
    float mag = sqrtf(ax * ax + ay * ay + az * az);
    if (mag < 0.1f) return EV_NONE;  // no usable gravity vector
    float angle = atan2f(sqrtf(ay * ay + az * az), ax) * 57.29578f;  // tilt of the X axis, degrees

    if (cal_n < CAL_SAMPLES) {  // calibrate rest at the start of the set
      cal_sum += angle;
      cal_n++;
      rest_deg = angle_f = cal_sum / cal_n;
      t_rest_ms = t_ms;
      return EV_NONE;
    }
    angle_f += ANGLE_ALPHA * (angle - angle_f);
    float d = fabsf(angle_f - rest_deg), rom = cfg.target_rom_deg;

    if (!moving) {
      if (d < EXIT_FRAC * rom) t_rest_ms = t_ms;
      else if (d > ENTER_FRAC * rom) {
        moving = true;
        peak_deg = d;
        rough_sum = 0;
        rough_n = 0;
      }
      return EV_NONE;
    }
    if (d > peak_deg) peak_deg = d;
    rough_sum += fabsf(mag - 1.0f);
    rough_n++;
    if (d >= EXIT_FRAC * rom) return EV_NONE;

    moving = false;  // back at rest: was that a rep?
    uint32_t tempo = t_ms - t_rest_ms;
    t_rest_ms = t_ms;
    if (tempo < cfg.min_rep_ms || tempo > cfg.max_rep_ms) return EV_NONE;
    out.tempo_ms = tempo;
    out.rom_deg = (uint16_t)(peak_deg + 0.5f);
    out.quality = score(peak_deg, tempo, rough_n ? rough_sum / rough_n : 0);
    if (peak_deg < VALID_FRAC * rom) {
      partials++;
      out.count = count;
      return EV_PARTIAL;
    }
    out.count = ++count;
    return EV_REP;
  }
};

// ======================= sketch =======================
RepDetector rd;
RepConfig cfg;
bool mpuOk = false, setActive = false;
int targetReps = 10;
uint32_t buzzUntil = 0;

void send(const char *line) {
  Serial.print(line);
  Serial.print('\n');
}

void beep(uint32_t ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  buzzUntil = millis() + ms;
}

void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool mpuInit() {
  Wire.beginTransmission(MPU);
  if (Wire.endTransmission() != 0) return false;
  mpuWrite(0x6B, 0x00);  // wake up
  mpuWrite(0x1A, 0x04);  // 20 Hz low-pass filter
  mpuWrite(0x1C, 0x08);  // +-4 g
  return true;
}

bool mpuRead(float &ax, float &ay, float &az) {
  Wire.beginTransmission(MPU);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU, 6) != 6) return false;
  int16_t x = (Wire.read() << 8) | Wire.read();
  int16_t y = (Wire.read() << 8) | Wire.read();
  int16_t z = (Wire.read() << 8) | Wire.read();
  ax = x / 8192.0f;
  ay = y / 8192.0f;
  az = z / 8192.0f;
  return true;
}

void setStart() {
  rd.reset(cfg);
  setActive = true;
  send("SET,START");
  beep(80);
}

void setStop() {
  char buf[40];
  setActive = false;
  snprintf(buf, sizeof(buf), "SET,STOP,%u,%u", rd.count, rd.partials);
  send(buf);
}

// Commands from the app: START, STOP, CFG,<rom>,<tempo>,<reps>,<hr_max>. EX,<name> is ignored here.
void handleLine(const char *line) {
  unsigned rom, tempo, reps, hr;
  if (strcmp(line, "START") == 0) {
    if (!setActive) setStart();
  } else if (strcmp(line, "STOP") == 0) {
    if (setActive) setStop();
  } else if (sscanf(line, "CFG,%u,%u,%u,%u", &rom, &tempo, &reps, &hr) == 4 && rom >= 5 && rom <= 180 && tempo >= 300 && tempo <= 10000 && reps <= 500) {
    cfg.target_rom_deg = rom;
    cfg.target_tempo_ms = tempo;
    targetReps = reps;
  }
}

void setup() {
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL, 400000);
  mpuOk = mpuInit();
  rd.reset(cfg);
  send("HELLO,DOSELOOP,1");
  if (!mpuOk) send("WARN,MPU6050_NOT_FOUND");
}

void loop() {
  static char rx[64];
  static uint8_t rxLen = 0;
  static uint32_t nextSample = millis(), btnSince = 0;
  static bool btnDown = false;
  uint32_t now = millis();

  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (rxLen) {
        rx[rxLen] = 0;
        handleLine(rx);
      }
      rxLen = 0;
    } else if (rxLen < sizeof(rx) - 1) {
      rx[rxLen++] = ch;
    } else {
      rxLen = 0;  // overlong line: drop it
    }
  }

  // BOOT button, debounced: start or stop a set.
  bool pressed = digitalRead(PIN_BUTTON) == LOW;
  if (pressed && !btnDown) {
    if (!btnSince) btnSince = now;
    else if (now - btnSince > 30) {
      btnDown = true;
      if (setActive) setStop();
      else setStart();
    }
  } else if (!pressed) {
    btnSince = 0;
    btnDown = false;
  }

  if (buzzUntil && (int32_t)(now - buzzUntil) >= 0) {
    digitalWrite(PIN_BUZZER, LOW);
    buzzUntil = 0;
  }

  // Motion: 50 samples a second.
  if ((int32_t)(now - nextSample) >= 0) {
    nextSample += 1000 / DL_SAMPLE_HZ;
    float ax, ay, az;
    if (setActive && mpuOk && mpuRead(ax, ay, az)) {
      Rep rep;
      RepEvent ev = rd.update(ax, ay, az, now, rep);
      char buf[48];
      if (ev == EV_REP) {
        snprintf(buf, sizeof(buf), "REP,%u,%u,%u,%u", rep.count, rep.tempo_ms, rep.rom_deg, rep.quality);
        send(buf);
        if (targetReps && rep.count == targetReps) beep(400);     // dose reached
        else if (targetReps && rep.count > targetReps) beep(60);  // past the dose
      } else if (ev == EV_PARTIAL) {
        snprintf(buf, sizeof(buf), "PART,%u", rep.rom_deg);
        send(buf);
      }
    }
  }

  // LED: off when idle, slow blink in a set, solid at the dose, fast blink if the sensor is missing.
  bool led = !mpuOk ? (now / 120) % 2 : !setActive ? false : (targetReps && rd.count >= targetReps) ? true : (now / 500) % 2;
  digitalWrite(PIN_LED, led);

  delay(1);  // let the CPU idle between passes (less heat)
}
