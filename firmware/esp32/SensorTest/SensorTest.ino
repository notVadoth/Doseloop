/*
 * Sensor test: Waveshare ESP32-S3-LCD-1.69 + MPU6050 + MAX30102 (purple GY-MAX30102)
 *
 * Use this before DoseLoopESP32 to check the wiring. It scans the I2C bus, then once a second
 * prints the accelerometer and gyro, heart rate and SpO2, and the ESP32's own chip temperature
 * (so you can see whether the board is really overheating). Open Serial Monitor at 115200.
 *
 * Wiring (both sensors in parallel on the same two pins):
 *   3V3 -> MPU6050 VCC, MAX30102 VIN      GND -> both GND
 *   GPIO11 (SDA) -> both SDA              GPIO10 (SCL) -> both SCL
 *   MPU6050 AD0 -> GND (address 0x68). XDA, XCL and both INT pins: leave unconnected.
 * On the 1.69" board GPIO4-8 drive the screen, so do not use them for I2C.
 *
 * Arduino IDE: board "ESP32S3 Dev Module", USB CDC On Boot: Enabled.
 * Library: "SparkFun MAX3010x Pulse and Proximity Sensor Library". The MPU6050 is read
 * directly, so no MPU library is needed.
 */
#include <Wire.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"

#define I2C_SDA 11
#define I2C_SCL 10
#define LCD_BL 15      // screen backlight: kept off here, the test does not use the screen
#define PIN_SYS_EN 41  // keeps the board on from its battery (older boards: 35)

#define MPU 0x68
MAX30105 ox;
bool mpuOk = false, oxOk = false;

// ---------- I2C scan ----------
void scanBus() {
  Serial.println("I2C scan:");
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  0x%02X %s\n", a, a == 0x68 ? "(MPU6050)" : a == 0x57 ? "(MAX30102)" : a == 0x6B || a == 0x51 ? "(onboard)" : "");
      found++;
    }
  }
  if (!found) Serial.println("  nothing found: check 3V3, GND, and that SDA/SCL are not swapped");
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
  mpuWrite(0x1B, 0x08);  // gyro +-500 deg/s
  mpuWrite(0x1C, 0x08);  // accel +-4 g
  return true;
}

// Accel in g, gyro in deg/s, temperature of the MPU chip in C.
bool mpuRead(float a[3], float g[3], float &tempC) {
  Wire.beginTransmission(MPU);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU, 14) != 14) return false;
  int16_t r[7];
  for (int i = 0; i < 7; i++) r[i] = (Wire.read() << 8) | Wire.read();
  for (int i = 0; i < 3; i++) {
    a[i] = r[i] / 8192.0f;
    g[i] = r[i + 4] / 65.5f;
  }
  tempC = r[3] / 340.0f + 36.53f;
  return true;
}

// ---------- MAX30102 ----------
// 25 samples a second; heart rate and SpO2 from the last 4 seconds, recomputed every second.
#define N 100
uint32_t irBuf[N], redBuf[N];
int have = 0, fresh = 0;
int hr = 0, spo2 = 0;
bool finger = false;

void oxPoll() {
  ox.check();
  while (ox.available()) {
    memmove(irBuf, irBuf + 1, (N - 1) * sizeof(uint32_t));
    memmove(redBuf, redBuf + 1, (N - 1) * sizeof(uint32_t));
    irBuf[N - 1] = ox.getFIFOIR();
    redBuf[N - 1] = ox.getFIFORed();
    ox.nextSample();
    if (have < N) have++;
    fresh++;
  }
  if (have < N || fresh < 25) return;
  fresh = 0;
  uint64_t sum = 0;
  for (int i = 0; i < N; i++) sum += irBuf[i];
  finger = sum / N > 50000;
  if (!finger) {
    hr = spo2 = 0;
    return;
  }
  int32_t s, h;
  int8_t sOk, hOk;
  maxim_heart_rate_and_oxygen_saturation(irBuf, N, redBuf, &s, &sOk, &h, &hOk);
  if (hOk && h >= 40 && h <= 200) hr = h;
  if (sOk && s >= 70 && s <= 100) spo2 = s;
}

void setup() {
  pinMode(PIN_SYS_EN, OUTPUT);
  digitalWrite(PIN_SYS_EN, HIGH);
  pinMode(LCD_BL, OUTPUT);
  digitalWrite(LCD_BL, LOW);  // backlight off: less heat while testing
  setCpuFrequencyMhz(80);     // no Wi-Fi or screen here, so the slowest speed is plenty

  Serial.begin(115200);
  delay(1500);  // give Serial Monitor time to connect
  Serial.println("\nDoseLoop sensor test");
  Wire.begin(I2C_SDA, I2C_SCL, 400000);
  scanBus();

  mpuOk = mpuInit();
  Serial.println(mpuOk ? "MPU6050 ok" : "MPU6050 NOT found at 0x68 (is AD0 on GND?)");
  oxOk = ox.begin(Wire, I2C_SPEED_FAST);
  Serial.println(oxOk ? "MAX30102 ok" : "MAX30102 NOT found at 0x57 (check wiring; some purple boards pull I2C up to 1.8 V)");
  if (oxOk) ox.setup(60, 4, 2, 100, 411, 4096);  // LED level, averaging, red+IR, 100 Hz, pulse width, range
  Serial.println("Put a fingertip gently on the MAX30102 and keep still for 5-10 seconds.\n");
}

void loop() {
  static uint32_t lastPrint = 0;
  if (oxOk) oxPoll();

  if (millis() - lastPrint >= 1000) {
    lastPrint = millis();
    float a[3], g[3], mpuT = 0;
    if (mpuOk && mpuRead(a, g, mpuT))
      Serial.printf("acc %+5.2f %+5.2f %+5.2f g | gyro %+6.1f %+6.1f %+6.1f dps | ", a[0], a[1], a[2], g[0], g[1], g[2]);
    else
      Serial.print("MPU6050 -- | ");
    if (!oxOk) Serial.print("MAX30102 -- | ");
    else if (!finger) Serial.print("no finger | ");
    else Serial.printf("HR %s SpO2 %s | ", hr ? String(hr).c_str() : "--", spo2 ? (String(spo2) + "%").c_str() : "--");
    float chip = temperatureRead();  // ESP32-S3 internal sensor: rough, reads above the case temperature
    Serial.printf("chip %.0f C%s\n", chip, chip > 75 ? "  << HOT: unplug and check the wiring" : "");
  }
  delay(2);
}
