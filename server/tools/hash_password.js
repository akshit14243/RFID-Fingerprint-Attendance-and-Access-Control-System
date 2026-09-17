// node tools/hash_password.js mypassword    -> prints the bcrypt hash to paste
// into the users table. Plain passwords are never stored anywhere.
const bcrypt = require("bcryptjs");
const pw = process.argv[2];
if (!pw) {
  console.error("usage: node tools/hash_password.js <password>");
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 10));
