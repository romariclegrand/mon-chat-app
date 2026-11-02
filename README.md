# ChatApp Souverain - Messagerie Instantanée pour l'Administration

## Concept
Messagerie instantanée open source, sécurisée et hébergeable sur l'infrastructure de l'État. Elle permet aux agents publics d'échanger des messages, des fichiers et des groupes, avec un chiffrement de bout en bout.

## Architecture
- **Backend** : Node.js + Express + Socket.io
- **Base de données** : SQLite
- **Frontend** : HTML/CSS/JS pur
- **Chiffrement** : AES-256 via CryptoJS (côté client)
- **Authentification** : bcrypt + code 2FA à 6 chiffres
- **Révocation** : Bouton admin + invalidation des sessions

## Technologies et Licences
- Node.js (MIT)
- Express (MIT)
- Socket.io (MIT)
- SQLite (Domaine Public)
- bcrypt (MIT)
- crypto-js (MIT)

## Niveau d'engagement Open Source
**Étendre et adapter** : Le projet est basé sur une architecture Node.js/Socket.io éprouvée. Nous avons ajouté une couche de chiffrement E2E et un système de révocation.

## Instructions d'installation
1. Cloner le dépôt : `git clone [lien]`
2. Installer les dépendances : `npm install`
3. Lancer le serveur : `node server.js`
4. Ouvrir `http://localhost:3000`

### Avec Docker (recommandé)
```bash
docker-compose up --build