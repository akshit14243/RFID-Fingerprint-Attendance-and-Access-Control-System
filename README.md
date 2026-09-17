# Team-AccessPro: RFID & Biometric Attendance Automation System

An enterprise-grade, real-time access control and automated attendance system designed for IoT environments. The platform integrates ESP32 microcontrollers, PN532 RFID readers, and R307S optical fingerprint sensors with a high-concurrency Node.js REST API, an append-only PostgreSQL ledger, and a live web management console.

---

## 🏛 System Architecture

```
                                  ┌────────────────────────────────────────────────────────┐
                                  │                  PostgreSQL Database                   │
                                  │  - Append-Only Access Logs (DB Trigger Enforced)       │
                                  │  - Credential & Biometric Vault                        │
                                  │  - Shift Scheduling, Rooms, & Access Rules Views      │
                                  └───────────────────────────▲────────────────────────────┘
                                                              │ SQL Connection Pool
                                                              │ (pg library)
                                  ┌───────────────────────────▼────────────────────────────┐
                                  │                Node.js / Express API                   │
                                  │  - JWT / HMAC Session Authentication                   │
                                  │  - Real-Time Event Bus (Server-Sent Events / SSE)      │
                                  │  - Hardware Adapter (authenticate / sync / log)        │
                                  │  - Zod Request Schema Validation                       │
                                  └──────────────▲──────────────────────────▲──────────────┘
                                                 │                          │
                 HTTP REST / Sync (Port 3000)    │                          │ SSE / JSON REST
                                                 │                          │
    ┌────────────────────────────────────────────┴────────┐   ┌─────────────┴────────────────────────────┐
    │              Edge Hardware (ESP32)                  │   │           Web Administration Console     │
    │  - PN532 NFC/RFID Reader (UART / HSU)               │   │  - Real-time live scan monitoring        │
    │  - R307S Fingerprint Optical Sensor (UART)          │   │  - Employee onboarding & RFID pairing    │
    │  - Offline Cache Fallback (LittleFS Flash Storage)  │   │  - Room rules & biometric 2FA policies   │
    │  - Relay, Status LEDs, and Piezo Buzzer             │   │  - Shifts, Working Hours & Holidays      │
    └─────────────────────────────────────────────────────┘   └──────────────────────────────────────────┘
```

---

## ✨ Key Capabilities

* **Dual-Factor Edge Verification (2FA)**: Supports card-only (RFID/NFC), fingerprint-only, or strict two-factor authentication (RFID tap followed by fingerprint verification).
* **Hardware Failure Tolerance & Offline Sync**: Edge devices cache an authorized access list locally via LittleFS. If Wi-Fi drops, door access continues locally and syncs logs once connectivity resumes.
* **Audit-Grade Immutable Ledger**: The `access_events` database table is append-only, enforced by PostgreSQL database triggers preventing modifications or deletions.
* **Real-Time Live Feed**: Operates over Server-Sent Events (SSE) to display scans, occupancy changes, and device heartbeats on the web dashboard with sub-second latency.
* **Comprehensive Admin Suite**:
  * **Employee & Credential Lifecycle**: Add/deactivate employees, assign hex RFID UIDs, link fingerprint sensor slots.
  * **Device Management**: Register and monitor hardware readers across multiple rooms with online/offline health checks.
  * **Access Rules & Permissions**: Define door restrictions per department or per employee with optional expiration dates.
  * **Shift Schedules & Attendance**: Configurable shifts (start/end times, late grace period) and corporate holiday management.

---

## 🛠 Tech Stack

* **Backend Engine**: Node.js (v18+), Express.js
* **Database**: PostgreSQL 14+ (Connection pooling, custom views, append-only triggers)
* **Validation & Security**: Zod runtime schema validation, bcrypt password hashing, cryptographic HMAC tokens
* **Frontend Console**: HTML5, React, Tailwind-style design system with CSS custom properties (no bundler requirement)
* **Embedded Firmware**: C++ (Arduino Core for ESP32), Adafruit-PN532, Adafruit-Fingerprint, ArduinoJson

---

## 🚀 Quick Start Guide

### Prerequisites
* **Node.js** (v18.0.0 or higher)
* **PostgreSQL** (v14 or higher running locally or on network)

---

### 1. Database Initialization

Connect to your PostgreSQL server and execute the initialization scripts in sequence:

