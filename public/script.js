// ============================================================
// CLIENT SOCKET.IO - MESSAGERIE INSTANTANÉE MULTI-UTILISATEUR
// ============================================================

// ===== VARIABLES GLOBALES =====
const socket = io();
let pseudoActuel = null;
let salonActuel = 'general';
let conversationActuelle = null;
let conversations = {};
let utilisateurSelectionne = null;
let monRole = 'agent'; // 'agent' ou 'admin'
let enConversationPrivee = false;

// ============================================================
// CHIFFREMENT E2E (AES-256 via crypto-js)
// ============================================================
function deriveKey(pseudoCible) {
    return CryptoJS.SHA256(pseudoCible + "HACKATHON_226_SALT_2026").toString();
}

function chiffrer(contenu, cible) {
    return CryptoJS.AES.encrypt(contenu, deriveKey(cible)).toString();
}

function dechiffrer(ciphertext, source) {
    try {
        const bytes = CryptoJS.AES.decrypt(ciphertext, deriveKey(source));
        const resultat = bytes.toString(CryptoJS.enc.Utf8);
        return resultat || "[Message chiffré - clé incorrecte]";
    } catch (e) {
        return "[Erreur de déchiffrement]";
    }
}

// ============================================================
// AUTHENTIFICATION
// ============================================================

function showTab(tab) {
    document.querySelectorAll('.auth-form').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#auth-tabs button').forEach(el => el.classList.remove('active'));

    if (tab === 'connexion') {
        document.getElementById('form-connexion').classList.add('active');
        document.getElementById('tab-connexion').classList.add('active');
    } else {
        document.getElementById('form-inscription').classList.add('active');
        document.getElementById('tab-inscription').classList.add('active');
    }
}

function sInscrire() {
    const pseudo = document.getElementById('register-pseudo').value.trim();
    const password = document.getElementById('register-password').value.trim();
    const errorEl = document.getElementById('register-error');

    if (!pseudo || !password) {
        errorEl.textContent = 'Veuillez remplir tous les champs.';
        return;
    }

    socket.emit('inscription', { pseudo, password });
}

function seConnecter() {
    const pseudo = document.getElementById('login-pseudo').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const totp_code = document.getElementById('login-totp').value.trim(); // NOUVEAU
    const errorEl = document.getElementById('login-error');

    if (!pseudo || !password || !totp_code) {
        errorEl.textContent = 'Veuillez remplir tous les champs (dont le 2FA).';
        return;
    }

    socket.emit('connexion', { pseudo, password, totp_code });
}

// ============================================================
// SOCKET EVENTS (AUTH)
// ============================================================

socket.on('inscription_reussie', (data) => {
    document.getElementById('register-error').textContent = '';
    document.getElementById('register-pseudo').value = '';
    document.getElementById('register-password').value = '';
    
    // Afficher le QR Code
    if (data.qr_code) {
        document.getElementById('qrcode-img').src = data.qr_code;
        document.getElementById('manual-secret').textContent = data.secret;
        document.getElementById('qrcode-container').style.display = 'block';
        alert('Compte créé ! Scannez le QR Code avec Google Authenticator avant de vous connecter.');
    } else {
        alert(data.message);
        showTab('connexion');
    }
});

socket.on('connexion_reussie', (data) => {
    pseudoActuel = data.pseudo;
    monRole = data.role; // On stocke le rôle
    document.getElementById('pseudo-display').textContent = pseudoActuel + (monRole === 'admin' ? ' (Admin)' : '');
    document.getElementById('auth-container').style.display = 'none';
    document.getElementById('chat-container').style.display = 'flex';
    document.getElementById('login-error').textContent = '';
    chargerConversations();
});

socket.on('erreur', (message) => {
    const loginError = document.getElementById('login-error');
    const registerError = document.getElementById('register-error');
    if (loginError) loginError.textContent = message;
    if (registerError) registerError.textContent = message;
    alert('❌ ' + message);
});

// ============================================================
// MESSAGES PUBLICS (SALONS)
// ============================================================

