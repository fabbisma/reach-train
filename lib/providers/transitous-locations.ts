import type { Place, Station } from "@/lib/types";
import { haversineKm } from "@/lib/utils";

type GeocodeMatch = {
  type?: "ADDRESS" | "PLACE" | "STOP";
  name?: string;
  id?: string;
  lat?: number;
  lon?: number;
  country?: string;
  tz?: string;
  score?: number;
  importance?: number;
  modes?: string[];
};

type MapStop = {
  name?: string;
  stopId?: string;
  parentId?: string;
  importance?: number;
  lat?: number;
  lon?: number;
  tz?: string;
};

const API_ROOT = "https://api.transitous.org/api";
const RAIL_DISCOVERY_RADIUS_KM = 68;
const MAX_CORRIDOR_DISTANCE_KM = 440;
const SAMPLE_COUNT = 4;

function normalize(value: string) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function userAgent(contact: string) {
  return `EcoRailPlanner/0.3.0.1 (${contact})`;
}

function interpolate(a: Place, b: Place, fraction: number): { lat: number; lng: number } {
  let deltaLng = b.lng - a.lng;
  if (deltaLng > 180) deltaLng -= 360;
  if (deltaLng < -180) deltaLng += 360;
  let lng = a.lng + deltaLng * fraction;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return {
    lat: a.lat + (b.lat - a.lat) * fraction,
    lng
  };
}

function boundingBox(center: { lat: number; lng: number }, radiusKm: number) {
  const latDelta = radiusKm / 111.32;
  const cos = Math.max(0.15, Math.cos((center.lat * Math.PI) / 180));
  const lngDelta = Math.min(12, radiusKm / (111.32 * cos));
  return {
    minLat: Math.max(-89.9, center.lat - latDelta),
    maxLat: Math.min(89.9, center.lat + latDelta),
    minLng: Math.max(-179.9, center.lng - lngDelta),
    maxLng: Math.min(179.9, center.lng + lngDelta)
  };
}

function placeMatchRank(match: GeocodeMatch, query: string) {
  const wanted = normalize(query);
  const name = normalize(match.name ?? "");
  const exact = name === wanted ? 1000 : name.startsWith(wanted) || wanted.startsWith(name) ? 300 : 0;
  const stationWords = /\b(gare|station|hbf|bahnhof|stazione|estacion|estação|central|terminus)\b/i.test(query);
  const typeBonus = stationWords
    ? match.type === "STOP" ? 80 : 0
    : match.type === "PLACE" ? 45 : match.type === "ADDRESS" ? 30 : 10;
  return exact + typeBonus + (match.score ?? 0);
}

export class TransitousLocationProvider {
  constructor(private readonly contact: string) {}

  async resolvePlace(queryText: string): Promise<Place | null> {
    const query = new URLSearchParams({
      text: queryText,
      type: "ADDRESS,PLACE,STOP",
      language: "fr,en",
      numResults: "8"
    });

    const response = await fetch(`${API_ROOT}/v1/geocode?${query.toString()}`, {
      headers: { "User-Agent": userAgent(this.contact) },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Transitous geocode error ${response.status}`);

    const matches = (await response.json()) as GeocodeMatch[];
    const selected = [...matches]
      .filter((item) => item.name && Number.isFinite(item.lat) && Number.isFinite(item.lon))
      .sort((a, b) => placeMatchRank(b, queryText) - placeMatchRank(a, queryText))[0];

    if (!selected?.name || selected.lat == null || selected.lon == null) return null;
    return {
      name: selected.name,
      lat: selected.lat,
      lng: selected.lon,
      countryCode: selected.country?.toUpperCase(),
      timeZone: selected.tz
    };
  }

  private async stopsInBox(center: { lat: number; lng: number }): Promise<Station[]> {
    const box = boundingBox(center, RAIL_DISCOVERY_RADIUS_KM);
    const query = new URLSearchParams({
      min: `${box.minLat},${box.minLng}`,
      max: `${box.maxLat},${box.maxLng}`,
      grouped: "true",
      language: "fr,en"
    });
    // On cherche des gares ferroviaires, pas les arrêts de métro/tram voisins.
    for (const mode of ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_RAIL", "SUBURBAN"]) {
      query.append("modes", mode);
    }

    const response = await fetch(`${API_ROOT}/v6/map/stops?${query.toString()}`, {
      headers: { "User-Agent": userAgent(this.contact) },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Transitous stops error ${response.status}`);

    const stops = (await response.json()) as MapStop[];
    return stops.flatMap((stop) => {
      if (!stop.name || stop.lat == null || stop.lon == null) return [];
      const id = stop.parentId || stop.stopId || `motis-${stop.name}-${stop.lat.toFixed(5)}-${stop.lon.toFixed(5)}`;
      return [{
        id,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lon,
        importance: Math.max(0, Math.min(1, stop.importance ?? 0.25)),
        timeZone: stop.tz
      } satisfies Station];
    });
  }

  async discoverRailStations(origin: Place, destination: Place): Promise<Station[]> {
    const directKm = haversineKm(origin, destination);
    const corridorKm = Math.min(MAX_CORRIDOR_DISTANCE_KM, Math.max(40, directKm * 0.9));
    const maxFraction = directKm > 1 ? Math.min(0.92, corridorKm / directKm) : 0;

    const centers = Array.from({ length: SAMPLE_COUNT }, (_, index) => {
      const ratio = index / (SAMPLE_COUNT - 1);
      return interpolate(origin, destination, maxFraction * ratio);
    });

    const settled = await Promise.allSettled(centers.map((center) => this.stopsInBox(center)));
    const dedup = new Map<string, Station>();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const station of result.value) {
        const existing = dedup.get(station.id);
        if (!existing || station.importance > existing.importance) dedup.set(station.id, station);
      }
    }

    return [...dedup.values()];
  }
}