```bash
# 1. Base Schema (Tables, triggers, enums, and views)
psql -U postgres -f db/01_schema.sql

# 2. Seed Data (Initial rooms, devices, administrators, sample staff)
psql -U postgres -f db/02_seed.sql

# 3. Extended Management Entities (Departments, shifts, holidays)
psql -U postgres -f db/03_admin_entities.sql
```

---

### 2. Backend Server Setup

Navigate to the `server/` directory, install dependencies, and configure environment variables:

```bash
cd server
npm install
```

Create `.env` inside the `server/` directory (or copy from `.env.example`):

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_postgres_password
DB_NAME=access_control

PORT=3000
AUTH_SECRET=your_super_secret_session_key_min_32_chars

LEGACY_SYNC_ENABLED=false
```

Start the application:

```bash
# Production start
npm start

# Development mode with hot-reload
npm run dev
```

The API and static web console will be available at:
👉 **`http://localhost:3000`**

---

## 🔐 Default Access Credentials

| Role | Email | Password | Permissions |
|---|---|---|---|
| **System Administrator** | `admin@example.com` | `admin123` | Full access (CRUD on staff, credentials, rules, shifts, devices) |
| **Auditor / Viewer** | `viewer@example.com` | `admin123` | Read-only access to live feed, logs, and reports |

---

## 📡 Hardware & Firmware Integration

The backend provides dedicated adapter endpoints compatible with the ESP32 firmware located in the `firmware/` directory:

| Endpoint | Method | Purpose |
|---|---|---|
| `/access_control/authenticate.php` | `GET` | Authenticates scanned NFC/RFID UID against room access rules |
| `/access_control/sync.php` | `GET` | Fetches active allow-list for LittleFS edge cache storage |
| `/access_control/log_access.php` | `GET` | Edge hardware logs entry/exit scans with direction & timestamp |

### ESP32 Pinout Overview

| Peripheral | Protocol | ESP32 Pins | Notes |
|---|---|---|---|
| **PN532 NFC** | HSU (UART) | TX: `GPIO 16`, RX: `GPIO 17` | High-speed UART mode (DIP switch: `0 1`) |
| **R307S Sensor** | Serial2 (UART) | TX: `GPIO 18`, RX: `GPIO 19` | 57600 default baud rate |
| **Relay** | Digital Out | `GPIO 26` | Active LOW trigger for door strike / maglock |
| **Buzzer** | Digital Out | `GPIO 27` | Beep confirmation / error buzz |
| **Status LEDs** | Digital Out | Green: `GPIO 25`, Red: `GPIO 33` | Authorization status indicators |

---

## 📁 Repository Structure

```
├── db/
│   ├── 01_schema.sql            # Core database schema, triggers, views
│   ├── 02_seed.sql              # Initial system seed data
│   └── 03_admin_entities.sql    # Shifts, departments, and holiday definitions
├── firmware/
│   ├── esp32_test2.ino          # Complete edge controller firmware
│   └── esp32_pn532_r307s_...    # Modular component pinout reference
├── server/
│   ├── routes/
│   │   ├── admin.js             # People, credentials, rules, departments, shifts, holidays
│   │   ├── device.js            # Device status & registration
│   │   ├── hardware_adapter.js  # Edge firmware compatibility layer
│   │   ├── reads.js             # Attendance and event query routes
│   │   └── stream.js            # Server-Sent Events (SSE) live push engine
│   ├── auth.js                  # JWT/HMAC token signing & role guards
│   ├── db.js                    # PostgreSQL pool client
│   ├── decision.js              # Access rule policy decision engine
│   └── index.js                 # Express server bootstrap
├── tools/
│   └── simulate_device.cjs      # Hardware simulation script for automated testing
├── web/
│   └── index.html               # Live management dashboard (React SPA)
├── API.md                       # Complete API contract specification
└── README.md                    # Project documentation
```

---

## 🧪 Testing Without Hardware

You can simulate device taps and offline batch syncs using the built-in test runner:

```bash
# Simulate 5 real-time authorized and denied taps
node tools/simulate_device.cjs --loop 5

# Simulate offline device operation followed by batch sync
node tools/simulate_device.cjs --offline 4

# Verify deduplication engine (replaying existing scans)
node tools/simulate_device.cjs --replay
```

---

## 📄 License
This project is developed for internal access control and attendance automation. All rights reserved.
