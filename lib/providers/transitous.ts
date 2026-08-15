import type { RailProvider } from "@/lib/providers/types";
import type { Place, RailLeg, Station } from "@/lib/types";
import { haversineKm } from "@/lib/utils";

type TransitousLeg = {
  mode?: string;
  displayName?: string;
  routeShortName?: string;
  agencyName?: string;
  realTime?: boolean;
};

type TransitousItinerary = {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  legs?: TransitousLeg[];
};

type TransitousResponse = {
  itineraries?: TransitousItinerary[];
};

const RAIL_MODES = new Set([
  "RAIL",
  "HIGHSPEED_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "REGIONAL_RAIL",
  "REGIONAL_FAST_RAIL",
  "SUBURBAN",
  "SUBWAY"
]);

export class TransitousRailProvider implements RailProvider {
  constructor(private readonly contact: string) {}

  async journey(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
    maxTransfers: number;
  }): Promise<RailLeg | null> {
    const query = new URLSearchParams({
      fromPlace: `${params.station.lat},${params.station.lng}`,
      toPlace: `${params.destination.lat},${params.destination.lng}`,
      time: params.searchAt,
      arriveBy: params.mode === "arriveBy" ? "true" : "false",
      transitModes: "RAIL",
      directModes: "",
      maxTransfers: String(params.maxTransfers),
      timetableView: "false",
      radius: "350",
      detailedLegs: "false",
      joinInterlinedLegs: "true",
      language: "fr"
    });

    const response = await fetch(`https://api.transitous.org/api/v6/plan?${query.toString()}`, {
      headers: {
        "User-Agent": `EcoRailPlanner/0.1.5 (${this.contact})`
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Transitous error ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }

    const json = (await response.json()) as TransitousResponse;
    const itineraries = json.itineraries ?? [];
    if (!itineraries.length) return null;

    const target = new Date(params.searchAt).getTime();
    const valid = itineraries.filter((itinerary) => {
      if (params.mode === "arriveBy") return new Date(itinerary.endTime).getTime() <= target;
      return new Date(itinerary.startTime).getTime() >= target;
    });

    const withinTransferLimit = valid.filter((itinerary) => Math.max(0, itinerary.transfers) <= params.maxTransfers);
    if (!withinTransferLimit.length) return null;

    const itinerary = [...withinTransferLimit].sort((a, b) => {
      if (params.mode === "arriveBy") {
        // Pour une heure d'arrivée imposée, on privilégie le départ le plus tardif.
        return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
      }
      // Pour un départ imposé, on privilégie l'arrivée la plus tôt.
      return new Date(a.endTime).getTime() - new Date(b.endTime).getTime();
    })[0];

    const railLegs = (itinerary.legs ?? []).filter((leg) => leg.mode && RAIL_MODES.has(leg.mode));
    const services = [...new Set(
      railLegs
        .map((leg) => leg.displayName || leg.routeShortName || leg.agencyName)
        .filter((value): value is string => Boolean(value))
    )].slice(0, 4);

    return {
      distanceKm: Math.round(haversineKm(params.station, params.destination) * 1.08 * 10) / 10,
      durationMinutes: Math.max(1, Math.round(itinerary.duration / 60)),
      departureAt: new Date(itinerary.startTime).toISOString(),
      arrivalAt: new Date(itinerary.endTime).toISOString(),
      changes: Math.max(0, itinerary.transfers),
      services,
      realtime: railLegs.some((leg) => leg.realTime === true)
    };
  }
}
