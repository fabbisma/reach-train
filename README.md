# Eco Rail Planner — V0.3.1 Global Beta

Clean full-project baseline rebuilt from the stable V0.2.8.1 UI/map behavior plus the V0.3 dynamic-station engine.

## Canonical source tree

There is exactly one multimodal search engine:

```
lib/search-engine.ts
```

Do not keep or create a second `search-engine.ts` at the repository root.

Main source files:

```
app/
  api/search/route.ts
  globals.css
  layout.tsx
  page.tsx
components/
  rail-map.tsx
  search-form.tsx
lib/
  providers/
    google-routes.ts
    mock.ts
    navitia.ts
    transitous-locations.ts
    transitous.ts
    types.ts
  search-engine.ts
  stations.ts
  types.ts
  utils.ts
```

## V0.3 Global Beta

- Free-form origin/destination resolution through Transitous/MOTIS geocoding.
- Dynamic rail-station discovery around the origin and along the corridor.
- Transitous/MOTIS is the main rail provider; Navitia remains a France fallback.
- Candidate set capped to keep calculations responsive.
- Day-of / previous-day recommendations.
- Top 3 candidates per criterion with station deduplication.
- Clear train segments and transfers.
- Comparison against 100% car.
- Leaflet mini-map with car and rail geometry when available.
- Time-zone-aware request handling.

Coverage depends on the public transport data available in Transitous/MOTIS for the region tested.

## Environment variables

See `.env.example`. Existing Vercel environment variables can be kept.


## V0.3.1

- Validation obligatoire du départ et de la destination via l’autocomplétion Transitous/MOTIS.
- Les coordonnées sélectionnées deviennent la source de vérité du calcul.
- Les suggestions affichent davantage de contexte administratif pour éviter les homonymes.
- Le routage ferroviaire part du stop MOTIS exact lorsqu’il est disponible.
- Rayon de 6 km autour de la destination pour rattacher une ville/adresse à une gare voisine.
- Dernier kilomètre piéton autorisé jusqu’à 60 min et élargissement automatique de 3 à 5 correspondances si aucune solution n’est trouvée.
