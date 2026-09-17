#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <LittleFS.h>

#include <PN532_HSU.h>
#include <PN532.h>
#include <Adafruit_Fingerprint.h>

// =====================================================
// Wi-Fi
// =====================================================

const char* ssid = "Excitel_y";
const char* password = "098765432";

const char* esp32_id = "ESP32_01";

// =====================================================
// SERVER URLs
// =====================================================

const char* serverURL =
  "http://192.168.1.7/access_control/authenticate.php";

const char* syncURL =
  "http://192.168.1.7/access_control/sync.php?esp32_id=ESP32_01";

const char* logURL =
  "http://192.168.1.7/access_control/log_access.php";

// =====================================================
// LITTLEFS
// =====================================================
const char* employeeFile = "/employees.json";
const char* pendingLogFile = "/pending_logs.json";

unsigned long lastLogSync = 0;
const unsigned long LOG_SYNC_INTERVAL = 30000;  // 30 seconds
// =====================================================
// PN532 UART
// =====================================================

HardwareSerial PN532Serial(1);

PN532_HSU pn532hsu(PN532Serial);
PN532 nfc(pn532hsu);

// =====================================================
// R307S Fingerprint UART
// =====================================================

HardwareSerial FingerSerial(2);

Adafruit_Fingerprint finger = Adafruit_Fingerprint(&FingerSerial);

// =====================================================
// ESP32 PINS
// =====================================================

// PN532
#define PN532_RX 26
#define PN532_TX 27

// R307S
#define FINGER_RX 16
#define FINGER_TX 17

// Outputs
#define GREEN_LED 25
#define RED_LED   33
#define BUZZER    32
#define RELAY     23
#define BLUE_LED  4

// =====================================================
// FUNCTION DECLARATIONS
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

// =====================================================
// LITTLEFS FUNCTIONS
// =====================================================

bool saveEmployeeData(String jsonData);
void readEmployeeData();
void syncEmployees();

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
// SETUP
// =====================================================

void setup()
{
  Serial.begin(115200);

  delay(1000);

  // ===================================================
  // OUTPUT PINS
  // ===================================================

  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  pinMode(RELAY, OUTPUT);
  pinMode(BLUE_LED, OUTPUT);

  digitalWrite(BLUE_LED, LOW);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER, LOW);
  digitalWrite(RELAY, LOW);

  // ===================================================
  // LITTLEFS
  // ===================================================

  Serial.println();
  Serial.println("=================================");
  Serial.println("MOUNTING LITTLEFS");
  Serial.println("=================================");

  if (!LittleFS.begin(true))
  {
    Serial.println("ERROR: LittleFS mount failed!");
  }
  else
  {
    Serial.println("LittleFS mounted successfully.");

    size_t total = LittleFS.totalBytes();
    size_t used = LittleFS.usedBytes();

    Serial.println();
    Serial.println("Flash filesystem:");

    Serial.print("Total: ");
    Serial.print(total / 1024);
    Serial.println(" KB");

    Serial.print("Used: ");
    Serial.print(used / 1024);
    Serial.println(" KB");

    Serial.print("Free: ");
    Serial.print((total - used) / 1024);
    Serial.println(" KB");
  }

  // ===================================================
  // R307S
  // ===================================================

  FingerSerial.begin(
    57600,
    SERIAL_8N1,
    FINGER_RX,
    FINGER_TX
  );

  finger.begin(57600);

  Serial.println();
  Serial.println("=================================");
  Serial.println("ACCESS CONTROL SYSTEM");
  Serial.println("=================================");

  if (finger.verifyPassword())
  {
    Serial.println("R307S fingerprint sensor OK");
  }
  else
  {
    Serial.println("R307S fingerprint sensor NOT FOUND");
  }

  // ===================================================
  // PN532
  // ===================================================

  PN532Serial.begin(
    115200,
    SERIAL_8N1,
    PN532_RX,
    PN532_TX
  );

  nfc.begin();

  uint32_t versiondata = nfc.getFirmwareVersion();

  if (!versiondata)
  {
    Serial.println("PN532 NOT FOUND");

    while (1)
    {
      delay(1000);
    }
  }

  Serial.println("PN532 NFC reader OK");

  nfc.SAMConfig();

  // ===================================================
  // WI-FI
  // ===================================================

  Serial.println();
  Serial.println("Connecting to Wi-Fi...");

  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("Wi-Fi connected!");

  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());

  // ===================================================
  // STAGE 1
  // DOWNLOAD EMPLOYEE DATA
  // ===================================================

  syncEmployees();

  // ===================================================
  // READ EMPLOYEE CACHE
  // ===================================================

  readEmployeeData();

  // ===================================================
  // SYSTEM READY
  // ===================================================

  Serial.println();
  Serial.println("=================================");
  Serial.println("System Ready");
  Serial.println("Employee cache ready");
  Serial.println("Place NFC card...");
  Serial.println("=================================");
}

