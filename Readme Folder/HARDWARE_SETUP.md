# Hardware Team Guide & Firmware Integration Manual

This document details the wiring, firmware configuration, and API specifications for connecting the **ESP32 (with PN532 NFC and R307S Fingerprint module)** to the backend access control server.

---

## 1. System Architecture

```
                                  Wi-Fi (LAN / HTTP)
 [PN532 RFID] ──UART1──┐                                  ┌───► PostgreSQL DB
                       ├──► [ESP32 Controller] ───────────┤     ('access_control')
 [R307S Finger] ──UART2─┘    (esp32_test2.ino)    Port 3000   └───► Real-Time Web Console
                                                                  (Server-Sent Events)
 [Relay + LEDs + Buzzer] ◄── GPIOs
```

1. **Card Tap**: User taps NFC card on PN532.
2. **Online Query**: ESP32 checks `GET /access_control/authenticate.php?nfc_uid=...&esp32_id=...`.
3. **Biometric Challenge**: If authorized, server returns the employee's assigned `fingerprint_id`.
4. **Sensor Match**: ESP32 prompts user to place finger on R307S; checks if matched slot equals `fingerprint_id`.
5. **Action**: If matched, ESP32 energizes relay (`GPIO 23`) and turns on Green LED.
6. **Logging**: ESP32 calls `GET /access_control/log_access.php` to save the audit log and update the web dashboard in real time.
7. **Offline Support**: If Wi-Fi is lost, ESP32 verifies against its local LittleFS flash cache (`/employees.json`) synced via `/access_control/sync.php`.

---

## 2. Hardware Wiring Pinout

All pins match the hardware team's sketch: `esp32_test2.ino`.

### A. PN532 NFC Module (UART / HSU Mode)
> **Note**: Ensure DIP switches on the PN532 are set to HSU mode (`Channel 1 = OFF (0)`, `Channel 2 = OFF (0)`).

| PN532 Pin | ESP32 GPIO | Description |
|---|---|---|
| **VCC** | 3.3V or 5V | Power |
| **GND** | GND | Common Ground |
| **TXD (SCL)** | **GPIO 27** | HardwareSerial(1) RX |
| **RXD (SDA)** | **GPIO 26** | HardwareSerial(1) TX |

### B. R307S Optical Fingerprint Sensor (UART)
> Default Baud Rate: `57600` baud.

| R307S Wire Color | Sensor Pin | ESP32 GPIO | Description |
|---|---|---|---|
| **Red** | VCC | 3.3V / 5V | Power |
| **Black** | GND | GND | Common Ground |
| **Yellow** | TX | **GPIO 16** | HardwareSerial(2) RX |
| **Green** | RX | **GPIO 17** | HardwareSerial(2) TX |

### C. Actuators & Status Indicators

| Component | ESP32 GPIO | Logic State |
|---|---|---|
| **Relay (Door Lock)** | **GPIO 23** | `HIGH` = Unlock (Active for 3s), `LOW` = Locked |
| **Green LED** | **GPIO 25** | `HIGH` on Access Granted |
| **Red LED** | **GPIO 33** | `HIGH` on Access Denied / Error |
| **Blue LED** | **GPIO 4** | `HIGH` when waiting for fingerprint scan |
| **Buzzer** | **GPIO 32** | 1 beep = Prompt/Scan, 2 beeps = Granted, 3 beeps = Denied |

---

## 3. Firmware Configuration (`esp32_test2.ino`)

Open `esp32_test2.ino` in Arduino IDE or PlatformIO and update lines 15–32 with your local network details:

```cpp
// =====================================================
// Wi-Fi Configuration
// =====================================================
const char* ssid     = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// Unique ID for this door reader
const char* esp32_id = "ESP32_01";

// =====================================================
// SERVER URLs (Replace IP with Laptop/Server IP)
// =====================================================
const char* serverURL = "http://192.168.1.100:3000/access_control/authenticate.php";
const char* syncURL   = "http://192.168.1.100:3000/access_control/sync.php?esp32_id=ESP32_01";
const char* logURL    = "http://192.168.1.100:3000/access_control/log_access.php";
```

> **IMPORTANT**: Make sure to include `:3000` (the server port) in the URLs. Both the laptop running the Node.js server and the ESP32 must be on the same Wi-Fi router.

---

## 4. API Endpoints Specification

The backend provides native support for the firmware's endpoints:

### 1. Card Authentication
* **Endpoint**: `GET /access_control/authenticate.php`
* **Query Parameters**:
  * `nfc_uid`: Card hex string (e.g. `04A2B7C1` or `C6:10:00:02`).
  * `esp32_id`: Reader identifier (e.g. `ESP32_01`).
* **Success Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "authorized": true,
    "message": "OK",
    "user_id": 1,
    "employee_id": "EMP-001",
    "name": "Varma",
    "fingerprint_id": 1,
    "door_id": 1,
    "door_name": "Main Entrance"
  }
  ```
* **Denied Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "authorized": false,
    "message": "Card not recognized"
  }
  ```

---

### 2. Access Audit Logging
* **Endpoint**: `GET /access_control/log_access.php`
* **Query Parameters**:
  * `user_id`: Database person ID.
  * `door_id`: Door ID (1 = Main Entrance, 2 = Hardware Lab, etc.).
  * `nfc_uid`: Card hex string.
  * `fingerprint_id`: Matched sensor slot (or `-1` if failed).
  * `result`: `GRANTED` or `DENIED`.
  * `reason`: Reason string (e.g. `OK`, `Fingerprint not recognized`).
* **Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "event_id": 128
  }
  ```

---

### 3. Offline Employee Sync
* **Endpoint**: `GET /access_control/sync.php`
* **Query Parameters**:
  * `esp32_id`: Reader identifier (e.g. `ESP32_01`).
* **Response (HTTP 200)**:
  ```json
  {
    "success": true,
    "employee_count": 5,
    "employees": [
      {
        "employee_id": "EMP-001",
        "name": "Varma",
        "nfc_uid": "04A2B7C1",
        "fingerprint_id": 1,
        "door_id": 1,
        "allowed": 1,
        "status": "active"
      }
    ]
  }
  ```

---

## 5. Quick Verification with cURL

Before powering on the ESP32, you can verify the backend from your command line:

```bash
# 1. Test Authentication
curl "http://localhost:3000/access_control/authenticate.php?nfc_uid=04A2B7C1&esp32_id=ESP32_01"

# 2. Test Logging
curl "http://localhost:3000/access_control/log_access.php?user_id=1&door_id=1&nfc_uid=04A2B7C1&fingerprint_id=1&result=GRANTED&reason=OK"

# 3. Test Offline Sync
curl "http://localhost:3000/access_control/sync.php?esp32_id=ESP32_01"
```
