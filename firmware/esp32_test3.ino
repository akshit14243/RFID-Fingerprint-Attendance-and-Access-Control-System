#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Wire.h>
#include <RTClib.h>
#include <LiquidCrystal_I2C.h>

#include <PN532_HSU.h>
#include <PN532.h>
#include <Adafruit_Fingerprint.h>

// =====================================================
// Wi-Fi
// =====================================================

const char* ssid = "ZenV Quantum";
const char* password = "ZenVQuantum@2026";

const char* esp32_id = "ESP32_01";

// =====================================================
// Server URLs
// =====================================================

const char* serverURL =
  "http://192.168.0.196/access_control/authenticate.php";

const char* syncURL =
  "http://192.168.0.196/access_control/sync.php?esp32_id=ESP32_01";

const char* logURL =
  "http://192.168.0.196/access_control/log_access.php";

// =====================================================
// LittleFS
// =====================================================


const char* employeeFile = "/employees.json";
const char* pendingLogFile = "/pending_logs.json";

unsigned long lastLogSync = 0;
const unsigned long LOG_SYNC_INTERVAL = 30000;  // 30 seconds

// =====================================================
// PN532 NFC
// =====================================================

HardwareSerial PN532Serial(1);

PN532_HSU pn532hsu(PN532Serial);
PN532 nfc(pn532hsu);

// =====================================================
// R307S Fingerprint
// =====================================================

HardwareSerial FingerSerial(2);

Adafruit_Fingerprint finger =
  Adafruit_Fingerprint(&FingerSerial);

// =====================================================
// RTC
// =====================================================

RTC_DS3231 rtc;

// =====================================================
// LCD
// =====================================================

LiquidCrystal_I2C lcd(0x27, 16, 2);

// =====================================================
// Pin Definitions
// =====================================================

#define PN532_RX 26
#define PN532_TX 27

#define FINGER_RX 16
#define FINGER_TX 17

#define GREEN_LED 25
#define RED_LED   33
#define BUZZER    32
#define RELAY     23
#define BLUE_LED  4

#define I2C_SDA   21
#define I2C_SCL   22

// =====================================================
// Fingerprint timeout
// =====================================================

#define FINGER_TIMEOUT 10000UL

// =====================================================
// NTP
// =====================================================

// India Standard Time = UTC + 5:30
const long GMT_OFFSET_SEC = 19800;
const int DAYLIGHT_OFFSET_SEC = 0;

// =====================================================
// RTC automatic synchronization
// =====================================================

unsigned long lastNTPSync = 0;

// Sync every 6 hours
const unsigned long NTP_SYNC_INTERVAL =
  6UL * 60UL * 60UL * 1000UL;

// =====================================================
// Function declarations
// =====================================================

void authenticateCard(String cardUID);
void authenticateOfflineCard(String cardUID);

int searchFingerprint();

void accessGranted();
void accessDenied();

void waitForCardRemoval();

void ensureWiFi();

void logAccess(
  int userID,
  int doorID,
  String nfcUID,
  int fingerprintID,
  String result,
  String reason
);

String urlEncode(String str);

bool saveEmployeeData(String jsonData);

void readEmployeeData();

void syncEmployees();

void initializeRTC();

bool syncRTCWithNTP();

void checkPeriodicNTPSync();

void updateLCD(String line1, String line2);

String getRTCDateTime();
bool queueOfflineLog(
  int userID,
  int doorID,
  String nfcUID,
  int fingerprintID,
  String result,
  String reason
);
void syncPendingLogs();

// =====================================================
// LCD helper
// =====================================================

void updateLCD(String line1, String line2)
{
  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));

  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}

// =====================================================
// RTC date/time string
// =====================================================

String getRTCDateTime()
{
  DateTime now = rtc.now();

  char buffer[25];

  sprintf(
    buffer,
    "%02d/%02d/%04d %02d:%02d:%02d",
    now.day(),
    now.month(),
    now.year(),
    now.hour(),
    now.minute(),
    now.second()
  );

  return String(buffer);
}

// =====================================================
// RTC initialization
// =====================================================

void initializeRTC()
{
  Serial.println();
  Serial.println("================================");
  Serial.println("RTC INITIALIZATION");
  Serial.println("================================");

  Wire.begin(I2C_SDA, I2C_SCL);

  if (!rtc.begin())
  {
    Serial.println("ERROR: DS3231 not found!");

    updateLCD(
      "RTC ERROR",
      "Check DS3231"
    );

    return;
  }

  Serial.println("DS3231 detected.");

  if (rtc.lostPower())
  {
    Serial.println("WARNING: RTC lost power.");

    updateLCD(
      "RTC WARNING",
      "Time may be wrong"
    );

    delay(2000);
  }

  Serial.print("RTC Time: ");
  Serial.println(getRTCDateTime());
}

// =====================================================
// NTP synchronization
// =====================================================

