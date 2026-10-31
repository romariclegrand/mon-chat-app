// ============================================================
// SERVEUR NODE.JS - MESSAGERIE INSTANTANÉE
// Version : E2E + 2FA + Révocation
// ============================================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const db = new sqlite3.Database(path.join(__dirname, 'database', 'chat.db'));

db.serialize(() => {
    // Table users avec role (admin/agent)
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pseudo TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            totp_secret TEXT,
            role TEXT DEFAULT 'agent',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => { if (err) console.error(err); else console.log('✅ Table users prête'); });

    // Table sessions pour la révocation
    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pseudo TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            revoked BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => { if (err) console.error(err); else console.log('✅ Table sessions prête'); });

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            auteur TEXT NOT NULL,
            contenu TEXT NOT NULL,
            salon TEXT DEFAULT 'general',
            conversation_id TEXT,
            date_envoi DATETIME DEFAULT CURRENT_TIMESTAMP,
            est_prive BOOLEAN DEFAULT 0,
            est_chiffre BOOLEAN DEFAULT 1
        )
    `, (err) => { if (err) console.error(err); else console.log('✅ Table messages prête'); });
});

const users = {};
const connectedUsers = {};

io.on('connection', (socket) => {
    console.log(`🟢 Nouvel utilisateur connecté : ${socket.id}`);

    // ===== INSCRIPTION =====
    socket.on('inscription', async (data) => {
        const { pseudo, password } = data;
        if (!pseudo || !password) return socket.emit('erreur', 'Champs vides.');

        try {
            const existingUser = await new Promise((resolve) => {
                db.get('SELECT * FROM users WHERE pseudo = ?', [pseudo], (err, row) => resolve(row));
            });
            if (existingUser) return socket.emit('erreur', 'Ce pseudo est déjà pris.');

            const hash = await bcrypt.hash(password, 10);
            const secret = speakeasy.generateSecret({ name: `Messagerie226 (${pseudo})` });

            await new Promise((resolve) => {
                db.run('INSERT INTO users (pseudo, password_hash, totp_secret) VALUES (?, ?, ?)', 
                    [pseudo, hash, secret.base32], function(err) { resolve(); });
            });

            QRCode.toDataURL(secret.otpauth_url, (err, data_url) => {
                socket.emit('inscription_reussie', { 
                    message: 'Compte créé ! Scannez ce QR Code.',
                    qr_code: data_url,
                    secret: secret.base32
                });
            });
        } catch (error) { socket.emit('erreur', 'Erreur inscription.'); }
    });

    // ===== CONNEXION =====
    socket.on('connexion', async (data) => {
        const { pseudo, password, totp_code } = data;
        if (!pseudo || !password || !totp_code) return socket.emit('erreur', 'Champs vides (dont 2FA).');

        try {
            const user = await new Promise((resolve) => {
                db.get('SELECT * FROM users WHERE pseudo = ?', [pseudo], (err, row) => resolve(row));
            });
            if (!user) return socket.emit('erreur', 'Pseudo incorrect.');

            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) return socket.emit('erreur', 'Mot de passe incorrect.');

            const verified = speakeasy.totp.verify({
                secret: user.totp_secret, encoding: 'base32', token: totp_code, window: 1
            });
            if (!verified) return socket.emit('erreur', 'Code 2FA invalide.');

            // --- VERIFICATION DE REVOCATION ---
            // On regarde si l'utilisateur a des sessions existantes
            const anySession = await new Promise((resolve) => {
                db.get('SELECT * FROM sessions WHERE pseudo = ?', [pseudo], (err, row) => resolve(row));
            });
            const activeSession = await new Promise((resolve) => {
                db.get('SELECT * FROM sessions WHERE pseudo = ? AND revoked = 0', [pseudo], (err, row) => resolve(row));
            });
            
            // Si l'utilisateur a déjà eu une session mais que TOUTES sont révoquées -> BLOQUÉ
            if (anySession && !activeSession) {
                return socket.emit('erreur', '⛔ Votre accès a été révoqué par l\'administrateur.');
            }

            // --- CREATION DE LA SESSION ---
            const token = crypto.randomBytes(32).toString('hex');
            await new Promise((resolve) => {
                db.run('INSERT INTO sessions (pseudo, token) VALUES (?, ?)', [pseudo, token], resolve);
            });

            // Kick l'ancienne session
            if (connectedUsers[pseudo]) {
                const oldSocketId = connectedUsers[pseudo];
                if (io.sockets.sockets.get(oldSocketId)) io.sockets.sockets.get(oldSocketId).disconnect(true);
                delete connectedUsers[pseudo];
                delete users[oldSocketId];
            }

            connectedUsers[pseudo] = socket.id;
            users[socket.id] = { pseudo, salon: 'general', role: user.role };
            socket.join('general');

            const messages = await new Promise((resolve) => {
                db.all('SELECT * FROM messages WHERE salon = ? ORDER BY date_envoi LIMIT 50', ['general'], (err, rows) => resolve(rows || []));
            });
            socket.emit('historique', messages);
            io.emit('utilisateurs_connectes', Object.keys(connectedUsers));
            socket.broadcast.emit('nouvel_utilisateur', pseudo);
            socket.emit('connexion_reussie', { pseudo, role: user.role, token });

        } catch (error) { socket.emit('erreur', 'Erreur connexion.'); }
    });

    // ===== RÉVOCATION (Admin seulement) =====
    socket.on('revoquer_agent', async (data) => {
        const admin = users[socket.id];
        if (!admin || admin.role !== 'admin') {
            return socket.emit('erreur', 'Seul un admin peut révoquer un agent.');
        }

        const targetPseudo = data.pseudo;

        // 1. Invalider toutes les sessions en BDD
        await new Promise((resolve) => {
            db.run('UPDATE sessions SET revoked = 1 WHERE pseudo = ?', [targetPseudo], resolve);
        });

        // 2. Déconnecter l'agent s'il est en ligne
        const targetSocketId = connectedUsers[targetPseudo];
        if (targetSocketId) {
            io.to(targetSocketId).emit('session_revoquee', { message: 'Votre accès a été révoqué.' });
            io.sockets.sockets.get(targetSocketId).disconnect(true);
            delete connectedUsers[targetPseudo];
            delete users[targetSocketId];
        }

        io.emit('utilisateur_revoque', { pseudo: targetPseudo });
        socket.emit('revocation_reussie', { pseudo: targetPseudo });
        console.log(`🚫 ${targetPseudo} a été révoqué par ${admin.pseudo}`);
    });

    // ===== MESSAGES (Chiffrés) =====
    socket.on('message', async (data) => {
        const { contenu, destination, conversation_id } = data;
        const user = users[socket.id];
        if (!user || !contenu) return;

        if (destination && conversation_id) {
            await new Promise((resolve) => {
                db.run('INSERT INTO messages (auteur, contenu, conversation_id, est_prive, est_chiffre) VALUES (?, ?, ?, ?, ?)',
                    [user.pseudo, contenu, conversation_id, 1, 1], resolve);
            });
            const destSocketId = connectedUsers[destination];
            const msgData = { auteur: user.pseudo, contenu, date: new Date().toISOString(), conversation_id, est_prive: true, est_chiffre: true, destinataire: destination };
            io.to(socket.id).emit('message_prive', msgData);
            if (destSocketId) io.to(destSocketId).emit('message_prive', msgData);
        } else {
            const salon = user.salon || 'general';
            await new Promise((resolve) => {
                db.run('INSERT INTO messages (auteur, contenu, salon, est_prive, est_chiffre) VALUES (?, ?, ?, ?, ?)',
                    [user.pseudo, contenu, salon, 0, 1], resolve);
            });
            io.to(salon).emit('nouveau_message', { auteur: user.pseudo, contenu, date: new Date().toISOString(), est_chiffre: true });
        }
    });

    // ===== AUTRES ÉVÉNEMENTS =====
    socket.on('changer_salon', async (data) => {
        const user = users[socket.id];
        if (!user) return;
        socket.leave(user.salon); user.salon = data.nouveauSalon; socket.join(data.nouveauSalon);
        const messages = await new Promise((resolve) => {
            db.all('SELECT * FROM messages WHERE salon = ? ORDER BY date_envoi LIMIT 50', [data.nouveauSalon], (err, rows) => resolve(rows || []));
        });
        socket.emit('historique', messages); socket.emit('salon_change', { nouveauSalon: data.nouveauSalon });
    });

    socket.on('historique_conversation', async (data) => {
        const user = users[socket.id];
        if (!user) return;
        const messages = await new Promise((resolve) => {
            db.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY date_envoi LIMIT 50', [data.conversation_id], (err, rows) => resolve(rows || []));
        });
        socket.emit('historique_conversation', { conversation_id: data.conversation_id, messages });
    });

    socket.on('supprimer_message', (data) => {
        const user = users[socket.id];
        if (!user) return;
        db.run('DELETE FROM messages WHERE id = ? AND auteur = ?', [data.messageId, user.pseudo], function() {
            if (this.changes > 0) io.to(user.salon).emit('message_supprime', { messageId: data.messageId });
        });
    });

    socket.on('bannir_utilisateur', (data) => {
        const user = users[socket.id];
        if (!user || user.role !== 'admin') return;
        const socketId = connectedUsers[data.pseudo];
        if (socketId) {
            io.sockets.sockets.get(socketId).disconnect(true);
            delete connectedUsers[data.pseudo]; delete users[socketId];
            io.emit('utilisateur_banni', { pseudo: data.pseudo });
        }
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

server.listen(PORT, () => console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`));