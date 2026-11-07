# Hardware guide

## Parts

| Part | Qty | Purpose | Approx. cost (CAD) |
|---|---|---|---|
| STM32 Nucleo-F401RE | 1 | Microcontroller, USB power and serial (ECE 198 kit) | in kit |
| MPU-6050 breakout (GY-521) | 1 | 3-axis accelerometer over I2C: rep counting and quality | $5 |
| Analog pulse sensor (PulseSensor-style, 3.3 V) | 1 | Heart rate from fingertip or earlobe | $8 |
| Active buzzer, 3.3 V | 1 | "Dose reached" and "heart rate high" alerts | $1 |
| Elastic strap with hook-and-loop | 1 | Holds the IMU on thigh, shin, wrist or ankle | $4 |
| Jumper wires, 1 m ribbon for the IMU | – | Lets the IMU sit on the limb while the board stays on a table | in kit |
| USB-A to mini-B cable | 1 | Power and data to the laptop | in kit |

The button (B1) and LED (LD2) on the Nucleo are used as-is.

## Wiring

| Device pin | Nucleo pin | Arduino header |
|---|---|---|
| MPU-6050 VCC | 3V3 | 3V3 |
| MPU-6050 GND | GND | GND |
| MPU-6050 SCL | PB8 | D15 |
| MPU-6050 SDA | PB9 | D14 |
| Pulse sensor signal | PA0 | A0 |
| Pulse sensor + | 3V3 | 3V3 |
| Pulse sensor − | GND | GND |
| Buzzer + | PA6 | D12 |
| Buzzer − | GND | GND |

Leave the MPU-6050's AD0 pin unconnected or tied to GND (I2C address 0x68). The GY-521 board has its own pull-ups on SCL and SDA. Power everything from **3V3**, not 5 V: PA0 is not 5 V tolerant in analog mode.

## Building the firmware

1. In STM32CubeIDE: *File → New → STM32 Project*, board **NUCLEO-F401RE**, initialise peripherals in default mode: **No** (the code configures them itself).
2. Copy `firmware/core/doseloop_core.c` and `.h` into the project's `Core/Src` and `Core/Inc`.
3. Replace the generated `Core/Src/main.c` with `firmware/stm32/main.c`. If the generated `stm32f4xx_it.c` also defines `SysTick_Handler`, delete the copy in one of the two files.
4. In `stm32f4xx_hal_conf.h`, make sure `HAL_I2C_MODULE_ENABLED`, `HAL_UART_MODULE_ENABLED` and `HAL_ADC_MODULE_ENABLED` are defined.
5. Build and run. On reset the board prints `HELLO,DOSELOOP,1` at 115200 baud.

If LD2 blinks rapidly after reset, a peripheral failed to start. It is almost always the IMU wiring.

## Using it

1. Strap the IMU to the limb named on screen (for sit-to-stand: the front of the thigh), with the board's long edge along the limb.
2. In the participant app choose **Wearable sensor**, pick the board's serial port, and press **Start set** (or the blue button on the board).
3. Keep still for the first half-second while it captures the rest position.
4. LD2 blinks on each counted rep. A long beep means the dose is reached; short beeps after that mean "stop".

## Serial protocol

115200 baud, 8N1, one ASCII line per message.

| Direction | Line | Meaning |
|---|---|---|
| board → app | `HELLO,DOSELOOP,1` | Boot banner |
| board → app | `SET,START` | A set began (from the app or the button) |
| board → app | `REP,<n>,<tempo_ms>,<range_deg>,<quality>` | Valid rep number `n` |
| board → app | `PART,<range_deg>` | Movement under half the prescribed range; not counted |
| board → app | `HR,<bpm>` | Heart rate, at most every 2 s |
| board → app | `WARN,HR_HIGH` | Heart rate above the ceiling |
| board → app | `SET,STOP,<reps>,<partials>` | Set ended |
| app → board | `CFG,<range_deg>,<tempo_ms>,<target_reps>,<hr_max>` | Targets for the next set |
| app → board | `START` / `STOP` | Begin or end a set |

You can drive the board by hand from any serial terminal to test it before involving the app.

## Calibration checklist for the prototype

These are worth measuring with real people before the symposium:

- **Prescribed range per exercise** (`target_rom_deg` in `server/db.js`). Record three good reps and read the `REP` lines.
- **Sensor placement.** Tilt is measured about the board's X axis; if counts are low, rotate the board 90° on the strap.
- **Pulse sensor.** It is sensitive to pressure and movement. The fingertip of the hand that is *not* moving gives the cleanest signal.
- **Next step: going wireless.** Replace the USB link with an HC-05 Bluetooth module on the same UART pins and a small LiPo pack. The protocol does not change.

## Alternative: Waveshare ESP32-S3-LCD-1.69 with MAX30102

`firmware/esp32/DoseLoopESP32/` runs the same rep detector (`doseloop_core.c`) and the same serial protocol on a Waveshare ESP32-S3-LCD-1.69, shows the count, heart rate and SpO2 on its 240x280 screen, and can also post live readings over Wi-Fi.

| Device pin | ESP32-S3-LCD-1.69 |
|---|---|
| MPU-6050 VCC / GND | 3V3 / GND |
| MPU-6050 SDA / SCL | GPIO11 / GPIO10 (the board's I2C header) |
| MPU-6050 AD0 | GND (address 0x68) |
| MAX30102 VIN / GND | 3V3 / GND |
| MAX30102 SDA / SCL | GPIO11 / GPIO10 (same bus, address 0x57) |

The screen (ST7789V2: DC 4, CS 5, SCK 6, MOSI 7, RST 8, backlight 15), BOOT button (GPIO0, starts and stops a set), buzzer (GPIO42 on V2 boards, 33 on older ones) and power hold (GPIO41 on V2, 35 on older) are on the board. Pins are from Waveshare's V2 schematic.

Arduino IDE: install "esp32 by Espressif Systems" 3.0.5 or newer, board **ESP32S3 Dev Module**, **USB CDC On Boot: Enabled**; libraries **GFX Library for Arduino** (1.4.9 or newer) and **SparkFun MAX3010x Pulse and Proximity Sensor Library**. Set Wi-Fi details and the participant number at the top of the sketch, or leave `WIFI_SSID` empty for USB only.

Extra protocol lines: the board sends `SPO2,<percent>`; the app sends `EX,<exercise name>` before each `CFG`. Older boards ignore lines they do not know.
