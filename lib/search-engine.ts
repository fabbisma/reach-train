import { MockRailProvider, MockRoadProvider } from "@/lib/providers/mock";
import { GoogleRoutesProvider } from "@/lib/providers/google-routes";
import { NavitiaRailProvider } from "@/lib/providers/navitia";
import type { RailProvider, RoadProvider } from "@/lib/providers/types";
import { resolveKnownPlace, STATIONS } from "@/lib/stations";
import type { JourneyOption, SearchRequest, SearchResponse, Station } from "@/lib/types";
import { addMinutes, haversineKm, minutesBetween, zonedLocalToIso } from "@/lib/utils";

const STATION_BUFFER_MINUTES = 22;
const COMFORT_EXTRA_MINUTES = 10;

function providers(): { road: RoadProvider; rail: RailProvider; live: boolean } {
  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  const navitiaToken = process.env.NAVITIA_TOKEN;
  return {
    road: googleKey ? new GoogleRoutesProvider(googleKey) : new MockRoadProvider(),
    rail: navitiaToken ? new NavitiaRailProvider(navitiaToken) : new MockRailProvider(),
    live: Boolean(googleKey && navitiaToken)
  };
}

function candidateStations(origin: { lat: number; lng: number }, destination: { lat: number; lng: number }, maxDriveMinutes: number) {
  const direct = haversineKm(origin, destination);
  return STATIONS
    .map((station) => {
      const originKm = haversineKm(origin, station);
      const stationToDest = haversineKm(station, destination);
      const detourRatio = (originKm + stationToDest) / Math.max(1, direct);
      const driveEstimate = (originKm / 75) * 60 + 8;
      const strategicScore = station.importance * 0.55 + (1 / Math.max(1, detourRatio)) * 0.3 + (1 / Math.max(1, originKm / 30)) * 0.15;
      return { station, driveEstimate, detourRatio, strategicScore };
    })
    .filter((x) => x.driveEstimate <= maxDriveMinutes * 1.18 && x.detourRatio <= 1.55)
    .sort((a, b) => b.strategicScore - a.strategicScore)
    .slice(0, 7)
    .map((x) => x.station);
}

function estimateImpact(params: { carKm: number; railKm: number; directCarKm: number; vehicleType: SearchRequest["vehicleType"] }) {
  const carCo2PerKm = params.vehicleType === "electric" ? 0.055 : 0.19;
  const carCostPerKm = params.vehicleType === "electric" ? 0.105 : 0.155;
  const trainCo2PerKm = 0.006;
  const trainCostPerKm = 0.11;
  return {
    co2Kg: Math.round((params.carKm * carCo2PerKm + params.railKm * trainCo2PerKm) * 10) / 10,
    estimatedCostEur: Math.round((params.carKm * carCostPerKm + params.railKm * trainCostPerKm) * 10) / 10,
    carKmAvoided: Math.max(0, Math.round(params.directCarKm - params.carKm))
  };
}

function pareto(options: JourneyOption[]) {
  return options.filter((a) => !options.some((b) => {
    if (a.id === b.id) return false;
    const noWorse = b.totalMinutes <= a.totalMinutes && b.co2Kg <= a.co2Kg && b.estimatedCostEur <= a.estimatedCostEur;
    const strictlyBetter = b.totalMinutes < a.totalMinutes || b.co2Kg < a.co2Kg || b.estimatedCostEur < a.estimatedCostEur;
    return noWorse && strictlyBetter;
  }));
}

function normalize(values: number[], value: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max === min ? 0 : (value - min) / (max - min);
}

function labelAndSort(options: JourneyOption[]) {
  if (!options.length) return options;
  const time = options.map((x) => x.totalMinutes);
  const co2 = options.map((x) => x.co2Kg);
  const cost = options.map((x) => x.estimatedCostEur);

  for (const option of options) {
    option.score = normalize(time, option.totalMinutes) * 0.48 + normalize(co2, option.co2Kg) * 0.34 + normalize(cost, option.estimatedCostEur) * 0.18;
  }

  const fastest = [...options].sort((a, b) => a.totalMinutes - b.totalMinutes)[0];
  const greenest = [...options].sort((a, b) => a.co2Kg - b.co2Kg)[0];
  const cheapest = [...options].sort((a, b) => a.estimatedCostEur - b.estimatedCostEur)[0];
  const recommended = [...options].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];

  for (const option of options) {
    if (option.id === recommended.id) option.labels.push("recommended");
    if (option.id === fastest.id) option.labels.push("fastest");
    if (option.id === greenest.id) option.labels.push("greenest");
    if (option.id === cheapest.id) option.labels.push("cheapest");
  }

  return [...options].sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 4);
}

