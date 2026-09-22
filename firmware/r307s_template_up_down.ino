#include <Arduino.h>
#include <HardwareSerial.h>
#include <Adafruit_Fingerprint.h>
#include <FFat.h>

// ============================================================
// R307S
// ============================================================

HardwareSerial FingerSerial(2);
Adafruit_Fingerprint finger(&FingerSerial);

#define FINGER_RX 16
#define FINGER_TX 17
#define FINGER_BAUD 57600

// ============================================================
// TEST SETTINGS
// ============================================================

#define TARGET_ID           10
#define BUFFER_ID           1

#define TEMPLATE_SIZE       512
#define DATA_PACKET_SIZE    128

#define MAX_CAPTURE_BYTES   4096

const char *TEMPLATE_FILE = "/template_id10.bin";

// ============================================================
// STORAGE
// ============================================================

uint8_t templateData[TEMPLATE_SIZE];

uint32_t totalCapturedBytes = 0;
uint32_t packetNumber = 0;

// ============================================================
// UTILITY
// ============================================================

void flushFingerSerial()
{
    while (FingerSerial.available())
        FingerSerial.read();
}

uint16_t calculateChecksum(
    uint8_t pid,
    uint16_t length,
    const uint8_t *payload
)
{
    uint16_t sum = pid;

    sum += (length >> 8) & 0xFF;
    sum += length & 0xFF;

    for (uint16_t i = 0; i < length - 2; i++)
        sum += payload[i];

    return sum;
}

// ============================================================
// SENSOR CHECK - LIBRARY
// ============================================================

bool checkSensor()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("CHECKING R307S");
    Serial.println("========================================");

    if (finger.verifyPassword())
    {
        Serial.println("R307S fingerprint sensor OK");
        return true;
    }

    Serial.println("R307S fingerprint sensor NOT detected");
    return false;
}

// ============================================================
// FINGERPRINT COUNT - LIBRARY
// ============================================================

bool printFingerprintCount()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("FINGERPRINT COUNT");
    Serial.println("========================================");

    if (finger.getTemplateCount() != FINGERPRINT_OK)
    {
        Serial.println("Failed to read fingerprint count.");
        return false;
    }

    Serial.print("Total fingerprints stored: ");
    Serial.println(finger.templateCount);

    return true;
}

// ============================================================
// ENROLL NEW FINGER INTO ID 10
// ============================================================

bool enrollTarget()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("ENROLL NEW FINGER");
    Serial.println("========================================");

    Serial.print("Target ID: ");
    Serial.println(TARGET_ID);

    // Make sure ID 10 is empty
    uint8_t result = finger.deleteModel(TARGET_ID);

    if (result == FINGERPRINT_OK)
    {
        Serial.println("Existing ID 10 deleted.");
    }
    else if (result == FINGERPRINT_NOTFOUND)
    {
        Serial.println("ID 10 is already empty.");
    }
    else
    {
        Serial.print("Could not prepare ID 10. Error: 0x");
        Serial.println(result, HEX);
        return false;
    }

    // -------------------------
    // First finger image
    // -------------------------

    Serial.println();
    Serial.println("Place NEW finger on sensor...");

    while (true)
    {
        result = finger.getImage();

        if (result == FINGERPRINT_OK)
        {
            Serial.println("First fingerprint image captured.");
            break;
        }

        if (result != FINGERPRINT_NOFINGER)
        {
            Serial.print("getImage error: 0x");
            Serial.println(result, HEX);
            return false;
        }

        delay(100);
    }

    result = finger.image2Tz(1);

    if (result != FINGERPRINT_OK)
    {
        Serial.print("First image conversion failed: 0x");
        Serial.println(result, HEX);
        return false;
    }

    Serial.println("First fingerprint converted.");

    Serial.println();
    Serial.println("Remove finger...");

    while (finger.getImage() != FINGERPRINT_NOFINGER)
        delay(100);

    delay(500);

    // -------------------------
    // Second finger image
    // -------------------------

    Serial.println();
    Serial.println("Place SAME finger again...");

    while (true)
    {
        result = finger.getImage();

        if (result == FINGERPRINT_OK)
        {
            Serial.println("Second fingerprint image captured.");
            break;
        }

        if (result != FINGERPRINT_NOFINGER)
        {
            Serial.print("getImage error: 0x");
            Serial.println(result, HEX);
            return false;
        }

        delay(100);
    }

    result = finger.image2Tz(2);

    if (result != FINGERPRINT_OK)
    {
        Serial.print("Second image conversion failed: 0x");
        Serial.println(result, HEX);
        return false;
    }

    Serial.println("Second fingerprint converted.");

    // -------------------------
    // Create model
    // -------------------------

    result = finger.createModel();

    if (result != FINGERPRINT_OK)
    {
        Serial.print("Fingerprint model creation failed: 0x");
        Serial.println(result, HEX);
        return false;
    }

    Serial.println("Fingerprint model created.");

    // -------------------------
    // Store ID 10
    // -------------------------

    result = finger.storeModel(TARGET_ID);

    if (result != FINGERPRINT_OK)
    {
        Serial.print("Failed to store ID 10: 0x");
        Serial.println(result, HEX);
        return false;
    }

    Serial.println();
    Serial.println("========================================");
    Serial.println("ENROLLMENT SUCCESSFUL");
    Serial.println("========================================");

    Serial.println("New fingerprint stored as ID 10.");

    return true;
}

