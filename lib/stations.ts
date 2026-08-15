import type { Place, Station } from "@/lib/types";

export const STATIONS: Station[] = [
  { id: "fr-lons", name: "Lons-le-Saunier", lat: 46.6754, lng: 5.5502, importance: 0.45 },
  { id: "fr-dole", name: "Dole", lat: 47.0962, lng: 5.4886, importance: 0.62 },
  { id: "fr-bourg", name: "Bourg-en-Bresse", lat: 46.2001, lng: 5.2149, importance: 0.72 },
  { id: "fr-macon-ville", name: "Mâcon-Ville", lat: 46.3065, lng: 4.8257, importance: 0.68 },
  { id: "fr-macon-tgv", name: "Mâcon-Loché TGV", lat: 46.2827, lng: 4.7784, importance: 0.83 },
  { id: "fr-dijon", name: "Dijon-Ville", lat: 47.3234, lng: 5.0271, importance: 0.9 },
  { id: "fr-besancon-tgv", name: "Besançon Franche-Comté TGV", lat: 47.3077, lng: 5.9569, importance: 0.86 },
  { id: "fr-creusot-tgv", name: "Le Creusot Montceau TGV", lat: 46.7655, lng: 4.4995, importance: 0.84 },
  { id: "fr-lyon-part-dieu", name: "Lyon Part-Dieu", lat: 45.7606, lng: 4.8595, importance: 1.0 },
  { id: "fr-belfort-tgv", name: "Belfort-Montbéliard TGV", lat: 47.5861, lng: 6.8971, importance: 0.86 },
  { id: "fr-mulhouse", name: "Mulhouse-Ville", lat: 47.7418, lng: 7.3430, importance: 0.88 },
  { id: "fr-strasbourg", name: "Strasbourg", lat: 48.5850, lng: 7.7346, importance: 0.98 },
  { id: "ch-basel-sbb", name: "Bâle SBB", lat: 47.5476, lng: 7.5896, importance: 0.95 }
];

const KNOWN_PLACES: Record<string, Place> = {
  "courlaoux": { name: "Courlaoux", lat: 46.6681, lng: 5.4611, countryCode: "FR" },
  "lons-le-saunier": { name: "Lons-le-Saunier", lat: 46.6753, lng: 5.5554, countryCode: "FR" },
  "lons le saunier": { name: "Lons-le-Saunier", lat: 46.6753, lng: 5.5554, countryCode: "FR" },
  "paris": { name: "Paris", lat: 48.8566, lng: 2.3522, countryCode: "FR" },
  "lyon": { name: "Lyon", lat: 45.764, lng: 4.8357, countryCode: "FR" },
  "bordeaux": { name: "Bordeaux", lat: 44.8378, lng: -0.5792, countryCode: "FR" },
  "seignosse": { name: "Seignosse", lat: 43.689, lng: -1.3746, countryCode: "FR" },
  "villefranche-sur-saone": { name: "Villefranche-sur-Saône", lat: 45.989, lng: 4.7197, countryCode: "FR" },
  "villefranche sur saone": { name: "Villefranche-sur-Saône", lat: 45.989, lng: 4.7197, countryCode: "FR" },
  "dusseldorf": { name: "Düsseldorf", lat: 51.2277, lng: 6.7735, countryCode: "DE" },
  "düsseldorf": { name: "Düsseldorf", lat: 51.2277, lng: 6.7735, countryCode: "DE" }
};

function normalize(value: string) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function resolveKnownPlace(query: string): Place | null {
  const key = normalize(query);
  const direct = KNOWN_PLACES[key];
  if (direct) return direct;

  const fuzzy = Object.entries(KNOWN_PLACES).find(([candidate]) => key.includes(candidate) || candidate.includes(key));
  return fuzzy?.[1] ?? null;
}