// =====================================================
// LOOP
// =====================================================

void loop()
{
  // ===================================================
  // PERIODIC OFFLINE LOG SYNCHRONIZATION
  // ===================================================

  if (
    WiFi.status() == WL_CONNECTED &&
    millis() - lastLogSync >= LOG_SYNC_INTERVAL
  )
  {
    lastLogSync = millis();

    syncPendingLogs();
  }

  uint8_t uid[7];
  uint8_t uidLength;

  bool success = nfc.readPassiveTargetID(
    PN532_MIFARE_ISO14443A,
    uid,
    &uidLength
  );

  if (!success)
  {
    delay(100);
    return;
  }

  // ===================================================
  // CONVERT UID
  // ===================================================

  String cardUID = "";

  for (uint8_t i = 0; i < uidLength; i++)
  {
    if (i > 0)
    {
      cardUID += ":";
    }

    if (uid[i] < 0x10)
    {
      cardUID += "0";
    }

    cardUID += String(uid[i], HEX);
  }

  cardUID.toUpperCase();

  // ===================================================
  // NFC DETECTED
  // ===================================================

  Serial.println();
  Serial.println("---------------------------------");
  Serial.println("NFC CARD DETECTED");

  Serial.print("UID: ");
  Serial.println(cardUID);

  // ===================================================
  // CURRENT ONLINE AUTHENTICATION
  // ===================================================

  authenticateCard(cardUID);

  // ===================================================
  // WAIT FOR CARD REMOVAL
  // ===================================================

  waitForCardRemoval();
}

// =====================================================
// STAGE 1
// SAVE EMPLOYEE DATA TO LITTLEFS
// =====================================================

bool saveEmployeeData(String jsonData)
{
  File file = LittleFS.open(employeeFile, "w");

  if (!file)
  {
    Serial.println("ERROR: Could not open employees.json");

    return false;
  }

  file.print(jsonData);

  file.close();

  Serial.println("Employee data saved to flash.");

  return true;
}

// =====================================================
// READ EMPLOYEE DATA FROM LITTLEFS
// =====================================================

void readEmployeeData()
{
  Serial.println();
  Serial.println("================================");
  Serial.println("READING EMPLOYEE CACHE");
  Serial.println("================================");

  if (!LittleFS.exists(employeeFile))
  {
    Serial.println("employees.json does not exist.");

    return;
  }

  File file = LittleFS.open(employeeFile, "r");

  if (!file)
  {
    Serial.println("ERROR: Could not open employees.json");

    return;
  }

  String jsonData = file.readString();

  file.close();

  Serial.println();
  Serial.println("Data stored in flash:");
  Serial.println(jsonData);

  // ===================================================
  // PARSE JSON
  // ===================================================

  DynamicJsonDocument doc(8192);

  DeserializationError error =
    deserializeJson(doc, jsonData);

  if (error)
  {
    Serial.print("JSON Parse Error: ");
    Serial.println(error.c_str());

    return;
  }

  int employeeCount =
    doc["employee_count"] | 0;

  Serial.println();
  Serial.print("Employees stored: ");
  Serial.println(employeeCount);

  JsonArray employees =
    doc["employees"].as<JsonArray>();

  for (JsonObject employee : employees)
  {
    Serial.println();
    Serial.println("--------------------------------");

    Serial.print("Employee ID: ");
    Serial.println(
      employee["employee_id"].as<const char*>()
    );

    Serial.print("Name: ");
    Serial.println(
      employee["name"].as<const char*>()
    );

    Serial.print("NFC UID: ");
    Serial.println(
      employee["nfc_uid"].as<const char*>()
    );

    Serial.print("Fingerprint ID: ");
    Serial.println(
      employee["fingerprint_id"].as<int>()
    );

    Serial.print("Door ID: ");
    Serial.println(
      employee["door_id"].as<int>()
    );

    Serial.print("Allowed: ");
    Serial.println(
      employee["allowed"].as<int>()
    );

    Serial.print("Status: ");
    Serial.println(
      employee["status"].as<const char*>()
    );
  }
}

// =====================================================
// DOWNLOAD EMPLOYEE DATA FROM SERVER
// =====================================================