// ============================================================
// VERIFY ID 10 EXISTS - LIBRARY
// ============================================================

bool verifyTargetExists()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("VERIFYING ID 10");
    Serial.println("========================================");

    uint8_t result = finger.loadModel(TARGET_ID);

    if (result == FINGERPRINT_OK)
    {
        Serial.println("Fingerprint ID 10 loaded successfully.");
        return true;
    }

    Serial.print("ID 10 load failed: 0x");
    Serial.println(result, HEX);

    return false;
}

// ============================================================
// RAW UPCHAR COMMAND
// ============================================================

bool sendUpChar(uint8_t bufferID)
{
    uint8_t command[] =
    {
        0xEF, 0x01,
        0xFF, 0xFF, 0xFF, 0xFF,
        0x01,
        0x00, 0x04,
        0x08,
        bufferID,
        0x00, 0x0E
    };

    flushFingerSerial();

    Serial.println();
    Serial.println("========================================");
    Serial.println("SENDING UPCHAR");
    Serial.println("========================================");

    Serial.print("Command: ");

    for (size_t i = 0; i < sizeof(command); i++)
    {
        if (command[i] < 0x10)
            Serial.print("0");

        Serial.print(command[i], HEX);
        Serial.print(" ");
    }

    Serial.println();

    FingerSerial.write(command, sizeof(command));
    FingerSerial.flush();

    return true;
}

// ============================================================
// READ UPCHAR ACK
// ============================================================

bool readUpCharACK()
{
    uint8_t packet[32];
    uint16_t index = 0;

    unsigned long start = millis();

    while (millis() - start < 3000)
    {
        if (FingerSerial.available())
        {
            uint8_t b = FingerSerial.read();

            if (index < sizeof(packet))
                packet[index++] = b;

            if (index >= 9)
            {
                if (packet[0] == 0xEF &&
                    packet[1] == 0x01)
                {
                    uint8_t pid = packet[6];

                    uint16_t length =
                        ((uint16_t)packet[7] << 8) |
                        packet[8];

                    uint16_t totalLength = 9 + length;

                    if (index >= totalLength)
                    {
                        uint16_t receivedChecksum =
                            ((uint16_t)packet[totalLength - 2] << 8) |
                            packet[totalLength - 1];

                        uint16_t calculatedChecksum = pid;

                        calculatedChecksum += packet[7];
                        calculatedChecksum += packet[8];

                        for (uint16_t i = 0; i < length - 2; i++)
                            calculatedChecksum += packet[9 + i];

                        Serial.println();
                        Serial.println("UPCHAR ACK RECEIVED");

                        Serial.print("PID: 0x");
                        Serial.println(pid, HEX);

                        if (length >= 3)
                        {
                            Serial.print("Confirmation: 0x");
                            Serial.println(packet[9], HEX);
                        }

                        Serial.print("Received checksum: 0x");
                        Serial.println(receivedChecksum, HEX);

                        Serial.print("Calculated checksum: 0x");
                        Serial.println(calculatedChecksum, HEX);

                        if (receivedChecksum != calculatedChecksum)
                        {
                            Serial.println("ACK CHECKSUM ERROR");
                            return false;
                        }

                        if (pid != 0x07)
                        {
                            Serial.println("Unexpected ACK PID.");
                            return false;
                        }

                        if (packet[9] != 0x00)
                        {
                            Serial.println("UpChar rejected by sensor.");
                            return false;
                        }

                        Serial.println("UpChar accepted.");
                        return true;
                    }
                }
            }
        }
    }

    Serial.println("UpChar ACK timeout.");
    return false;
}

