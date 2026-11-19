/*
 * DoseLoop wearable for a standard ESP32 dev board (ESP32-WROOM-32 / DevKitC / "ESP32 Dev Module")
 * with an MPU6050 and a MAX30102. No screen: the onboard LED and an optional buzzer give feedback.
 *
 * Counts reps from the MPU6050 (worn on the wrist), measures heart rate and SpO2 from the
 * MAX30102, and sends them to DoseLoop:
 *   USB:   the app's "Wearable" option (Chrome or Edge) logs each set to the participant's record.
 *   Wi-Fi: live updates to the app's Live class board (optional; leave WIFI_SSID empty).
 *
 * Wiring (both sensors in parallel on the default I2C pins):
 *   3V3    -> MPU6050 VCC, MAX30102 VIN         GND -> both GND
 *   GPIO21 -> both SDA                          GPIO22 -> both SCL
 *   MPU6050 AD0 -> GND (address 0x68). XDA, XCL and both INT pins: not connected.
 *   Optional active buzzer: + to GPIO25, - to GND.
 *   Onboard LED (GPIO2) and BOOT button (GPIO0) are on the board already.
 *
 * Arduino IDE: board "ESP32 Dev Module" (package "esp32 by Espressif Systems").
 * Library: "SparkFun MAX3010x Pulse and Proximity Sensor Library".
 * Put doseloop_core.c and doseloop_core.h (from firmware/core) next to this file.
 *
 * Serial protocol (115200 baud), one line per message:
 *   board -> app  HELLO,DOSELOOP,1 | SET,START | REP,<n>,<tempo_ms>,<rom_deg>,<quality>
 *                 PART,<rom_deg> | HR,<bpm> | SPO2,<percent> | WARN,HR_HIGH | SET,STOP,<reps>,<partials>
 *   app -> board  EX,<exercise name> | CFG,<rom_deg>,<tempo_ms>,<target_reps>,<hr_max> | START | STOP
 */
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
#include "doseloop_core.h"

// ---------------- settings ----------------
const char *WIFI_SSID = "";  // leave empty for USB only
const char *WIFI_PASS = "";
// The online demo, or your computer running the app with HOST=0.0.0.0 (e.g. "http://192.168.1.20:4198").
const char *DOSELOOP_URL = "https://doseloop-tau.vercel.app";
const int PARTICIPANT_ID = 9;  // whose tile on the Live class board this updates

#define I2C_SDA 21
#define I2C_SCL 22
#define PIN_LED 2      // onboard blue LED on most dev boards
#define PIN_BUTTON 0   // BOOT button: start / stop a set
#define PIN_BUZZER 25  // optional active buzzer

// ---------------- state ----------------
MAX30105 ox;
bool oxOk = false, mpuOk = false;
rd_t rd;
rd_config_t rdCfg;
char exercise[48] = "Sit-to-stand";
int targetReps = 10, hrMax = 130, setNo = 0;
bool setActive = false, finger = false;
uint8_t lastQuality = 0;
int hr = 0, spo2 = 0;
uint32_t buzzUntil = 0;

portMUX_TYPE liveMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool liveDirty = true;

void send(const char *line) {
  Serial.print(line);
  Serial.print('\n');
}
void beep(uint32_t ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  buzzUntil = millis() + ms;
}
void markLive() {
  portENTER_CRITICAL(&liveMux);
  liveDirty = true;
  portEXIT_CRITICAL(&liveMux);
}