socket.on('historique', (messagesData) => {
    if (!enConversationPrivee) {
        const container = document.getElementById('messages');
        container.innerHTML = '';
        messagesData.forEach(msg => {
            // On passe msg.est_chiffre pour que l'affichage sache qu'il faut déchiffrer
            ajouterMessage(msg.auteur, msg.contenu, msg.date_envoi, false, msg.est_chiffre);
        });
        container.scrollTop = container.scrollHeight;
    }
});

socket.on('nouveau_message', (data) => {
    if (!enConversationPrivee) {
        ajouterMessage(data.auteur, data.contenu, data.date, false, data.est_chiffre);
        const container = document.getElementById('messages');
        container.scrollTop = container.scrollHeight;
    }
});

socket.on('salon_change', (data) => {
    enConversationPrivee = false;
    conversationActuelle = null;
    document.getElementById('messages').innerHTML = '';
    salonActuel = data.nouveauSalon;
    document.getElementById('salon-actuel').textContent = `# ${salonActuel}`;
    document.getElementById('btn-retour').style.display = 'none';
    document.getElementById('input-message').placeholder = 'Écrire un message...';
});

// ============================================================
// MESSAGES PRIVÉS (CONVERSATIONS 1-à-1)
// ============================================================

socket.on('message_prive', (data) => {
    if (enConversationPrivee && conversationActuelle && data.conversation_id === conversationActuelle.conversation_id) {
        ajouterMessage(data.auteur, data.contenu, data.date, true, data.est_chiffre);
        const container = document.getElementById('messages');
        container.scrollTop = container.scrollHeight;
    } else {
        const autre = data.auteur === pseudoActuel ? data.destinataire : data.auteur;
        
        if (!conversations[autre]) {
            conversations[autre] = data.conversation_id;
            localStorage.setItem(`conversations_${pseudoActuel}`, JSON.stringify(conversations));
            afficherConversations();
        }
        
        if (data.auteur !== pseudoActuel) {
            alert(`📩 Nouveau message de ${data.auteur}`);
        }
    }
});

socket.on('historique_conversation', (data) => {
    if (enConversationPrivee && conversationActuelle && data.conversation_id === conversationActuelle.conversation_id) {
        const container = document.getElementById('messages');
        container.innerHTML = '';
        data.messages.forEach(msg => {
            ajouterMessage(msg.auteur, msg.contenu, msg.date_envoi, true, msg.est_chiffre);
        });
        container.scrollTop = container.scrollHeight;
    }
});

// ============================================================
// UTILISATEURS CONNECTÉS
// ============================================================

socket.on('utilisateurs_connectes', (users) => {
    const list = document.getElementById('liste-utilisateurs');
    list.innerHTML = '';
    document.getElementById('nb-users').textContent = users.length;

    users.forEach(pseudo => {
        const li = document.createElement('li');
        li.textContent = pseudo;
        li.style.cursor = 'pointer';
        li.style.padding = '6px 10px';
        li.style.borderRadius = '6px';
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';

        // Bouton de révocation (seulement si admin et que ce n'est pas soi-même)
        if (monRole === 'admin' && pseudo !== pseudoActuel) {
            const btnRevoke = document.createElement('button');
            btnRevoke.textContent = '🚫';
            btnRevoke.title = 'Révoquer l\'accès';
            btnRevoke.style.background = '#e94560';
            btnRevoke.style.border = 'none';
            btnRevoke.style.borderRadius = '4px';
            btnRevoke.style.cursor = 'pointer';
            btnRevoke.style.padding = '2px 6px';
            btnRevoke.style.color = '#fff';
            btnRevoke.onclick = (e) => {
                e.stopPropagation(); // Évite d'ouvrir le popup
                if (confirm(`Révoquer l'accès de ${pseudo} ?`)) {
                    socket.emit('revoquer_agent', { pseudo });
                }
            };
            li.appendChild(btnRevoke);
        }

        li.addEventListener('click', (event) => {
            if (pseudo !== pseudoActuel) ouvrirPopupUtilisateur(pseudo, event);
        });

        list.appendChild(li);
    });
});

socket.on('utilisateur_deconnecte', (pseudo) => {
    if (!enConversationPrivee) {
        ajouterMessage('Système', `${pseudo} a quitté le chat.`, new Date().toISOString(), false, false);
    }
});

socket.on('utilisateur_banni', (data) => {
    if (data.pseudo === pseudoActuel) {
        alert('Vous avez été banni.');
        socket.disconnect();
    } else {
        alert(`${data.pseudo} a été banni.`);
    }
});

