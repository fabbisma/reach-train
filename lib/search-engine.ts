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
  allowedDriveMinutes: number;
};

function candidateStations(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  maxDriveMinutes: number,
  international: boolean,
  expanded = false
): StationCandidate[] {
  const direct = haversineKm(origin, destination);
  const expandedLimit = maxDriveMinutes + (expanded ? 120 : 0);
  const strategicExtraMinutes = international && !expanded ? 120 : !expanded ? 45 : 0;

  const ranked = STATIONS.map((station) => {
    const originKm = haversineKm(origin, station);
    const stationToDest = haversineKm(station, destination);
    const detourRatio = (originKm + stationToDest) / Math.max(1, direct);
    const driveEstimate = (originKm / 75) * 60 + 8;
    const withinNormalSearch = driveEstimate <= expandedLimit * 1.35 && detourRatio <= 1.7;
    const strategicException =
      international &&
      !expanded &&
      station.importance >= 0.86 &&
      driveEstimate <= maxDriveMinutes + strategicExtraMinutes &&
      detourRatio <= 1.8;
    const strategicScore =
      station.importance * 0.55 +
      (1 / Math.max(1, detourRatio)) * 0.3 +
      (1 / Math.max(1, originKm / 30)) * 0.15 +
      (strategicException ? 0.08 : 0);
    return { station, strategicScore, strategicException, withinNormalSearch };
  });

  const selected = new Map<string, StationCandidate>();
  const normalCount = expanded ? 10 : 6;
  const normalItems = ranked.filter((x) => x.withinNormalSearch);
  for (const item of normalItems
    .sort((a, b) => b.strategicScore - a.strategicScore)
    .slice(0, normalCount)) {
    selected.set(item.station.id, {
      station: item.station,
      strategicException: expanded && ((haversineKm(origin, item.station) / 75) * 60 + 8 > maxDriveMinutes),
      allowedDriveMinutes: expanded ? maxDriveMinutes + 120 : maxDriveMinutes
    });
  }

  // Toujours conserver les gares réellement les plus proches : sinon un gros
  // hub mieux noté pourrait faire disparaître Lons/Dole avant même le calcul.
  for (const item of [...normalItems]
    .sort((a, b) => haversineKm(origin, a.station) - haversineKm(origin, b.station))
    .slice(0, 2)) {
    selected.set(item.station.id, {
      station: item.station,
      strategicException: expanded && ((haversineKm(origin, item.station) / 75) * 60 + 8 > maxDriveMinutes),
      allowedDriveMinutes: expanded ? maxDriveMinutes + 120 : maxDriveMinutes
    });
  }

  if (!expanded) {
    for (const item of ranked
      .filter((x) => x.strategicException && !x.withinNormalSearch)
      .sort((a, b) => b.strategicScore - a.strategicScore)
      .slice(0, 3)) {
      selected.set(item.station.id, {
        station: item.station,
        strategicException: true,
        allowedDriveMinutes: maxDriveMinutes + strategicExtraMinutes
      });
    }
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
    const targetMs = new Date(target).getTime();
    const arrivalMs = new Date(option.destinationArrivalAt).getTime();
    if (arrivalMs > targetMs) {
      const lateBy = minutesBetween(target, option.destinationArrivalAt);
      warnings.push(`Arrivée +${compactDuration(lateBy)} après l'heure souhaitée`);
    } else {
      const earlyBy = minutesBetween(option.destinationArrivalAt, target);
      if (earlyBy >= 90) warnings.push(`Arrivée ${compactDuration(earlyBy)} en avance`);
    }
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
      const gapA = Math.abs(targetMs - new Date(a.destinationArrivalAt).getTime());
      const gapB = Math.abs(targetMs - new Date(b.destinationArrivalAt).getTime());
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
  allowedDriveMinutes: number;
  searchAtIso?: string;
  request: SearchRequest;
  origin: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  destination: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  road: RoadProvider;
  rail: RailProvider;
  directRoadKm: number;
}): Promise<JourneyOption | null> {
  const targetIso = params.searchAtIso ?? zonedLocalToIso(params.request.date, params.request.time);
  const initialRoad = await params.road.route(params.origin, params.station);
  const driveLimitExceededBy = Math.max(0, initialRoad.durationMinutes - params.request.maxDriveMinutes);
  if (initialRoad.durationMinutes > params.allowedDriveMinutes) return null;

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

async function buildEarliestSameDayOption(params: {
  station: Station;
  allowedDriveMinutes: number;
  request: SearchRequest;
  origin: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  destination: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  road: RoadProvider;
  rail: RailProvider;
  directRoadKm: number;
}): Promise<JourneyOption | null> {
  const dayStartIso = zonedLocalToIso(params.request.date, "00:00");
  const initialRoad = await params.road.route(params.origin, params.station, dayStartIso);
  const driveLimitExceededBy = Math.max(0, initialRoad.durationMinutes - params.request.maxDriveMinutes);
  if (initialRoad.durationMinutes > params.allowedDriveMinutes) return null;

  const earliestTrainAt = addMinutes(dayStartIso, initialRoad.durationMinutes + STATION_BUFFER_MINUTES);
  const rail = await params.rail.journey({
    station: params.station,
    destination: params.destination,
    searchAt: earliestTrainAt,
    mode: "departAt",
    maxTransfers: params.request.maxTransfers
  });
  if (!rail) return null;

  const latestStationArrivalAt = addMinutes(rail.departureAt, -STATION_BUFFER_MINUTES);
  let latestDepartureAt = addMinutes(latestStationArrivalAt, -initialRoad.durationMinutes);
  const roadAtLatest = await params.road.route(params.origin, params.station, latestDepartureAt);
  latestDepartureAt = addMinutes(latestStationArrivalAt, -roadAtLatest.durationMinutes);

  let recommendedDepartureAt = addMinutes(latestDepartureAt, -COMFORT_EXTRA_MINUTES);
  if (new Date(recommendedDepartureAt).getTime() < new Date(dayStartIso).getTime() &&
      new Date(latestDepartureAt).getTime() >= new Date(dayStartIso).getTime()) {
    recommendedDepartureAt = dayStartIso;
  }

  const trafficRoad = await params.road.route(params.origin, params.station, recommendedDepartureAt);
  if (recommendedDepartureAt !== dayStartIso) {
    recommendedDepartureAt = addMinutes(rail.departureAt, -(STATION_BUFFER_MINUTES + COMFORT_EXTRA_MINUTES + trafficRoad.durationMinutes));
  }
  const stationArrivalAt = addMinutes(recommendedDepartureAt, trafficRoad.durationMinutes);
  const comfortableDepartureAt = recommendedDepartureAt === dayStartIso
    ? dayStartIso
    : addMinutes(recommendedDepartureAt, -COMFORT_EXTRA_MINUTES);
  const actualBufferMinutes = minutesBetween(stationArrivalAt, rail.departureAt);
  if (actualBufferMinutes < STATION_BUFFER_MINUTES) return null;

  const impact = estimateImpact({
    carKm: trafficRoad.distanceKm,
    railKm: rail.distanceKm,
    directCarKm: params.directRoadKm,
    vehicleType: params.request.vehicleType
  });

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

type BatchResult = {
  options: JourneyOption[];
  failures: string[];
};

async function evaluateCandidates(params: {
  candidates: StationCandidate[];
  request: SearchRequest;
  origin: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  destination: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  road: RoadProvider;
  rail: RailProvider;
  directRoadKm: number;
  searchAtIso?: string;
}): Promise<BatchResult> {
  const settled = await Promise.allSettled(params.candidates.map((candidate) => buildOption({
    station: candidate.station,
    strategicException: candidate.strategicException,
    allowedDriveMinutes: candidate.allowedDriveMinutes,
    searchAtIso: params.searchAtIso,
    request: params.request,
    origin: params.origin,
    destination: params.destination,
    road: params.road,
    rail: params.rail,
    directRoadKm: params.directRoadKm
  })));

  const options: JourneyOption[] = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value) options.push(result.value);
      return;
    }
    const stationName = params.candidates[index]?.station.name ?? `gare ${index + 1}`;
    failures.push(stationName);
    console.error(`Échec API pour ${stationName}:`, result.reason);
  });
  return { options, failures };
}

