import type { RailProvider } from "@/lib/providers/types";
import type { Place, RailLeg, Station } from "@/lib/types";
import { haversineKm } from "@/lib/utils";

type TransitousItinerary = {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
};

type TransitousResponse = {
  itineraries?: TransitousItinerary[];
};

export class TransitousRailProvider implements RailProvider {
  constructor(private readonly contact: string) {}

  async journey(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
  }): Promise<RailLeg | null> {
    const query = new URLSearchParams({
      fromPlace: `${params.station.lat},${params.station.lng}`,
      toPlace: `${params.destination.lat},${params.destination.lng}`,
      time: params.searchAt,
      arriveBy: params.mode === "arriveBy" ? "true" : "false",
      transitModes: "RAIL",
      maxTransfers: "5",
      maxItineraries: "5",
      timetableView: "true",
      detailedLegs: "false"
    });

    const response = await fetch(`https://api.transitous.org/api/v6/plan?${query.toString()}`, {
      headers: {
        "User-Agent": `EcoRailPlanner/0.1.2 (${this.contact})`
      },
      cache: "no-store"
    });

    if (!response.ok) throw new Error(`Transitous error ${response.status}`);

    const json = (await response.json()) as TransitousResponse;
    const itineraries = json.itineraries ?? [];
    if (!itineraries.length) return null;

    const target = new Date(params.searchAt).getTime();
    const valid = itineraries.filter((itinerary) => {
      if (params.mode === "arriveBy") return new Date(itinerary.endTime).getTime() <= target;
      return new Date(itinerary.startTime).getTime() >= target;
    });

    const pool = valid.length ? valid : itineraries;
    const itinerary = [...pool].sort((a, b) => {
      if (params.mode === "arriveBy") {
        return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
      }
      return new Date(a.endTime).getTime() - new Date(b.endTime).getTime();
    })[0];

    return {
      distanceKm: Math.round(haversineKm(params.station, params.destination) * 1.08 * 10) / 10,
      durationMinutes: Math.round(itinerary.duration / 60),
      departureAt: new Date(itinerary.startTime).toISOString(),
      arrivalAt: new Date(itinerary.endTime).toISOString(),
      changes: itinerary.transfers
    };
  }
}