// ============================================================
// READ COMPLETE UPCHAR DATA STREAM
// ============================================================

bool receiveTemplateStream()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("RECEIVING COMPLETE UPCHAR STREAM");
    Serial.println("========================================");

    memset(templateData, 0, sizeof(templateData));

    totalCapturedBytes = 0;
    packetNumber = 0;

    bool endPacketReceived = false;

    unsigned long lastByteTime = millis();

    while (!endPacketReceived)
    {
        if (FingerSerial.available())
        {
            uint8_t header[9];

            // Search for packet header
            uint8_t first = FingerSerial.read();

            if (first != 0xEF)
                continue;

            unsigned long headerStart = millis();

            while (FingerSerial.available() < 8)
            {
                if (millis() - headerStart > 1000)
                    return false;
            }

            header[0] = 0xEF;

            for (int i = 1; i < 9; i++)
                header[i] = FingerSerial.read();

            if (header[1] != 0x01)
            {
                Serial.println("Invalid packet header.");
                continue;
            }

            uint8_t pid = header[6];

            uint16_t length =
                ((uint16_t)header[7] << 8) |
                header[8];

            if (length < 2 || length > 300)
            {
                Serial.print("Invalid packet length: ");
                Serial.println(length);
                continue;
            }

            uint16_t payloadLength = length - 2;

            uint8_t payload[256];

            if (payloadLength > sizeof(payload))
            {
                Serial.println("Payload too large.");
                return false;
            }

            unsigned long dataStart = millis();

            uint16_t received = 0;

            while (received < payloadLength)
            {
                if (FingerSerial.available())
                {
                    payload[received++] = FingerSerial.read();
                    lastByteTime = millis();
                }

                if (millis() - dataStart > 3000)
                {
                    Serial.println("Data packet timeout.");
                    return false;
                }
            }

            uint8_t checksumBytes[2];

            while (!FingerSerial.available())
            {
                if (millis() - lastByteTime > 1000)
                {
                    Serial.println("Checksum timeout.");
                    return false;
                }
            }

            checksumBytes[0] = FingerSerial.read();

            while (!FingerSerial.available())
            {
                if (millis() - lastByteTime > 1000)
                {
                    Serial.println("Checksum timeout.");
                    return false;
                }
            }

            checksumBytes[1] = FingerSerial.read();

            uint16_t receivedChecksum =
                ((uint16_t)checksumBytes[0] << 8) |
                checksumBytes[1];

            uint16_t calculatedChecksum = pid;

            calculatedChecksum += header[7];
            calculatedChecksum += header[8];

            for (uint16_t i = 0; i < payloadLength; i++)
                calculatedChecksum += payload[i];

            packetNumber++;

            Serial.println();
            Serial.print("Packet #");
            Serial.print(packetNumber);

            Serial.print(" PID 0x");
            Serial.print(pid, HEX);

            Serial.print(", payload ");
            Serial.print(payloadLength);
            Serial.print(" bytes");

            Serial.print(", checksum 0x");
            Serial.print(receivedChecksum, HEX);

            if (receivedChecksum == calculatedChecksum)
                Serial.println(" OK");
            else
                Serial.println(" ERROR");

            if (receivedChecksum != calculatedChecksum)
            {
                Serial.println("Checksum error.");
                return false;
            }

            // ------------------------------------------------
            // Capture EVERY payload byte
            // ------------------------------------------------

            if (totalCapturedBytes + payloadLength <= MAX_CAPTURE_BYTES)
            {
                Serial.print("Captured bytes: ");
                Serial.print(totalCapturedBytes);
                Serial.print(" -> ");
                Serial.println(totalCapturedBytes + payloadLength);

                // Only first 512 are our template file
                for (uint16_t i = 0; i < payloadLength; i++)
                {
                    if (totalCapturedBytes < TEMPLATE_SIZE)
                    {
                        templateData[totalCapturedBytes] = payload[i];
                    }

                    totalCapturedBytes++;
                }
            }
            else
            {
                Serial.println("Capture buffer limit reached.");
                return false;
            }

            // ------------------------------------------------
            // End packet
            // ------------------------------------------------

            if (pid == 0x08)
            {
                endPacketReceived = true;
            }
        }
    }

    Serial.println();
    Serial.println("========================================");
    Serial.println("UPCHAR STREAM COMPLETE");
    Serial.println("========================================");

    Serial.print("Total payload bytes captured: ");
    Serial.println(totalCapturedBytes);

    Serial.print("Template bytes retained: ");
    Serial.println(min(totalCapturedBytes, (uint32_t)TEMPLATE_SIZE));

    return totalCapturedBytes >= TEMPLATE_SIZE;
}

