# US_2001 — Reading notes (short version)

The full write-up is in `docs/Reading_Notes_US2001.docx`. This is the condensed version I keep open
while working. For every topic I try to record three things: what it is, how it is wired, what can
go wrong.

## 1. ESP32
- Dual-core MCU with Wi-Fi and Bluetooth, roughly 520 KB SRAM, usually 4 MB flash on the dev board.
- Flash keeps the program and anything I write to LittleFS; SRAM is the working memory and it is
  small, so no lazy big buffers.
- Three UART controllers. UART0 is the USB console. UART1 and UART2 are mine.
- GPIO 34–39 are input only — no pull-ups, cannot drive a relay.
- GPIO 0, 2, 5, 12, 15 are strapping pins, read at boot. A module holding one of them at the wrong
  level means the board will not boot or will not flash.
- GPIO 6–11 are wired to the flash chip. Using them bricks the running program.
- What can go wrong: brown-out when a module pulls current the USB port cannot supply.

## 2. Communication protocols
- **UART**: two wires plus ground, TX to RX crossed both ways, no clock line. Both ends must agree on
  baud. Frame is start bit, 8 data bits, stop bit. Wrong baud gives readable-looking garbage, not
  silence — that is the symptom I should recognise.
- **I2C**: SDA and SCL, one master, addressed slaves, pull-up resistors required. PN532 sits at 0x24.
- **SPI**: MOSI, MISO, SCK, SS. Fastest, more pins, one SS line per device.
- Both my modules use UART; PN532 can do all three, chosen by DIP switch.

## 3. PN532
- 13.56 MHz reader. A passive card has no battery; the reader's field induces current in the card's
  coil and that powers it long enough to answer.
- The answer includes a **UID** — a number identifying the *card*, not the person holding it.
- HSU mode needs a wake-up preamble before `SAMConfiguration`, otherwise the first command is missed.
- What can go wrong: DIP switches in the wrong position, forgetting the wake-up, a library version
  without a HardwareSerial constructor.

## 4. R307S fingerprint
- Optical sensor. Captures an image, converts it to a **template** (a feature set). Only templates are
  stored — the image is not kept and cannot be turned back into a finger.
- Enrolment: two captures of the same finger are merged into one template and stored in a numbered
  slot. Matching: 1:1 verify against one slot, or 1:N search across all.
- FAR = false accept rate (wrong person let in), FRR = false reject rate (right person refused).
  Lowering one raises the other.
- Default baud 57600.
- What can go wrong: the slot number means nothing on its own — my database has to keep slot ↔ person
  mapping consistent, or the sensor confidently identifies the wrong human.

## 5. C basics that matter here
- Fixed-width types (`uint8_t`, `uint32_t`) because a UID is bytes and memory is in kilobytes.
- Scope and lifetime — a pointer to a local buffer that has gone out of scope is a real crash here.
- Arrays and structs for records: one struct per access event is much easier to reason about.
- Every hardware call returns a status. Checking the return value is the whole difference between a
  system that fails loudly and one that silently logs nothing.