// ============================================================
// GESTION DES SALONS
// ============================================================

function changerSalon(salon) {
    if (salon === salonActuel && !enConversationPrivee) return;
    
    enConversationPrivee = false;
    conversationActuelle = null;
    document.getElementById('btn-retour').style.display = 'none';
    document.getElementById('input-message').placeholder = 'Écrire un message...';
    
    salonActuel = salon;
    socket.emit('changer_salon', { nouveauSalon: salon });
    
    document.querySelectorAll('.salon-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.salon-btn').forEach(btn => {
        if (btn.textContent.includes(salon)) btn.classList.add('active');
    });
}

function creerSalonPrive() {
    const nom = document.getElementById('input-nouveau-salon').value.trim();
    const invitesInput = document.getElementById('input-invites').value.trim();
    if (!nom) {
        alert('Veuillez entrer un nom pour le salon.');
        return;
    }
    const invites = invitesInput ? invitesInput.split(',').map(s => s.trim()) : [];
    socket.emit('creer_salon_prive', { nomSalon: nom, invites });
}

socket.on('salon_creer', (data) => {
    alert(data.message);
    const salonBtn = document.createElement('button');
    salonBtn.className = 'salon-btn';
    salonBtn.textContent = `# ${data.salon}`;
    salonBtn.onclick = () => changerSalon(data.salon);
    document.getElementById('salons-prives').appendChild(salonBtn);
});

// ============================================================
// ENVOYER UN MESSAGE (PUBLIC OU PRIVÉ) - PATCH E2E
// ============================================================

function envoyerMessage() {
    const input = document.getElementById('input-message');
    const contenu = input.value.trim();
    if (!contenu) return;

    if (enConversationPrivee && conversationActuelle) {
        // ===== MESSAGE PRIVÉ CHIFFRÉ =====
        const contenuChiffre = chiffrer(contenu, conversationActuelle.pseudo);
        
        socket.emit('message', {
            contenu: contenuChiffre,
            destination: conversationActuelle.pseudo,
            conversation_id: conversationActuelle.conversation_id,
            est_chiffre: true
        });
        
        // Affichage optimiste côté expéditeur (on affiche le clair)
        ajouterMessage(pseudoActuel, contenu, new Date().toISOString(), true, false);
        
    } else {
        // ===== MESSAGE PUBLIC CHIFFRÉ =====
        const contenuChiffre = chiffrer(contenu, salonActuel);
        
        socket.emit('message', {
            contenu: contenuChiffre,
            est_chiffre: true
        });
        
        // Affichage optimiste (clair local)
        ajouterMessage(pseudoActuel, contenu, new Date().toISOString(), false, false);
    }

    input.value = '';
}

// ============================================================
// CONVERSATIONS PRIVÉES
// ============================================================

function chargerConversations() {
    const saved = localStorage.getItem(`conversations_${pseudoActuel}`);
    if (saved) {
        conversations = JSON.parse(saved);
    }
    afficherConversations();
}

function afficherConversations() {
    const container = document.getElementById('liste-conversations');
    container.innerHTML = '';
    const pseudos = Object.keys(conversations);
    
    if (pseudos.length === 0) {
        container.innerHTML = '<p style="color: #666; font-size: 13px; padding: 8px 0;">Aucune conversation</p>';
        return;
    }

    pseudos.forEach(pseudo => {
        const div = document.createElement('div');
        div.className = 'conv-item';
        div.textContent = `💬 ${pseudo}`;
        div.style.cssText = `
            padding: 6px 10px;
            border-radius: 6px;
            cursor: pointer;
            color: #ccc;
            transition: background 0.2s;
        `;
        div.addEventListener('mouseenter', () => {
            div.style.backgroundColor = '#0f3460';
        });
        div.addEventListener('mouseleave', () => {
            div.style.backgroundColor = 'transparent';
        });
        div.addEventListener('click', () => {
            ouvrirConversationPrivee(pseudo);
        });
        container.appendChild(div);
    });
}