bool syncRTCWithNTP()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("NTP skipped - Wi-Fi not connected.");
    return false;
  }

  Serial.println();
  Serial.println("================================");
  Serial.println("NTP TIME SYNCHRONIZATION");
  Serial.println("================================");

  updateLCD(
    "Updating Time",
    "Please wait..."
  );

  configTime(
    GMT_OFFSET_SEC,
    DAYLIGHT_OFFSET_SEC,
    "pool.ntp.org",
    "time.nist.gov",
    "time.google.com"
  );

  struct tm timeinfo;

  unsigned long start = millis();

  while (!getLocalTime(&timeinfo))
  {
    if (millis() - start > 10000)
    {
      Serial.println("NTP synchronization FAILED.");

      updateLCD(
        "NTP Failed",
        "Using RTC"
      );

      delay(1500);

      return false;
    }

    delay(500);
  }

  Serial.println("NTP time received.");

  Serial.printf(
    "NTP Time: %02d/%02d/%04d %02d:%02d:%02d\n",
    timeinfo.tm_mday,
    timeinfo.tm_mon + 1,
    timeinfo.tm_year + 1900,
    timeinfo.tm_hour,
    timeinfo.tm_min,
    timeinfo.tm_sec
  );

  DateTime ntpTime(
    timeinfo.tm_year + 1900,
    timeinfo.tm_mon + 1,
    timeinfo.tm_mday,
    timeinfo.tm_hour,
    timeinfo.tm_min,
    timeinfo.tm_sec
  );

  rtc.adjust(ntpTime);

  Serial.println("DS3231 updated from NTP.");

  Serial.print("RTC New Time: ");
  Serial.println(getRTCDateTime());

  lastNTPSync = millis();

  updateLCD(
    "Time Updated",
    "RTC Synced"
  );

  delay(1500);

  return true;
}

// =====================================================
// Periodic NTP synchronization
// =====================================================

void checkPeriodicNTPSync()
{
  if (WiFi.status() != WL_CONNECTED)
    return;

  if (millis() - lastNTPSync >= NTP_SYNC_INTERVAL)
  {
    Serial.println();
    Serial.println("Periodic NTP synchronization...");

    syncRTCWithNTP();
  }
}

// =====================================================
// Setup
// =====================================================

void setup()
{
  Serial.begin(115200);

  delay(1000);

  Serial.println();
  Serial.println("================================");
  Serial.println("ESP32 ACCESS CONTROL SYSTEM");
  Serial.println("================================");

  // ===================================================
  // Outputs
  // ===================================================

  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  pinMode(RELAY, OUTPUT);
  pinMode(BLUE_LED, OUTPUT);

  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER, LOW);
  digitalWrite(RELAY, LOW);
  digitalWrite(BLUE_LED, LOW);

  // ===================================================
  // LCD + I2C
  // ===================================================

  Wire.begin(I2C_SDA, I2C_SCL);

  lcd.init();
  lcd.backlight();

  updateLCD(
    "ACCESS CONTROL",
    "Starting..."
  );

  delay(1500);

  // ===================================================
  // RTC
  // ===================================================

  initializeRTC();

  // ===================================================
  // LittleFS
  // ===================================================

  Serial.println();
  Serial.println("Mounting LittleFS...");

  if (!LittleFS.begin(true))
  {
    Serial.println("LittleFS mount FAILED!");

    updateLCD(
      "LittleFS ERROR",
      "System Halted"
    );

    while (true)
    {
      digitalWrite(RED_LED, HIGH);
      delay(300);
      digitalWrite(RED_LED, LOW);
      delay(300);
    }
  }

  Serial.println("LittleFS mounted successfully.");

  // ===================================================
  // Fingerprint
  // ===================================================

  Serial.println();
  Serial.println("Initializing fingerprint sensor...");

  FingerSerial.begin(
    57600,
    SERIAL_8N1,
    FINGER_RX,
    FINGER_TX
  );

  finger.begin(57600);

  if (finger.verifyPassword())
  {
    Serial.println("R307S fingerprint sensor OK.");
  }
  else
  {
    Serial.println("R307S fingerprint sensor ERROR!");

    updateLCD(
      "Fingerprint",
      "Sensor Error"
    );

    while (true)
    {
      digitalWrite(RED_LED, HIGH);
      delay(300);
      digitalWrite(RED_LED, LOW);
      delay(300);
    }
  }

  // ===================================================
  // PN532
  // ===================================================

  Serial.println();
  Serial.println("Initializing PN532...");

  PN532Serial.begin(
    115200,
    SERIAL_8N1,
    PN532_RX,
    PN532_TX
  );

  nfc.begin();

  uint32_t versiondata =
    nfc.getFirmwareVersion();

  if (!versiondata)
  {
    Serial.println("PN532 not found!");

    updateLCD(
      "NFC ERROR",
      "Check PN532"
    );

    while (true)
    {
      digitalWrite(RED_LED, HIGH);
      delay(300);
      digitalWrite(RED_LED, LOW);
      delay(300);
    }
  }

  Serial.println("PN532 detected.");

  nfc.SAMConfig();

  // ===================================================
  // Wi-Fi
  // ===================================================

  Serial.println();
  Serial.println("Connecting to Wi-Fi...");

  updateLCD(
    "Connecting WiFi",
    "Please wait..."
  );

  WiFi.begin(ssid, password);

  unsigned long wifiStart = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - wifiStart < 15000
  )
  {
    delay(500);

    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println("Wi-Fi connected.");

    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());

    updateLCD(
      "WiFi Connected",
      "Syncing..."
    );

    // =================================================
    // Synchronize employee data
    // =================================================

    syncEmployees();

    // =================================================
    // Update RTC using NTP
    // =================================================

    syncRTCWithNTP();
  }
  else
  {
    Serial.println("Wi-Fi unavailable.");

    Serial.println("Starting in OFFLINE mode.");

    updateLCD(
      "OFFLINE MODE",
      "Using Local Data"
    );

    delay(2000);
  }

  // ===================================================
  // Read local employee data
  // ===================================================

  readEmployeeData();

  // ===================================================
  // Ready
  // ===================================================

  digitalWrite(BLUE_LED, LOW);

  Serial.println();
  Serial.println("================================");
  Serial.println("SYSTEM READY");
  Serial.println("================================");

  Serial.print("RTC Date/Time: ");
  Serial.println(getRTCDateTime());

  updateLCD(
    "ACCESS CONTROL",
    "Place Your Card"
  );
}

