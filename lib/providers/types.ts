import type { Place, RailLeg, RoadLeg, Station } from "@/lib/types";

export interface RoadProvider {
  route(origin: Place, destination: Place | Station, departureAt?: string): Promise<RoadLeg>;
}

export interface RailProvider {
  journey(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
    maxTransfers: number;
  }): Promise<RailLeg | null>;
}
