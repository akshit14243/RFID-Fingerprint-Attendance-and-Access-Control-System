// ONE FILE TO EDIT when the other team tells us their field names.
//
// Their old RFID-only system returns records in its own shape. We do not
// change our database to match them - we translate their record into ours
// right here, and nothing else in the codebase has to know they exist.
//
// Replace the right-hand side of each line with their actual field name.

module.exports = {
  // Where the list of records lives in their JSON response.
  // "" means the response is the array itself, e.g. [ {...}, {...} ]
  recordsPath: "data",

  // Their unique id for a record. We store it so re-running the sync can
  // never create a duplicate row.
  externalId: (r) => String(r.log_id),

  // The card number they read.
  cardUid: (r) => String(r.card_no || "").toUpperCase().replace(/[^0-9A-F]/g, ""),

  // Which of their readers it came from. We map it to one of our devices.
  readerId: (r) => String(r.reader_id),

  // When it happened, as something new Date() understands.
  scannedAt: (r) => r.punch_time,

  // Their in/out flag, if they have one. Return "IN", "OUT" or null.
  // null means we work the direction out ourselves from the previous event.
  direction: (r) => (r.io_type === 1 ? "IN" : r.io_type === 0 ? "OUT" : null),

  // Their reader id  ->  our devices.device_key
  readerToDeviceKey: {
    "FIN-01": "DEV-LEGACY-FIN-01",
  },
};
