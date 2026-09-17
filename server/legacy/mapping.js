module.exports = {
  recordsPath: "data",

  externalId: (r) => String(r.log_id),

  cardUid: (r) => String(r.card_no || "").toUpperCase().replace(/[^0-9A-F]/g, ""),

  readerId: (r) => String(r.reader_id),

  scannedAt: (r) => r.punch_time,

  direction: (r) => (r.io_type === 1 ? "IN" : r.io_type === 0 ? "OUT" : null),

  readerToDeviceKey: {
    "FIN-01": "DEV-LEGACY-FIN-01",
  },
};
