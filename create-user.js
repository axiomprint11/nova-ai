require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const [,, username, password] = process.argv;
if (!username || !password) {
  console.log('Usage: node create-user.js <username> <password>');
  process.exit(1);
}

const db = new sqlite3.Database('/opt/axiom-ai/users.db');
bcrypt.hash(password, 10, (err, hash) => {
  db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash], function(err) {
    if (err) { console.log('Error:', err.message); process.exit(1); }
    console.log(`✅ User "${username}" created successfully!`);
    db.close();
  });
});
