# TCL Live

TCL Live est une application web moderne permettant de suivre en temps réel le réseau de transports en commun de Lyon (TCL).

L'application est accessible en ligne à l'adresse suivante : **[tcl-live.virgil-gayte.me](https://tcl-live.virgil-gayte.me)**

## Fonctionnalités

- **Suivi en temps réel** : Visualisez la position exacte des bus et tramways sur une carte interactive.
- **Métro & Funiculaire** : Visualisez les tracés et les arrêts des lignes de métro (A, B, C, D) et funiculaires (F1, F2).
- **Informations aux arrêts** : Consultez les prochains passages en temps réel pour chaque arrêt, incluant le métro.
- **Favoris** : Enregistrez vos lignes habituelles pour y accéder rapidement.
- **Filtrage intelligent** : Filtrez les lignes par catégorie (Métro, Tram, Bus), par proximité ou par favoris.
- **Alertes Trafic** : Restez informé des incidents et perturbations sur le réseau.
- **Géolocalisation** : Trouvez facilement les arrêts et les lignes à proximité.

## Utilisation des données

Le projet utilise les données ouvertes de la Métropole de Lyon via la plateforme [Data Grand Lyon](https://data.grandlyon.com/) :
- Positions en temps réel (SIRI Lite)
- Tracés des lignes (WFS)
- Liste des arrêts et horaires de passage

## Installation locale

1. Clonez le dépôt.
2. Installez les dépendances : `npm install`
3. Configurez votre fichier `.env` avec vos identifiants Data Grand Lyon.
4. Lancez le serveur : `npm start`

## Licence

Ce projet est la propriété de Virgil Gayte.