// =====================================================
// Main loop
// =====================================================

void loop()
{
  // ===================================================
  // Check periodic NTP update
  // ===================================================

  checkPeriodicNTPSync();

  // ===================================================
  // Check Wi-Fi
  // ===================================================

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("Wi-Fi disconnected.");

    WiFi.reconnect();
  }
  // ===================================================
  // SYNCHRONIZE PENDING OFFLINE LOGS
  // ===================================================

  if (WiFi.status() == WL_CONNECTED)
  {
  if (
    millis() - lastLogSync >=
    LOG_SYNC_INTERVAL
   )
   {
    lastLogSync = millis();

    syncPendingLogs();
   }
  }

  // ===================================================
  // NFC
  // ===================================================

  uint8_t uid[] = {
    0, 0, 0, 0, 0, 0, 0
  };

  uint8_t uidLength;

  boolean success =
    nfc.readPassiveTargetID(
      PN532_MIFARE_ISO14443A,
      uid,
      &uidLength
    );

  if (success)
  {
    String cardUID = "";

    for (uint8_t i = 0; i < uidLength; i++)
    {
      if (i > 0)
        cardUID += ":";

      if (uid[i] < 0x10)
        cardUID += "0";

      cardUID += String(
        uid[i],
        HEX
      );
    }

    cardUID.toUpperCase();

    Serial.println();
    Serial.println("================================");
    Serial.println("NFC CARD DETECTED");
    Serial.println("================================");

    Serial.print("UID: ");
    Serial.println(cardUID);

    Serial.print("RTC Time: ");
    Serial.println(getRTCDateTime());

    updateLCD(
      "Card Detected",
      "Checking..."
    );

    delay(500);

    // =================================================
    // Authentication
    // =================================================

    authenticateCard(cardUID);

    // =================================================
    // Wait until card removed
    // =================================================

    waitForCardRemoval();

    updateLCD(
      "ACCESS CONTROL",
      "Place Your Card"
    );
  }

  delay(100);
}

 // =====================================================
 // QUEUE OFFLINE ACCESS LOG
 // =====================================================

bool queueOfflineLog(
  int userID,
  int doorID,
  String nfcUID,
  int fingerprintID,
  String result,
  String reason
 )
{
  Serial.println();
  Serial.println("=================================");
  Serial.println("QUEUEING OFFLINE ACCESS LOG");
  Serial.println("=================================");

  DynamicJsonDocument doc(16384);

  // ===================================================
  // LOAD EXISTING QUEUE
  // ===================================================

  if (LittleFS.exists(pendingLogFile))
  {
    File file = LittleFS.open(pendingLogFile, "r");

    if (file)
    {
      String jsonData = file.readString();
      file.close();

      if (jsonData.length() > 0)
      {
        DeserializationError error =
          deserializeJson(doc, jsonData);

        if (error)
        {
          Serial.print("Pending log JSON error: ");
          Serial.println(error.c_str());

          doc.clear();
          doc["logs"].to<JsonArray>();
        }
      }
    }
  }
  else
  {
    doc["logs"].to<JsonArray>();
  }

  // ===================================================
  // GET LOG ARRAY
  // ===================================================

  JsonArray logs = doc["logs"].as<JsonArray>();

  if (logs.isNull())
  {
    logs = doc["logs"].to<JsonArray>();
  }

  // ===================================================
  // CREATE NEW LOG
  // ===================================================

  JsonObject log = logs.createNestedObject();

  // IMPORTANT:
  // RTC time is captured NOW, when access happened.
  String accessTime = getRTCDateTime();

  log["user_id"] = userID;
  log["door_id"] = doorID;
  log["nfc_uid"] = nfcUID;
  log["fingerprint_id"] = fingerprintID;

  // Original access timestamp
  log["access_time"] = accessTime;

  log["result"] = result;
  log["reason"] = reason;

  // ===================================================
  // SAVE QUEUE
  // ===================================================

  File file = LittleFS.open(pendingLogFile, "w");

  if (!file)
  {
    Serial.println(
      "ERROR: Could not open pending_logs.json"
    );

    return false;
  }

  if (serializeJson(doc, file) == 0)
  {
    Serial.println(
      "ERROR: Failed to write pending log"
    );

    file.close();
    return false;
  }

  file.close();

  // ===================================================
  // SERIAL INFORMATION
  // ===================================================

  Serial.println("Offline log saved to LittleFS.");

  Serial.print("User ID: ");
  Serial.println(userID);

  Serial.print("Door ID: ");
  Serial.println(doorID);

  Serial.print("NFC UID: ");
  Serial.println(nfcUID);

  Serial.print("Fingerprint ID: ");
  Serial.println(fingerprintID);

  Serial.print("Access Time: ");
  Serial.println(accessTime);

  Serial.print("Result: ");
  Serial.println(result);

  Serial.print("Reason: ");
  Serial.println(reason);

  Serial.print("Pending logs: ");
  Serial.println(logs.size());

  Serial.println("File: /pending_logs.json");

  Serial.println("=================================");

  return true;
}
// =====================================================
  // SYNCHRONIZE PENDING OFFLINE LOGS
  // =====================================================
