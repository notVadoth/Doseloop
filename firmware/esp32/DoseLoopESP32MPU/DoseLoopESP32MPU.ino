/*
 * DoseLoop wearable, MPU6050 only, for a standard ESP32 dev board ("ESP32 Dev Module").
 *
 * Counts reps from the MPU6050 worn on the wrist and sends them over USB to the DoseLoop
 * app's "Wearable" option (Chrome or Edge), which saves each set to the participant's record.
 *
 * Wiring:
 *   MPU6050 VCC -> 3V3 (not 5V)    GND -> GND
 *   MPU6050 SDA -> GPIO21          SCL -> GPIO22
 *   MPU6050 AD0 -> GND (address 0x68). XDA, XCL, INT: not connected.
 *   Optional active buzzer: + to GPIO25, - to GND.
 *
 * Arduino IDE: board "ESP32 Dev Module". No extra libraries.
 * Put doseloop_core.c and doseloop_core.h (from firmware/core) next to this file.
 *
 * Serial (115200), one line per message:
 *   board -> app  HELLO,DOSELOOP,1 | SET,START | REP,<n>,<tempo_ms>,<rom_deg>,<quality>
 *                 PART,<rom_deg> | SET,STOP,<reps>,<partials> | WARN,MPU6050_NOT_FOUND
 *   app -> board  EX,<exercise name> | CFG,<rom_deg>,<tempo_ms>,<target_reps>,<hr_max> | START | STOP
 */
#include <Arduino.h>
#include <Wire.h>
#include "doseloop_core.h"

#define I2C_SDA 21
#define I2C_SCL 22
#define PIN_LED 2      // onboard blue LED
#define PIN_BUTTON 0   // BOOT button: start / stop a set
#define PIN_BUZZER 25  // optional active buzzer

#define MPU 0x68

rd_t rd;
rd_config_t rdCfg;
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

// ---------- MPU6050 ----------
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

// ---------- sets ----------
void setStart() {
  rd_init(&rd, &rdCfg);
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

void handleLine(const char *line) {
  if (strncmp(line, "EX,", 3) == 0) return;  // exercise name: nothing to show without a screen
  dl_cfg_cmd_t c;
  switch (dl_parse_line(line, &c)) {
    case DL_CMD_CFG:
      rdCfg.target_rom_deg = c.target_rom_deg;
      rdCfg.target_tempo_ms = c.target_tempo_ms;
      targetReps = c.target_reps;
      break;
    case DL_CMD_START:
      if (!setActive) setStart();
      break;
    case DL_CMD_STOP:
      if (setActive) setStop();
      break;
    default:
      break;
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

  rd_default_config(&rdCfg);
  rd_init(&rd, &rdCfg);
  send("HELLO,DOSELOOP,1");
  if (!mpuOk) send("WARN,MPU6050_NOT_FOUND");
}

void loop() {
  static char rx[64];
  static uint8_t rxLen = 0;
  static uint32_t nextSample = millis(), btnSince = 0;
  static bool btnDown = false;
  uint32_t now = millis();

  // Commands from the app.
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

  // Motion: 50 samples a second into the rep detector.
  if ((int32_t)(now - nextSample) >= 0) {
    nextSample += 1000 / DL_SAMPLE_HZ;
    float ax, ay, az;
    if (setActive && mpuOk && mpuRead(ax, ay, az)) {
      rd_rep_t rep;
      rd_event_t ev = rd_update(&rd, ax, ay, az, now, &rep);
      char buf[48];
      if (ev == RD_EVENT_REP) {
        snprintf(buf, sizeof(buf), "REP,%u,%u,%u,%u", rep.count, rep.tempo_ms, rep.rom_deg, rep.quality);
        send(buf);
        if (targetReps && rep.count == targetReps) beep(400);     // dose reached
        else if (targetReps && rep.count > targetReps) beep(60);  // past the dose
      } else if (ev == RD_EVENT_PARTIAL) {
        snprintf(buf, sizeof(buf), "PART,%u", rep.rom_deg);
        send(buf);
      }
    }
  }

  // LED: off when idle, slow blink during a set, solid once the dose is reached,
  // fast blink if the sensor is missing.
  bool led = !mpuOk ? (now / 120) % 2 : !setActive ? false : (targetReps && rd.count >= targetReps) ? true : (now / 500) % 2;
  digitalWrite(PIN_LED, led);

  delay(1);  // let the CPU idle between passes (less heat)
}
