# Penalty League

Duel de tirs au but en ligne, à deux, chacun sur son appareil.

**Jouer : https://penaltyleague.web.app**

Ouvre le lien, entre un pseudo, puis :

- **« Chercher un adversaire »** : tu affrontes automatiquement le premier joueur qui cherche aussi.
- **« Créer un salon »** pour jouer avec un ami : donne-lui le code à 4 caractères, il le saisit et clique sur « Rejoindre ».

Le classement de l'accueil compte les matchs terminés, par pseudo. Quitter un
match en cours (bouton « Abandonner », onglet fermé, connexion perdue) compte
comme une défaite, et comme une victoire pour l'adversaire.

## Règles

- 5 tirs chacun, en alternance : on est tour à tour tireur et gardien.
- Le tireur et le gardien choisissent en secret gauche, centre ou droite. Même zone : arrêt. Sinon : but.
- 10 secondes pour choisir. Tireur trop lent : tir raté. Gardien trop lent : but.
- Le match s'arrête dès qu'un joueur ne peut plus être rattrapé. Égalité après 5 tirs : mort subite.
- En cas de revanche, c'est l'autre joueur qui tire en premier.

## Comment ça marche

Le site est hébergé sur Firebase (plan gratuit) : Hosting pour les pages,
Realtime Database pour les parties et les résultats, connexion anonyme.
Il n'y a pas de serveur : les règles de `database.rules.json` jouent l'arbitre
(choix secrets jusqu'à ce que les deux joueurs aient choisi, chrono de 10 s,
tirs dans l'ordre, revanche seulement si les deux la demandent).

Chaque push sur `main` lance les tests puis déploie le site
(`.github/workflows/deploy.yml`).

## Développer en local

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent, et Java 11 ou plus
récent (pour les émulateurs Firebase).

```bash
git clone https://github.com/MadjidSahki/PenaltyLocal.git
cd PenaltyLocal
npm install
npm start
```

`npm start` lance une copie locale de Firebase (rien n'est envoyé en ligne).
Ouvre http://127.0.0.1:5002 dans deux onglets pour jouer contre toi-même.

Tests :

```bash
npm test            # logique du match et classement
npm run test:rules  # règles de sécurité, dans l'émulateur
```
