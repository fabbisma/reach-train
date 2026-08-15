EcoRail Planner V0.2.7.2 hotfix

Remplacer dans GitHub exactement :
- lib/types.ts
- lib/search-engine.ts

Ce correctif synchronise SearchResponse.directCar avec le retour de search-engine.ts.
Il corrige l'erreur Vercel TS2741: Property 'directCar' is missing ... but required in type 'SearchResponse'.
