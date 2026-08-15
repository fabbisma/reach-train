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

export class MockRailProvider implements RailProvider {
  async journey(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
  }): Promise<RailLeg | null> {
    const crowKm = haversineKm(params.station, params.destination);
    if (crowKm < 35) return null;

    const railDistanceKm = crowKm * 1.08;
    const effectiveSpeed = 85 + params.station.importance * 95;
    const durationMinutes = Math.round((railDistanceKm / effectiveSpeed) * 60 + (1 - params.station.importance) * 28 + 12);
    const changes = params.station.importance > 0.78 ? 0 : params.station.importance > 0.55 ? 1 : 2;

    let departureAt: string;
    let arrivalAt: string;

    if (params.mode === "arriveBy") {
      const target = new Date(params.searchAt);
      const slot = Math.max(12, Math.round(38 - params.station.importance * 20));
      const arrivalCandidate = new Date(target.getTime() - slot * 60_000).toISOString();
      arrivalAt = arrivalCandidate;
      departureAt = addMinutes(arrivalAt, -durationMinutes);
    } else {
      const frequency = params.station.importance > 0.8 ? 15 : params.station.importance > 0.6 ? 30 : 45;
      departureAt = roundUpToMinutes(params.searchAt, frequency);
      arrivalAt = addMinutes(departureAt, durationMinutes);
    }

    const result: RailLeg = {
      distanceKm: Math.round(railDistanceKm * 10) / 10,
      durationMinutes,
      departureAt,
      arrivalAt,
      changes
    };

    return result;
  }
}
