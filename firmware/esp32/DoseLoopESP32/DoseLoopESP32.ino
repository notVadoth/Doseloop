/*
 * DoseLoop wearable: Waveshare ESP32-S3-LCD-1.69 + MPU6050 + MAX30102
 *
 * Counts reps from the MPU6050, measures heart rate and SpO2 from the MAX30102, shows them
 * on the 1.69" screen, and sends them to DoseLoop two ways:
 *   USB:   the same line protocol as the STM32 wearable, so the app's "Wearable sensor"
 *          option (Chrome or Edge) logs each set to the participant's record.
 *   Wi-Fi: live updates to the app's Live class board (optional; leave WIFI_SSID empty).
 *
 * Wiring (all on the board's I2C header, shared with the onboard IMU and clock):
 *   MPU6050   VCC->3V3  GND->GND  SDA->GPIO11  SCL->GPIO10  AD0->GND (address 0x68)
 *   MAX30102  VIN->3V3  GND->GND  SDA->GPIO11  SCL->GPIO10  (INT not used, address 0x57)
 *
 * Arduino IDE: board "ESP32S3 Dev Module", USB CDC On Boot: Enabled, Flash 16MB.
 * Libraries: "GFX Library for Arduino" (moononournation, 1.4.9+) and
 *            "SparkFun MAX3010x Pulse and Proximity Sensor Library".
 * Put doseloop_core.c and doseloop_core.h (from firmware/core) next to this file.
 *
 * Serial protocol, one ASCII line per message (as firmware/stm32/main.c, plus SPO2 and EX):
 *   board -> app  HELLO,DOSELOOP,1 | SET,START | REP,<n>,<tempo_ms>,<rom_deg>,<quality>
 *                 PART,<rom_deg> | HR,<bpm> | SPO2,<percent> | WARN,HR_HIGH | SET,STOP,<reps>,<partials>
 *   app -> board  EX,<exercise name> | CFG,<rom_deg>,<tempo_ms>,<target_reps>,<hr_max> | START | STOP
 */
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Arduino_GFX_Library.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
#include "doseloop_core.h"

// ---------------- settings ----------------
const char *WIFI_SSID = "";  // leave empty for USB only
const char *WIFI_PASS = "";
// The online demo, or your computer running the app with HOST=0.0.0.0 (e.g. "http://192.168.1.20:4198").
const char *DOSELOOP_URL = "https://doseloop-tau.vercel.app";
const int PARTICIPANT_ID = 9;  // whose tile on the Live class board this updates

// Board pins (Waveshare ESP32-S3-LCD-1.69 schematic).
#define LCD_DC 4
#define LCD_CS 5
#define LCD_SCK 6
#define LCD_MOSI 7
#define LCD_RST 8
#define LCD_BL 15
#define I2C_SDA 11
#define I2C_SCL 10
#define PIN_BUTTON 0  // BOOT button: start / stop a set
// V2 boards (see the QC label). Older boards: buzzer 33, power hold 35.
#define PIN_BUZZER 42
#define PIN_SYS_EN 41

// ---------------- display ----------------
Arduino_DataBus *bus = new Arduino_ESP32SPI(LCD_DC, LCD_CS, LCD_SCK, LCD_MOSI, GFX_NOT_DEFINED);
Arduino_GFX *panel = new Arduino_ST7789(bus, LCD_RST, 0 /* rotation */, true /* IPS */, 240, 280, 0, 20, 0, 20);
Arduino_Canvas *gfx = new Arduino_Canvas(240, 280, panel);  // draw off-screen, then flush: no flicker

// ---------------- state ----------------
MAX30105 ox;
bool oxOk = false, mpuOk = false;

rd_t rd;
rd_config_t rdCfg;
char exercise[48] = "Sit-to-stand";
int targetReps = 10;
int hrMax = 130;
bool setActive = false;
int setNo = 0;
uint8_t lastQuality = 0;
int hr = 0, spo2 = 0;  // 0 = no reading
bool finger = false;
uint32_t buzzUntil = 0;

// Shared with the Wi-Fi task on the other core.
portMUX_TYPE liveMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool liveDirty = true;

// ---------------- helpers ----------------
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

// ---------------- MPU6050 (read directly; no library needed) ----------------
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

// ---------------- MAX30102: heart rate and SpO2 ----------------
// 100 samples/s averaged 4:1 = 25 samples/s; the Maxim algorithm reads the last 4 seconds
// (100 samples) once a second. Readings are kept only when the algorithm marks them valid,
// and the median of the last 4 is shown, which steadies the number.
#define OX_N 100
uint32_t irBuf[OX_N], redBuf[OX_N];
int oxCount = 0, oxNew = 0;
int hrHist[4], spHist[4], hrN = 0, spN = 0;