// ============================================================
// SAVE 512-BYTE TEMPLATE
// ============================================================

bool saveTemplate()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("SAVING ID 10 TEMPLATE");
    Serial.println("========================================");

    File file = FFat.open(TEMPLATE_FILE, FILE_WRITE);

    if (!file)
    {
        Serial.println("Failed to open template file.");
        return false;
    }

    size_t written =
        file.write(templateData, TEMPLATE_SIZE);

    file.close();

    Serial.print("Bytes written: ");
    Serial.println(written);

    if (written != TEMPLATE_SIZE)
    {
        Serial.println("Template write incomplete.");
        return false;
    }

    Serial.print("Saved: ");
    Serial.println(TEMPLATE_FILE);

    return true;
}

// ============================================================
// FILE VERIFICATION
// ============================================================

bool verifyTemplateFile()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("VERIFYING TEMPLATE FILE");
    Serial.println("========================================");

    File file = FFat.open(TEMPLATE_FILE, FILE_READ);

    if (!file)
    {
        Serial.println("Failed to open template file.");
        return false;
    }

    size_t size = file.size();

    Serial.print("File size: ");
    Serial.println(size);

    if (size != TEMPLATE_SIZE)
    {
        Serial.println("ERROR: File is not 512 bytes.");
        file.close();
        return false;
    }

    uint8_t buffer[128];

    uint32_t sum = 0;
    uint32_t nonZero = 0;
    uint32_t totalRead = 0;

    while (file.available())
    {
        int n = file.read(buffer, sizeof(buffer));

        if (n <= 0)
            break;

        for (int i = 0; i < n; i++)
        {
            sum += buffer[i];

            if (buffer[i] != 0)
                nonZero++;

            totalRead++;
        }
    }

    file.close();

    Serial.print("Bytes read: ");
    Serial.println(totalRead);

    Serial.print("File byte sum: 0x");
    Serial.println(sum, HEX);

    Serial.print("Non-zero bytes: ");
    Serial.println(nonZero);

    if (nonZero == 0)
    {
        Serial.println("WARNING: Template contains only zeros.");
        return false;
    }

    Serial.println("Template file contains data.");

    return true;
}

// ============================================================
// DELETE ID 10 FROM R307S
// ============================================================

bool deleteTarget()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("DELETING ORIGINAL ID 10");
    Serial.println("========================================");

    uint8_t result = finger.deleteModel(TARGET_ID);

    if (result == FINGERPRINT_OK)
    {
        Serial.println("ID 10 deleted successfully.");
        return true;
    }

    Serial.print("Failed to delete ID 10: 0x");
    Serial.println(result, HEX);

    return false;
}