function ouvrirConversationPrivee(pseudo) {
    const ids = [pseudoActuel, pseudo].sort();
    const conversation_id = `prive_${ids[0]}_${ids[1]}`;

    conversations[pseudo] = conversation_id;
    localStorage.setItem(`conversations_${pseudoActuel}`, JSON.stringify(conversations));
    afficherConversations();

    enConversationPrivee = true;
    conversationActuelle = { pseudo, conversation_id };
    
    document.getElementById('salon-actuel').textContent = `💬 ${pseudo}`;
    document.getElementById('btn-retour').style.display = 'block';
    document.getElementById('messages').innerHTML = '';

    socket.emit('historique_conversation', { conversation_id });

    document.getElementById('input-message').placeholder = `Message privé pour ${pseudo}...`;
}

function retournerSalon() {
    enConversationPrivee = false;
    conversationActuelle = null;
    document.getElementById('salon-actuel').textContent = `# ${salonActuel}`;
    document.getElementById('btn-retour').style.display = 'none';
    document.getElementById('input-message').placeholder = 'Écrire un message...';
    document.getElementById('messages').innerHTML = '';
    socket.emit('changer_salon', { nouveauSalon: salonActuel });
}

// ============================================================
// POPUP UTILISATEUR
// ============================================================

function ouvrirPopupUtilisateur(pseudo, event) {
    if (pseudo === pseudoActuel) {
        alert('C\'est vous !');
        return;
    }
    utilisateurSelectionne = pseudo;
    const popup = document.getElementById('popup-utilisateur');
    document.getElementById('popup-pseudo').textContent = pseudo;
    popup.style.display = 'block';

    const x = Math.min(event.clientX + 10, window.innerWidth - 240);
    const y = Math.min(event.clientY + 10, window.innerHeight - 160);
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
}

function fermerPopupUtilisateur() {
    document.getElementById('popup-utilisateur').style.display = 'none';
    utilisateurSelectionne = null;
}

function discuterPrive() {
    if (!utilisateurSelectionne) return;
    ouvrirConversationPrivee(utilisateurSelectionne);
    fermerPopupUtilisateur();
}

function bloquerUtilisateur() {
    if (!utilisateurSelectionne) return;
    let bloques = JSON.parse(localStorage.getItem('bloques') || '[]');
    if (!bloques.includes(utilisateurSelectionne)) {
        bloques.push(utilisateurSelectionne);
        localStorage.setItem('bloques', JSON.stringify(bloques));
        alert(`🚫 ${utilisateurSelectionne} a été bloqué.`);
    } else {
        alert(`⚠️ ${utilisateurSelectionne} est déjà bloqué.`);
    }
    fermerPopupUtilisateur();
}

function voirProfil() {
    if (!utilisateurSelectionne) return;
    document.getElementById('profil-pseudo').textContent = utilisateurSelectionne;
    document.getElementById('profil-statut').textContent = '● En ligne';
    document.getElementById('profil-date').textContent = new Date().toLocaleDateString();
    document.getElementById('popup-profil').style.display = 'block';
    fermerPopupUtilisateur();
}

function fermerPopupProfil() {
    document.getElementById('popup-profil').style.display = 'none';
}

function bannirUtilisateur(pseudo) {
    if (confirm(`Bannir ${pseudo} ?`)) {
        socket.emit('bannir_utilisateur', { pseudo });
    }
}

// ============================================================
// SUPPRIMER UN MESSAGE
// ============================================================

function supprimerMessage(id) {
    if (confirm('Supprimer ce message ?')) {
        socket.emit('supprimer_message', { messageId: id });
    }
}

socket.on('message_supprime', (data) => {
    const msgs = document.querySelectorAll('.message');
    msgs.forEach(el => {
        if (el.dataset.id === data.messageId.toString()) {
            el.style.display = 'none';
        }
    });
});

// ============================================================
// AFFICHER UN MESSAGE - PATCH E2E
// ============================================================