async function buildOption(params: {
  station: Station;
  request: SearchRequest;
  origin: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  destination: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  road: RoadProvider;
  rail: RailProvider;
  directRoadKm: number;
}): Promise<JourneyOption | null> {
  const targetIso = zonedLocalToIso(params.request.date, params.request.time);
  const initialRoad = await params.road.route(params.origin, params.station);
  if (initialRoad.durationMinutes > params.request.maxDriveMinutes) return null;

  if (params.request.mode === "arriveBy") {
    const rail = await params.rail.journey({ station: params.station, destination: params.destination, searchAt: targetIso, mode: "arriveBy" });
    if (!rail) return null;

    const latestStationArrivalAt = addMinutes(rail.departureAt, -STATION_BUFFER_MINUTES);
    let latestDepartureAt = addMinutes(latestStationArrivalAt, -initialRoad.durationMinutes);
    const roadAtLatest = await params.road.route(params.origin, params.station, latestDepartureAt);
    latestDepartureAt = addMinutes(latestStationArrivalAt, -roadAtLatest.durationMinutes);

    let recommendedDepartureAt = addMinutes(latestDepartureAt, -COMFORT_EXTRA_MINUTES);
    const trafficRoad = await params.road.route(params.origin, params.station, recommendedDepartureAt);
    recommendedDepartureAt = addMinutes(rail.departureAt, -(STATION_BUFFER_MINUTES + COMFORT_EXTRA_MINUTES + trafficRoad.durationMinutes));
    const stationArrivalAt = addMinutes(recommendedDepartureAt, trafficRoad.durationMinutes);
    const comfortableDepartureAt = addMinutes(recommendedDepartureAt, -COMFORT_EXTRA_MINUTES);
    const actualBufferMinutes = minutesBetween(stationArrivalAt, rail.departureAt);
    const impact = estimateImpact({ carKm: trafficRoad.distanceKm, railKm: rail.distanceKm, directCarKm: params.directRoadKm, vehicleType: params.request.vehicleType });

    return {
      id: params.station.id,
      station: params.station,
      recommendedDepartureAt,
      comfortableDepartureAt,
      latestDepartureAt,
      stationArrivalAt,
      trainDepartureAt: rail.departureAt,
      destinationArrivalAt: rail.arrivalAt,
      totalMinutes: minutesBetween(recommendedDepartureAt, rail.arrivalAt),
      drive: trafficRoad,
      rail,
      bufferMinutes: actualBufferMinutes,
      ...impact,
      labels: []
    };
  }

  const carDepartureAt = targetIso;
  const road = await params.road.route(params.origin, params.station, carDepartureAt);
  const earliestTrainAt = addMinutes(addMinutes(carDepartureAt, road.durationMinutes), STATION_BUFFER_MINUTES);
  const rail = await params.rail.journey({ station: params.station, destination: params.destination, searchAt: earliestTrainAt, mode: "departAt" });
  if (!rail) return null;
  const stationArrivalAt = addMinutes(carDepartureAt, road.durationMinutes);
  const impact = estimateImpact({ carKm: road.distanceKm, railKm: rail.distanceKm, directCarKm: params.directRoadKm, vehicleType: params.request.vehicleType });

  return {
    id: params.station.id,
    station: params.station,
    recommendedDepartureAt: carDepartureAt,
    comfortableDepartureAt: carDepartureAt,
    latestDepartureAt: carDepartureAt,
    stationArrivalAt,
    trainDepartureAt: rail.departureAt,
    destinationArrivalAt: rail.arrivalAt,
    totalMinutes: minutesBetween(carDepartureAt, rail.arrivalAt),
    drive: road,
    rail,
    bufferMinutes: STATION_BUFFER_MINUTES,
    ...impact,
    labels: []
  };
}

export async function searchMultimodal(request: SearchRequest): Promise<SearchResponse> {
  const origin = resolveKnownPlace(request.origin);
  const destination = resolveKnownPlace(request.destination);
  if (!origin || !destination) {
    throw new Error("DEMO_PLACE_NOT_FOUND");
  }

  const { road, rail, live } = providers();
  const directRoad = await road.route(origin, destination);
  const stations = candidateStations(origin, destination, request.maxDriveMinutes);
  const options = (await Promise.all(stations.map((station) => buildOption({ station, request, origin, destination, road, rail, directRoadKm: directRoad.distanceKm })))).filter((x): x is JourneyOption => Boolean(x));

  return {
    mode: live ? "live" : "demo",
    request,
    origin,
    destination,
    options: labelAndSort(pareto(options)),
    notes: live
      ? ["Google Routes et Navitia sont actifs.", "Les coûts et le CO₂ restent des estimations V0.1."]
      : ["Mode démo : horaires et temps routiers simulés.", "Ajoutez NAVITIA_TOKEN et GOOGLE_MAPS_API_KEY pour activer les providers réels.", "En mode démo, les lieux reconnus incluent notamment Courlaoux, Paris, Lyon, Bordeaux et Seignosse."]
  };
}
