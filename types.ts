export type SearchMode = "arriveBy" | "departAt";
export type VehicleType = "electric" | "thermal";

export type LatLng = {
  lat: number;
  lng: number;
};

export type Place = LatLng & {
  name: string;
  countryCode?: string;
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

export type RailTransfer = {
  stationName: string;
  arrivalAt: string;
  departureAt: string;
  durationMinutes: number;
  fromService?: string;
  toService?: string;
};

export type RailSegment = {
  fromStation: string;
  toStation: string;
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  service?: string;
  fromLat?: number;
  fromLng?: number;
  toLat?: number;
  toLng?: number;
  realtime?: boolean;
};

export type RailLeg = {
  distanceKm: number;
  durationMinutes: number;
  departureAt: string;
  arrivalAt: string;
  changes: number;
  services?: string[];
  realtime?: boolean;
  transfers?: RailTransfer[];
  segments?: RailSegment[];
};

export type RecommendationCriterion = "closestStation" | "fastestRailWithinLimit" | "fastestRailExtended" | "fastestTotal";

export type RecommendationBadge = {
  criterion: RecommendationCriterion;
  rank: 1 | 2 | 3;
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
  isStrategicException: boolean;
  driveLimitExceededBy: number;
  score?: number;
  departureDay: "requestedDay" | "previousDay";
  labels: RecommendationBadge[];
  warnings: string[];
};

export type ProviderStatus = {
  name: string;
  live: boolean;
};

export type SearchAdjustment = {
  kind: "none" | "moreDrive" | "laterArrival" | "previousDay";
  driveExtensionMinutes: number;
  arrivalShiftMinutes: number;
  message: string;
};

export type SearchResponse = {
  mode: "demo" | "hybrid" | "live";
  request: SearchRequest;
  origin: Place;
  destination: Place;
  directCar: RoadLeg;
  options: JourneyOption[];
  viableStationCount: number;
  paretoStationCount: number;
  usedMaxTransfers: number;
  providers: {
    road: ProviderStatus;
    rail: ProviderStatus;
  };
  adjustment: SearchAdjustment;
  notes: string[];
};
