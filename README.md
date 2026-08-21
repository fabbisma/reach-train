# Eco Rail Planner — V0.3.5.1 Global Beta

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
    google-places.ts
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

- Origin/destination autocomplete through Google Places API (New) when configured, with Transitous fallback.
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


## Évolutions récentes

### V0.3.1
- Validation obligatoire du départ et de la destination via l’autocomplétion Transitous/MOTIS.
- Les coordonnées sélectionnées deviennent la source de vérité du calcul.
- Routage depuis le stop MOTIS exact lorsqu’il est disponible.
- Rayon autour de la destination et élargissement automatique des correspondances si nécessaire.

### V0.3.2
- Transit après la gare : rail + RER/métro + tram + bus, avec au moins un segment ferroviaire obligatoire.
- Filtrage des solutions de la veille dominées ou excessivement longues.

### V0.3.3
- Plafond dur : une option multimodale est masquée si son temps total dépasse 150 % du trajet 100 % voiture.
- Mini-carte Leaflet pleinement interactive : zoom, molette, pincement tactile et déplacement.

### V0.3.4
- Une proposition est exclue si l’accès voiture à la gare dépasse 60 % de la distance du trajet 100 % voiture.
- Le plafond de 150 % du temps voiture reste actif.
- La distance approximative entre le dernier arrêt de transport public et l’adresse finale est affichée.
- La carte distingue le dernier arrêt et l’adresse finale lorsqu’ils ne coïncident pas.

### V0.3.5.1
- Autocomplétion départ/destination via Google Places API (New) quand `GOOGLE_PLACES_API_KEY` ou `GOOGLE_MAPS_API_KEY` est configurée.
- Sélection Google résolue en coordonnées exactes avant le calcul ; Transitous reste utilisé comme fallback et pour enrichir le fuseau horaire.
- Suppression du choix électrique/thermique : le type de véhicule n’influence plus l’algorithme.
- Coût et CO₂ restent des estimations sur un profil voiture générique.
- Les champs de départ/destination sont vides au chargement : l’utilisateur sélectionne explicitement une suggestion.
