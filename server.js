// ============================================================
// SERVEUR NODE.JS - MESSAGERIE INSTANTANÉE MULTI-UTILISATEUR
// ============================================================

// ===== IMPORTS =====
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
require('dotenv').config();

console.log('✅ Démarrage du serveur...');

// ===== INITIALISATION =====
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// ===== MIDDLEWARES =====
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== BASE DE DONNÉES SQLITE =====
console.log('📁 Connexion à la base de données...');
const db = new sqlite3.Database(path.join(__dirname, 'database', 'chat.db'));

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pseudo TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('❌ Erreur table users:', err.message);
        else console.log('✅ Table users prête');
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            auteur TEXT NOT NULL,
            contenu TEXT NOT NULL,
            salon TEXT DEFAULT 'general',
            conversation_id TEXT,
            date_envoi DATETIME DEFAULT CURRENT_TIMESTAMP,
            est_prive BOOLEAN DEFAULT 0
        )
    `, (err) => {
        if (err) console.error('❌ Erreur table messages:', err.message);
        else console.log('✅ Table messages prête');
    });
});

// ===== VARIABLES GLOBALES =====
const users = {};
const connectedUsers = {};

// ============================================================
// SOCKET.IO - GESTION DES CONNEXIONS
// ============================================================
io.on('connection', (socket) => {
    console.log(`🟢 Nouvel utilisateur connecté : ${socket.id}`);

    // ===== INSCRIPTION =====
    socket.on('inscription', async (data) => {
        const { pseudo, password } = data;

        if (!pseudo || !password) {
            socket.emit('erreur', 'Veuillez remplir tous les champs.');
            return;
        }

        try {
            const existingUser = await new Promise((resolve) => {
                db.get('SELECT * FROM users WHERE pseudo = ?', [pseudo], (err, row) => {
                    resolve(row);
                });
            });

            if (existingUser) {
                socket.emit('erreur', 'Ce pseudo est déjà pris.');
                return;
            }

            const saltRounds = 10;
            const hash = await bcrypt.hash(password, saltRounds);

            await new Promise((resolve) => {
                db.run('INSERT INTO users (pseudo, password_hash) VALUES (?, ?)', [pseudo, hash], function(err) {
                    resolve();
                });
            });

            socket.emit('inscription_reussie', { message: 'Compte créé avec succès !' });
        } catch (error) {
            console.error('❌ Erreur inscription:', error);
            socket.emit('erreur', 'Erreur lors de l\'inscription.');
        }
    });

    // ===== CONNEXION =====
    socket.on('connexion', async (data) => {
        const { pseudo, password } = data;

        if (!pseudo || !password) {
            socket.emit('erreur', 'Veuillez remplir tous les champs.');
            return;
        }

        try {
            const user = await new Promise((resolve) => {
                db.get('SELECT * FROM users WHERE pseudo = ?', [pseudo], (err, row) => {
                    resolve(row);
                });
            });

            if (!user) {
                socket.emit('erreur', 'Pseudo incorrect.');
                return;
            }

            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) {
                socket.emit('erreur', 'Mot de passe incorrect.');
                return;
            }

            if (connectedUsers[pseudo]) {
                const oldSocketId = connectedUsers[pseudo];
                if (io.sockets.sockets.get(oldSocketId)) {
                    io.sockets.sockets.get(oldSocketId).disconnect(true);
                }
                delete connectedUsers[pseudo];
                delete users[oldSocketId];
            }

            connectedUsers[pseudo] = socket.id;
            users[socket.id] = { pseudo, salon: 'general' };

            socket.join('general');

            const messages = await new Promise((resolve) => {
                db.all('SELECT * FROM messages WHERE salon = ? ORDER BY date_envoi LIMIT 50', ['general'], (err, rows) => {
                    resolve(rows || []);
                });
            });
            socket.emit('historique', messages);

            io.emit('utilisateurs_connectes', Object.keys(connectedUsers));
            socket.broadcast.emit('nouvel_utilisateur', pseudo);

            socket.emit('connexion_reussie', { pseudo });
            console.log(`✅ Connexion réussie: ${pseudo}`);
        } catch (error) {
            console.error('❌ Erreur connexion:', error);
            socket.emit('erreur', 'Erreur lors de la connexion.');
        }
    });

    // ============================================================
    // ENVOI DE MESSAGE (CORRIGÉ)
    // ============================================================
    socket.on('message', async (data) => {
        const { contenu, destination, conversation_id } = data;
        const user = users[socket.id];

        if (!user) {
            socket.emit('erreur', 'Vous devez être connecté.');
            return;
        }

        if (!contenu || contenu.trim() === '') {
            return;
        }

        const auteur = user.pseudo;

        try {
            if (destination && conversation_id) {
                // ===== MESSAGE PRIVÉ (1-à-1) =====
                console.log(`🔒 Message privé de ${auteur} à ${destination}: ${contenu}`);

                // Sauvegarde en BDD
                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO messages (auteur, contenu, conversation_id, est_prive) VALUES (?, ?, ?, ?)',
                        [auteur, contenu, conversation_id, 1],
                        function(err) {
                            if (err) console.error('❌ Erreur insertion BDD:', err);
                            resolve();
                        }
                    );
                });

                // Récupérer le socket du destinataire
                const destSocketId = connectedUsers[destination];
                console.log(`📤 Destinataire ${destination} connecté: ${destSocketId ? 'Oui' : 'Non'}`);

                // Données du message
                const messageData = {
                    auteur: auteur,
                    contenu: contenu,
                    date: new Date().toISOString(),
                    conversation_id: conversation_id,
                    est_prive: true,
                    destinataire: destination
                };

                // Envoyer à l'expéditeur (pour affichage immédiat)
                io.to(socket.id).emit('message_prive', messageData);
                console.log(`✅ Message envoyé à l'expéditeur: ${auteur}`);

                // Envoyer au destinataire s'il est connecté
                if (destSocketId) {
                    io.to(destSocketId).emit('message_prive', messageData);
                    console.log(`✅ Message envoyé au destinataire: ${destination}`);
                } else {
                    console.log(`⚠️ ${destination} n'est pas connecté. Message sauvegardé en BDD.`);
                    socket.emit('erreur', `${destination} n'est pas connecté. Message sauvegardé.`);
                }

            } else {
                // ===== MESSAGE PUBLIC =====
                const salon = user.salon || 'general';
                console.log(`📢 Message public de ${auteur} dans ${salon}: ${contenu}`);

                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO messages (auteur, contenu, salon, est_prive) VALUES (?, ?, ?, ?)',
                        [auteur, contenu, salon, 0],
                        function(err) {
                            resolve();
                        }
                    );
                });

                io.to(salon).emit('nouveau_message', {
                    auteur,
                    contenu,
                    date: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('❌ Erreur envoi message:', error);
            socket.emit('erreur', 'Erreur lors de l\'envoi du message.');
        }
    });

    // ============================================================
    // AUTRES ÉVÉNEMENTS
    // ============================================================

    socket.on('changer_salon', async (data) => {
        const { nouveauSalon } = data;
        const user = users[socket.id];

        if (!user) {
            socket.emit('erreur', 'Vous devez être connecté.');
            return;
        }

        socket.leave(user.salon);
        user.salon = nouveauSalon;
        socket.join(nouveauSalon);

        const messages = await new Promise((resolve) => {
            db.all('SELECT * FROM messages WHERE salon = ? ORDER BY date_envoi LIMIT 50', [nouveauSalon], (err, rows) => {
                resolve(rows || []);
            });
        });
        socket.emit('historique', messages);

        socket.emit('salon_change', { nouveauSalon });
        console.log(`📂 ${user.pseudo} a changé pour le salon: ${nouveauSalon}`);
    });

    socket.on('creer_salon_prive', (data) => {
        const { nomSalon, invites } = data;
        const user = users[socket.id];

        if (!user) {
            socket.emit('erreur', 'Vous devez être connecté.');
            return;
        }

        const salonPrive = `prive_${nomSalon}`;
        socket.join(salonPrive);
        user.salon = salonPrive;

        invites.forEach(pseudo => {
            const socketId = connectedUsers[pseudo];
            if (socketId) {
                io.sockets.sockets.get(socketId).join(salonPrive);
                io.to(socketId).emit('invitation_salon', {
                    salon: salonPrive,
                    inviteur: user.pseudo
                });
            }
        });

        socket.emit('salon_creer', { salon: salonPrive, message: 'Salon privé créé avec succès.' });
        socket.emit('salon_change', { nouveauSalon: salonPrive });
        console.log(`🔒 ${user.pseudo} a créé le salon privé: ${salonPrive}`);
    });

    socket.on('historique_conversation', async (data) => {
        const { conversation_id } = data;
        const user = users[socket.id];

        if (!user) {
            socket.emit('erreur', 'Vous devez être connecté.');
            return;
        }

        try {
            const messages = await new Promise((resolve) => {
                db.all(
                    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY date_envoi LIMIT 50',
                    [conversation_id],
                    (err, rows) => {
                        resolve(rows || []);
                    }
                );
            });
            console.log(`📜 Historique conversation ${conversation_id}: ${messages.length} messages`);
            socket.emit('historique_conversation', { conversation_id, messages });
        } catch (error) {
            console.error('❌ Erreur historique:', error);
            socket.emit('erreur', 'Erreur lors du chargement de l\'historique.');
        }
    });

    socket.on('supprimer_message', (data) => {
        const { messageId } = data;
        const user = users[socket.id];

        if (!user) {
            socket.emit('erreur', 'Vous devez être connecté.');
            return;
        }

        db.run('DELETE FROM messages WHERE id = ? AND auteur = ?', [messageId, user.pseudo], function(err) {
            if (err) {
                socket.emit('erreur', 'Erreur lors de la suppression.');
                return;
            }
            if (this.changes === 0) {
                socket.emit('erreur', 'Vous ne pouvez supprimer que vos propres messages.');
                return;
            }
            io.to(user.salon).emit('message_supprime', { messageId });
            console.log(`🗑️ ${user.pseudo} a supprimé un message`);
        });
    });

    socket.on('bannir_utilisateur', (data) => {
        const { pseudo } = data;
        const user = users[socket.id];

        if (!user) {
            socket.emit('erreur', 'Vous devez être connecté.');
            return;
        }

        if (user.pseudo !== 'admin') {
            socket.emit('erreur', 'Vous n\'avez pas les droits pour bannir un utilisateur.');
            return;
        }

        const socketId = connectedUsers[pseudo];
        if (socketId) {
            io.sockets.sockets.get(socketId).disconnect(true);
            delete connectedUsers[pseudo];
            delete users[socketId];
            io.emit('utilisateur_banni', { pseudo });
            socket.emit('bannissement_reussi', { pseudo });
            console.log(`🔨 ${pseudo} a été banni par ${user.pseudo}`);
        } else {
            socket.emit('erreur', 'Utilisateur non trouvé.');
        }
    });

    socket.on('deconnexion', () => {
        const user = users[socket.id];
        if (user) {
            delete connectedUsers[user.pseudo];
            delete users[socket.id];
            io.emit('utilisateurs_connectes', Object.keys(connectedUsers));
            io.emit('utilisateur_deconnecte', user.pseudo);
            console.log(`🔴 ${user.pseudo} s'est déconnecté`);
        }
        socket.disconnect();
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete connectedUsers[user.pseudo];
            delete users[socket.id];
            io.emit('utilisateurs_connectes', Object.keys(connectedUsers));
            io.emit('utilisateur_deconnecte', user.pseudo);
            console.log(`🔴 ${user.pseudo} s'est déconnecté (involontaire)`);
        }
    });
});

// ===== LANCEMENT =====
server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});