void syncPendingLogs()
{
  if (!LittleFS.exists(pendingLogFile))
    return;

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("Wi-Fi unavailable - pending logs kept.");
    return;
  }

  File file = LittleFS.open(pendingLogFile, "r");

  if (!file)
  {
    Serial.println("ERROR: Could not open pending_logs.json");
    return;
  }

  String jsonData = file.readString();
  file.close();

  if (jsonData.length() == 0)
  {
    LittleFS.remove(pendingLogFile);
    return;
  }

  DynamicJsonDocument doc(32768);

  DeserializationError error = deserializeJson(doc, jsonData);

  if (error)
  {
    Serial.print("Pending log JSON error: ");
    Serial.println(error.c_str());
    return;
  }

  JsonArray logs = doc["logs"].as<JsonArray>();

  if (logs.isNull() || logs.size() == 0)
  {
    LittleFS.remove(pendingLogFile);
    Serial.println("No pending logs.");
    return;
  }

  Serial.println();
  Serial.println("=================================");
  Serial.println("SYNCING PENDING OFFLINE LOGS");
  Serial.println("=================================");

  Serial.print("Pending logs: ");
  Serial.println(logs.size());

  // Process one log at a time
  for (size_t i = 0; i < logs.size(); )
  {
    JsonObject log = logs[i];

    int userID = log["user_id"] | 0;
    int doorID = log["door_id"] | 0;
    String nfcUID = log["nfc_uid"] | "";
    int fingerprintID = log["fingerprint_id"] | 0;

    String accessTime = log["access_time"] | "";
    String result = log["result"] | "DENIED";
    String reason = log["reason"] | "DEVICE_ERROR";

    Serial.println();
    Serial.println("Uploading pending log:");
    Serial.print("User ID: ");
    Serial.println(userID);

    Serial.print("Access Time: ");
    Serial.println(accessTime);

    String url = String(logURL);

    url += "?user_id=";
    url += String(userID);

    url += "&door_id=";
    url += String(doorID);

    url += "&nfc_uid=";
    url += urlEncode(nfcUID);

    url += "&fingerprint_id=";
    url += String(fingerprintID);

    url += "&access_time=";
    url += urlEncode(accessTime);

    url += "&result=";
    url += urlEncode(result);

    url += "&reason=";
    url += urlEncode(reason);

    Serial.print("URL: ");
    Serial.println(url);

    HTTPClient http;

    http.setTimeout(5000);

    if (!http.begin(url))
    {
      Serial.println("HTTP begin failed.");
      Serial.println("Log kept in queue.");
      break;
    }

    int httpCode = http.GET();

    Serial.print("HTTP Response Code: ");
    Serial.println(httpCode);

    if (httpCode <= 0)
    {
      Serial.println("HTTP request failed.");
      Serial.println("Log kept in queue.");

      http.end();
      break;
    }

    String response = http.getString();

    Serial.print("Server Response: ");
    Serial.println(response);

    StaticJsonDocument<512> responseDoc;

    DeserializationError responseError =
      deserializeJson(responseDoc, response);

    if (responseError)
    {
      Serial.print("Server JSON error: ");
      Serial.println(responseError.c_str());

      http.end();
      break;
    }

    bool success = responseDoc["success"] | false;

    http.end();

    // =============================================
    // SERVER ACCEPTED THE LOG
    // =============================================

    if (success)
    {
      Serial.println("LOG UPLOADED SUCCESSFULLY.");

      // Remove this uploaded log
      logs.remove(i);

      Serial.print("Remaining pending logs: ");
      Serial.println(logs.size());

      // IMPORTANT:
      // Do not increment i because the next log
      // has now moved into this position.
    }
    else
    {
      Serial.println("SERVER REJECTED LOG.");
      Serial.println("Log kept in queue.");

      break;
    }
  }

  // =============================================
  // SAVE REMAINING LOGS
  // =============================================

  if (logs.size() == 0)
  {
    if (LittleFS.remove(pendingLogFile))
    {
      Serial.println();
      Serial.println("=================================");
      Serial.println("ALL OFFLINE LOGS SYNCHRONIZED");
      Serial.println("QUEUE FILE DELETED");
      Serial.println("=================================");
    }
    else
    {
      Serial.println("ERROR: Could not delete pending_logs.json");
    }

    return;
  }

  // Some logs remain
  File saveFile = LittleFS.open(pendingLogFile, "w");

  if (!saveFile)
  {
    Serial.println("ERROR: Could not rewrite pending_logs.json");
    return;
  }

  serializeJson(doc, saveFile);
  saveFile.close();

  Serial.print("Pending logs still stored: ");
  Serial.println(logs.size());
}
// =====================================================
// Authenticate card ONLINE
// =====================================================

