import type { RailProvider } from "@/lib/providers/types";
import type { Place, RailLeg, RailTransfer, Station } from "@/lib/types";
import { haversineKm } from "@/lib/utils";

type TransitousPlace = {
  name?: string;
};

type TransitousLeg = {
  mode?: string;
  displayName?: string;
  routeShortName?: string;
  tripShortName?: string;
  agencyName?: string;
  realTime?: boolean;
  startTime?: string;
  endTime?: string;
  from?: TransitousPlace;
  to?: TransitousPlace;
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

function serviceName(leg?: TransitousLeg) {
  if (!leg) return undefined;
  return leg.displayName || leg.routeShortName || leg.tripShortName || leg.agencyName || undefined;
}

function stationName(previous: TransitousLeg, next: TransitousLeg) {
  const arrival = previous.to?.name?.trim();
  const departure = next.from?.name?.trim();
  if (arrival && departure && arrival !== departure) return `${arrival} → ${departure}`;
  return arrival || departure || "Correspondance";
}

function transferDetails(railLegs: TransitousLeg[]): RailTransfer[] {
  const details: RailTransfer[] = [];
  for (let index = 0; index < railLegs.length - 1; index += 1) {
    const previous = railLegs[index];
    const next = railLegs[index + 1];
    if (!previous.endTime || !next.startTime) continue;

    const durationMinutes = Math.max(
      0,
      Math.round((new Date(next.startTime).getTime() - new Date(previous.endTime).getTime()) / 60_000)
    );

    details.push({
      stationName: stationName(previous, next),
      arrivalAt: new Date(previous.endTime).toISOString(),
      departureAt: new Date(next.startTime).toISOString(),
      durationMinutes,
      fromService: serviceName(previous),
      toService: serviceName(next)
    });
  }
  return details;
}

export class TransitousRailProvider implements RailProvider {
  constructor(private readonly contact: string) {}

  private async fetchItineraries(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
    maxTransfers: number;
  }): Promise<TransitousItinerary[]> {
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
        "User-Agent": `EcoRailPlanner/0.1.8 (${this.contact})`
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Transitous error ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }

    const json = (await response.json()) as TransitousResponse;
    const target = new Date(params.searchAt).getTime();

    return (json.itineraries ?? []).filter((itinerary) => {
      const transfers = Math.max(0, itinerary.transfers);
      if (transfers > params.maxTransfers) return false;
      if (params.mode === "arriveBy") return new Date(itinerary.endTime).getTime() <= target;
      return new Date(itinerary.startTime).getTime() >= target;
    });
  }

  private bestItinerary(
    itineraries: TransitousItinerary[],
    mode: "arriveBy" | "departAt"
  ): TransitousItinerary | undefined {
    return [...itineraries].sort((a, b) => {
      // Le nombre demandé est un plafond. On privilégie d'abord le moins de
      // correspondances : 1 signifie donc "direct OU 1 correspondance".
      const transferDelta = Math.max(0, a.transfers) - Math.max(0, b.transfers);
      if (transferDelta !== 0) return transferDelta;

      if (mode === "arriveBy") {
        return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
      }
      return new Date(a.endTime).getTime() - new Date(b.endTime).getTime();
    })[0];
  }

  async journey(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
    maxTransfers: number;
  }): Promise<RailLeg | null> {
    let itineraries = await this.fetchItineraries(params);
    if (!itineraries.length) return null;

    // MOTIS peut ne retourner que les itinéraires optimaux pour le plafond
    // demandé. Si maxTransfers > 0 et qu'aucun direct n'est présent dans cette
    // réponse, on fait une vérification ciblée en direct-only.
    if (params.maxTransfers > 0 && !itineraries.some((itinerary) => Math.max(0, itinerary.transfers) === 0)) {
      const directItineraries = await this.fetchItineraries({ ...params, maxTransfers: 0 });
      if (directItineraries.length) itineraries = [...directItineraries, ...itineraries];
    }

    const itinerary = this.bestItinerary(itineraries, params.mode);
    if (!itinerary) return null;

    const railLegs = (itinerary.legs ?? []).filter((leg) => leg.mode && RAIL_MODES.has(leg.mode));
    const services = [...new Set(
      railLegs
        .map((leg) => serviceName(leg))
        .filter((value): value is string => Boolean(value))
    )].slice(0, 5);

    return {
      distanceKm: Math.round(haversineKm(params.station, params.destination) * 1.08 * 10) / 10,
      durationMinutes: Math.max(1, Math.round(itinerary.duration / 60)),
      departureAt: new Date(itinerary.startTime).toISOString(),
      arrivalAt: new Date(itinerary.endTime).toISOString(),
      changes: Math.max(0, itinerary.transfers),
      services,
      realtime: railLegs.some((leg) => leg.realTime === true),
      transfers: transferDetails(railLegs)
    };
  }
}
