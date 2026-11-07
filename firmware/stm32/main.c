/*
 * DoseLoop wearable - STM32 Nucleo-F401RE
 *
 * Wiring (see docs/HARDWARE.md):
 *   MPU-6050   SCL -> PB8 (D15), SDA -> PB9 (D14), VCC -> 3V3, GND -> GND
 *   Pulse sensor signal -> PA0 (A0), VCC -> 3V3, GND -> GND
 *   Active buzzer + -> PA6 (D12), - -> GND
 *   On-board: LD2 = PA5, user button B1 = PC13, ST-Link virtual COM = USART2 (PA2/PA3)
 *
 * Serial protocol, 115200 8N1, one ASCII line per message:
 *   device -> host   HELLO,DOSELOOP,1
 *                    SET,START
 *                    REP,<n>,<tempo_ms>,<rom_deg>,<quality>
 *                    PART,<rom_deg>
 *                    HR,<bpm>
 *                    WARN,HR_HIGH
 *                    SET,STOP,<reps>,<partials>
 *   host -> device   CFG,<rom_deg>,<tempo_ms>,<target_reps>,<hr_max>
 *                    START
 *                    STOP
 *
 * Drop this file and firmware/core/ into a STM32CubeIDE project for the
 * NUCLEO-F401RE (replace the generated main.c, add core/ to the include path).
 */
#include <stdio.h>
#include <string.h>

#include "doseloop_core.h"
#include "stm32f4xx_hal.h"

#define MPU_ADDR (0x68 << 1)
#define MPU_PWR_MGMT_1 0x6B
#define MPU_CONFIG 0x1A
#define MPU_ACCEL_CONFIG 0x1C
#define MPU_ACCEL_XOUT_H 0x3B
#define MPU_LSB_PER_G 8192.0f /* +-4 g full scale */

#define LED_PORT GPIOA
#define LED_PIN GPIO_PIN_5
#define BUZZ_PORT GPIOA
#define BUZZ_PIN GPIO_PIN_6
#define BTN_PORT GPIOC
#define BTN_PIN GPIO_PIN_13

static I2C_HandleTypeDef hi2c1;
static UART_HandleTypeDef huart2;
static ADC_HandleTypeDef hadc1;

static rd_t rd;
static hr_t hr;
static rd_config_t rd_cfg;
static uint16_t target_reps = 10;
static uint16_t hr_max = 0;
static bool set_active;

static uint8_t rx_byte;
static char rx_line[48];
static uint8_t rx_len;
static volatile bool rx_ready;
static char rx_pending[48];

static uint32_t buzz_until;
static uint32_t led_until;

static void SystemClock_Config(void);
static void GPIO_Init(void);
static void I2C1_Init(void);
static void USART2_Init(void);
static void ADC1_Init(void);
static void Error_Handler(void);

static void send_line(const char *s)
{
    HAL_UART_Transmit(&huart2, (uint8_t *)s, (uint16_t)strlen(s), 50);
}

static void beep(uint32_t ms)
{
    HAL_GPIO_WritePin(BUZZ_PORT, BUZZ_PIN, GPIO_PIN_SET);
    buzz_until = HAL_GetTick() + ms;
}

static void mpu_write(uint8_t reg, uint8_t val)
{
    if (HAL_I2C_Mem_Write(&hi2c1, MPU_ADDR, reg, I2C_MEMADD_SIZE_8BIT, &val, 1, 100) != HAL_OK) {
        Error_Handler();
    }
}

static void mpu_init(void)
{
    mpu_write(MPU_PWR_MGMT_1, 0x00);   /* wake */
    mpu_write(MPU_CONFIG, 0x04);       /* 20 Hz digital low-pass */
    mpu_write(MPU_ACCEL_CONFIG, 0x08); /* +-4 g */
}

