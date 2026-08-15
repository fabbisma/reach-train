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
  const normalCount = expanded ? 8 : 6;
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

const MAX_AUTO_TRANSFERS = 3;

async function buildOption(params: {
  station: Station;
  strategicException: boolean;
  allowedDriveMinutes: number;
  searchAtIso?: string;
  maxTransfers: number;
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
    const rail = await params.rail.journey({
      station: params.station,
      destination: params.destination,
      searchAt: targetIso,
      mode: "arriveBy",
      maxTransfers: params.maxTransfers
    });
    if (!rail) return null;

    const latestStationArrivalAt = addMinutes(rail.departureAt, -STATION_BUFFER_MINUTES);
    let latestDepartureAt = addMinutes(latestStationArrivalAt, -initialRoad.durationMinutes);
    const roadAtLatest = await params.road.route(params.origin, params.station, latestDepartureAt);
    latestDepartureAt = addMinutes(latestStationArrivalAt, -roadAtLatest.durationMinutes);

    let recommendedDepartureAt = addMinutes(latestDepartureAt, -COMFORT_EXTRA_MINUTES);
    const trafficRoad = await params.road.route(params.origin, params.station, recommendedDepartureAt);
    recommendedDepartureAt = addMinutes(
      rail.departureAt,
      -(STATION_BUFFER_MINUTES + COMFORT_EXTRA_MINUTES + trafficRoad.durationMinutes)
    );
    const stationArrivalAt = addMinutes(recommendedDepartureAt, trafficRoad.durationMinutes);
    const comfortableDepartureAt = addMinutes(recommendedDepartureAt, -COMFORT_EXTRA_MINUTES);
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

  const carDepartureAt = targetIso;
  const road = await params.road.route(params.origin, params.station, carDepartureAt);
  const earliestTrainAt = addMinutes(addMinutes(carDepartureAt, road.durationMinutes), STATION_BUFFER_MINUTES);
  const rail = await params.rail.journey({
    station: params.station,
    destination: params.destination,
    searchAt: earliestTrainAt,
    mode: "departAt",
    maxTransfers: params.maxTransfers
  });
  if (!rail) return null;
  const stationArrivalAt = addMinutes(carDepartureAt, road.durationMinutes);
  const impact = estimateImpact({
    carKm: road.distanceKm,
    railKm: rail.distanceKm,
    directCarKm: params.directRoadKm,
    vehicleType: params.request.vehicleType
  });

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
  maxTransfers: number;
  searchAtIso: string;
}): Promise<BatchResult> {
  const settled = await Promise.allSettled(params.candidates.map((candidate) => buildOption({
    station: candidate.station,
    strategicException: candidate.strategicException,
    allowedDriveMinutes: candidate.allowedDriveMinutes,
    searchAtIso: params.searchAtIso,
    maxTransfers: params.maxTransfers,
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

function sameDepartureDay(options: JourneyOption[], dateKey: string) {
  return options.filter((option) => parisDateKey(option.recommendedDepartureAt) === dateKey);
}

function previousDateKey(request: SearchRequest) {
  const noon = zonedLocalToIso(request.date, "12:00");
  return parisDateKey(addMinutes(noon, -24 * 60));
}

function minimumDriveOverrun(options: JourneyOption[]) {
  const positive = options.map((option) => option.driveLimitExceededBy).filter((value) => value > 0);
  return positive.length ? Math.min(...positive) : 0;
}

function betterStationOption(a: JourneyOption | undefined, b: JourneyOption) {
  if (!a) return b;
  if (b.rail.changes !== a.rail.changes) return b.rail.changes < a.rail.changes ? b : a;
  if (b.totalMinutes !== a.totalMinutes) return b.totalMinutes < a.totalMinutes ? b : a;
  return new Date(b.destinationArrivalAt).getTime() < new Date(a.destinationArrivalAt).getTime() ? b : a;
}

function mergeByStation(target: Map<string, JourneyOption>, options: JourneyOption[]) {
  for (const option of options) {
    target.set(option.station.id, betterStationOption(target.get(option.station.id), option));
  }
}

type ProgressiveResult = {
  sameDay: JourneyOption[];
  previousDay: JourneyOption[];
  usedMaxTransfers: number;
  previousDayMaxTransfers: number;
  failures: string[];
};

async function progressiveTransferSearch(params: {
  candidates: StationCandidate[];
  request: SearchRequest;
  origin: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  destination: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  road: RoadProvider;
  rail: RailProvider;
  directRoadKm: number;
  searchAtIso: string;
  requestedDateKey: string;
  previousDateKey: string;
}): Promise<ProgressiveResult> {
  const failures: string[] = [];
  const previousByStation = new Map<string, JourneyOption>();
  let previousDayMaxTransfers = 0;

  // On stoppe dès qu'un niveau donne des solutions le jour demandé :
  // direct d'abord, puis 1, 2 et 3 correspondances seulement si nécessaire.
  for (let maxTransfers = 0; maxTransfers <= MAX_AUTO_TRANSFERS; maxTransfers += 1) {
    const batch = await evaluateCandidates({
      candidates: params.candidates,
      request: params.request,
      origin: params.origin,
      destination: params.destination,
      road: params.road,
      rail: params.rail,
      directRoadKm: params.directRoadKm,
      maxTransfers,
      searchAtIso: params.searchAtIso
    });
    failures.push(...batch.failures);

    const sameDay = sameDepartureDay(batch.options, params.requestedDateKey);
    const previous = sameDepartureDay(batch.options, params.previousDateKey);
    if (previous.length) {
      mergeByStation(previousByStation, previous);
      previousDayMaxTransfers = maxTransfers;
    }

    if (sameDay.length) {
      return {
        sameDay,
        previousDay: [...previousByStation.values()],
        usedMaxTransfers: maxTransfers,
        previousDayMaxTransfers,
        failures
      };
    }
  }

  return {
    sameDay: [],
    previousDay: [...previousByStation.values()],
    usedMaxTransfers: MAX_AUTO_TRANSFERS,
    previousDayMaxTransfers,
    failures
  };
}

function adjustmentForSameDay(options: JourneyOption[]): SearchResponse["adjustment"] {
  const overrun = minimumDriveOverrun(options);
  if (!overrun) {
    return {
      kind: "none",
      driveExtensionMinutes: 0,
      arrivalShiftMinutes: 0,
      message: "Recherche effectuée avec les préférences demandées."
    };
  }
  return {
    kind: "moreDrive",
    driveExtensionMinutes: overrun,
    arrivalShiftMinutes: 0,
    message: `Le meilleur choix le jour même demande de dépasser la préférence voiture d’au moins ${compactDuration(overrun)}.`
  };
}

export async function searchMultimodal(request: SearchRequest): Promise<SearchResponse> {
  const origin = resolveKnownPlace(request.origin);
  const destination = resolveKnownPlace(request.destination);
  if (!origin || !destination) throw new Error("DEMO_PLACE_NOT_FOUND");

  const { road, rail, roadLive, railLive, roadName, railName } = providers(destination.countryCode);
  const directRoad = await road.route(origin, destination);
  const international = Boolean(destination.countryCode && destination.countryCode !== "FR");
  const originalTargetIso = zonedLocalToIso(request.date, request.time);
  const requestedDate = request.date;
  const prevDate = previousDateKey(request);
  const failures: string[] = [];

  // Une seule liste de gares pour tout le calcul. Elle contient les gares proches
  // et quelques grands hubs jusqu'à +2 h de conduite, signalés comme compromis.
  const candidates = candidateStations(origin, destination, request.maxDriveMinutes, international, true);

  let options: JourneyOption[] = [];
  let usedMaxTransfers = 0;
  let adjustment: SearchResponse["adjustment"] = {
    kind: "none",
    driveExtensionMinutes: 0,
    arrivalShiftMinutes: 0,
    message: "Recherche effectuée avec les préférences demandées."
  };

  if (request.mode === "arriveBy") {
    const initial = await progressiveTransferSearch({
      candidates,
      request,
      origin,
      destination,
      road,
      rail,
      directRoadKm: directRoad.distanceKm,
      searchAtIso: originalTargetIso,
      requestedDateKey: requestedDate,
      previousDateKey: prevDate
    });
    failures.push(...initial.failures);

    if (initial.sameDay.length) {
      options = initial.sameDay;
      usedMaxTransfers = initial.usedMaxTransfers;
      adjustment = adjustmentForSameDay(options);
    } else {
      // La veille est mémorisée comme solution de secours avec la même logique
      // direct → 1 → 2 → 3. Avant de l'afficher, on vérifie si +1 h ou +2 h
      // permet de conserver un départ le jour demandé.
      const previousFallback = initial.previousDay;
      const previousFallbackTransfers = initial.previousDayMaxTransfers;
      let laterFound = false;

      for (const shiftMinutes of [60, 120]) {
        const shiftedTarget = addMinutes(originalTargetIso, shiftMinutes);
        const later = await progressiveTransferSearch({
          candidates,
          request,
          origin,
          destination,
          road,
          rail,
          directRoadKm: directRoad.distanceKm,
          searchAtIso: shiftedTarget,
          requestedDateKey: requestedDate,
          previousDateKey: prevDate
        });
        failures.push(...later.failures);

        if (later.sameDay.length) {
          options = later.sameDay;
          usedMaxTransfers = later.usedMaxTransfers;
          const overrun = minimumDriveOverrun(options);
          adjustment = {
            kind: "laterArrival",
            driveExtensionMinutes: overrun,
            arrivalShiftMinutes: shiftMinutes,
            message: `Aucune solution satisfaisante le jour même avant ${request.time}. L’app a décalé l’arrivée de ${compactDuration(shiftMinutes)}${overrun ? ` et accepte au moins +${compactDuration(overrun)} de voiture sur certaines options` : ""}.`
          };
          laterFound = true;
          break;
        }
      }

      if (!laterFound) {
        options = previousFallback;
        usedMaxTransfers = previousFallbackTransfers;
        adjustment = {
          kind: "previousDay",
          driveExtensionMinutes: minimumDriveOverrun(previousFallback),
          arrivalShiftMinutes: 0,
          message: "Aucune solution le jour demandé n’a été trouvée avant l’heure souhaitée, ni avec +1 h ou +2 h. Les départs de la veille sont affichés en dernier recours."
        };
      }
    }
  } else {
    // En mode départ, même logique automatique : direct puis davantage de
    // correspondances uniquement si aucun trajet n'est trouvé.
    for (let maxTransfers = 0; maxTransfers <= MAX_AUTO_TRANSFERS; maxTransfers += 1) {
      const batch = await evaluateCandidates({
        candidates,
        request,
        origin,
        destination,
        road,
        rail,
        directRoadKm: directRoad.distanceKm,
        maxTransfers,
        searchAtIso: originalTargetIso
      });
      failures.push(...batch.failures);
      if (batch.options.length) {
        options = batch.options;
        usedMaxTransfers = maxTransfers;
        adjustment = adjustmentForSameDay(options);
        break;
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
  notes.push(`Correspondances automatiques : le moteur s'est arrêté à ${usedMaxTransfers} correspondance${usedMaxTransfers > 1 ? "s" : ""} maximum.`);
  if (request.mode === "arriveBy") {
    notes.push("Ordre de recherche : heure demandée en direct → 1 → 2 → 3 correspondances ; la veille est gardée en secours ; puis +1 h et +2 h sont testés pour préserver un départ le jour même.");
    notes.push("Synthèse affichée : gare la plus proche, train le plus direct, meilleur compromis et arrivée la plus proche de l’heure demandée parmi les trajets trouvés.");
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
    usedMaxTransfers,
    providers: {
      road: { name: roadName, live: roadLive },
      rail: { name: railName, live: railLive }
    },
    adjustment,
    notes
  };
}