void authenticateCard(String cardUID)
{
  // ===================================================
  // If Wi-Fi is not connected
  // use offline authentication
  // ===================================================

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println();
    Serial.println("Wi-Fi unavailable.");
    Serial.println("Using OFFLINE authentication.");

    authenticateOfflineCard(cardUID);

    return;
  }

  // ===================================================
  // Create URL
  // ===================================================

  String url =
    String(serverURL) +
    "?nfc_uid=" +
    urlEncode(cardUID) +
    "&esp32_id=" +
    urlEncode(esp32_id);

  Serial.println();
  Serial.println("Online authentication...");
  Serial.println("Request URL:");
  Serial.println(url);

  HTTPClient http;

  http.setTimeout(3000);

  if (!http.begin(url))
  {
    Serial.println("HTTP begin failed.");

    Serial.println("Falling back to OFFLINE.");

    authenticateOfflineCard(cardUID);

    return;
  }

  int httpCode = http.GET();

  Serial.print("HTTP Response Code: ");
  Serial.println(httpCode);

  // ===================================================
  // Server unreachable
  // ===================================================

  if (httpCode <= 0)
  {
    Serial.println("Server unreachable.");

    http.end();

    Serial.println("Falling back to OFFLINE.");

    authenticateOfflineCard(cardUID);

    return;
  }

  String response =
    http.getString();

  Serial.println();
  Serial.println("Server response:");
  Serial.println(response);

  // ===================================================
  // JSON
  // ===================================================

  DynamicJsonDocument doc(4096);

  DeserializationError error =
    deserializeJson(doc, response);

  if (error)
  {
    Serial.print("JSON error: ");
    Serial.println(error.c_str());

    http.end();

    Serial.println("Falling back to OFFLINE.");

    authenticateOfflineCard(cardUID);

    return;
  }

  bool success =
    doc["success"] | false;

  // ===================================================
  // Server rejected request
  // ===================================================

  if (!success)
  {
    Serial.println("Server rejected card.");

    String message =
      doc["message"] | "Access Denied";

    Serial.println(message);

    updateLCD(
      "Access Denied",
      "Try Again"
    );

    accessDenied();

    http.end();

    return;
  }

  // ===================================================
  // Authorization
  // ===================================================

  bool authorized =
    doc["authorized"] | false;

  if (!authorized)
  {
    Serial.println("Access NOT authorized.");

    updateLCD(
      "Access Denied",
      "No Permission"
    );

    accessDenied();

    http.end();

    return;
  }

  // ===================================================
  // Get server data
  // ===================================================

  int userID =
    doc["user_id"] | 0;

  String employeeID =
    doc["employee_id"] | "";

  String name =
    doc["name"] | "";

  int fingerprintID =
    doc["fingerprint_id"] | 0;

  int doorID =
    doc["door_id"] | 0;

  String doorName =
    doc["door_name"] | "";

  Serial.println();
  Serial.println("================================");
  Serial.println("CARD AUTHORIZED");
  Serial.println("================================");

  Serial.print("Employee ID: ");
  Serial.println(employeeID);

  Serial.print("Name: ");
  Serial.println(name);

  Serial.print("Fingerprint ID: ");
  Serial.println(fingerprintID);

  Serial.print("Door ID: ");
  Serial.println(doorID);

  Serial.print("Door: ");
  Serial.println(doorName);

  // ===================================================
  // Validate fingerprint ID
  // ===================================================

  if (fingerprintID <= 0)
  {
    Serial.println(
      "Invalid fingerprint ID."
    );

    updateLCD(
      "Access Denied",
      "Device Error"
    );

    accessDenied();

    http.end();

    return;
  }


  updateLCD(
    "Card Accepted",
    "Place Finger"
  );

  digitalWrite(BUZZER, HIGH);
  delay(500);
  digitalWrite(BUZZER, LOW);
  digitalWrite(BLUE_LED, HIGH);
  int matchedID = searchFingerprint();

  digitalWrite(BLUE_LED, LOW);

  // ===================================================
  // Fingerprint timeout / failure
  // ===================================================

  if (matchedID == -1)
  {
    Serial.println("Fingerprint authentication failed.");

    updateLCD(
      "Fingerprint",
      "Failed"
    );

    accessDenied();

    logAccess(
      userID,
      doorID,
      cardUID,
      0,
      "DENIED",
      "No Fingerprint"
    );

    http.end();

    return;
  }

  // ===================================================
  // Compare fingerprint IDs
  // ===================================================

  Serial.println();
  Serial.println("================================");
  Serial.println("FINGERPRINT COMPARISON");
  Serial.println("================================");

  Serial.print("Database Fingerprint ID: ");
  Serial.println(fingerprintID);

  Serial.print("R307S Matched ID: ");
  Serial.println(matchedID);

  // ===================================================
  // MATCH
  // ===================================================

  if (matchedID == fingerprintID)
  {
    Serial.println();
    Serial.println("ACCESS GRANTED");

    updateLCD(
      "Access Granted",
      "Door Unlocked"
    );

    accessGranted();

    logAccess(
      userID,
      doorID,
      cardUID,
      matchedID,
      "GRANTED",
      "ACCESS_GRANTED"
    );
  }

  // ===================================================
  // MISMATCH
  // ===================================================

  else
  {
    Serial.println();
    Serial.println("ACCESS DENIED");
    Serial.println("Fingerprint mismatch.");

    updateLCD(
      "Access Denied",
      "Fingerprint"
    );

    accessDenied();

    logAccess(
      userID,
      doorID,
      cardUID,
      matchedID,
      "DENIED",
      "FINGERPRINT_MISMATCH"
    );
  }

  http.end();
}

// =====================================================
// OFFLINE authentication
// =====================================================

