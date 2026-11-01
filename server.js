const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const db = new sqlite3.Database(path.join(__dirname, 'database', 'chat.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, pseudo TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, code_2fa TEXT, role TEXT DEFAULT 'agent', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, (err) => { if (err) console.error(err); else console.log('✅ Table users prête'); });
    db.run(`CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, pseudo TEXT NOT NULL, token TEXT UNIQUE NOT NULL, revoked BOOLEAN DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, (err) => { if (err) console.error(err); else console.log('✅ Table sessions prête'); });
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, auteur TEXT NOT NULL, contenu TEXT NOT NULL, salon TEXT DEFAULT 'general', conversation_id TEXT, date_envoi DATETIME DEFAULT CURRENT_TIMESTAMP, est_prive BOOLEAN DEFAULT 0, est_chiffre BOOLEAN DEFAULT 1)`, (err) => { if (err) console.error(err); else console.log('✅ Table messages prête'); });
});

const users = {};
const connectedUsers = {};

io.on('connection', (socket) => {
    console.log(`🟢 Nouvel utilisateur connecté : ${socket.id}`);

    socket.on('inscription', async (data) => {
        const { pseudo, password } = data;
        if (!pseudo || !password) return socket.emit('erreur', 'Champs vides.');
        try {
            const existingUser = await new Promise((resolve) => { db.get('SELECT * FROM users WHERE pseudo = ?', [pseudo], (err, row) => resolve(row)); });
            if (existingUser) return socket.emit('erreur', 'Ce pseudo est déjà pris.');
            const hash = await bcrypt.hash(password, 10);
            const code2FA = Math.floor(100000 + Math.random() * 900000).toString();
            await new Promise((resolve) => { db.run('INSERT INTO users (pseudo, password_hash, code_2fa) VALUES (?, ?, ?)', [pseudo, hash, code2FA], function(err) { resolve(); }); });
            socket.emit('inscription_reussie', { message: `Compte créé ! Votre code de sécurité à 6 chiffres est : ${code2FA}. Notez-le bien.`, code_2fa: code2FA });
        } catch (error) { socket.emit('erreur', 'Erreur inscription.'); }
    });

    socket.on('connexion', async (data) => {
        const { pseudo, password, totp_code } = data;
        if (!pseudo || !password || !totp_code) return socket.emit('erreur', 'Champs vides (dont 2FA).');
        try {
            const user = await new Promise((resolve) => { db.get('SELECT * FROM users WHERE pseudo = ?', [pseudo], (err, row) => resolve(row)); });
            if (!user) return socket.emit('erreur', 'Pseudo incorrect.');
            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) return socket.emit('erreur', 'Mot de passe incorrect.');
            if (totp_code !== user.code_2fa) return socket.emit('erreur', 'Code de sécurité (2FA) invalide.');
            
            const anySession = await new Promise((resolve) => { db.get('SELECT * FROM sessions WHERE pseudo = ?', [pseudo], (err, row) => resolve(row)); });
            const activeSession = await new Promise((resolve) => { db.get('SELECT * FROM sessions WHERE pseudo = ? AND revoked = 0', [pseudo], (err, row) => resolve(row)); });
            if (anySession && !activeSession) return socket.emit('erreur', '⛔ Votre accès a été révoqué par l\'administrateur.');

            const token = crypto.randomBytes(32).toString('hex');
            await new Promise((resolve) => { db.run('INSERT INTO sessions (pseudo, token) VALUES (?, ?)', [pseudo, token], resolve); });

            if (connectedUsers[pseudo]) {
                const oldSocketId = connectedUsers[pseudo];
                if (io.sockets.sockets.get(oldSocketId)) io.sockets.sockets.get(oldSocketId).disconnect(true);
                delete connectedUsers[pseudo];
                delete users[oldSocketId];
            }
            connectedUsers[pseudo] = socket.id;
            users[socket.id] = { pseudo, salon: 'general', role: user.role };
            socket.join('general');

            const messages = await new Promise((resolve) => { db.all('SELECT * FROM messages WHERE salon = ? ORDER BY date_envoi LIMIT 50', ['general'], (err, rows) => resolve(rows || [])); });
            socket.emit('historique', messages);
            io.emit('utilisateurs_connectes', Object.keys(connectedUsers));
            socket.broadcast.emit('nouvel_utilisateur', pseudo);
            socket.emit('connexion_reussie', { pseudo, role: user.role, token });
        } catch (error) { socket.emit('erreur', 'Erreur connexion.'); }
    });

    socket.on('revoquer_agent', async (data) => {
        const admin = users[socket.id];
        if (!admin || admin.role !== 'admin') return socket.emit('erreur', 'Seul un admin peut révoquer.');
        const targetPseudo = data.pseudo;
        await new Promise((resolve) => { db.run('UPDATE sessions SET revoked = 1 WHERE pseudo = ?', [targetPseudo], resolve); });
        const targetSocketId = connectedUsers[targetPseudo];
        if (targetSocketId) {
            io.to(targetSocketId).emit('session_revoquee', { message: 'Votre accès a été révoqué.' });
            io.sockets.sockets.get(targetSocketId).disconnect(true);
            delete connectedUsers[targetPseudo]; delete users[targetSocketId];
        }
        io.emit('utilisateur_revoque', { pseudo: targetPseudo });
        socket.emit('revocation_reussie', { pseudo: targetPseudo });
    });

    socket.on('message', async (data) => {
        const { contenu, destination, conversation_id } = data;
        const user = users[socket.id];
        if (!user || !contenu) return;
        if (destination && conversation_id) {
            await new Promise((resolve) => { db.run('INSERT INTO messages (auteur, contenu, conversation_id, est_prive, est_chiffre) VALUES (?, ?, ?, ?, ?)', [user.pseudo, contenu, conversation_id, 1, 1], resolve); });
            const destSocketId = connectedUsers[destination];
            const msgData = { auteur: user.pseudo, contenu, date: new Date().toISOString(), conversation_id, est_prive: true, est_chiffre: true, destinataire: destination };
            io.to(socket.id).emit('message_prive', msgData);
            if (destSocketId) io.to(destSocketId).emit('message_prive', msgData);
        } else {
            const salon = user.salon || 'general';
            await new Promise((resolve) => { db.run('INSERT INTO messages (auteur, contenu, salon, est_prive, est_chiffre) VALUES (?, ?, ?, ?, ?)', [user.pseudo, contenu, salon, 0, 1], resolve); });
            io.to(salon).emit('nouveau_message', { auteur: user.pseudo, contenu, date: new Date().toISOString(), est_chiffre: true });
        }
    });

    socket.on('changer_salon', async (data) => {
        const user = users[socket.id]; if (!user) return;
        socket.leave(user.salon); user.salon = data.nouveauSalon; socket.join(data.nouveauSalon);
        const messages = await new Promise((resolve) => { db.all('SELECT * FROM messages WHERE salon = ? ORDER BY date_envoi LIMIT 50', [data.nouveauSalon], (err, rows) => resolve(rows || [])); });
        socket.emit('historique', messages); socket.emit('salon_change', { nouveauSalon: data.nouveauSalon });
    });

    socket.on('historique_conversation', async (data) => {
        const user = users[socket.id]; if (!user) return;
        const messages = await new Promise((resolve) => { db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY date_envoi LIMIT 50', [data.conversation_id], (err, rows) => resolve(rows || [])); });
        socket.emit('historique_conversation', { conversation_id: data.conversation_id, messages });
    });

    socket.on('deconnexion', () => {
        const user = users[socket.id];
        if (user) { delete connectedUsers[user.pseudo]; delete users[socket.id]; io.emit('utilisateurs_connectes', Object.keys(connectedUsers)); }
        socket.disconnect();
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) { delete connectedUsers[user.pseudo]; delete users[socket.id]; io.emit('utilisateurs_connectes', Object.keys(connectedUsers)); }
    });
});
// Script temporaire pour promouvoir un admin
db.run("UPDATE users SET role = 'admin' WHERE pseudo = 'yelkouni'");

server.listen(PORT, () => console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`));