const bcrypt = require("bcryptjs");
const pw = process.argv[2];
if (!pw) {
  console.error("usage: node tools/hash_password.js <password>");
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 10));
