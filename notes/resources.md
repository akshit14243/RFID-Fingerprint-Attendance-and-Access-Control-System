# US_2000 — Resources I am working from

Collected on day 1 so I do not go hunting for links again. Grouped the way I actually read them.

## ESP32 board
- Getting started with ESP32 — https://randomnerdtutorials.com/getting-started-with-esp32/
- Pinout reference — https://lastminuteengineers.com/esp32-pinout-reference/
- Digital pins (input/output, pull-ups) — https://docs.arduino.cc/learn/microcontrollers/digital-pins/

## Arduino toolchain
- Arduino IDE — https://www.arduino.cc/en/software
- arduino-esp32 core — https://github.com/espressif/arduino-esp32
- arduino-esp32 docs — https://docs.espressif.com/projects/arduino-esp32/en/latest/
- Language reference — https://www.arduino.cc/reference/en/
- Multiple UARTs (Serial1 / Serial2) — https://randomnerdtutorials.com/esp32-uart-communication-serial-arduino/

## Communication protocols
- Serial communication — https://learn.sparkfun.com/tutorials/serial-communication
- UART — https://www.circuitbasics.com/basics-uart-communication/
- I2C — https://learn.sparkfun.com/tutorials/i2c
- SPI — https://learn.sparkfun.com/tutorials/serial-peripheral-interface-spi

Why I2C and SPI when both modules run on UART: the PN532 supports all three and a DIP switch picks
one, so I need to know what I am choosing and be able to fall back to I2C if HSU misbehaves.

## C / C++
- LearnCpp — https://www.learncpp.com/

## PN532 / RFID
- Adafruit PN532 guide — https://learn.adafruit.com/adafruit-pn532-rfid-nfc
- Elechouse PN532 V3 manual (DIP switch table) — https://www.elechouse.com/elechouse/images/product/PN532_module_V3/PN532_%20Manual_V3.pdf
- NXP UM0701-02 — https://www.nxp.com/docs/en/user-guide/141520.pdf
- RFID theory — https://en.wikipedia.org/wiki/Radio-frequency_identification
- ISO/IEC 14443 — https://en.wikipedia.org/wiki/ISO/IEC_14443
- NFC background — https://en.wikipedia.org/wiki/Near-field_communication
- Adafruit_PN532 library — https://github.com/adafruit/Adafruit-PN532

## R307S fingerprint
- Adafruit Fingerprint library (R30X family) — https://github.com/adafruit/Adafruit-Fingerprint-Sensor-Library
- Adafruit optical fingerprint guide — https://learn.adafruit.com/adafruit-optical-fingerprint-sensor

## Networking (week 2 onward)
- Wi-Fi functions — https://randomnerdtutorials.com/esp32-useful-wi-fi-functions-arduino/
- HTTP GET/POST — https://randomnerdtutorials.com/esp32-http-get-post-arduino/
- HTTPClient — https://github.com/espressif/arduino-esp32/tree/master/libraries/HTTPClient
- ArduinoJson — https://arduinojson.org/
- LittleFS — https://randomnerdtutorials.com/esp32-write-data-littlefs-arduino/
- OWASP API security — https://owasp.org/www-project-api-security/

## Git
- About Git — https://docs.github.com/en/get-started/using-git/about-git
- Hello World — https://docs.github.com/en/get-started/your-journey/hello-world
- Pro Git — https://git-scm.com/book/en/v2
- Learn Git Branching — https://learngitbranching.js.org/
- Pull requests — https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-an-existing-branch
- SSH setup — https://docs.github.com/en/authentication/connecting-to-github