static bool mpu_read(float *ax, float *ay, float *az)
{
    uint8_t b[6];
    if (HAL_I2C_Mem_Read(&hi2c1, MPU_ADDR, MPU_ACCEL_XOUT_H, I2C_MEMADD_SIZE_8BIT, b, 6, 10) != HAL_OK) {
        return false;
    }
    *ax = (float)(int16_t)((b[0] << 8) | b[1]) / MPU_LSB_PER_G;
    *ay = (float)(int16_t)((b[2] << 8) | b[3]) / MPU_LSB_PER_G;
    *az = (float)(int16_t)((b[4] << 8) | b[5]) / MPU_LSB_PER_G;
    return true;
}

static uint16_t pulse_read(void)
{
    HAL_ADC_Start(&hadc1);
    uint16_t v = 0;
    if (HAL_ADC_PollForConversion(&hadc1, 2) == HAL_OK) {
        v = (uint16_t)HAL_ADC_GetValue(&hadc1);
    }
    HAL_ADC_Stop(&hadc1);
    return v;
}

static void set_start(void)
{
    rd_init(&rd, &rd_cfg);
    set_active = true;
    HAL_GPIO_WritePin(LED_PORT, LED_PIN, GPIO_PIN_SET);
    send_line("SET,START\n");
    beep(80);
}

static void set_stop(void)
{
    char buf[40];
    set_active = false;
    HAL_GPIO_WritePin(LED_PORT, LED_PIN, GPIO_PIN_RESET);
    snprintf(buf, sizeof(buf), "SET,STOP,%u,%u\n", rd.count, rd.partials);
    send_line(buf);
}

static void handle_command(const char *line)
{
    dl_cfg_cmd_t c;
    switch (dl_parse_line(line, &c)) {
    case DL_CMD_CFG:
        rd_cfg.target_rom_deg = (float)c.target_rom_deg;
        rd_cfg.target_tempo_ms = c.target_tempo_ms;
        target_reps = c.target_reps;
        hr_max = c.hr_max;
        break;
    case DL_CMD_START:
        if (!set_active) {
            set_start();
        }
        break;
    case DL_CMD_STOP:
        if (set_active) {
            set_stop();
        }
        break;
    default:
        break;
    }
}

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *h)
{
    if (h->Instance == USART2) {
        if (rx_byte == '\n' || rx_byte == '\r') {
            if (rx_len && !rx_ready) {
                rx_line[rx_len] = '\0';
                memcpy(rx_pending, rx_line, rx_len + 1u);
                rx_ready = true;
            }
            rx_len = 0;
        } else if (rx_len < sizeof(rx_line) - 1) {
            rx_line[rx_len++] = (char)rx_byte;
        } else {
            rx_len = 0; /* overlong line: drop it */
        }
        HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
    }
}

void USART2_IRQHandler(void)
{
    HAL_UART_IRQHandler(&huart2);
}

void SysTick_Handler(void)
{
    HAL_IncTick();
}

