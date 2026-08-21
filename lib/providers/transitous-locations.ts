import type { LocationSuggestion, Place, Station } from "@/lib/types";
import { haversineKm } from "@/lib/utils";

type GeocodeArea = {
  name?: string;
  adminLevel?: number;
  matched?: boolean;
  unique?: boolean;
  default?: boolean;
};

type GeocodeMatch = {
  type?: "ADDRESS" | "PLACE" | "STOP";
  category?: string;
  name?: string;
  id?: string;
  lat?: number;
  lon?: number;
  country?: string;
  zip?: string;
  street?: string;
  houseNumber?: string;
  tz?: string;
  score?: number;
  importance?: number;
  modes?: string[];
  areas?: GeocodeArea[];
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
  return `EcoRailPlanner/0.3.5.3 (${contact})`;
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

function uniqueParts(parts: Array<string | undefined>) {
  const seen = new Set<string>();
  return parts.flatMap((part) => {
    const value = part?.trim();
    if (!value) return [];
    const key = normalize(value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [value];
  });
}

function matchLabel(match: GeocodeMatch) {
  const areas = (match.areas ?? [])
    .filter((area) => area.name)
    .sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)) || (b.adminLevel ?? 0) - (a.adminLevel ?? 0));
  const usefulAreas = areas
    .filter((area, index) => area.default || area.unique || area.matched || index < 2)
    .map((area) => area.name)
    .slice(0, 3);

  const addressPrefix = match.type === "ADDRESS"
    ? [match.houseNumber, match.street].filter(Boolean).join(" ").trim()
    : undefined;

  return uniqueParts([
    addressPrefix || match.name,
    addressPrefix ? match.name : undefined,
    match.zip,
    ...usefulAreas,
    match.country?.toUpperCase()
  ]).join(" · ");
}

export class TransitousLocationProvider {
  constructor(private readonly contact: string) {}

  async searchPlaces(queryText: string, limit = 7): Promise<LocationSuggestion[]> {
    const query = new URLSearchParams({
      text: queryText,
      type: "ADDRESS,PLACE,STOP",
      language: "fr,en",
      numResults: String(limit)
    });

    const response = await fetch(`${API_ROOT}/v1/geocode?${query.toString()}`, {
      headers: { "User-Agent": userAgent(this.contact) },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Transitous geocode error ${response.status}`);

    const matches = (await response.json()) as GeocodeMatch[];
    return [...matches]
      .filter((item) => item.name && item.id && Number.isFinite(item.lat) && Number.isFinite(item.lon))
      .sort((a, b) => placeMatchRank(b, queryText) - placeMatchRank(a, queryText))
      .slice(0, limit)
      .map((item) => ({
        id: item.id!,
        label: matchLabel(item),
        type: item.type ?? "PLACE",
        place: {
          name: item.name!,
          lat: item.lat!,
          lng: item.lon!,
          countryCode: item.country?.toUpperCase(),
          timeZone: item.tz,
          sourceId: item.id,
          sourceType: item.type ?? "PLACE"
        }
      }));
  }

  async resolvePlace(queryText: string): Promise<Place | null> {
    const matches = await this.searchPlaces(queryText, 8);
    return matches[0]?.place ?? null;
  }

  private async stopsInBox(center: { lat: number; lng: number }): Promise<Station[]> {
    const box = boundingBox(center, RAIL_DISCOVERY_RADIUS_KM);
    const query = new URLSearchParams({
      min: `${box.minLat},${box.minLng}`,
      max: `${box.maxLat},${box.maxLng}`,
      grouped: "true",
      language: "fr,en"
    });
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
      const providerStopId = stop.parentId || stop.stopId;
      const id = providerStopId || `motis-${stop.name}-${stop.lat.toFixed(5)}-${stop.lon.toFixed(5)}`;
      return [{
        id,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lon,
        importance: Math.max(0, Math.min(1, stop.importance ?? 0.25)),
        timeZone: stop.tz,
        providerStopId
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