void syncEmployees()
{
  Serial.println();
  Serial.println("================================");
  Serial.println("DOWNLOADING EMPLOYEE DATA");
  Serial.println("================================");

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("Wi-Fi not connected.");
    Serial.println("Employee synchronization skipped.");

    return;
  }

  HTTPClient http;

  http.begin(syncURL);

  int httpCode = http.GET();

  Serial.print("HTTP Response Code: ");
  Serial.println(httpCode);

  if (httpCode != 200)
  {
    Serial.println(
      "ERROR: Employee synchronization failed."
    );

    http.end();

    return;
  }

  String payload = http.getString();

  http.end();

  Serial.println();
  Serial.println("Server response:");
  Serial.println(payload);

  // ===================================================
  // CHECK JSON
  // ===================================================

  DynamicJsonDocument doc(8192);

  DeserializationError error =
    deserializeJson(doc, payload);

  if (error)
  {
    Serial.print("JSON Parse Error: ");
    Serial.println(error.c_str());

    return;
  }

  bool success =
    doc["success"] | false;

  if (!success)
  {
    Serial.println(
      "Server reported SYNC FAILED."
    );

    return;
  }

  int employeeCount =
    doc["employee_count"] | 0;

  Serial.print("Employees received: ");
  Serial.println(employeeCount);

  // ===================================================
  // SAVE TO LITTLEFS
  // ===================================================

  if (saveEmployeeData(payload))
  {
    Serial.println("SYNC → FLASH SUCCESS");
  }
  else
  {
    Serial.println("SYNC → FLASH FAILED");
  }
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
  // LOAD EXISTING LOG FILE
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

          // Start a new queue
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
  // ADD NEW LOG
  // ===================================================

  JsonObject log = logs.createNestedObject();

  log["user_id"] = userID;
  log["door_id"] = doorID;
  log["nfc_uid"] = nfcUID;
  log["fingerprint_id"] = fingerprintID;
  log["result"] = result;
  log["reason"] = reason;

  // ===================================================
  // SAVE FILE
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
  // DISPLAY STATUS
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

  Serial.print("Result: ");
  Serial.println(result);

  Serial.print("Reason: ");
  Serial.println(reason);

  Serial.print("Pending logs: ");
  Serial.println(logs.size());

  Serial.println(
    "File: /pending_logs.json"
  );

  Serial.println("=================================");

  return true;
}
// =====================================================
// SYNCHRONIZE PENDING OFFLINE LOGS
// =====================================================

