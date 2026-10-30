// ============================================================
// CLIENT SOCKET.IO - MESSAGERIE INSTANTANÉE MULTI-UTILISATEUR
// ============================================================

// ===== VARIABLES GLOBALES =====
const socket = io();
let pseudoActuel = null;
let salonActuel = 'general';
let conversationActuelle = null; // { pseudo: 'roland', conversation_id: 'prive_romantic_roland' }
let conversations = {}; // { 'pseudo': 'conversation_id' }
let utilisateurSelectionne = null;
let enConversationPrivee = false; // Nouvelle variable

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
    const errorEl = document.getElementById('login-error');

    if (!pseudo || !password) {
        errorEl.textContent = 'Veuillez remplir tous les champs.';
        return;
    }

    socket.emit('connexion', { pseudo, password });
}

// ============================================================
// SOCKET EVENTS (AUTH)
// ============================================================

socket.on('inscription_reussie', (data) => {
    document.getElementById('register-error').textContent = '';
    document.getElementById('register-pseudo').value = '';
    document.getElementById('register-password').value = '';
    alert(data.message);
    showTab('connexion');
});

socket.on('connexion_reussie', (data) => {
    pseudoActuel = data.pseudo;
    document.getElementById('pseudo-display').textContent = pseudoActuel;
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
    // Ne charger l'historique que si on est dans un salon (pas en conversation privée)
    if (!enConversationPrivee) {
        const container = document.getElementById('messages');
        container.innerHTML = '';
        messagesData.forEach(msg => {
            ajouterMessage(msg.auteur, msg.contenu, msg.date_envoi, false);
        });
        container.scrollTop = container.scrollHeight;
    }
});

socket.on('nouveau_message', (data) => {
    // Ne pas afficher les messages publics si on est en conversation privée
    if (!enConversationPrivee) {
        ajouterMessage(data.auteur, data.contenu, data.date, false);
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
    // Vérifier si on est dans la bonne conversation
    if (enConversationPrivee && conversationActuelle && data.conversation_id === conversationActuelle.conversation_id) {
        ajouterMessage(data.auteur, data.contenu, data.date, true);
        const container = document.getElementById('messages');
        container.scrollTop = container.scrollHeight;
    } else {
        // Nouveau message d'une autre conversation
        const autre = data.auteur === pseudoActuel ? data.destinataire : data.auteur;
        
        // Sauvegarder la conversation si elle n'existe pas
        if (!conversations[autre]) {
            conversations[autre] = data.conversation_id;
            localStorage.setItem(`conversations_${pseudoActuel}`, JSON.stringify(conversations));
            afficherConversations();
        }
        
        // Notification (seulement si c'est pas moi)
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
            ajouterMessage(msg.auteur, msg.contenu, msg.date_envoi, true);
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
        li.style.transition = 'background-color 0.2s';

        li.addEventListener('mouseenter', () => {
            li.style.backgroundColor = '#0f3460';
        });
        li.addEventListener('mouseleave', () => {
            li.style.backgroundColor = 'transparent';
        });

        li.addEventListener('click', (event) => {
            if (pseudo !== pseudoActuel) {
                ouvrirPopupUtilisateur(pseudo, event);
            } else {
                alert('C\'est vous !');
            }
        });

        list.appendChild(li);
    });
});

socket.on('nouvel_utilisateur', (pseudo) => {
    if (!enConversationPrivee) {
        ajouterMessage('Système', `${pseudo} a rejoint le chat.`, new Date().toISOString(), false);
    }
});

socket.on('utilisateur_deconnecte', (pseudo) => {
    if (!enConversationPrivee) {
        ajouterMessage('Système', `${pseudo} a quitté le chat.`, new Date().toISOString(), false);
    }
});

socket.on('utilisateur_banni', (data) => {
    alert(`${data.pseudo} a été banni.`);
});

// ============================================================
// GESTION DES SALONS
// ============================================================

function changerSalon(salon) {
    if (salon === salonActuel && !enConversationPrivee) return;
    
    // Si on est dans une conversation privée, on la ferme
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
// ENVOYER UN MESSAGE (PUBLIC OU PRIVÉ)
// ============================================================

function envoyerMessage() {
    const input = document.getElementById('input-message');
    const contenu = input.value.trim();
    if (!contenu) return;

    if (enConversationPrivee && conversationActuelle) {
        // ===== MESSAGE PRIVÉ (1-à-1) =====
        socket.emit('message', {
            contenu,
            destination: conversationActuelle.pseudo,
            conversation_id: conversationActuelle.conversation_id
        });
        // ❌ PLUS D'AFFICHAGE OPTIMISTE (le serveur renverra le message)
        // ✅ On vide juste l'input
    } else {
        // ===== MESSAGE PUBLIC (dans un salon) =====
        socket.emit('message', { contenu });
        // ✅ Affichage optimiste pour les messages publics (OK)
        ajouterMessage(pseudoActuel, contenu, new Date().toISOString(), false);
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
    // Générer un ID de conversation unique (trié alphabétiquement)
    const ids = [pseudoActuel, pseudo].sort();
    const conversation_id = `prive_${ids[0]}_${ids[1]}`;

    // Sauvegarder la conversation
    conversations[pseudo] = conversation_id;
    localStorage.setItem(`conversations_${pseudoActuel}`, JSON.stringify(conversations));
    afficherConversations();

    // Mettre à jour l'interface
    enConversationPrivee = true;
    conversationActuelle = { pseudo, conversation_id };
    
    // ✅ CORRECTION ICI : 💬 au lieu de #
    document.getElementById('salon-actuel').textContent = `💬 ${pseudo}`;
    document.getElementById('btn-retour').style.display = 'block';
    document.getElementById('messages').innerHTML = '';

    // Charger l'historique
    socket.emit('historique_conversation', { conversation_id });

    // Changer le placeholder de l'input
    document.getElementById('input-message').placeholder = `Message privé pour ${pseudo}...`;
}

function retournerSalon() {
    enConversationPrivee = false;
    conversationActuelle = null;
    document.getElementById('salon-actuel').textContent = `# ${salonActuel}`;
    document.getElementById('btn-retour').style.display = 'none';
    document.getElementById('input-message').placeholder = 'Écrire un message...';
    document.getElementById('messages').innerHTML = '';
    // Recharger l'historique du salon
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

    // Positionner la popup
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
// AFFICHER UN MESSAGE
// ============================================================

function ajouterMessage(auteur, contenu, date, estPrive = false) {
    const container = document.getElementById('messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';
    
    if (auteur === pseudoActuel) {
        msgDiv.classList.add('message-moi');
    }
    if (estPrive) {
        msgDiv.classList.add('message-prive');
    }

    const dateObj = new Date(date);
    const dateStr = dateObj.toLocaleTimeString();

    msgDiv.innerHTML = `
        <div class="message-infos">${auteur}</div>
        ${contenu}
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