function ajouterMessage(auteur, contenu, date, estPrive = false, estChiffre = false) {
    const container = document.getElementById('messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';
    
    if (auteur === pseudoActuel) {
        msgDiv.classList.add('message-moi');
    }
    if (estPrive) {
        msgDiv.classList.add('message-prive');
    }

    // Déchiffrement si le message vient du serveur (estChiffre = true)
    let contenuAffiche = contenu;
    if (estChiffre) {
        const cle = estPrive 
            ? (auteur === pseudoActuel ? conversationActuelle?.pseudo : auteur)
            : salonActuel;
        contenuAffiche = dechiffrer(contenu, cle);
    }

    const dateObj = new Date(date);
    const dateStr = dateObj.toLocaleTimeString();

    msgDiv.innerHTML = `
        <div class="message-infos">${auteur}</div>
        ${contenuAffiche}
        <div class="message-date">${dateStr}</div>
    `;

    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}

// ============================================================
// PARAMÈTRES (ROUE DENTÉE)
// ============================================================

function ouvrirParametres() {
    document.getElementById('panel-parametres').style.display = 'block';
}

function fermerParametres() {
    document.getElementById('panel-parametres').style.display = 'none';
}

function changerTheme(theme) {
    const body = document.body;
    const container = document.getElementById('chat-container');
    const sidebar = document.getElementById('sidebar-left');
    const chat = document.getElementById('chat-area');

    body.style.backgroundColor = '';
    container.style.backgroundColor = '';
    sidebar.style.backgroundColor = '';
    chat.style.backgroundColor = '';
    document.getElementById('messages').style.backgroundColor = '';
    document.getElementById('input-area').style.backgroundColor = '';

    if (theme === 'sombre') {
        body.style.backgroundColor = '#1a1a2e';
        container.style.backgroundColor = '#16213e';
        sidebar.style.backgroundColor = '#1a1a2e';
        chat.style.backgroundColor = '#1a1a2e';
        document.getElementById('messages').style.backgroundColor = '#1a1a2e';
        document.getElementById('input-area').style.backgroundColor = '#0f3460';
    } else if (theme === 'clair') {
        body.style.backgroundColor = '#f0f0f0';
        container.style.backgroundColor = '#ffffff';
        sidebar.style.backgroundColor = '#f8f9fa';
        chat.style.backgroundColor = '#ffffff';
        document.getElementById('messages').style.backgroundColor = '#ffffff';
        document.getElementById('input-area').style.backgroundColor = '#e9ecef';
    } else if (theme === 'bleu') {
        body.style.backgroundColor = '#0a192f';
        container.style.backgroundColor = '#0f3460';
        sidebar.style.backgroundColor = '#0a192f';
        chat.style.backgroundColor = '#0a192f';
        document.getElementById('messages').style.backgroundColor = '#0a192f';
        document.getElementById('input-area').style.backgroundColor = '#0f3460';
    }
    fermerParametres();
}

function changerCouleur(couleur) {
    const style = document.createElement('style');
    style.id = 'couleur-perso';
    style.textContent = `
        .message-moi {
            background-color: ${couleur} !important;
        }
    `;
    const oldStyle = document.getElementById('couleur-perso');
    if (oldStyle) oldStyle.remove();
    document.head.appendChild(style);
    fermerParametres();
}

// ============================================================
// DÉCONNEXION
// ============================================================

function deconnexion() {
    socket.emit('deconnexion');
    document.getElementById('chat-container').style.display = 'none';
    document.getElementById('auth-container').style.display = 'block';
    pseudoActuel = null;
    conversationActuelle = null;
    enConversationPrivee = false;
}

// ============================================================
// TOUCHE ENTREE
// ============================================================

document.getElementById('input-message').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') envoyerMessage();
});

function showTab(tab) {
    document.querySelectorAll('.auth-form').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#auth-tabs button').forEach(el => el.classList.remove('active'));
    
    // Cacher le QR code si on change d'onglet
    document.getElementById('qrcode-container').style.display = 'none';

    if (tab === 'connexion') {
        document.getElementById('form-connexion').classList.add('active');
        document.getElementById('tab-connexion').classList.add('active');
    } else {
        document.getElementById('form-inscription').classList.add('active');
        document.getElementById('tab-inscription').classList.add('active');
    }
}

socket.on('session_revoquee', (data) => {
    alert('⛔ ' + data.message);
    deconnexion(); // Déconnecte l'utilisateur côté client
});

socket.on('utilisateur_revoque', (data) => {
    ajouterMessage('Système', `${data.pseudo} a été révoqué.`, new Date().toISOString(), false, false);
});

socket.on('revocation_reussie', (data) => {
    alert(`✅ L'accès de ${data.pseudo} a été révoqué.`);
});