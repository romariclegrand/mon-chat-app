const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'database', 'chat.db'));

const pseudoAdmin = 'romaric'; // ⚠️ REMPLACE PAR TON PSEUDO EXACT

db.run(`UPDATE users SET role = 'admin' WHERE pseudo = ?`, [pseudoAdmin], function(err) {
    if (err) {
        console.error("❌ Erreur:", err.message);
    } else {
        console.log(`✅ Le compte '${pseudoAdmin}' est maintenant administrateur !`);
    }
    db.close();
});