// ============================================================
// RAW DOWNCHAR
// ============================================================

bool sendDownChar(uint8_t bufferID)
{
    uint8_t command[] =
    {
        0xEF, 0x01,
        0xFF, 0xFF, 0xFF, 0xFF,
        0x01,
        0x00, 0x04,
        0x09,
        bufferID,
        0x00, 0x0F
    };

    flushFingerSerial();

    Serial.println();
    Serial.println("========================================");
    Serial.println("SENDING DOWNCHAR");
    Serial.println("========================================");

    FingerSerial.write(command, sizeof(command));
    FingerSerial.flush();

    return true;
}

// ============================================================
// READ DOWNCHAR ACK
// ============================================================

bool readDownCharACK()
{
    uint8_t packet[32];
    uint16_t index = 0;

    unsigned long start = millis();

    while (millis() - start < 3000)
    {
        if (FingerSerial.available())
        {
            uint8_t b = FingerSerial.read();

            if (index < sizeof(packet))
                packet[index++] = b;

            if (index >= 9)
            {
                if (packet[0] == 0xEF &&
                    packet[1] == 0x01)
                {
                    uint8_t pid = packet[6];

                    uint16_t length =
                        ((uint16_t)packet[7] << 8) |
                        packet[8];

                    uint16_t totalLength = 9 + length;

                    if (index >= totalLength)
                    {
                        uint16_t receivedChecksum =
                            ((uint16_t)packet[totalLength - 2] << 8) |
                            packet[totalLength - 1];

                        uint16_t calculatedChecksum = pid;

                        calculatedChecksum += packet[7];
                        calculatedChecksum += packet[8];

                        for (uint16_t i = 0; i < length - 2; i++)
                            calculatedChecksum += packet[9 + i];

                        Serial.println();
                        Serial.println("DOWNCHAR ACK RECEIVED");

                        Serial.print("PID: 0x");
                        Serial.println(pid, HEX);

                        Serial.print("Confirmation: 0x");
                        Serial.println(packet[9], HEX);

                        Serial.print("Received checksum: 0x");
                        Serial.println(receivedChecksum, HEX);

                        Serial.print("Calculated checksum: 0x");
                        Serial.println(calculatedChecksum, HEX);

                        if (receivedChecksum != calculatedChecksum)
                        {
                            Serial.println("ACK checksum error.");
                            return false;
                        }

                        if (pid != 0x07 || packet[9] != 0x00)
                        {
                            Serial.println("DownChar rejected.");
                            return false;
                        }

                        Serial.println("DownChar accepted.");
                        return true;
                    }
                }
            }
        }
    }

    Serial.println("DownChar ACK timeout.");
    return false;
}

// ============================================================
// SEND ONE DATA PACKET
// ============================================================

void sendDataPacket(
    const uint8_t *data,
    uint16_t length,
    uint8_t pid
)
{
    uint16_t packetLength = length + 2;

    uint16_t checksum = pid;

    checksum += (packetLength >> 8) & 0xFF;
    checksum += packetLength & 0xFF;

    for (uint16_t i = 0; i < length; i++)
        checksum += data[i];

    FingerSerial.write(0xEF);
    FingerSerial.write(0x01);

    FingerSerial.write(0xFF);
    FingerSerial.write(0xFF);
    FingerSerial.write(0xFF);
    FingerSerial.write(0xFF);

    FingerSerial.write(pid);

    FingerSerial.write((packetLength >> 8) & 0xFF);
    FingerSerial.write(packetLength & 0xFF);

    FingerSerial.write(data, length);

    FingerSerial.write((checksum >> 8) & 0xFF);
    FingerSerial.write(checksum & 0xFF);

    FingerSerial.flush();

    Serial.print("Sent PID 0x");
    Serial.print(pid, HEX);
    Serial.print(" packet: ");
    Serial.print(length);
    Serial.print(" bytes, checksum 0x");
    Serial.println(checksum, HEX);
}

// ============================================================
// SEND 512 BYTE TEMPLATE
// ============================================================

