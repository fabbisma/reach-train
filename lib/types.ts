export type SearchMode = "arriveBy" | "departAt";
export type VehicleType = "electric" | "thermal";

export type LatLng = {
  lat: number;
  lng: number;
};

export type Place = LatLng & {
  name: string;
};

export type Station = LatLng & {
  id: string;
  name: string;
  importance: number;
};

export type SearchRequest = {
  origin: string;
  destination: string;
  date: string;
  time: string;
  mode: SearchMode;
  maxDriveMinutes: number;
  vehicleType: VehicleType;
};

export type RoadLeg = {
  distanceKm: number;
  durationMinutes: number;
};

export type RailLeg = {
  distanceKm: number;
  durationMinutes: number;
  departureAt: string;
  arrivalAt: string;
  changes: number;
};

export type JourneyOption = {
  id: string;
  station: Station;
  recommendedDepartureAt: string;
  comfortableDepartureAt: string;
  latestDepartureAt: string;
  stationArrivalAt: string;
  trainDepartureAt: string;
  destinationArrivalAt: string;
  totalMinutes: number;
  drive: RoadLeg;
  rail: RailLeg;
  bufferMinutes: number;
  co2Kg: number;
  estimatedCostEur: number;
  carKmAvoided: number;
  score?: number;
  labels: Array<"recommended" | "greenest" | "fastest" | "cheapest">;
};

export type SearchResponse = {
  mode: "demo" | "live";
  request: SearchRequest;
  origin: Place;
  destination: Place;
  options: JourneyOption[];
  notes: string[];
};