void syncPendingLogs()
{
  // ===================================================
  // CHECK FILE
  // ===================================================

  if (!LittleFS.exists(pendingLogFile))
  {
    return;
  }

  File file = LittleFS.open(
    pendingLogFile,
    "r"
  );

  if (!file)
  {
    Serial.println(
      "ERROR: Could not open pending_logs.json"
    );

    return;
  }

  String jsonData = file.readString();

  file.close();

  if (jsonData.length() == 0)
  {
    return;
  }

  // ===================================================
  // PARSE JSON
  // ===================================================

  DynamicJsonDocument doc(16384);

  DeserializationError error =
    deserializeJson(doc, jsonData);

  if (error)
  {
    Serial.print(
      "Pending log JSON parse error: "
    );

    Serial.println(error.c_str());

    return;
  }

  JsonArray logs =
    doc["logs"].as<JsonArray>();

  if (logs.isNull() || logs.size() == 0)
  {
    LittleFS.remove(pendingLogFile);

    Serial.println(
      "No pending logs."
    );

    return;
  }

  Serial.println();
  Serial.println("=================================");
  Serial.println("SYNCING OFFLINE ACCESS LOGS");
  Serial.println("=================================");

  Serial.print("Pending logs: ");
  Serial.println(logs.size());

  // ===================================================
  // CHECK WIFI
  // ===================================================

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println(
      "Wi-Fi not connected."
    );

    Serial.println(
      "Pending logs kept in flash."
    );

    return;
  }

  // ===================================================
  // PROCESS LOGS ONE BY ONE
  // ===================================================

  bool allUploaded = true;

  for (size_t i = 0; i < logs.size(); )
  {
    JsonObject log = logs[i];

    int userID =
      log["user_id"] | -1;

    int doorID =
      log["door_id"] | -1;

    String nfcUID =
      log["nfc_uid"] | "";

    int fingerprintID =
      log["fingerprint_id"] | -1;

    String result =
      log["result"] | "DENIED";

    String reason =
      log["reason"] | "Offline access";

    Serial.println();
    Serial.println("---------------------------------");
    Serial.print("Uploading log ");
    Serial.print(i + 1);
    Serial.print(" of ");
    Serial.println(logs.size());

    // =================================================
    // CREATE URL
    // =================================================

    String url = logURL;

    url += "?user_id=";
    url += String(userID);

    url += "&door_id=";
    url += String(doorID);

    url += "&nfc_uid=";
    url += urlEncode(nfcUID);

    url += "&fingerprint_id=";
    url += String(fingerprintID);

    url += "&result=";
    url += urlEncode(result);

    url += "&reason=";
    url += urlEncode(reason);

    Serial.print("Upload URL: ");
    Serial.println(url);

    // =================================================
    // HTTP
    // =================================================

    HTTPClient http;

    http.setTimeout(3000);

    if (!http.begin(url))
    {
      Serial.println(
        "HTTP begin failed."
      );

      allUploaded = false;

      break;
    }

    int httpCode = http.GET();

    Serial.print(
      "HTTP Response Code: "
    );

    Serial.println(httpCode);

    if (httpCode <= 0)
    {
      Serial.print(
        "HTTP ERROR: "
      );

      Serial.println(
        http.errorToString(httpCode)
      );

      http.end();

      allUploaded = false;

      break;
    }

    String response =
      http.getString();

    Serial.println(
      "Server response:"
    );

    Serial.println(response);

    StaticJsonDocument<300> responseDoc;

    DeserializationError responseError =
      deserializeJson(
        responseDoc,
        response
      );

    if (responseError)
    {
      Serial.println(
        "Invalid server JSON."
      );

      http.end();

      allUploaded = false;

      break;
    }

    bool success =
      responseDoc["success"] | false;

    http.end();

    // =================================================
    // UPLOAD SUCCESS
    // =================================================

    if (success)
    {
      Serial.println(
        "OFFLINE LOG UPLOADED SUCCESSFULLY"
      );

      // Remove uploaded log
      logs.remove(i);

      // Do NOT increment i.
      // The next log has now moved into this position.
    }

    // =================================================
    // UPLOAD FAILED
    // =================================================

    else
    {
      Serial.println(
        "OFFLINE LOG UPLOAD FAILED"
      );

      Serial.println(
        "Remaining logs will be kept."
      );

      allUploaded = false;

      break;
    }
  }

  // ===================================================
  // SAVE REMAINING LOGS
  // ===================================================

  if (logs.size() == 0)
  {
    LittleFS.remove(pendingLogFile);

    Serial.println();
    Serial.println(
      "ALL OFFLINE LOGS SYNCHRONIZED"
    );

    Serial.println(
      "pending_logs.json removed."
    );
  }
  else
  {
    File file = LittleFS.open(
      pendingLogFile,
      "w"
    );

    if (file)
    {
      serializeJson(doc, file);

      file.close();

      Serial.println();
      Serial.print(
        "Remaining pending logs: "
      );

      Serial.println(logs.size());
    }
    else
    {
      Serial.println(
        "ERROR: Could not update pending_logs.json"
      );
    }
  }

  Serial.println("=================================");
}
 // =====================================================
// AUTHENTICATE CARD
// ONLINE FIRST, OFFLINE FALLBACK
// =====================================================