// ---------------- MPU6050 ----------------
#define MPU 0x68
void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}
bool mpuInit() {
  Wire.beginTransmission(MPU);
  if (Wire.endTransmission() != 0) return false;
  mpuWrite(0x6B, 0x00);  // wake
  mpuWrite(0x1A, 0x04);  // 20 Hz low-pass
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

// ---------------- MAX30102 ----------------
#define OX_N 100  // 4 s at 25 samples/s
uint32_t irBuf[OX_N], redBuf[OX_N];
int oxCount = 0, oxNew = 0;
int hrHist[4], spHist[4], hrN = 0, spN = 0;

int median(int *v, int n) {
  int s[4];
  for (int i = 0; i < n; i++) s[i] = v[i];
  for (int i = 0; i < n; i++)
    for (int j = i + 1; j < n; j++)
      if (s[j] < s[i]) { int t = s[i]; s[i] = s[j]; s[j] = t; }
  return n ? s[n / 2] : 0;
}

void oxPoll() {
  if (!oxOk) return;
  ox.check();
  while (ox.available()) {
    if (oxCount < OX_N) oxCount++;
    memmove(irBuf, irBuf + 1, (OX_N - 1) * sizeof(uint32_t));
    memmove(redBuf, redBuf + 1, (OX_N - 1) * sizeof(uint32_t));
    irBuf[OX_N - 1] = ox.getFIFOIR();
    redBuf[OX_N - 1] = ox.getFIFORed();
    ox.nextSample();
    oxNew++;
  }
  if (oxCount < OX_N || oxNew < 25) return;
  oxNew = 0;
  uint64_t sum = 0;
  for (int i = 0; i < OX_N; i++) sum += irBuf[i];
  finger = sum / OX_N > 50000;
  if (!finger) {
    hr = spo2 = hrN = spN = 0;
    return;
  }
  int32_t s, h;
  int8_t sValid, hValid;
  maxim_heart_rate_and_oxygen_saturation(irBuf, OX_N, redBuf, &s, &sValid, &h, &hValid);
  if (hValid && h >= 40 && h <= 200) {
    memmove(hrHist + 1, hrHist, 3 * sizeof(int));
    hrHist[0] = h;
    if (hrN < 4) hrN++;
    hr = median(hrHist, hrN);
  }
  if (sValid && s >= 70 && s <= 100) {
    memmove(spHist + 1, spHist, 3 * sizeof(int));
    spHist[0] = s;
    if (spN < 4) spN++;
    spo2 = median(spHist, spN);
  }
}

// ---------------- sets ----------------
void setStart() {
  rd_init(&rd, &rdCfg);
  setActive = true;
  setNo++;
  lastQuality = 0;
  send("SET,START");
  beep(80);
  markLive();
}
void setStop() {
  char buf[40];
  setActive = false;
  snprintf(buf, sizeof(buf), "SET,STOP,%u,%u", rd.count, rd.partials);
  send(buf);
  markLive();
}

void handleLine(const char *line) {
  if (strncmp(line, "EX,", 3) == 0) {
    strncpy(exercise, line + 3, sizeof(exercise) - 1);
    exercise[sizeof(exercise) - 1] = 0;
    markLive();
    return;
  }
  dl_cfg_cmd_t c;
  switch (dl_parse_line(line, &c)) {
    case DL_CMD_CFG:
      rdCfg.target_rom_deg = c.target_rom_deg;
      rdCfg.target_tempo_ms = c.target_tempo_ms;
      targetReps = c.target_reps;
      hrMax = c.hr_max;
      markLive();
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

// LED: off when idle, slow blink during a set, solid once the dose is reached,
// fast blink when heart rate is over the limit.
void drawLed(uint32_t now) {
  bool on;
  if (hrMax && hr > hrMax) on = (now / 120) % 2;
  else if (!setActive) on = false;
  else if (targetReps && rd.count >= targetReps) on = true;
  else on = (now / 500) % 2;
  digitalWrite(PIN_LED, on);
}

// ---------------- Wi-Fi (other core, so sampling never waits) ----------------
void wifiTask(void *) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t lastPost = 0;
  for (;;) {
    bool dirty;
    portENTER_CRITICAL(&liveMux);
    dirty = liveDirty;
    portEXIT_CRITICAL(&liveMux);
    if (WiFi.status() == WL_CONNECTED && (dirty || millis() - lastPost > 5000)) {
      portENTER_CRITICAL(&liveMux);
      liveDirty = false;
      portEXIT_CRITICAL(&liveMux);
      char body[320], q[8], h[8];
      snprintf(q, sizeof(q), lastQuality ? "%u" : "null", lastQuality);
      snprintf(h, sizeof(h), hr ? "%d" : "null", hr);
      snprintf(body, sizeof(body),
               "{\"participant_id\":%d,\"exercise\":\"%s\",\"set\":%d,\"sets\":%d,\"reps\":%u,\"target\":%d,\"quality\":%s,\"hr\":%s,\"status\":\"%s\",\"source\":\"device\"}",
               PARTICIPANT_ID, exercise, max(1, min(10, setNo)), max(1, min(10, setNo)), rd.count, max(1, targetReps), q, h, setActive ? "active" : "resting");
      String url = String(DOSELOOP_URL) + "/api/live";
      HTTPClient http;
      WiFiClientSecure tls;
      WiFiClient plain;
      if (url.startsWith("https")) {
        tls.setInsecure();  // demo only: the server certificate is not checked
        http.begin(tls, url);
      } else {
        http.begin(plain, url);
      }
      http.addHeader("Content-Type", "application/json");
      http.setTimeout(4000);
      http.POST((uint8_t *)body, strlen(body));
      http.end();
      lastPost = millis();
    }
    if (WiFi.status() != WL_CONNECTED && millis() - lastPost > 10000) {
      WiFi.reconnect();
      lastPost = millis();
    }
    vTaskDelay(pdMS_TO_TICKS(200));
  }
}

// ---------------- setup and loop ----------------
void setup() {
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL, 400000);

  mpuOk = mpuInit();
  oxOk = ox.begin(Wire, I2C_SPEED_FAST);
  if (oxOk) ox.setup(60, 4, 2, 100, 411, 4096);  // LED level, averaging, red+IR, 100 Hz, pulse width, range

  rd_default_config(&rdCfg);
  rd_init(&rd, &rdCfg);
  send("HELLO,DOSELOOP,1");
  if (!mpuOk) send("WARN,MPU6050_NOT_FOUND");
  if (!oxOk) send("WARN,MAX30102_NOT_FOUND");

  if (strlen(WIFI_SSID)) xTaskCreatePinnedToCore(wifiTask, "wifi", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  static char rx[64];
  static uint8_t rxLen = 0;
  static uint32_t nextSample = millis(), lastHrSent = 0, lastWarn = 0, btnSince = 0;
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
      rxLen = 0;
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

  // Heart rate and SpO2 every 2 seconds while a finger is on the sensor.
  oxPoll();
  if (finger && hr && now - lastHrSent >= 2000) {
    char buf[24];
    lastHrSent = now;
    snprintf(buf, sizeof(buf), "HR,%d", hr);
    send(buf);
    if (spo2) {
      snprintf(buf, sizeof(buf), "SPO2,%d", spo2);
      send(buf);
    }
    markLive();
    if (hrMax && hr > hrMax && now - lastWarn >= 10000) {
      lastWarn = now;
      send("WARN,HR_HIGH");
      beep(600);
    }
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
        lastQuality = rep.quality;
        if (targetReps && rep.count == targetReps) beep(400);
        else if (targetReps && rep.count > targetReps) beep(60);
        markLive();
      } else if (ev == RD_EVENT_PARTIAL) {
        snprintf(buf, sizeof(buf), "PART,%u", rep.rom_deg);
        send(buf);
      }
    }
  }

  drawLed(now);
  delay(1);  // let the CPU idle between passes (less heat)
}
