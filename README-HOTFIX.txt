EcoRail Planner V0.2.8.1 — hotfix liaison voiture sur la mini-carte

Remplacer TOUS les fichiers de cette archive en conservant exactement leurs chemins.

Fichiers :
- components/rail-map.tsx
- components/search-form.tsx
- app/globals.css
- lib/types.ts
- lib/providers/google-routes.ts
- lib/providers/mock.ts

Nouveautés :
- la mini-carte affiche l’origine puis la liaison voiture jusqu’à la gare ;
- avec Google Routes actif, le vrai tracé routier est utilisé via la polyline Compute Routes ;
- en mode simulé, fallback par liaison directe origine → gare ;
- voiture en pointillés, train en trait plein, avec légende ;
- le zoom englobe voiture + train ;
- badge interface V0.2.8.1.

Aucune nouvelle dépendance n’est ajoutée par rapport à V0.2.8.
