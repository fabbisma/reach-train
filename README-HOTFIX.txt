EcoRail Planner V0.2.8 — hotfix carte réelle

Remplacer/ajouter TOUS les fichiers de cette archive en conservant exactement leurs chemins.

Fichiers :
- package.json                         (ajoute Leaflet 1.9.4)
- app/layout.tsx                      (charge le CSS Leaflet)
- app/globals.css                     (styles de la vraie mini-carte)
- components/search-form.tsx          (utilise la nouvelle carte, badge V0.2.8)
- components/rail-map.tsx             (NOUVEAU : carte Leaflet/OpenStreetMap)
- lib/types.ts                        (géométrie de segment)
- lib/providers/transitous.ts         (récupère et décode legGeometry MOTIS)
- lib/providers/navitia.ts            (utilise geojson si disponible)

Important : components/rail-map.tsx est un NOUVEAU fichier à créer dans GitHub.
Vercel installera automatiquement la nouvelle dépendance Leaflet à partir de package.json.

Comportement :
- fond de carte OpenStreetMap réel ;
- zoom auto sur le trajet ;
- marqueurs gare de départ / correspondances / arrivée ;
- tracé MOTIS détaillé lorsque Transitous fournit legGeometry ;
- sinon fallback sur les coordonnées des gares.