bool sendTemplate()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("DOWNLOADING TEMPLATE TO R307S");
    Serial.println("========================================");

    for (uint16_t offset = 0;
         offset < TEMPLATE_SIZE;
         offset += DATA_PACKET_SIZE)
    {
        uint16_t remaining =
            TEMPLATE_SIZE - offset;

        uint16_t length =
            min((uint16_t)DATA_PACKET_SIZE, remaining);

        bool lastPacket =
            (offset + length >= TEMPLATE_SIZE);

        uint8_t pid =
            lastPacket ? 0x08 : 0x02;

        sendDataPacket(
            &templateData[offset],
            length,
            pid
        );

        delay(20);
    }

    Serial.println();
    Serial.println("All 512 template bytes sent.");

    return true;
}

// ============================================================
// VERIFY STORED ID 10
// ============================================================

bool verifyStoredTarget()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("VERIFYING STORED TARGET");
    Serial.println("========================================");

    Serial.println("Loading target ID: 10");

    uint8_t result =
        finger.loadModel(TARGET_ID);

    if (result == FINGERPRINT_OK)
    {
        Serial.println("Target fingerprint ID 10 loaded successfully.");
        return true;
    }

    Serial.print("Target load failed: 0x");
    Serial.println(result, HEX);

    return false;
}

// ============================================================
// SEARCH SAME FINGER
// ============================================================

bool searchTarget()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("FINGERPRINT SEARCH TEST");
    Serial.println("========================================");

    Serial.println("Place the SAME NEW finger...");
    delay(1000);

    uint8_t result;

    while (true)
    {
        result = finger.getImage();

        if (result == FINGERPRINT_OK)
        {
            Serial.println("Fingerprint image captured.");
            break;
        }

        if (result != FINGERPRINT_NOFINGER)
        {
            Serial.print("getImage error: 0x");
            Serial.println(result, HEX);
            return false;
        }

        delay(100);
    }

    result = finger.image2Tz();

    if (result != FINGERPRINT_OK)
    {
        Serial.print("Fingerprint conversion failed: 0x");
        Serial.println(result, HEX);
        return false;
    }

    Serial.println("Fingerprint converted.");

    result = finger.fingerFastSearch();

    if (result != FINGERPRINT_OK)
    {
        Serial.print("Fingerprint search failed: 0x");
        Serial.println(result, HEX);
        return false;
    }

    Serial.println();
    Serial.println("========================================");
    Serial.println("FINGERPRINT MATCH");
    Serial.println("========================================");

    Serial.print("Matched ID: ");
    Serial.println(finger.fingerID);

    Serial.print("Confidence: ");
    Serial.println(finger.confidence);

    if (finger.fingerID == TARGET_ID)
    {
        Serial.println();
        Serial.println("SUCCESS: MATCHED ID 10");
        return true;
    }

    Serial.println();
    Serial.println("FAILED: MATCHED DIFFERENT ID");

    return false;
}

// ============================================================
// DELETE TEMPLATE FILE
// ============================================================

bool deleteTemplateFile()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("DELETING TEMPLATE FILE");
    Serial.println("========================================");

    if (!FFat.exists(TEMPLATE_FILE))
    {
        Serial.println("Template file already does not exist.");
        return true;
    }

    if (FFat.remove(TEMPLATE_FILE))
    {
        Serial.println("Template file deleted successfully.");
        return true;
    }

    Serial.println("Template file deletion FAILED.");
    return false;
}

// ============================================================
// SETUP
// ============================================================

