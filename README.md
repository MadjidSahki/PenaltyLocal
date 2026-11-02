# Penalty 1v1

Duel de tirs au but à deux, chacun sur son appareil, dans le navigateur.
Le serveur tourne sur ton PC ; l'adversaire ouvre simplement une adresse.

## Lancer

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent.

```bash
git clone https://github.com/MadjidSahki/PenaltyLocal.git
cd PenaltyLocal
npm install
npm start
```

`npm install` n'est nécessaire qu'une fois. Les fois suivantes, `npm start` suffit.

Le serveur affiche les adresses à utiliser, par exemple :

```
Sur ce PC : http://localhost:3000
Réseau local : http://192.168.1.20:3000
```

Pour changer de port : `PORT=4000 npm start`. Pour arrêter : `Ctrl+C`.

## Jouer

1. Chacun ouvre l'adresse dans son navigateur et entre un pseudo.
2. L'un clique sur « Créer un salon » et donne le code à 4 caractères à l'autre.
3. L'autre entre le code et clique sur « Rejoindre » : le match commence.

## Jouer avec quelqu'un hors de ton réseau

1. Sur ta box, redirige le port TCP `3000` vers l'adresse « Réseau local » de ton PC.
2. Au premier lancement, macOS peut demander d'autoriser les connexions entrantes pour Node : accepte.
3. Donne à ton adversaire `http://<ton IP publique>:3000`. Ton IP publique est visible dans l'interface de ta box.

Tant que le serveur tourne, il est accessible depuis Internet : arrête-le après la partie.

## Règles

- 5 tirs chacun, en alternance : on est tour à tour tireur et gardien.
- Le tireur et le gardien choisissent en secret gauche, centre ou droite. Même zone : arrêt. Sinon : but.
- 10 secondes pour choisir. Tireur trop lent : tir raté. Gardien trop lent : but.
- Le match s'arrête dès qu'un joueur ne peut plus être rattrapé. Égalité après 5 tirs : mort subite.

## Tests

```bash
npm test
```
