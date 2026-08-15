import type { RailProvider } from "@/lib/providers/types";
import type { Place, RailLeg, RailSegment, RailTransfer, Station } from "@/lib/types";
import { haversineKm } from "@/lib/utils";

type TransitousPlace = {
  name?: string;
  lat?: number;
  lon?: number;
  tz?: string;
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
  legGeometry?: {
    points?: string;
    precision?: number;
    length?: number;
  };
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


function decodePolyline(encoded: string, precision = 6): Array<{ lat: number; lng: number }> {
  if (!encoded) return [];
  const coordinates: Array<{ lat: number; lng: number }> = [];
  const factor = 10 ** precision;
  let index = 0;
  let lat = 0;
  let lng = 0;

  const decodeValue = () => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };

  while (index < encoded.length) {
    lat += decodeValue();
    lng += decodeValue();
    coordinates.push({ lat: lat / factor, lng: lng / factor });
  }

  return coordinates;
}

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

function railSegments(railLegs: TransitousLeg[]): RailSegment[] {
  return railLegs.flatMap((leg) => {
    if (!leg.startTime || !leg.endTime) return [];
    const departureAt = new Date(leg.startTime).toISOString();
    const arrivalAt = new Date(leg.endTime).toISOString();
    return [{
      fromStation: leg.from?.name?.trim() || "Gare de départ",
      toStation: leg.to?.name?.trim() || "Gare d’arrivée",
      departureAt,
      arrivalAt,
      durationMinutes: Math.max(1, Math.round((new Date(arrivalAt).getTime() - new Date(departureAt).getTime()) / 60_000)),
      service: serviceName(leg),
      fromLat: leg.from?.lat,
      fromLng: leg.from?.lon,
      toLat: leg.to?.lat,
      toLng: leg.to?.lon,
      realtime: leg.realTime === true,
      fromTimeZone: leg.from?.tz,
      toTimeZone: leg.to?.tz,
      geometry: leg.legGeometry?.points
        ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6)
        : undefined
    } satisfies RailSegment];
  });
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
      toService: serviceName(next),
      timeZone: previous.to?.tz || next.from?.tz
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
      detailedLegs: "true",
      joinInterlinedLegs: "true",
      language: "fr"
    });

    const response = await fetch(`https://api.transitous.org/api/v6/plan?${query.toString()}`, {
      headers: {
        "User-Agent": `EcoRailPlanner/0.3.0.1 (${this.contact})`
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

  async journeys(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
    maxTransfers: number;
  }): Promise<RailLeg[]> {
    const itineraries = await this.fetchItineraries(params);

    return itineraries
      .map((itinerary) => {
        const trainLegs = (itinerary.legs ?? []).filter((leg) => leg.mode && RAIL_MODES.has(leg.mode));
        const services = [...new Set(
          trainLegs
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
          realtime: trainLegs.some((leg) => leg.realTime === true),
          transfers: transferDetails(trainLegs),
          segments: railSegments(trainLegs)
        } satisfies RailLeg;
      })
      .sort((a, b) =>
        a.durationMinutes - b.durationMinutes ||
        a.changes - b.changes ||
        new Date(b.departureAt).getTime() - new Date(a.departureAt).getTime()
      );
  }
}
