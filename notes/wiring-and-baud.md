# US_2002 — Wiring and baud plan

Full version with reasoning in `docs/Wiring_and_Baud_Notes_US2002.docx`.

## PN532 (RFID reader)

| PN532 pin | ESP32 pin | Note |
|---|---|---|
| VCC | 3V3 | module is 3.3 V tolerant |
| GND | GND | common ground with everything |
| TXD | GPIO 16 (RX2) | crossed: their TX to my RX |
| RXD | GPIO 17 (TX2) | crossed: my TX to their RX |

- Interface: **HSU (UART)**, DIP switch 1 = OFF, 2 = ON on the Elechouse V3.
- Baud: **115200**.
- Fallback if HSU misbehaves: switch DIP to I2C, SDA on GPIO 21, SCL on GPIO 22, address 0x24.
- Wake-up preamble required before `SAMConfiguration`.

## R307S (fingerprint sensor)

| R307S wire | ESP32 pin | Note |
|---|---|---|
| VCC | see below | **check the label on the module first** |
| GND | GND | common ground |
| TX | GPIO 26 (RX1) | crossed |
| RX | GPIO 25 (TX1) | crossed |

- Baud: **57600** (factory default).
- Voltage: classic R307 wants ~4.2–6 V supply with 3.3 V logic; some R307S variants are 3.3 V
  throughout. I will read the label before powering it rather than assume.

## Why these pins

- 16 / 17 and 25 / 26 are plain bidirectional GPIOs with no boot-time role.
- Avoided 34–39: input only, they cannot transmit.
- Avoided 0, 2, 5, 12, 15: strapping pins, a module pulling them at boot stops the board booting.
- Avoided 6–11: connected to the flash chip.
- UART0 (GPIO 1 / 3) left alone so USB serial debugging keeps working.

## Power

Everything shares one ground. If the fingerprint sensor turns out to need 5 V, it gets 5 V from VIN
while its logic lines stay at 3.3 V, and I will double-check that before connecting.