int main(void)
{
    HAL_Init();
    SystemClock_Config();
    GPIO_Init();
    I2C1_Init();
    USART2_Init();
    ADC1_Init();

    mpu_init();
    rd_default_config(&rd_cfg);
    hr_init(&hr);
    HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
    send_line("HELLO,DOSELOOP,1\n");

    uint32_t next_sample = HAL_GetTick();
    uint32_t last_hr_report = 0;
    uint32_t last_hr_warn = 0;
    uint32_t btn_since = 0;
    bool btn_down = false;
    char buf[48];

    while (1) {
        uint32_t now = HAL_GetTick();

        if (rx_ready) {
            handle_command(rx_pending);
            rx_ready = false;
        }

        if (buzz_until && (int32_t)(now - buzz_until) >= 0) {
            HAL_GPIO_WritePin(BUZZ_PORT, BUZZ_PIN, GPIO_PIN_RESET);
            buzz_until = 0;
        }
        if (led_until && (int32_t)(now - led_until) >= 0) {
            HAL_GPIO_WritePin(LED_PORT, LED_PIN, set_active ? GPIO_PIN_SET : GPIO_PIN_RESET);
            led_until = 0;
        }

        /* B1 is active low; 30 ms debounce, toggles the set on press. */
        bool pressed = HAL_GPIO_ReadPin(BTN_PORT, BTN_PIN) == GPIO_PIN_RESET;
        if (pressed && !btn_down) {
            if (!btn_since) {
                btn_since = now;
            } else if (now - btn_since > 30) {
                btn_down = true;
                if (set_active) {
                    set_stop();
                } else {
                    set_start();
                }
            }
        } else if (!pressed) {
            btn_since = 0;
            btn_down = false;
        }

        if ((int32_t)(now - next_sample) < 0) {
            continue;
        }
        next_sample += 1000 / DL_SAMPLE_HZ;

        if (hr_update(&hr, pulse_read(), now) && hr.bpm && now - last_hr_report >= 2000) {
            last_hr_report = now;
            snprintf(buf, sizeof(buf), "HR,%u\n", hr.bpm);
            send_line(buf);
            if (hr_max && hr.bpm > hr_max && now - last_hr_warn >= 10000) {
                last_hr_warn = now;
                send_line("WARN,HR_HIGH\n");
                beep(600);
            }
        }

        if (!set_active) {
            continue;
        }
        float ax, ay, az;
        if (!mpu_read(&ax, &ay, &az)) {
            continue;
        }
        rd_rep_t rep;
        rd_event_t ev = rd_update(&rd, ax, ay, az, now, &rep);
        if (ev == RD_EVENT_REP) {
            snprintf(buf, sizeof(buf), "REP,%u,%u,%u,%u\n", rep.count, rep.tempo_ms, rep.rom_deg, rep.quality);
            send_line(buf);
            /* Blink off for each rep; long beep once the prescribed dose is reached. */
            HAL_GPIO_WritePin(LED_PORT, LED_PIN, GPIO_PIN_RESET);
            led_until = now + 120;
            if (target_reps && rep.count == target_reps) {
                beep(400);
            } else if (target_reps && rep.count > target_reps) {
                beep(60); /* nag: past the dose */
            }
        } else if (ev == RD_EVENT_PARTIAL) {
            snprintf(buf, sizeof(buf), "PART,%u\n", rep.rom_deg);
            send_line(buf);
        }
    }
}

/* ---------- Peripheral setup (HSI -> PLL, 84 MHz) ---------- */

static void SystemClock_Config(void)
{
    RCC_OscInitTypeDef osc = {0};
    RCC_ClkInitTypeDef clk = {0};

    __HAL_RCC_PWR_CLK_ENABLE();
    __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE2);

    osc.OscillatorType = RCC_OSCILLATORTYPE_HSI;
    osc.HSIState = RCC_HSI_ON;
    osc.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
    osc.PLL.PLLState = RCC_PLL_ON;
    osc.PLL.PLLSource = RCC_PLLSOURCE_HSI;
    osc.PLL.PLLM = 16;
    osc.PLL.PLLN = 336;
    osc.PLL.PLLP = RCC_PLLP_DIV4;
    osc.PLL.PLLQ = 7;
    if (HAL_RCC_OscConfig(&osc) != HAL_OK) {
        Error_Handler();
    }

    clk.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    clk.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    clk.AHBCLKDivider = RCC_SYSCLK_DIV1;
    clk.APB1CLKDivider = RCC_HCLK_DIV2;
    clk.APB2CLKDivider = RCC_HCLK_DIV1;
    if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_2) != HAL_OK) {
        Error_Handler();
    }
}

static void GPIO_Init(void)
{
    GPIO_InitTypeDef g = {0};

    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();

    HAL_GPIO_WritePin(GPIOA, LED_PIN | BUZZ_PIN, GPIO_PIN_RESET);
    g.Pin = LED_PIN | BUZZ_PIN;
    g.Mode = GPIO_MODE_OUTPUT_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOA, &g);

    g.Pin = BTN_PIN;
    g.Mode = GPIO_MODE_INPUT;
    g.Pull = GPIO_NOPULL; /* Nucleo has an external pull-up on B1 */
    HAL_GPIO_Init(BTN_PORT, &g);
}

