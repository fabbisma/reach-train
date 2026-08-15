import { MockRailProvider, MockRoadProvider } from "@/lib/providers/mock";
import { GoogleRoutesProvider } from "@/lib/providers/google-routes";
import { NavitiaRailProvider } from "@/lib/providers/navitia";
import { TransitousRailProvider } from "@/lib/providers/transitous";
import type { RailProvider, RoadProvider } from "@/lib/providers/types";
import { resolveKnownPlace, STATIONS } from "@/lib/stations";
import type { JourneyOption, SearchRequest, SearchResponse, Station } from "@/lib/types";
import { addMinutes, haversineKm, minutesBetween, zonedLocalToIso } from "@/lib/utils";

const STATION_BUFFER_MINUTES = 22;
const COMFORT_EXTRA_MINUTES = 10;

function transitousContact() {
  if (process.env.TRANSITOUS_CONTACT) return process.env.TRANSITOUS_CONTACT;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : undefined;
}

function providers(destinationCountry?: string): {
  road: RoadProvider;
  rail: RailProvider;
  roadLive: boolean;
  railLive: boolean;
  roadName: string;
  railName: string;
} {
  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  const navitiaToken = process.env.NAVITIA_TOKEN;
  const contact = transitousContact();
  const international = Boolean(destinationCountry && destinationCountry !== "FR");

  const road = googleKey ? new GoogleRoutesProvider(googleKey) : new MockRoadProvider();
  const roadLive = Boolean(googleKey);

  if (international && contact) {
    return {
      road,
      rail: new TransitousRailProvider(contact),
      roadLive,
      railLive: true,
      roadName: roadLive ? "Google Routes" : "Simulation routière",
      railName: "Transitous/MOTIS"
    };
  }

  if (!international && navitiaToken) {
    return {
      road,
      rail: new NavitiaRailProvider(navitiaToken),
      roadLive,
      railLive: true,
      roadName: roadLive ? "Google Routes" : "Simulation routière",
      railName: "Navitia"
    };
  }

  return {
    road,
    rail: new MockRailProvider(),
    roadLive,
    railLive: false,
    roadName: roadLive ? "Google Routes" : "Simulation routière",
    railName: "Simulation ferroviaire"
  };
}

type StationCandidate = {
  station: Station;
  strategicException: boolean;
};

function candidateStations(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  maxDriveMinutes: number,
  international: boolean
): StationCandidate[] {
  const direct = haversineKm(origin, destination);
  const strategicExtraMinutes = international ? 120 : 45;

  const ranked = STATIONS.map((station) => {
    const originKm = haversineKm(origin, station);
    const stationToDest = haversineKm(station, destination);
    const detourRatio = (originKm + stationToDest) / Math.max(1, direct);
    const driveEstimate = (originKm / 75) * 60 + 8;
    const withinNormalSearch = driveEstimate <= maxDriveMinutes * 1.35 && detourRatio <= 1.65;
    const strategicException =
      international &&
      station.importance >= 0.86 &&
      driveEstimate <= maxDriveMinutes + strategicExtraMinutes &&
      detourRatio <= 1.75;
    const strategicScore =
      station.importance * 0.55 +
      (1 / Math.max(1, detourRatio)) * 0.3 +
      (1 / Math.max(1, originKm / 30)) * 0.15 +
      (strategicException ? 0.08 : 0);
    return { station, strategicScore, strategicException, withinNormalSearch };
  });

  // Limiter volontairement le nombre de recherches ferroviaires externes :
  // 6 gares normales + 3 grands hubs hors préférence. Cela garde Bâle/Mulhouse
  // dans le test international sans lancer une vingtaine de routages MOTIS.
  const selected = new Map<string, StationCandidate>();
  for (const item of ranked
    .filter((x) => x.withinNormalSearch)
    .sort((a, b) => b.strategicScore - a.strategicScore)
    .slice(0, 6)) {
    selected.set(item.station.id, { station: item.station, strategicException: false });
  }

  for (const item of ranked
    .filter((x) => x.strategicException && !x.withinNormalSearch)
    .sort((a, b) => b.strategicScore - a.strategicScore)
    .slice(0, 3)) {
    selected.set(item.station.id, { station: item.station, strategicException: true });
  }

  return [...selected.values()];
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

function labelAndSort(options: JourneyOption[], paretoOptions: JourneyOption[]) {
  if (!options.length) return options;
  const time = options.map((x) => x.totalMinutes);
  const co2 = options.map((x) => x.co2Kg);
  const cost = options.map((x) => x.estimatedCostEur);

  for (const option of options) {
    option.labels = [];
    option.score = normalize(time, option.totalMinutes) * 0.48 + normalize(co2, option.co2Kg) * 0.34 + normalize(cost, option.estimatedCostEur) * 0.18;
  }

  const fastest = [...options].sort((a, b) => a.totalMinutes - b.totalMinutes)[0];
  const greenest = [...options].sort((a, b) => a.co2Kg - b.co2Kg)[0];
  const cheapest = [...options].sort((a, b) => a.estimatedCostEur - b.estimatedCostEur)[0];
  const recommendedPool = paretoOptions.length ? paretoOptions : options;
  const recommended = [...recommendedPool].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];

  for (const option of options) {
    if (option.id === recommended.id) option.labels.push("recommended");
    if (option.id === fastest.id) option.labels.push("fastest");
    if (option.id === greenest.id) option.labels.push("greenest");
    if (option.id === cheapest.id) option.labels.push("cheapest");
  }

  // On conserve d'abord toute la frontière Pareto. Pendant le MVP, si elle
  // contient trop peu de gares, on complète avec des alternatives réellement
  // différentes : gare la plus proche, moins de correspondances et meilleur
  // score global. Cela rend le moteur testable sans masquer les possibilités.
  const selected = new Map<string, JourneyOption>();
  for (const option of [...paretoOptions].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))) {
    selected.set(option.id, option);
  }

  const closest = [...options].sort((a, b) => a.drive.durationMinutes - b.drive.durationMinutes)[0];
  const fewestChanges = [...options].sort((a, b) => a.rail.changes - b.rail.changes || a.totalMinutes - b.totalMinutes)[0];
  for (const option of [recommended, fastest, greenest, cheapest, closest, fewestChanges]) {
    if (option) selected.set(option.id, option);
  }

  // Toujours montrer jusqu'à trois hubs stratégiques hors préférence de conduite,
  // afin que l'utilisateur voie qu'une gare plus lointaine a bien été testée.
  const strategicExceptions = options
    .filter((x) => x.isStrategicException)
    .sort((a, b) => a.rail.changes - b.rail.changes || a.totalMinutes - b.totalMinutes || b.station.importance - a.station.importance)
    .slice(0, 3);
  for (const option of strategicExceptions) selected.set(option.id, option);

  for (const option of [...options].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))) {
    if (selected.size >= 8) break;
    selected.set(option.id, option);
  }

  return [...selected.values()]
    .sort((a, b) => {
      const ar = a.id === recommended.id ? -1 : 0;
      const br = b.id === recommended.id ? -1 : 0;
      return ar - br || (a.score ?? 0) - (b.score ?? 0);
    })
    .slice(0, 8);
}