int median4(int *v, int n) {
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
  finger = sum / OX_N > 50000;  // much lower means nothing is on the sensor
  if (!finger) {
    hr = spo2 = hrN = spN = 0;
    markLive();
    return;
  }
  int32_t s, h;
  int8_t sValid, hValid;
  maxim_heart_rate_and_oxygen_saturation(irBuf, OX_N, redBuf, &s, &sValid, &h, &hValid);
  if (hValid && h >= 40 && h <= 200) {
    memmove(hrHist + 1, hrHist, 3 * sizeof(int));
    hrHist[0] = h;
    if (hrN < 4) hrN++;
    hr = median4(hrHist, hrN);
  }
  if (sValid && s >= 70 && s <= 100) {
    memmove(spHist + 1, spHist, 3 * sizeof(int));
    spHist[0] = s;
    if (spN < 4) spN++;
    spo2 = median4(spHist, spN);
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
  if (strncmp(line, "EX,", 3) == 0) {  // the exercise name, for the screen and the live board
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

// ---------------- screen ----------------
const uint16_t BG = 0x0A06, INK = 0xFFFF, MUTED = 0xB5D6, ACCENT = 0xFD8F, GOOD = 0x5EB5, ALERT = 0xF9C7, TRACK = 0x2A49;

void centered(const char *s, int y, int size, uint16_t color) {
  int16_t x1, y1;
  uint16_t w, h;
  gfx->setTextSize(size);
  gfx->getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  gfx->setTextColor(color);
  gfx->setCursor((240 - w) / 2, y);
  gfx->print(s);
}

void drawScreen() {
  char buf[32];
  gfx->fillScreen(BG);

  // Exercise and connection.
  centered(exercise, 18, 2, INK);
  gfx->fillCircle(222, 12, 5, WiFi.status() == WL_CONNECTED ? GOOD : TRACK);

  // The count, large, with the dose underneath.
  snprintf(buf, sizeof(buf), "%u", rd.count);
  bool reached = targetReps && rd.count >= targetReps;
  centered(buf, 62, 9, reached ? GOOD : INK);
  snprintf(buf, sizeof(buf), "of %d reps", targetReps);
  centered(buf, 140, 2, MUTED);
  int fill = targetReps ? min(200, (int)(200L * rd.count / targetReps)) : 0;
  gfx->fillRoundRect(20, 166, 200, 10, 5, TRACK);
  if (fill) gfx->fillRoundRect(20, 166, fill, 10, 5, reached ? GOOD : ACCENT);

  // Heart rate and oxygen.
  gfx->fillCircle(36, 205, 7, ALERT);
  snprintf(buf, sizeof(buf), hr ? "%d" : "--", hr);
  gfx->setTextSize(3);
  gfx->setTextColor(hrMax && hr > hrMax ? ALERT : INK);
  gfx->setCursor(50, 194);
  gfx->print(buf);
  gfx->setTextSize(2);
  gfx->setTextColor(MUTED);
  gfx->setCursor(130, 200);
  gfx->print("O2");
  snprintf(buf, sizeof(buf), spo2 ? "%d%%" : "--", spo2);
  gfx->setTextSize(3);
  gfx->setTextColor(spo2 && spo2 < 90 ? ALERT : INK);
  gfx->setCursor(158, 194);
  gfx->print(buf);

  // What to do next.
  const char *hint = !mpuOk ? "Motion sensor not found" : hrMax && hr > hrMax ? "Heart rate high: rest" : setActive ? (reached ? "Dose reached: stop" : "Set in progress") : "Press BOOT to start";
  if (setActive && !finger && oxOk) hint = "Finger on the sensor";
  centered(hint, 246, 2, hrMax && hr > hrMax ? ALERT : setActive ? ACCENT : MUTED);
  gfx->flush();
}

// ---------------- Wi-Fi (runs on the other core so sampling never waits) ----------------
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
      char body[320];
      char q[8], h[8];
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
  pinMode(PIN_SYS_EN, OUTPUT);
  digitalWrite(PIN_SYS_EN, HIGH);  // keep the board on when running from its battery
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(LCD_BL, OUTPUT);
  digitalWrite(LCD_BL, HIGH);

  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL, 400000);
  gfx->begin();

  mpuOk = mpuInit();
  oxOk = ox.begin(Wire, I2C_SPEED_FAST);
  if (oxOk) ox.setup(60 /* LED brightness */, 4 /* average */, 2 /* red + IR */, 100 /* samples/s */, 411 /* pulse width */, 4096 /* range */);

  rd_default_config(&rdCfg);
  rd_init(&rd, &rdCfg);
  send("HELLO,DOSELOOP,1");
  if (!mpuOk) send("WARN,MPU6050_NOT_FOUND");
  if (!oxOk) send("WARN,MAX30102_NOT_FOUND");

  if (strlen(WIFI_SSID)) xTaskCreatePinnedToCore(wifiTask, "wifi", 8192, nullptr, 1, nullptr, 0);
  drawScreen();
}

void loop() {
  static char rx[64];
  static uint8_t rxLen = 0;
  static uint32_t nextSample = millis(), nextDraw = 0, lastHrSent = 0, lastWarn = 0, btnSince = 0;
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

  // Heart rate and SpO2: reported every 2 seconds while a finger is on the sensor.
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

  // Motion: 50 samples a second into the same rep detector as the STM32 wearable.
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
        if (targetReps && rep.count == targetReps) beep(400);       // dose reached
        else if (targetReps && rep.count > targetReps) beep(60);    // past the dose
        markLive();
      } else if (ev == RD_EVENT_PARTIAL) {
        snprintf(buf, sizeof(buf), "PART,%u", rep.rom_deg);
        send(buf);
      }
    }
  }

  if ((int32_t)(now - nextDraw) >= 0) {
    nextDraw = now + 200;  // 5 frames a second is plenty and leaves time for sampling
    drawScreen();
  }
}