void authenticateOfflineCard(String cardUID)
{
  Serial.println();
  Serial.println("================================");
  Serial.println("OFFLINE AUTHENTICATION");
  Serial.println("================================");

  updateLCD(
    "OFFLINE MODE",
    "Using Local Data"
  );

  delay(1000);

  File file =
    LittleFS.open(employeeFile, "r");

  if (!file)
  {
    Serial.println(
      "Employee cache not found."
    );

    updateLCD(
      "Access Denied",
      "No Local Data"
    );

    accessDenied();

    return;
  }

  DynamicJsonDocument doc(8192);

  DeserializationError error =
    deserializeJson(doc, file);

  file.close();

  if (error)
  {
    Serial.println(
      "Employee cache JSON error."
    );

    updateLCD(
      "Access Denied",
      "Cache Error"
    );

    accessDenied();

    return;
  }

  JsonArray employees =
    doc["employees"].as<JsonArray>();

  bool found = false;

  int userID = 0;
  int doorID = 0;
  int fingerprintID = 0;

  String employeeID = "";
  String nfcUID = "";
  String status = "";

  int allowed = 0;

  // ===================================================
  // Search employee
  // ===================================================

  for (JsonObject employee : employees)
  {
    nfcUID =
      employee["nfc_uid"] | "";

    nfcUID.toUpperCase();

    if (nfcUID == cardUID)
    {
      found = true;

      userID =
        employee["user_id"] | 0;

      employeeID =
        employee["employee_id"] | "";


      fingerprintID =
        employee["fingerprint_id"] | 0;

      doorID =
        employee["door_id"] | 0;

      allowed =
        employee["allowed"] | 0;

      status =
        employee["status"] | "";

      status.toUpperCase();

      break;
    }
  }

  // ===================================================
  // Unknown card
  // ===================================================

  if (!found)
  {
    Serial.println("Unknown card.");

    updateLCD(
      "Access Denied",
      "Unknown Card"
    );

    accessDenied();

    return;
  }

  // ===================================================
  // Inactive user
  // ===================================================

  if (status != "ACTIVE")
  {
    Serial.println("Employee inactive.");

    updateLCD(
      "Access Denied",
      "Inactive User"
    );

    accessDenied();
    queueOfflineLog(
    userID,
    doorID,
    cardUID,
    -1,
    "DENIED",
    "Offline employee inactive"
  );

    return;
  }

  // ===================================================
  // Permission
  // ===================================================

  if (allowed != 1)
  {
    Serial.println("No permission.");

    updateLCD(
      "Access Denied",
      "No Permission"
    );

    accessDenied();
    queueOfflineLog(
    userID,
    doorID,
    cardUID,
    -1,
    "DENIED",
    "Offline card not authorized"
  );

    return;
  }

  // ===================================================
  // Fingerprint ID
  // ===================================================

  if (fingerprintID <= 0)
  {
    Serial.println(
      "Invalid fingerprint ID."
    );

    updateLCD(
      "Access Denied",
      "Device Error"
    );

    accessDenied();

    return;
  }

  // ===================================================
  // Valid offline employee
  // ===================================================

  Serial.println();
  Serial.println("Offline employee found.");

  Serial.print("Employee: ");
  Serial.println(employeeID);


  Serial.print("Fingerprint ID: ");
  Serial.println(fingerprintID);

  updateLCD(
    "Card Accepted",
    "Place Finger"
  );
  digitalWrite(BUZZER, HIGH);
  delay(500);
  digitalWrite(BUZZER, LOW);
  digitalWrite(BLUE_LED, HIGH);

  int matchedID =
    searchFingerprint();

  digitalWrite(BLUE_LED, LOW);

  // ===================================================
  // Fingerprint failed
  // ===================================================

  if (matchedID == -1)
  {
    Serial.println(
      "Fingerprint failed."
    );

    updateLCD(
      "Access Denied",
      "Fingerprint"
    );

    accessDenied();
     queueOfflineLog(
    userID,
    doorID,
    cardUID,
    0,
    "DENIED",
    "no fingerprint "
  );

    return;
  }

  // ===================================================
  // Fingerprint match
  // ===================================================

  if (matchedID == fingerprintID)
  {
    Serial.println();
    Serial.println("OFFLINE ACCESS GRANTED");

    updateLCD(
      "Access Granted",
      "Door Unlocked"
    );

    accessGranted();
    queueOfflineLog(
   userID,
   doorID,
   cardUID,
    matchedID,
   "GRANTED",
   "ACCESS_GRANTED"
    );

    // =================================================
    // IMPORTANT:
    // Offline log queue will be added in next stage.
    // =================================================
  }

  // ===================================================
  // Fingerprint mismatch
  // ===================================================

  else
  {
    Serial.println();
    Serial.println(
      "OFFLINE ACCESS DENIED"
    );

    Serial.println(
      "Fingerprint mismatch."
    );

    updateLCD(
      "Access Denied",
      "Fingerprint"
    );

    accessDenied();
    queueOfflineLog(
    userID,
   doorID,
   cardUID,
   matchedID,
  "DENIED",
   "FINGERPRINT_MISMATCH"
   );
  }
}


// =====================================================
// Fingerprint search with 10-second timeout
// =====================================================

int searchFingerprint()
{
  Serial.println();
  Serial.println("Waiting for fingerprint...");
  Serial.println(
    "Place your finger within 10 seconds."
  );

  unsigned long startTime =
    millis();

  bool fingerCaptured = false;

  // ===================================================
  // Wait for finger
  // ===================================================

  while (
    millis() - startTime <
    FINGER_TIMEOUT
  )
  {
    uint8_t p =
      finger.getImage();

    if (p == FINGERPRINT_OK)
    {
      fingerCaptured = true;
      break;
    }

    if (p == FINGERPRINT_NOFINGER)
    {
      delay(100);
      continue;
    }

    Serial.println(
      "Fingerprint sensor error."
    );

    return -1;
  }

  // ===================================================
  // Timeout
  // ===================================================

  if (!fingerCaptured)
  {
    Serial.println();
    Serial.println(
      "Fingerprint timeout!"
    );

    Serial.println(
      "No finger placed within 10 seconds."
    );

    updateLCD(
      "Fingerprint",
      "Timeout!"
    );

    delay(1500);

    return -1;
  }

  // ===================================================
  // Convert image
  // ===================================================

  Serial.println(
    "Fingerprint image captured."
  );

  uint8_t p =
    finger.image2Tz();

  if (p != FINGERPRINT_OK)
  {
    Serial.println(
      "Could not convert fingerprint."
    );

    return -1;
  }

  Serial.println(
    "Fingerprint converted."
  );

  // ===================================================
  // Search
  // ===================================================

  p =
    finger.fingerSearch();

  if (p == FINGERPRINT_OK)
  {
    Serial.println(
      "Fingerprint recognized!"
    );

    Serial.print("Matched ID: ");
    Serial.println(
      finger.fingerID
    );

    Serial.print("Confidence: ");
    Serial.println(
      finger.confidence
    );

    return finger.fingerID;
  }

  if (p == FINGERPRINT_NOTFOUND)
  {
    Serial.println(
      "Fingerprint NOT recognized."
    );

    return -1;
  }

  Serial.println(
    "Fingerprint search error."
  );

  return -1;
}