void authenticateCard(String cardUID)
{
  Serial.println();
  Serial.println("================================");
  Serial.println("AUTHENTICATION STARTED");
  Serial.println("================================");

  Serial.print("NFC UID: ");
  Serial.println(cardUID);

  // ===================================================
  // CHECK WIFI
  // ===================================================

  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println();
    Serial.println("Wi-Fi is NOT connected.");
    Serial.println("Switching to OFFLINE authentication...");

    authenticateOfflineCard(cardUID);

    return;
  }

  // ===================================================
  // TRY ONLINE AUTHENTICATION
  // ===================================================

  Serial.println();
  Serial.println("Wi-Fi connected.");
  Serial.println("Trying ONLINE authentication...");

  Serial.print("ESP32 ID: ");
  Serial.println(esp32_id);

  String url = serverURL;

  url += "?nfc_uid=";
  url += urlEncode(cardUID);

  url += "&esp32_id=";
  url += urlEncode(esp32_id);

  Serial.println();
  Serial.print("Request URL: ");
  Serial.println(url);

  HTTPClient http;

  http.setTimeout(3000);

  if (!http.begin(url))
  {
    Serial.println("HTTP begin failed.");
    Serial.println("Switching to OFFLINE authentication...");

    http.end();

    authenticateOfflineCard(cardUID);

    return;
  }

  int httpCode = http.GET();

  Serial.print("HTTP Response Code: ");
  Serial.println(httpCode);

  // ===================================================
  // SERVER NOT REACHABLE
  // ===================================================

  if (httpCode <= 0)
  {
    Serial.print("HTTP ERROR: ");
    Serial.println(http.errorToString(httpCode));

    Serial.println();
    Serial.println("Server is not reachable.");
    Serial.println("Switching to OFFLINE authentication...");

    http.end();

    authenticateOfflineCard(cardUID);

    return;
  }

  // ===================================================
  // SERVER RESPONSE RECEIVED
  // ===================================================

  String response = http.getString();

  Serial.println();
  Serial.println("========== SERVER RESPONSE ==========");
  Serial.println(response);
  Serial.println("=====================================");

  StaticJsonDocument<600> doc;

  DeserializationError error =
    deserializeJson(doc, response);

  if (error)
  {
    Serial.print("JSON parsing failed: ");
    Serial.println(error.c_str());

    Serial.println("Switching to OFFLINE authentication...");

    http.end();

    authenticateOfflineCard(cardUID);

    return;
  }

  bool success =
    doc["success"] | false;

  bool authorized =
    doc["authorized"] | false;

  Serial.println();
  Serial.println("========== SERVER RESULT ==========");

  Serial.print("Success: ");
  Serial.println(
    success ? "YES" : "NO"
  );

  Serial.print("Authorized: ");
  Serial.println(
    authorized ? "YES" : "NO"
  );

  // ===================================================
  // SERVER REPLIED - SERVER DECISION IS FINAL
  // ===================================================

  if (!success)
  {
    const char* message =
      doc["message"] | "Server error";

    Serial.print("Message: ");
    Serial.println(message);

    accessDenied();

    http.end();

    return;
  }

  // ===================================================
  // CARD NOT AUTHORIZED
  // ===================================================

  if (!authorized)
  {
    const char* message =
      doc["message"] | "Access denied";

    Serial.print("Message: ");
    Serial.println(message);

    Serial.println("NFC: CARD NOT AUTHORIZED");

    accessDenied();

    http.end();

    return;
  }

  // ===================================================
  // AUTHORIZED
  // ===================================================

  int userID =
    doc["user_id"] | -1;

  const char* employeeID =
    doc["employee_id"] | "";

  const char* employeeName =
    doc["name"] | "";

  int fingerprintID =
    doc["fingerprint_id"] | -1;

  int doorID =
    doc["door_id"] | -1;

  const char* doorName =
    doc["door_name"] | "";

  Serial.println();
  Serial.println(
    "========== ACCESS INFORMATION =========="
  );

  Serial.print("User ID: ");
  Serial.println(userID);

  Serial.print("Employee ID: ");
  Serial.println(employeeID);

  Serial.print("Name: ");
  Serial.println(employeeName);

  Serial.print("Fingerprint ID: ");
  Serial.println(fingerprintID);

  Serial.print("Door ID: ");
  Serial.println(doorID);

  Serial.print("Door Name: ");
  Serial.println(doorName);

  Serial.println("Permission: ALLOWED");

  Serial.println("Authentication Mode: ONLINE");

  Serial.println("========================================");

  // ===================================================
  // VALIDATE FINGERPRINT ID
  // ===================================================

  if (fingerprintID <= 0)
  {
    Serial.println(
      "Invalid fingerprint ID from server"
    );

    accessDenied();

    http.end();

    return;
  }

  // ===================================================
  // FINGERPRINT VERIFICATION
  // ===================================================

  Serial.println();
  Serial.println("=================================");
  Serial.println("NFC AUTHENTICATED");
  Serial.println("Fingerprint verification required");
  Serial.println("=================================");

  Serial.println();
  Serial.println("Place your finger on R307S...");

  digitalWrite(BLUE_LED, HIGH);

  digitalWrite(BUZZER, HIGH);
  delay(150);
  digitalWrite(BUZZER, LOW);

  int matchedID = searchFingerprint();

  digitalWrite(BLUE_LED, LOW);

  // ===================================================
  // FINGERPRINT NOT RECOGNIZED
  // ===================================================

  if (matchedID == -1)
  {
    Serial.println();
    Serial.println(
      "Fingerprint verification FAILED"
    );

    accessDenied();

    logAccess(
      userID,
      doorID,
      cardUID,
      -1,
      "DENIED",
      "Fingerprint not recognized"
    );

    http.end();

    return;
  }

  // ===================================================
  // FINGERPRINT RESULT
  // ===================================================

  Serial.println();
  Serial.println(
    "========== FINGERPRINT RESULT =========="
  );

  Serial.print("Database Fingerprint ID: ");
  Serial.println(fingerprintID);

  Serial.print("R307S Matched Fingerprint ID: ");
  Serial.println(matchedID);

  // ===================================================
  // BOTH FACTORS MATCH
  // ===================================================

  if (matchedID == fingerprintID)
  {
    Serial.println();
    Serial.println("=================================");
    Serial.println("       ACCESS GRANTED");
    Serial.println("       MODE: ONLINE");
    Serial.println("=================================");

    accessGranted();

    logAccess(
      userID,
      doorID,
      cardUID,
      matchedID,
      "GRANTED",
      "Access granted"
    );
  }

  // ===================================================
  // FINGERPRINT MISMATCH
  // ===================================================

  else
  {
    Serial.println();
    Serial.println("=================================");
    Serial.println("       ACCESS DENIED");
    Serial.println("Fingerprint ID mismatch");
    Serial.println("=================================");

    accessDenied();

    logAccess(
      userID,
      doorID,
      cardUID,
      matchedID,
      "DENIED",
      "Fingerprint mismatch"
    );
  }

  http.end();

  Serial.println("HTTP connection closed.");
}
// =====================================================
// OFFLINE AUTHENTICATION USING LITTLEFS
// =====================================================

