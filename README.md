# EcoRail Planner — V0.1.5

MVP d'un planificateur multimodal qui choisit automatiquement une gare stratégique entre le départ et la destination, puis calcule l'heure conseillée de départ en voiture.

## Ce qui fonctionne déjà

- Mode **Arriver avant** et **Partir vers**.
- Sélection automatique de gares candidates.
- Limite de temps de conduite jusqu'à la gare.
- Calcul voiture → gare → marge → train → destination.
- Heure de départ conseillée calculée à rebours en mode `arriveBy`.
- Élimination des solutions dominées (Pareto temps / CO₂ / coût).
- Labels : recommandé, plus rapide, CO₂ mini, moins cher.
- Mode démo sans aucune clé API.
- Providers prêts pour Google Routes et Navitia.

## Démarrer en local

```bash
npm install
npm run dev
```

Puis ouvrir `http://localhost:3000`.

## Déployer sur Vercel

Le projet utilise Next.js 16.3.1 (App Router) et React 19.2.4. Les horaires saisis sont interprétés en Europe/Paris pour le MVP France.

Le projet est un Next.js App Router standard. Une fois le dépôt GitHub importé dans Vercel, chaque push déclenche un déploiement.

## Mode réel

Copier `.env.example` vers `.env.local` et ajouter :

```bash
NAVITIA_TOKEN=...
GOOGLE_MAPS_API_KEY=...
```

Sans ces variables, l'application utilise automatiquement des providers simulés.

### Important pour V0.1

Le provider Navitia actuel est volontairement minimal : il utilise les coordonnées de la gare et de la destination. Avant production, il faudra :

1. ajouter une vraie géocodification/autocomplétion pour toutes les adresses ;
2. vérifier le mapping des distances ferroviaires selon les réponses Navitia ;
3. charger la liste complète des gares SNCF depuis GTFS ;
4. séparer temps de marche/parking et marge de sécurité par gare ;
5. remplacer les estimations coût/CO₂ par des sources réelles ;
6. ajouter la voiture seule comme référence directe dans le résultat.

## Structure

```text
app/
  api/search/route.ts       API POST /api/search
  page.tsx                  écran principal
components/
  search-form.tsx           formulaire + résultats
lib/
  search-engine.ts          moteur d'optimisation
  stations.ts               gares / lieux démo
  providers/
    mock.ts                 mode démo
    google-routes.ts        trajet routier réel
    navitia.ts              trajet ferroviaire réel
```


## V0.1.3

- Ne coupe plus la liste des gares trop tôt avant le calcul routier.
- Conserve la frontière Pareto mais complète l'affichage jusqu'à 6 alternatives utiles pendant le MVP.
- Affiche le nombre de gares réellement viables avec la limite de conduite choisie.
- Corrige notamment le test Courlaoux → Düsseldorf qui pouvait ne montrer que Dijon et Besançon.


## V0.1.3 — hubs stratégiques hors rayon

Pour les trajets internationaux, `maxDriveMinutes` est traité comme une préférence forte. Le moteur peut tester quelques grandes gares jusqu'à 120 minutes au-delà de cette préférence si elles sont susceptibles d'ouvrir une meilleure liaison ferroviaire. Ces propositions sont clairement signalées dans l'interface.

## V0.1.4 — premier test API réel

- Pour les destinations hors de France, Transitous/MOTIS est activé automatiquement sur Vercel grâce à l'URL publique du projet utilisée comme contact `User-Agent`.
- Le mode de recherche `Arriver avant` utilise `arriveBy=true` sur l'API MOTIS v6.
- L'interface distingue maintenant clairement les providers réels et simulés.
- `GOOGLE_MAPS_API_KEY` est facultative pour le premier test : sans elle, le rail est réel et la route voiture reste simulée (`mode hybride`).
- Avec `GOOGLE_MAPS_API_KEY`, le test Courlaoux → Düsseldorf passe en données réelles pour le rail et la route.
- Le nombre de requêtes Transitous est volontairement limité à 6 gares normales + 3 hubs stratégiques au maximum.


## V0.1.5 — filtre de correspondances

- Nouveau champ **Correspondances max**, réglé à **1** par défaut.
- `0` = trajet ferroviaire direct uniquement.
- Valeurs proposées : 0, 1, 2 ou 3 correspondances.
- Le filtre est envoyé directement aux providers ferroviaires (Transitous/MOTIS et Navitia), puis vérifié une seconde fois dans le provider.