// =====================================================
// Access Granted
// =====================================================

void accessGranted()
{
  digitalWrite(RED_LED, LOW);
  digitalWrite(BLUE_LED, LOW);

  digitalWrite(GREEN_LED, HIGH);

  digitalWrite(BUZZER, HIGH);

  digitalWrite(RELAY, HIGH);

  delay(1000);

  digitalWrite(BUZZER, LOW);

  // Door unlocked for 5 seconds

  delay(5000);

  digitalWrite(RELAY, LOW);

  digitalWrite(GREEN_LED, LOW);
}

// =====================================================
// Access Denied
// =====================================================

void accessDenied()
{
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RELAY, LOW);

  digitalWrite(RED_LED, HIGH);

  digitalWrite(BUZZER, HIGH);

  delay(500);

  digitalWrite(BUZZER, LOW);
  delay(500);
  digitalWrite(BUZZER, HIGH);

  delay(500);

  digitalWrite(BUZZER, LOW);

  delay(1500);

  digitalWrite(RED_LED, LOW);
}

// =====================================================
// Wait for card removal
// =====================================================

void waitForCardRemoval()
{
  Serial.println();
  Serial.println(
    "Waiting for card removal..."
  );

  delay(1000);

  // Simple debounce/removal delay.
  // Prevents immediate repeated processing
  // of the same card.

  delay(500);
}

// =====================================================
// Wi-Fi
// =====================================================

void ensureWiFi()
{
  if (WiFi.status() == WL_CONNECTED)
    return;

  Serial.println(
    "Wi-Fi disconnected. Reconnecting..."
  );

  WiFi.reconnect();

  unsigned long start =
    millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - start < 5000
  )
  {
    delay(250);
  }

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println(
      "Wi-Fi reconnected."
    );

    Serial.print("ESP32 IP: ");
    Serial.println(
      WiFi.localIP()
    );
  }
}

// =====================================================
// LOG ACCESS
// =====================================================

void logAccess(
  int userID,
  int doorID,
  String nfcUID,
  int fingerprintID,
  String result,
  String reason
)
{
  // ===================================================
  // IF WIFI IS NOT AVAILABLE
  // SAVE TO OFFLINE QUEUE
  // ===================================================

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println();
    Serial.println(
      "Wi-Fi unavailable."
    );

    Serial.println(
      "Saving access log to offline queue."
    );

    queueOfflineLog(
      userID,
      doorID,
      nfcUID,
      fingerprintID,
      result,
      reason
    );

    return;
  }

  // ===================================================
  // CREATE CURRENT ACCESS TIME
  // ===================================================

  String accessTime =
    getRTCDateTime();

  // ===================================================
  // CREATE URL
  // ===================================================

  String url =
    String(logURL) +
    "?user_id=" +
    String(userID) +
    "&door_id=" +
    String(doorID) +
    "&nfc_uid=" +
    urlEncode(nfcUID) +
    "&fingerprint_id=" +
    String(fingerprintID) +
    "&access_time=" +
    urlEncode(accessTime) +
    "&result=" +
    urlEncode(result) +
    "&reason=" +
    urlEncode(reason);

  Serial.println();
  Serial.println("Logging access...");
  Serial.print("Access Time: ");
  Serial.println(accessTime);

  Serial.println(url);

  HTTPClient http;

  http.setTimeout(3000);

  // ===================================================
  // HTTP BEGIN FAILURE
  // ===================================================

  if (!http.begin(url))
  {
    Serial.println(
      "Log HTTP begin failed."
    );

    Serial.println(
      "Saving log to offline queue."
    );

    queueOfflineLog(
      userID,
      doorID,
      nfcUID,
      fingerprintID,
      result,
      reason
    );

    return;
  }

  // ===================================================
  // SEND
  // ===================================================

  int code =
    http.GET();

  Serial.print(
    "Log HTTP Response: "
  );

  Serial.println(code);

  // ===================================================
  // HTTP FAILED
  // ===================================================

  if (code <= 0)
  {
    Serial.println(
      "Access log failed."
    );

    Serial.println(
      "Saving log to offline queue."
    );

    http.end();

    queueOfflineLog(
      userID,
      doorID,
      nfcUID,
      fingerprintID,
      result,
      reason
    );

    return;
  }

  // ===================================================
  // SERVER RESPONSE
  // ===================================================

  String response =
    http.getString();

  Serial.println(
    "Log response:"
  );

  Serial.println(response);

  StaticJsonDocument<300> responseDoc;

  DeserializationError error =
    deserializeJson(
      responseDoc,
      response
    );

  // ===================================================
  // INVALID RESPONSE
  // ===================================================

  if (error)
  {
    Serial.println(
      "Invalid server response."
    );

    http.end();

    queueOfflineLog(
      userID,
      doorID,
      nfcUID,
      fingerprintID,
      result,
      reason
    );

    return;
  }

  bool success =
    responseDoc["success"] | false;

  http.end();

  // ===================================================
  // SERVER REJECTED LOG
  // ===================================================

  if (!success)
  {
    Serial.println(
      "Server did not accept access log."
    );

    Serial.println(
      "Saving log to offline queue."
    );

    queueOfflineLog(
      userID,
      doorID,
      nfcUID,
      fingerprintID,
      result,
      reason
    );

    return;
  }

  // ===================================================
  // SUCCESS
  // ===================================================

  Serial.println(
    "ACCESS LOG SAVED TO SERVER"
  );
}