void authenticateOfflineCard(String cardUID)
{
  Serial.println();
  Serial.println("=================================");
  Serial.println("     OFFLINE AUTHENTICATION");
  Serial.println("=================================");

  Serial.print("Searching local employee cache for UID: ");
  Serial.println(cardUID);

  // ===================================================
  // CHECK EMPLOYEE CACHE
  // ===================================================

  if (!LittleFS.exists(employeeFile))
  {
    Serial.println();
    Serial.println("ERROR: employees.json not found!");

    Serial.println("Offline authentication unavailable.");

    accessDenied();

    return;
  }

  File file = LittleFS.open(employeeFile, "r");

  if (!file)
  {
    Serial.println();
    Serial.println("ERROR: Could not open employees.json");

    accessDenied();

    return;
  }

  String jsonData = file.readString();

  file.close();

  // ===================================================
  // PARSE CACHE
  // ===================================================

  DynamicJsonDocument doc(8192);

  DeserializationError error =
    deserializeJson(doc, jsonData);

  if (error)
  {
    Serial.print("Offline JSON Parse Error: ");
    Serial.println(error.c_str());

    accessDenied();

    return;
  }

  bool cacheSuccess =
    doc["success"] | false;

  if (!cacheSuccess)
  {
    Serial.println();
    Serial.println("ERROR: Employee cache is invalid.");

    accessDenied();

    return;
  }

  int employeeCount =
    doc["employee_count"] | 0;

  Serial.print("Employees in local cache: ");
  Serial.println(employeeCount);

  JsonArray employees =
    doc["employees"].as<JsonArray>();

  // ===================================================
  // SEARCH NFC UID
  // ===================================================

  bool employeeFound = false;

  int userID = -1;
  int fingerprintID = -1;
  int doorID = -1;
  int allowed = 0;

  String employeeID = "";
  String employeeName = "";
  String doorName = "";
  String status = "";

  for (JsonObject employee : employees)
  {
    const char* storedUID =
      employee["nfc_uid"] | "";

    if (cardUID.equalsIgnoreCase(storedUID))
    {
      employeeFound = true;

      userID =
        employee["user_id"] | -1;

      employeeID =
        employee["employee_id"] | "";

      employeeName =
        employee["name"] | "";

      fingerprintID =
        employee["fingerprint_id"] | -1;

      doorID =
        employee["door_id"] | -1;

      doorName =
        employee["door_name"] | "";

      allowed =
        employee["allowed"] | 0;

      status =
        employee["status"] | "";

      break;
    }
  }

  // ===================================================
  // NFC NOT FOUND
  // ===================================================

  if (!employeeFound)
  {
    Serial.println();
    Serial.println("NFC UID NOT FOUND IN LOCAL CACHE");

    Serial.println("Access denied.");

    accessDenied();

    return;
  }

  // ===================================================
  // DISPLAY LOCAL EMPLOYEE
  // ===================================================

  Serial.println();
  Serial.println("========== LOCAL EMPLOYEE ==========");

  Serial.print("User ID: ");
  Serial.println(userID);

  Serial.print("Employee ID: ");
  Serial.println(employeeID);

  Serial.print("Name: ");
  Serial.println(employeeName);

  Serial.print("NFC UID: ");
  Serial.println(cardUID);

  Serial.print("Fingerprint ID: ");
  Serial.println(fingerprintID);

  Serial.print("Door ID: ");
  Serial.println(doorID);

  Serial.print("Door Name: ");
  Serial.println(doorName);

  Serial.print("Allowed: ");
  Serial.println(allowed);

  Serial.print("Status: ");
  Serial.println(status);

  Serial.println("Authentication Mode: OFFLINE");

  Serial.println("====================================");

  // ===================================================
  // CHECK EMPLOYEE STATUS
  // ===================================================

  if (!status.equalsIgnoreCase("ACTIVE"))
  {
  Serial.println();
  Serial.println("Employee is NOT ACTIVE.");

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
  // CHECK PERMISSION
  // ===================================================

  if (allowed != 1)
  {
  Serial.println();
  Serial.println("Employee is NOT authorized for this door.");

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
  // CHECK FINGERPRINT ID
  // ===================================================

  if (fingerprintID <= 0)
  {
    Serial.println();
    Serial.println("Invalid fingerprint ID in local cache.");

    accessDenied();

    return;
  }

  // ===================================================
  // FINGERPRINT VERIFICATION
  // ===================================================

  Serial.println();
  Serial.println("=================================");
  Serial.println("NFC AUTHENTICATED LOCALLY");
  Serial.println("Fingerprint verification required");
  Serial.println("=================================");

  Serial.println();
  Serial.println("Place your finger on R307S...");

  digitalWrite(BLUE_LED, HIGH);

  digitalWrite(BUZZER, HIGH);
  delay(150);
  digitalWrite(BUZZER, LOW);

  int matchedID = searchFingerprint();

  digitalWrite(BLUE_LED, LOW);

  // ===================================================
  // FINGERPRINT NOT RECOGNIZED
  // ===================================================

  if (matchedID == -1)
  {
  Serial.println();
  Serial.println(
    "Fingerprint verification FAILED"
  );

  accessDenied();

  Serial.println();
  Serial.println(
    "OFFLINE ACCESS RESULT: DENIED"
  );

  queueOfflineLog(
    userID,
    doorID,
    cardUID,
    -1,
    "DENIED",
    "Offline fingerprint not recognized"
  );

  return;
 }

  // ===================================================
  // FINGERPRINT RESULT
  // ===================================================

  Serial.println();
  Serial.println(
    "========== OFFLINE FINGERPRINT RESULT =========="
  );

  Serial.print("Cached Fingerprint ID: ");
  Serial.println(fingerprintID);

  Serial.print("R307S Matched Fingerprint ID: ");
  Serial.println(matchedID);

  // ===================================================
  // BOTH FACTORS MATCH
  // ===================================================

  if (matchedID == fingerprintID)
  {
    Serial.println();
    Serial.println("=================================");
    Serial.println("       ACCESS GRANTED");
    Serial.println("       MODE: OFFLINE");
    Serial.println("=================================");

    accessGranted();

    Serial.println();
    Serial.println("Offline access granted successfully.");
      queueOfflineLog(
      userID,
      doorID,
      cardUID,
      matchedID,
      "GRANTED",
      "Offline access granted"
    );

    // IMPORTANT:
    // Offline logging will be added in STAGE 3.
  }

  // ===================================================
  // FINGERPRINT MISMATCH
  else
  {
  Serial.println();
  Serial.println("=================================");
  Serial.println("       ACCESS DENIED");
  Serial.println("       MODE: OFFLINE");
  Serial.println("Fingerprint ID mismatch");
  Serial.println("=================================");

  accessDenied();

  // =================================================
  // SAVE OFFLINE DENIED LOG
  // =================================================

  queueOfflineLog(
    userID,
    doorID,
    cardUID,
    matchedID,
    "DENIED",
    "Offline fingerprint mismatch"
  );
  }
}
// =====================================================
// URL ENCODE
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
      encoded += '%';

      code0 = (c >> 4) & 0xF;
      code1 = c & 0xF;

      encoded += char(
        code0 > 9
          ? code0 - 10 + 'A'
          : code0 + '0'
      );

      encoded += char(
        code1 > 9
          ? code1 - 10 + 'A'
          : code1 + '0'
      );
    }
  }

  return encoded;
}