void setup()
{
    Serial.begin(115200);
    delay(1500);

    FingerSerial.begin(
        FINGER_BAUD,
        SERIAL_8N1,
        FINGER_RX,
        FINGER_TX
    );

    Serial.println();
    Serial.println("========================================");
    Serial.println("R307S ID 10 ROUND-TRIP TEST");
    Serial.println("========================================");

    // --------------------------------------------------------
    // FATFS
    // --------------------------------------------------------

    Serial.println();
    Serial.println("Starting FATFS...");

    if (!FFat.begin(false))
    {
        Serial.println("FATFS mount FAILED.");
        return;
    }

    Serial.println("FATFS mounted.");

    Serial.print("Free space: ");
    Serial.println(FFat.totalBytes() - FFat.usedBytes());

    // --------------------------------------------------------
    // SENSOR
    // --------------------------------------------------------

    if (!checkSensor())
        return;

    // --------------------------------------------------------
    // ENROLL
    // --------------------------------------------------------

    if (!enrollTarget())
        return;

    printFingerprintCount();

    // --------------------------------------------------------
    // VERIFY ID 10
    // --------------------------------------------------------

    if (!verifyTargetExists())
        return;

    // --------------------------------------------------------
    // UPCHAR
    // --------------------------------------------------------

    Serial.println();
    Serial.println("========================================");
    Serial.println("EXTRACTING ID 10 TEMPLATE");
    Serial.println("========================================");

    // loadModel puts stored ID 10 into sensor buffer
    if (finger.loadModel(TARGET_ID) != FINGERPRINT_OK)
    {
        Serial.println("Could not load ID 10 before UpChar.");
        return;
    }

    Serial.println("ID 10 loaded into sensor buffer.");

    sendUpChar(BUFFER_ID);

    if (!readUpCharACK())
        return;

    if (!receiveTemplateStream())
        return;

    // --------------------------------------------------------
    // SAVE
    // --------------------------------------------------------

    if (!saveTemplate())
        return;

    if (!verifyTemplateFile())
        return;

    // --------------------------------------------------------
    // DELETE ORIGINAL ID 10
    // --------------------------------------------------------

    if (!deleteTarget())
        return;

    // Confirm ID 10 is gone
    Serial.println();
    Serial.println("Checking that ID 10 was deleted...");

    uint8_t check =
        finger.loadModel(TARGET_ID);

    if (check == FINGERPRINT_OK)
    {
        Serial.println("WARNING: ID 10 still exists.");
        return;
    }

    Serial.println("ID 10 is no longer stored.");

    // --------------------------------------------------------
    // DOWNCHAR
    // --------------------------------------------------------

    Serial.println();
    Serial.println("========================================");
    Serial.println("RESTORING ID 10 FROM FILE");
    Serial.println("========================================");

    sendDownChar(BUFFER_ID);

    if (!readDownCharACK())
        return;

    if (!sendTemplate())
        return;

    delay(300);

    // --------------------------------------------------------
    // STORE ID 10
    // --------------------------------------------------------

    Serial.println();
    Serial.println("========================================");
    Serial.println("STORING RESTORED TEMPLATE");
    Serial.println("========================================");

    uint8_t result =
        finger.storeModel(TARGET_ID);

    if (result != FINGERPRINT_OK)
    {
        Serial.print("Template store FAILED: 0x");
        Serial.println(result, HEX);
        return;
    }

    Serial.println("Template stored successfully.");

    // --------------------------------------------------------
    // VERIFY
    // --------------------------------------------------------

    if (!verifyStoredTarget())
        return;

    // --------------------------------------------------------
    // SEARCH
    // --------------------------------------------------------

    if (!searchTarget())
    {
        Serial.println();
        Serial.println("========================================");
        Serial.println("SEARCH VERIFICATION FAILED");
        Serial.println("========================================");

        Serial.println("Template file will NOT be deleted.");
        return;
    }

    // --------------------------------------------------------
    // SUCCESS
    // --------------------------------------------------------

    Serial.println();
    Serial.println("========================================");
    Serial.println("ROUND-TRIP TEST SUCCESS");
    Serial.println("========================================");

    Serial.println("Enroll ID 10       : PASS");
    Serial.println("UpChar extraction  : PASS");
    Serial.println("Template saved     : PASS");
    Serial.println("Original deleted   : PASS");
    Serial.println("DownChar transfer  : PASS");
    Serial.println("Store ID 10        : PASS");
    Serial.println("Load ID 10         : PASS");
    Serial.println("Fingerprint search : PASS");

    // Only now delete the temporary file
    deleteTemplateFile();

    Serial.println();
    Serial.println("========================================");
    Serial.println("TEST COMPLETE");
    Serial.println("========================================");
}

void loop()
{
}