// =====================================================
// URL Encode
// =====================================================

String urlEncode(String str)
{
  String encoded = "";

  char c;

  char code0;
  char code1;

  for (int i = 0; i < str.length(); i++)
  {
    c = str.charAt(i);

    if (
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c == '-' ||
      c == '_' ||
      c == '.' ||
      c == '~'
    )
    {
      encoded += c;
    }
    else
    {
      code1 =
        (c & 0xF) + '0';

      if (
        (c & 0xF) > 9
      )
      {
        code1 =
          (c & 0xF) - 10 + 'A';
      }

      c =
        (c >> 4) & 0xF;

      code0 =
        c + '0';

      if (c > 9)
      {
        code0 =
          c - 10 + 'A';
      }

      encoded += '%';
      encoded += code0;
      encoded += code1;
    }
  }

  return encoded;
}

// =====================================================
// Save employee data
// =====================================================

bool saveEmployeeData(String jsonData)
{
  File file =
    LittleFS.open(
      employeeFile,
      "w"
    );

  if (!file)
  {
    Serial.println(
      "Could not open employee file."
    );

    return false;
  }

  file.print(jsonData);

  file.close();

  Serial.println(
    "Employee data saved to LittleFS."
  );

  return true;
}

// =====================================================
// Read employee data
// =====================================================

void readEmployeeData()
{
  Serial.println();
  Serial.println(
    "================================"
  );

  Serial.println(
    "READING EMPLOYEE CACHE"
  );

  Serial.println(
    "================================"
  );

  File file =
    LittleFS.open(
      employeeFile,
      "r"
    );

  if (!file)
  {
    Serial.println(
      "Employee cache does not exist."
    );

    return;
  }

  String data =
    file.readString();

  file.close();

  Serial.println(
    "Employee cache:"
  );

  Serial.println(data);

  DynamicJsonDocument doc(8192);

  DeserializationError error =
    deserializeJson(doc, data);

  if (error)
  {
    Serial.print(
      "JSON error: "
    );

    Serial.println(
      error.c_str()
    );

    return;
  }

  int count =
    doc["employee_count"] | 0;

  Serial.print(
    "Employee count: "
  );

  Serial.println(count);
}


void syncEmployees()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("Cannot sync - Wi-Fi unavailable.");
    return;
  }

  Serial.println();
  Serial.println("================================");
  Serial.println("EMPLOYEE DATA SYNC");
  Serial.println("================================");

  HTTPClient http;

  http.setTimeout(5000);

  if (!http.begin(syncURL))
  {
    Serial.println("Sync HTTP begin failed.");
    return;
  }

  int httpCode = http.GET();

  Serial.print("Sync HTTP Code: ");
  Serial.println(httpCode);

  if (httpCode != HTTP_CODE_OK)
  {
    Serial.println("Employee sync failed.");

    http.end();
    return;
  }

  String response = http.getString();

  Serial.println();
  Serial.println("Server sync response:");
  Serial.println(response);

  // ===================================================
  // Clean response
  // ===================================================

  response.trim();

  if (response.length() == 0)
  {
    Serial.println("ERROR: Empty sync response.");
    http.end();
    return;
  }
    DynamicJsonDocument doc(16384);

    DeserializationError error =
    deserializeJson(doc, response);

   if (error)
   {
    Serial.println();
    Serial.println("================================");
    Serial.println("SYNC JSON ERROR");
    Serial.println("================================");

    Serial.print("ArduinoJson error: ");
     Serial.println(error.c_str());

    Serial.print("Response length: ");
    Serial.println(response.length());

    Serial.println("Raw response:");
    Serial.println(response);

    http.end();
    return;
}

  // ===================================================
  // Check success
  // ===================================================

  bool success =
    doc["success"] | false;

  if (!success)
  {
    Serial.println("Server sync unsuccessful.");

    String message =
      doc["message"] | "Unknown server error";

    Serial.print("Server message: ");
    Serial.println(message);

    http.end();
    return;
  }

   // ===================================================
   // Check employees array
    // ===================================================

   JsonArray employees =
    doc["employees"].as<JsonArray>();

  if (employees.isNull())
  {
    Serial.println("ERROR: Employees array missing.");

    http.end();
    return;
  }

  // ===================================================
  // Validate employee records
  // ===================================================

  int employeeCount = employees.size();

  Serial.print("Employees received: ");
  Serial.println(employeeCount);

  for (JsonObject employee : employees)
  {
    if (!employee.containsKey("user_id") ||
        !employee.containsKey("nfc_uid") ||
        !employee.containsKey("fingerprint_id") ||
        !employee.containsKey("door_id") ||
        !employee.containsKey("allowed") ||
        !employee.containsKey("status"))
    {
      Serial.println(
        "ERROR: Employee record has missing fields."
      );

      http.end();
      return;
    }
  }

  // ===================================================
  // Save new employee cache
  // ===================================================

  if (saveEmployeeData(response))
  {
    Serial.println();
    Serial.println("================================");
    Serial.println("SYNC -> FLASH SUCCESS");
    Serial.println("================================");

    Serial.print("Employee records saved: ");
    Serial.println(employeeCount);
  }
  else
  {
    Serial.println();
    Serial.println("ERROR: Could not save employee cache.");
  }

  http.end();
}