// =====================================================
// SAVE ACCESS LOG
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
  if (WiFi.status() != WL_CONNECTED)
  {
  Serial.println();
  Serial.println("Wi-Fi not connected.");
  Serial.println("Saving access log to LittleFS...");

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

  Serial.println();
  Serial.println("=================================");
  Serial.println("Saving access log...");
  Serial.println("=================================");

  String url = logURL;

  url += "?user_id=";
  url += String(userID);

  url += "&door_id=";
  url += String(doorID);

  url += "&nfc_uid=";
  url += urlEncode(nfcUID);

  url += "&fingerprint_id=";
  url += String(fingerprintID);

  url += "&result=";
  url += urlEncode(result);

  url += "&reason=";
  url += urlEncode(reason);

  Serial.print("Log URL: ");
  Serial.println(url);

  HTTPClient http;

  http.begin(url);

  int httpCode = http.GET();

  Serial.print("Log HTTP Response Code: ");
  Serial.println(httpCode);

  if (httpCode > 0)
  {
    String response = http.getString();

    Serial.println("Log server response:");
    Serial.println(response);

    StaticJsonDocument<300> doc;

    DeserializationError error =
      deserializeJson(doc, response);

    if (!error)
    {
      bool success =
        doc["success"] | false;

      if (success)
      {
        Serial.println(
          "ACCESS LOG SAVED SUCCESSFULLY"
        );
      }
      else
      {
        Serial.println(
          "ACCESS LOG FAILED"
        );
      }
    }
  }
  else
  {
    Serial.print("Log HTTP ERROR: ");
    Serial.println(
      http.errorToString(httpCode)
    );
  }

  http.end();

  Serial.println("=================================");
}