async function buildOption(params: {
  station: Station;
  strategicException: boolean;
  request: SearchRequest;
  origin: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  destination: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  road: RoadProvider;
  rail: RailProvider;
  directRoadKm: number;
}): Promise<JourneyOption | null> {
  const targetIso = zonedLocalToIso(params.request.date, params.request.time);
  const initialRoad = await params.road.route(params.origin, params.station);
  const driveLimitExceededBy = Math.max(0, initialRoad.durationMinutes - params.request.maxDriveMinutes);
  if (driveLimitExceededBy > 0 && !params.strategicException) return null;
  // Une exception stratégique reste bornée : on ne propose pas une gare arbitrairement lointaine.
  if (params.strategicException && driveLimitExceededBy > 120) return null;

  if (params.request.mode === "arriveBy") {
    const rail = await params.rail.journey({ station: params.station, destination: params.destination, searchAt: targetIso, mode: "arriveBy", maxTransfers: params.request.maxTransfers });
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
      isStrategicException: driveLimitExceededBy > 0,
      driveLimitExceededBy,
      labels: []
    };
  }

  const carDepartureAt = targetIso;
  const road = await params.road.route(params.origin, params.station, carDepartureAt);
  const earliestTrainAt = addMinutes(addMinutes(carDepartureAt, road.durationMinutes), STATION_BUFFER_MINUTES);
  const rail = await params.rail.journey({ station: params.station, destination: params.destination, searchAt: earliestTrainAt, mode: "departAt", maxTransfers: params.request.maxTransfers });
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
    isStrategicException: driveLimitExceededBy > 0,
    driveLimitExceededBy,
    labels: []
  };
}

export async function searchMultimodal(request: SearchRequest): Promise<SearchResponse> {
  const origin = resolveKnownPlace(request.origin);
  const destination = resolveKnownPlace(request.destination);
  if (!origin || !destination) {
    throw new Error("DEMO_PLACE_NOT_FOUND");
  }

  const { road, rail, roadLive, railLive, roadName, railName } = providers(destination.countryCode);
  const directRoad = await road.route(origin, destination);
  const international = Boolean(destination.countryCode && destination.countryCode !== "FR");
  const stations = candidateStations(origin, destination, request.maxDriveMinutes, international);
  const failures: string[] = [];
  const settled = await Promise.allSettled(stations.map((candidate) => buildOption({
    station: candidate.station,
    strategicException: candidate.strategicException,
    request,
    origin,
    destination,
    road,
    rail,
    directRoadKm: directRoad.distanceKm
  })));
  const options: JourneyOption[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value) options.push(result.value);
      return;
    }
    failures.push(stations[index]?.station.name ?? `gare ${index + 1}`);
    console.error(`Échec API pour ${stations[index]?.station.name}:`, result.reason);
  });
  const paretoOptions = pareto(options);

  const mode: SearchResponse["mode"] = roadLive && railLive ? "live" : roadLive || railLive ? "hybrid" : "demo";
  const notes: string[] = [];
  if (railLive && destination.countryCode && destination.countryCode !== "FR") {
    notes.push("Horaires ferroviaires réels fournis par Transitous/MOTIS (données publiques européennes).");
  }
  if (!roadLive) {
    notes.push("Temps voiture encore simulés : ajoutez GOOGLE_MAPS_API_KEY dans Vercel pour activer Google Routes.");
  } else {
    notes.push("Temps voiture calculés par Google Routes, avec trafic lorsque l'heure de départ est connue.");
  }
  if (failures.length) {
    notes.push(`${failures.length} recherche(s) de gare ont échoué côté API et ont été ignorées : ${failures.join(", ")}.`);
  }
  notes.push(request.maxTransfers === 0 ? "Filtre actif : trajet ferroviaire direct uniquement." : `Filtre actif : ${request.maxTransfers} correspondance${request.maxTransfers > 1 ? "s" : ""} maximum.`);
  notes.push("Les coûts et le CO₂ restent des estimations dans cette version.");

  return {
    mode,
    request,
    origin,
    destination,
    options: labelAndSort(options, paretoOptions),
    viableStationCount: options.length,
    paretoStationCount: paretoOptions.length,
    providers: {
      road: { name: roadName, live: roadLive },
      rail: { name: railName, live: railLive }
    },
    notes
  };
}