static void I2C1_Init(void)
{
    hi2c1.Instance = I2C1;
    hi2c1.Init.ClockSpeed = 400000;
    hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
    hi2c1.Init.OwnAddress1 = 0;
    hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
    hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
    hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
    hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
    if (HAL_I2C_Init(&hi2c1) != HAL_OK) {
        Error_Handler();
    }
}

static void USART2_Init(void)
{
    huart2.Instance = USART2;
    huart2.Init.BaudRate = 115200;
    huart2.Init.WordLength = UART_WORDLENGTH_8B;
    huart2.Init.StopBits = UART_STOPBITS_1;
    huart2.Init.Parity = UART_PARITY_NONE;
    huart2.Init.Mode = UART_MODE_TX_RX;
    huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart2.Init.OverSampling = UART_OVERSAMPLING_16;
    if (HAL_UART_Init(&huart2) != HAL_OK) {
        Error_Handler();
    }
}

static void ADC1_Init(void)
{
    ADC_ChannelConfTypeDef ch = {0};

    hadc1.Instance = ADC1;
    hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
    hadc1.Init.Resolution = ADC_RESOLUTION_12B;
    hadc1.Init.ScanConvMode = DISABLE;
    hadc1.Init.ContinuousConvMode = DISABLE;
    hadc1.Init.DiscontinuousConvMode = DISABLE;
    hadc1.Init.ExternalTrigConv = ADC_SOFTWARE_START;
    hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
    hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
    hadc1.Init.NbrOfConversion = 1;
    hadc1.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
    if (HAL_ADC_Init(&hadc1) != HAL_OK) {
        Error_Handler();
    }
    ch.Channel = ADC_CHANNEL_0;
    ch.Rank = 1;
    ch.SamplingTime = ADC_SAMPLETIME_84CYCLES;
    if (HAL_ADC_ConfigChannel(&hadc1, &ch) != HAL_OK) {
        Error_Handler();
    }
}

/* HAL MSP hooks: clocks and pin muxing for each peripheral. */

void HAL_I2C_MspInit(I2C_HandleTypeDef *h)
{
    if (h->Instance == I2C1) {
        GPIO_InitTypeDef g = {0};
        __HAL_RCC_GPIOB_CLK_ENABLE();
        g.Pin = GPIO_PIN_8 | GPIO_PIN_9;
        g.Mode = GPIO_MODE_AF_OD;
        g.Pull = GPIO_PULLUP;
        g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
        g.Alternate = GPIO_AF4_I2C1;
        HAL_GPIO_Init(GPIOB, &g);
        __HAL_RCC_I2C1_CLK_ENABLE();
    }
}

void HAL_UART_MspInit(UART_HandleTypeDef *h)
{
    if (h->Instance == USART2) {
        GPIO_InitTypeDef g = {0};
        __HAL_RCC_USART2_CLK_ENABLE();
        __HAL_RCC_GPIOA_CLK_ENABLE();
        g.Pin = GPIO_PIN_2 | GPIO_PIN_3;
        g.Mode = GPIO_MODE_AF_PP;
        g.Pull = GPIO_NOPULL;
        g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
        g.Alternate = GPIO_AF7_USART2;
        HAL_GPIO_Init(GPIOA, &g);
        HAL_NVIC_SetPriority(USART2_IRQn, 5, 0);
        HAL_NVIC_EnableIRQ(USART2_IRQn);
    }
}

void HAL_ADC_MspInit(ADC_HandleTypeDef *h)
{
    if (h->Instance == ADC1) {
        GPIO_InitTypeDef g = {0};
        __HAL_RCC_ADC1_CLK_ENABLE();
        __HAL_RCC_GPIOA_CLK_ENABLE();
        g.Pin = GPIO_PIN_0;
        g.Mode = GPIO_MODE_ANALOG;
        g.Pull = GPIO_NOPULL;
        HAL_GPIO_Init(GPIOA, &g);
    }
}

static void Error_Handler(void)
{
    /* Fast blink: a peripheral failed to initialise (usually IMU wiring). */
    __disable_irq();
    while (1) {
        HAL_GPIO_TogglePin(LED_PORT, LED_PIN);
        for (volatile uint32_t i = 0; i < 400000; i++) {
        }
    }
}