// =====================================================
// FINGERPRINT SEARCH
// =====================================================

int searchFingerprint()
{
  Serial.println();
  Serial.println("Waiting for fingerprint...");

  while (true)
  {
    uint8_t p = finger.getImage();

    if (p == FINGERPRINT_OK)
    {
      break;
    }

    if (p == FINGERPRINT_NOFINGER)
    {
      delay(100);
      continue;
    }

    Serial.println(
      "Fingerprint sensor error"
    );

    return -1;
  }

  Serial.println(
    "Fingerprint image captured"
  );

  uint8_t p = finger.image2Tz();

  if (p != FINGERPRINT_OK)
  {
    Serial.println(
      "Could not convert fingerprint"
    );

    return -1;
  }

  Serial.println(
    "Fingerprint converted"
  );

  p = finger.fingerSearch();

  if (p == FINGERPRINT_OK)
  {
    Serial.println(
      "Fingerprint recognized!"
    );

    Serial.print("Matched ID: ");
    Serial.println(finger.fingerID);

    Serial.print("Confidence: ");
    Serial.println(finger.confidence);

    return finger.fingerID;
  }

  if (p == FINGERPRINT_NOTFOUND)
  {
    Serial.println(
      "Fingerprint NOT recognized"
    );

    return -1;
  }

  Serial.println(
    "Fingerprint search error"
  );

  return -1;
}

// =====================================================
// ACCESS GRANTED
// =====================================================

void accessGranted()
{
  digitalWrite(RED_LED, LOW);

  digitalWrite(GREEN_LED, HIGH);

  digitalWrite(RELAY, HIGH);

  digitalWrite(BUZZER, HIGH);
  delay(200);
  digitalWrite(BUZZER, LOW);

  Serial.println("Door unlocked");

  delay(5000);

  digitalWrite(RELAY, LOW);

  digitalWrite(GREEN_LED, LOW);

  Serial.println("Door locked");
}

// =====================================================
// ACCESS DENIED
// =====================================================

void accessDenied()
{
  digitalWrite(GREEN_LED, LOW);

  digitalWrite(RED_LED, HIGH);

  for (int i = 0; i < 2; i++)
  {
    digitalWrite(BUZZER, HIGH);
    delay(200);

    digitalWrite(BUZZER, LOW);
    delay(200);
  }

  delay(1000);

  digitalWrite(RED_LED, LOW);
}

// =====================================================
// WAIT FOR CARD REMOVAL
// =====================================================

void waitForCardRemoval()
{
  Serial.println();
  Serial.println("Remove NFC card...");

  delay(1000);

  uint8_t uid[7];
  uint8_t uidLength;

  while (
    nfc.readPassiveTargetID(
      PN532_MIFARE_ISO14443A,
      uid,
      &uidLength
    )
  )
  {
    delay(200);
  }

  Serial.println("Ready for next card.");
  Serial.println();
}

// =====================================================
// ENSURE WIFI
// =====================================================

void ensureWiFi()
{
  if (WiFi.status() == WL_CONNECTED)
  {
    return;
  }

  Serial.println();
  Serial.println("Wi-Fi disconnected!");
  Serial.println("Reconnecting...");

  WiFi.disconnect();
  WiFi.begin(ssid, password);

  unsigned long startTime = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - startTime < 10000
  )
  {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println(
      "Wi-Fi reconnected!"
    );

    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
  }
  else
  {
    Serial.println(
      "Wi-Fi reconnect failed."
    );
  }
}
