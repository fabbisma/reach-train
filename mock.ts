import type { RoadProvider, RailProvider } from "@/lib/providers/types";
import type { Place, RailLeg, RoadLeg, Station } from "@/lib/types";
import { addMinutes, haversineKm, roundUpToMinutes } from "@/lib/utils";

export class MockRoadProvider implements RoadProvider {
  async route(origin: Place, destination: Place | Station): Promise<RoadLeg> {
    const directKm = haversineKm(origin, destination);
    const distanceKm = directKm * 1.2;
    const averageKph = distanceKm < 25 ? 52 : distanceKm < 80 ? 70 : 82;
    const durationMinutes = Math.round((distanceKm / averageKph) * 60 + 5);
    return { distanceKm: Math.round(distanceKm * 10) / 10, durationMinutes };
  }
}

function mockLeg(params: {
  station: Station;
  destination: Place;
  railDistanceKm: number;
  durationMinutes: number;
  departureAt: string;
  arrivalAt: string;
  changes: number;
}): RailLeg {
  return {
    distanceKm: Math.round(params.railDistanceKm * 10) / 10,
    durationMinutes: params.durationMinutes,
    departureAt: params.departureAt,
    arrivalAt: params.arrivalAt,
    changes: params.changes,
    services: ["Train simulé"],
    segments: [{
      fromStation: params.station.name,
      toStation: params.destination.name,
      departureAt: params.departureAt,
      arrivalAt: params.arrivalAt,
      durationMinutes: params.durationMinutes,
      service: "Train simulé",
      fromLat: params.station.lat,
      fromLng: params.station.lng,
      toLat: params.destination.lat,
      toLng: params.destination.lng
    }]
  };
}

export class MockRailProvider implements RailProvider {
  async journeys(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
    maxTransfers: number;
  }): Promise<RailLeg[]> {
    const crowKm = haversineKm(params.station, params.destination);
    if (crowKm < 35) return [];

    const railDistanceKm = crowKm * 1.08;
    const effectiveSpeed = 85 + params.station.importance * 95;
    const durationMinutes = Math.round((railDistanceKm / effectiveSpeed) * 60 + (1 - params.station.importance) * 28 + 12);
    const changes = params.station.importance > 0.78 ? 0 : params.station.importance > 0.55 ? 1 : 2;
    if (changes > params.maxTransfers) return [];

    if (params.mode === "departAt") {
      const frequency = params.station.importance > 0.8 ? 15 : params.station.importance > 0.6 ? 30 : 45;
      const departureAt = roundUpToMinutes(params.searchAt, frequency);
      const arrivalAt = addMinutes(departureAt, durationMinutes);
      return [mockLeg({ station: params.station, destination: params.destination, railDistanceKm, durationMinutes, departureAt, arrivalAt, changes })];
    }

    const target = new Date(params.searchAt);
    const slot = Math.max(12, Math.round(38 - params.station.importance * 20));
    const arrivalAt = new Date(target.getTime() - slot * 60_000).toISOString();
    const dayDeparture = addMinutes(arrivalAt, -durationMinutes);
    const previousDeparture = addMinutes(dayDeparture, -24 * 60);
    const previousArrival = addMinutes(arrivalAt, -24 * 60);

    return [
      mockLeg({ station: params.station, destination: params.destination, railDistanceKm, durationMinutes, departureAt: dayDeparture, arrivalAt, changes }),
      mockLeg({ station: params.station, destination: params.destination, railDistanceKm, durationMinutes, departureAt: previousDeparture, arrivalAt: previousArrival, changes })
    ];
  }
}
