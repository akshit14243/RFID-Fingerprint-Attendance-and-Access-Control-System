#include <PN532_HSU.h>
#include <PN532.h>
#include <Adafruit_Fingerprint.h>

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
#define PN532_RX 26 //sda
#define PN532_TX 27 //scl

// R307S
#define FINGER_RX 16  //yellow
#define FINGER_TX 17   // green

// LEDs and buzzer
#define GREEN_LED 25
#define RED_LED   33
#define BUZZER    32
#define RELAY 23

// =====================================================
// TEST EMPLOYEE
// =====================================================

const char* allowedNFC = "C6:10:00:02";

const uint16_t allowedFingerprintID = 1;

const bool permissionToEnter = true;

const char* employeeName = "Test Employee";

// =====================================================
// SETUP
// =====================================================

void setup()
{
  Serial.begin(115200);

  // -------------------------------
  // Output pins
  // -------------------------------

  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER, LOW);

  pinMode(RELAY, OUTPUT);
  digitalWrite(RELAY, LOW);

  // -------------------------------
  // R307S
  // -------------------------------

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

  // -------------------------------
  // PN532
  // -------------------------------

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

  Serial.println();
  Serial.println("System Ready");
  Serial.println("Place NFC card...");
}

// =====================================================
// LOOP
// =====================================================

void loop()
{
  uint8_t uid[7];
  uint8_t uidLength;

  // Wait for NFC card
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

  // Convert UID to String
  String cardUID = "";

  for (uint8_t i = 0; i < uidLength; i++)
  {
    if (i > 0)
      cardUID += ":";

    if (uid[i] < 0x10)
      cardUID += "0";

    cardUID += String(uid[i], HEX);
  }

  cardUID.toUpperCase();

  // =================================================
  // NFC DETECTED
  // =================================================

  Serial.println();
  Serial.println("---------------------------------");
  Serial.println("NFC CARD DETECTED");

  Serial.print("UID: ");
  Serial.println(cardUID);

  Serial.print("Employee: ");
  Serial.println(employeeName);

  // =================================================
  // CHECK NFC
  // =================================================

  if (cardUID != allowedNFC)
  {
    Serial.println("NFC: UNKNOWN CARD");
    accessDenied();

    waitForCardRemoval();
    return;
  }

  Serial.println("NFC: CARD AUTHORIZED");

  // =================================================
  // CHECK PERMISSION
  // =================================================

  if (!permissionToEnter)
  {
    Serial.println("ACCESS: NO PERMISSION");

    accessDenied();

    waitForCardRemoval();
    return;
  }

  Serial.println("Permission: ALLOWED");

  // =================================================
  // FINGERPRINT
  // =================================================

  Serial.println();
  Serial.println("Place your finger on R307S...");

  int matchedID = searchFingerprint();

  if (matchedID == -1)
  {
    Serial.println("ACCESS DENIED");
    accessDenied();

    waitForCardRemoval();
    return;
  }

  // =================================================
  // COMPARE FINGERPRINT ID
  // =================================================

  Serial.print("Database Fingerprint ID: ");
  Serial.println(allowedFingerprintID);

  Serial.print("R307S Matched Fingerprint ID: ");
  Serial.println(matchedID);

  if (matchedID == allowedFingerprintID)
  {
    Serial.println();
    Serial.println("=================================");
    Serial.println("       ACCESS GRANTED");
    Serial.println("=================================");

    accessGranted();
  }
  else
  {
    Serial.println();
    Serial.println("=================================");
    Serial.println("       ACCESS DENIED");
    Serial.println("=================================");

    accessDenied();
  }

  waitForCardRemoval();
}

// =====================================================
// FINGERPRINT SEARCH
// =====================================================

int searchFingerprint()
{
  Serial.println();
  Serial.println("Waiting for fingerprint...");

  // Wait until finger is placed
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

    Serial.println("Fingerprint sensor error");
    return -1;
  }

  Serial.println("Fingerprint image captured");

  // Convert image
  uint8_t p = finger.image2Tz();

  if (p != FINGERPRINT_OK)
  {
    Serial.println("Could not convert fingerprint");
    return -1;
  }

  Serial.println("Fingerprint converted");

  // Search database inside R307S
  p = finger.fingerSearch();

  if (p == FINGERPRINT_OK)
  {
    Serial.println("Fingerprint recognized!");

    Serial.print("Matched ID: ");
    Serial.println(finger.fingerID);

    Serial.print("Confidence: ");
    Serial.println(finger.confidence);

    return finger.fingerID;
  }

  if (p == FINGERPRINT_NOTFOUND)
  {
    Serial.println("Fingerprint NOT recognized");
    return -1;
  }

  Serial.println("Fingerprint search error");

  return -1;
}

// =====================================================
// ACCESS GRANTED
// =====================================================

void accessGranted()
{
  digitalWrite(RED_LED, LOW);
  digitalWrite(GREEN_LED, HIGH);

  // Unlock door
  digitalWrite(RELAY, HIGH);

  // Short beep
  digitalWrite(BUZZER, HIGH);
  delay(200);
  digitalWrite(BUZZER, LOW);

  // Door remains unlocked for 5 seconds
  delay(5000);

  // Lock door again
  digitalWrite(RELAY, LOW);

  digitalWrite(GREEN_LED, LOW);
}

// =====================================================
// ACCESS DENIED
// =====================================================

void accessDenied()
{
  digitalWrite(GREEN_LED, LOW);

  // Red LED ON
  digitalWrite(RED_LED, HIGH);

  // Two beeps
  for (int i = 0; i < 2; i++)
  {
    digitalWrite(BUZZER, HIGH);
    delay(200);

    digitalWrite(BUZZER, LOW);
    delay(200);
  }

  delay(1000);

  // Red OFF
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

  // Wait until card is removed
  while (nfc.readPassiveTargetID(
           PN532_MIFARE_ISO14443A,
           uid,
           &uidLength))
  {
    delay(200);
  }

  Serial.println("Ready for next card.");
  Serial.println();
}