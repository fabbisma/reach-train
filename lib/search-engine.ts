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

function compactDuration(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest} min`;
  if (!rest) return `${hours} h`;
  return `${hours} h ${String(rest).padStart(2, "0")}`;
}

function parisDateKey(iso: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function warningsFor(option: JourneyOption, request: SearchRequest) {
  const warnings: string[] = [];

  if (parisDateKey(option.recommendedDepartureAt) < request.date) {
    warnings.push("Partir la veille");
  }

  if (option.driveLimitExceededBy > 0) {
    warnings.push(`Voiture +${compactDuration(option.driveLimitExceededBy)} vs limite`);
  }

  const transferDurations = option.rail.transfers?.map((transfer) => transfer.durationMinutes) ?? [];
  if (transferDurations.length) {
    const longest = Math.max(...transferDurations);
    const shortest = Math.min(...transferDurations);
    if (longest >= 45) warnings.push(`Transit long · ${compactDuration(longest)}`);
    else if (shortest <= 9) warnings.push(`Transit serré · ${compactDuration(shortest)}`);
  }

  if (request.mode === "arriveBy") {
    const target = zonedLocalToIso(request.date, request.time);
    const earlyBy = Math.max(0, minutesBetween(option.destinationArrivalAt, target));
    if (earlyBy >= 90) warnings.push(`Arrivée ${compactDuration(earlyBy)} en avance`);
  }

  return warnings.slice(0, 3);
}

function summarizeOptions(options: JourneyOption[], request: SearchRequest) {
  if (!options.length) return options;

  for (const option of options) {
    option.labels = [];
    option.warnings = warningsFor(option, request);
  }

  const closestDrive = [...options].sort((a, b) =>
    a.drive.durationMinutes - b.drive.durationMinutes ||
    a.drive.distanceKm - b.drive.distanceKm ||
    a.totalMinutes - b.totalMinutes
  )[0];

  const mostDirectRail = [...options].sort((a, b) =>
    a.rail.changes - b.rail.changes ||
    a.rail.durationMinutes - b.rail.durationMinutes ||
    a.totalMinutes - b.totalMinutes
  )[0];

  // Compromis lisible entre rejoindre une gare sans trop conduire et garder
  // un trajet ferroviaire rapide. Chaque correspondance ajoute une petite
  // pénalité de confort, mais un transit court peut rester gagnant.
  const minDrive = Math.min(...options.map((option) => option.drive.durationMinutes));
  const maxDrive = Math.max(...options.map((option) => option.drive.durationMinutes));
  const minRail = Math.min(...options.map((option) => option.rail.durationMinutes));
  const maxRail = Math.max(...options.map((option) => option.rail.durationMinutes));

  const normalized = (value: number, min: number, max: number) =>
    max === min ? 0 : (value - min) / (max - min);

  const bestCompromise = [...options].sort((a, b) => {
    const scoreA =
      normalized(a.drive.durationMinutes, minDrive, maxDrive) * 0.5 +
      normalized(a.rail.durationMinutes, minRail, maxRail) * 0.5 +
      a.rail.changes * 0.12;
    const scoreB =
      normalized(b.drive.durationMinutes, minDrive, maxDrive) * 0.5 +
      normalized(b.rail.durationMinutes, minRail, maxRail) * 0.5 +
      b.rail.changes * 0.12;
    return scoreA - scoreB || a.totalMinutes - b.totalMinutes;
  })[0];

  // En mode "arriver avant", on ajoute une sélection qui vise l'heure demandée
  // sans accepter un trajet globalement mauvais. Un trajet reste "intéressant"
  // s'il ne dépasse pas le plus rapide de plus de 12 %, avec au moins 30 min
  // de marge de tolérance sur les longs trajets.
  let bestArrivalFit: JourneyOption | undefined;
  if (request.mode === "arriveBy") {
    const targetMs = new Date(zonedLocalToIso(request.date, request.time)).getTime();
    const fastestTotal = Math.min(...options.map((option) => option.totalMinutes));
    const tolerance = Math.max(30, Math.round(fastestTotal * 0.12));
    const interesting = options.filter((option) => option.totalMinutes <= fastestTotal + tolerance);

    bestArrivalFit = [...interesting].sort((a, b) => {
      const gapA = Math.max(0, targetMs - new Date(a.destinationArrivalAt).getTime());
      const gapB = Math.max(0, targetMs - new Date(b.destinationArrivalAt).getTime());
      return gapA - gapB || a.totalMinutes - b.totalMinutes || a.rail.changes - b.rail.changes;
    })[0];
  }

  closestDrive.labels.push("closestDrive");
  if (!mostDirectRail.labels.includes("mostDirectRail")) mostDirectRail.labels.push("mostDirectRail");
  if (!bestCompromise.labels.includes("bestCompromise")) bestCompromise.labels.push("bestCompromise");
  if (bestArrivalFit && !bestArrivalFit.labels.includes("bestArrivalFit")) bestArrivalFit.labels.push("bestArrivalFit");

  // Une même gare peut gagner plusieurs catégories ; on conserve une seule carte.
  const selected = new Map<string, JourneyOption>();
  for (const option of [closestDrive, mostDirectRail, bestCompromise, bestArrivalFit]) {
    if (option) selected.set(option.id, option);
  }

  return [...selected.values()].sort((a, b) => {
    const order = (x: JourneyOption) =>
      x.labels.includes("closestDrive") ? 0 :
      x.labels.includes("mostDirectRail") ? 1 :
      x.labels.includes("bestCompromise") ? 2 : 3;
    return order(a) - order(b);
  });
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
      labels: [],
      warnings: []
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
    labels: [],
    warnings: []
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
  notes.push(request.mode === "arriveBy" ? "Synthèse affichée : gare la plus proche, train le plus direct, meilleur compromis et arrivée la plus proche de l’heure demandée parmi les trajets restant compétitifs." : "Synthèse affichée : gare la plus proche, train le plus direct et meilleur compromis entre temps de voiture, temps de train et nombre de correspondances.");
  notes.push("Les coûts et le CO₂ restent des estimations dans cette version.");

  return {
    mode,
    request,
    origin,
    destination,
    options: summarizeOptions(options, request),
    viableStationCount: options.length,
    paretoStationCount: paretoOptions.length,
    providers: {
      road: { name: roadName, live: roadLive },
      rail: { name: railName, live: railLive }
    },
    notes
  };
}