async function evaluateEarliestSameDay(params: {
  candidates: StationCandidate[];
  request: SearchRequest;
  origin: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  destination: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  road: RoadProvider;
  rail: RailProvider;
  directRoadKm: number;
}): Promise<BatchResult> {
  const settled = await Promise.allSettled(params.candidates.map((candidate) => buildEarliestSameDayOption({
    station: candidate.station,
    allowedDriveMinutes: candidate.allowedDriveMinutes,
    request: params.request,
    origin: params.origin,
    destination: params.destination,
    road: params.road,
    rail: params.rail,
    directRoadKm: params.directRoadKm
  })));

  const options: JourneyOption[] = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value) options.push(result.value);
      return;
    }
    const stationName = params.candidates[index]?.station.name ?? `gare ${index + 1}`;
    failures.push(stationName);
    console.error(`Échec API départ jour même pour ${stationName}:`, result.reason);
  });
  return { options, failures };
}

function sameDayDepartures(options: JourneyOption[], request: SearchRequest) {
  return options.filter((option) => parisDateKey(option.recommendedDepartureAt) === request.date);
}

function minimumDriveOverrun(options: JourneyOption[]) {
  const positive = options.map((option) => option.driveLimitExceededBy).filter((value) => value > 0);
  return positive.length ? Math.min(...positive) : 0;
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
  const originalTargetIso = zonedLocalToIso(request.date, request.time);
  const failures: string[] = [];

  const baseCandidates = candidateStations(origin, destination, request.maxDriveMinutes, international, false);
  const baseBatch = await evaluateCandidates({
    candidates: baseCandidates,
    request,
    origin,
    destination,
    road,
    rail,
    directRoadKm: directRoad.distanceKm,
    searchAtIso: originalTargetIso
  });
  failures.push(...baseBatch.failures);

  let options = baseBatch.options;
  let adjustment: SearchResponse["adjustment"] = {
    kind: "none",
    driveExtensionMinutes: 0,
    arrivalShiftMinutes: 0,
    message: "Recherche effectuée avec les préférences demandées."
  };

  if (request.mode === "arriveBy") {
    const baseSameDay = sameDayDepartures(baseBatch.options, request);

    if (baseSameDay.length) {
      options = baseSameDay;
      const overrun = minimumDriveOverrun(baseSameDay);
      if (overrun > 0 && baseSameDay.every((option) => option.driveLimitExceededBy > 0)) {
        adjustment = {
          kind: "moreDrive",
          driveExtensionMinutes: overrun,
          arrivalShiftMinutes: 0,
          message: `Pour partir le jour même, l’app a retenu des gares au-delà de la préférence voiture (+${compactDuration(overrun)} minimum).`
        };
      }
    } else {
      // Palier 2 : avant d'accepter un départ la veille, on autorise davantage
      // de voiture (jusqu'à +2 h) et on teste plus de gares.
      const expandedCandidates = candidateStations(origin, destination, request.maxDriveMinutes, international, true);
      const expandedBatch = await evaluateCandidates({
        candidates: expandedCandidates,
        request,
        origin,
        destination,
        road,
        rail,
        directRoadKm: directRoad.distanceKm,
        searchAtIso: originalTargetIso
      });
      failures.push(...expandedBatch.failures);
      const expandedSameDay = sameDayDepartures(expandedBatch.options, request);

      if (expandedSameDay.length) {
        options = expandedSameDay;
        const overrun = minimumDriveOverrun(expandedSameDay);
        adjustment = {
          kind: "moreDrive",
          driveExtensionMinutes: overrun,
          arrivalShiftMinutes: 0,
          message: `Aucun bon départ le jour même avec la limite initiale : recherche élargie en voiture jusqu’à +2 h${overrun ? ` (première option à +${compactDuration(overrun)})` : ""}.`
        };
      } else {
        // Palier 3 : on cherche l'arrivée la plus tôt réellement atteignable
        // en partant le jour demandé. Cela évite trois recherches artificielles
        // à +1 h / +2 h / +4 h et donne directement le premier trajet faisable.
        const earliestBatch = await evaluateEarliestSameDay({
          candidates: expandedCandidates,
          request,
          origin,
          destination,
          road,
          rail,
          directRoadKm: directRoad.distanceKm
        });
        failures.push(...earliestBatch.failures);
        const earliestSameDay = sameDayDepartures(earliestBatch.options, request);

        if (earliestSameDay.length) {
          options = earliestSameDay;
          const targetMs = new Date(originalTargetIso).getTime();
          const bestArrivalMs = Math.min(...earliestSameDay.map((option) => new Date(option.destinationArrivalAt).getTime()));
          const arrivalShiftMinutes = Math.max(0, Math.round((bestArrivalMs - targetMs) / 60_000));
          const overrun = minimumDriveOverrun(earliestSameDay);
          adjustment = {
            kind: "laterArrival",
            driveExtensionMinutes: overrun,
            arrivalShiftMinutes,
            message: `Aucun départ le jour même ne permettait d’arriver avant ${request.time}. L’app affiche maintenant les premières arrivées réalisables le jour même${arrivalShiftMinutes ? ` (à partir de +${compactDuration(arrivalShiftMinutes)})` : ""}${overrun ? `, avec jusqu’à +${compactDuration(overrun)} de voiture sur les options retenues` : ""}.`
          };
        } else {
          // Dernier recours uniquement : la veille.
          options = expandedBatch.options.length ? expandedBatch.options : baseBatch.options;
          adjustment = {
            kind: "previousDay",
            driveExtensionMinutes: 120,
            arrivalShiftMinutes: 0,
            message: "Même en cherchant les premiers trains accessibles après minuit et en autorisant jusqu’à +2 h de voiture, aucun départ le jour même n’a été trouvé. Les options de la veille sont affichées en dernier recours."
          };
        }
      }
    }
  }

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
  const uniqueFailures = [...new Set(failures)];
  if (uniqueFailures.length) {
    notes.push(`${uniqueFailures.length} recherche(s) de gare ont échoué côté API et ont été ignorées : ${uniqueFailures.join(", ")}.`);
  }
  notes.push(request.maxTransfers === 0 ? "Filtre actif : trajet ferroviaire direct uniquement." : `Filtre actif : ${request.maxTransfers} correspondance${request.maxTransfers > 1 ? "s" : ""} maximum.`);
  if (request.mode === "arriveBy") {
    notes.push("Priorité de recherche : départ le jour demandé → davantage de voiture → arrivée plus tardive → veille seulement en dernier recours.");
    notes.push("Synthèse affichée : gare la plus proche, train le plus direct, meilleur compromis et arrivée la plus proche de l’heure demandée parmi les trajets restant compétitifs.");
  } else {
    notes.push("Synthèse affichée : gare la plus proche, train le plus direct et meilleur compromis entre temps de voiture, temps de train et nombre de correspondances.");
  }
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
    adjustment,
    notes
  };
}
