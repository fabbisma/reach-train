import { MockRailProvider, MockRoadProvider } from "@/lib/providers/mock";
import { GoogleRoutesProvider } from "@/lib/providers/google-routes";
import { NavitiaRailProvider } from "@/lib/providers/navitia";
import { TransitousRailProvider } from "@/lib/providers/transitous";
import type { RailProvider, RoadProvider } from "@/lib/providers/types";
import { resolveKnownPlace, STATIONS } from "@/lib/stations";
import type { JourneyOption, RailLeg, RecommendationBadge, RecommendationCriterion, SearchRequest, SearchResponse, Station } from "@/lib/types";
import { addMinutes, haversineKm, minutesBetween, zonedLocalToIso } from "@/lib/utils";

const STATION_BUFFER_MINUTES = 22;
const COMFORT_EXTRA_MINUTES = 10;
const MAX_AUTO_TRANSFERS = 3;
const MAX_EXTENDED_DRIVE_MINUTES = 360;

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
  allowedDriveMinutes: number;
};

/**
 * Une liste unique est analysée une seule fois :
 * - les 6 gares les plus proches pour ne jamais perdre Lons/Dole/etc.
 * - jusqu'à 12 hubs importants sur un corridor raisonnable pour garder
 *   Belfort, Mulhouse, Bâle, Freiburg, Strasbourg, Karlsruhe, Zürich, etc.
 */
function analysisCandidates(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): StationCandidate[] {
  const direct = haversineKm(origin, destination);
  const enriched = STATIONS.map((station) => {
    const originKm = haversineKm(origin, station);
    const stationToDest = haversineKm(station, destination);
    const detourRatio = (originKm + stationToDest) / Math.max(1, direct);
    const driveEstimate = (originKm / 75) * 60 + 8;
    return { station, originKm, detourRatio, driveEstimate };
  });

  const selected = new Map<string, StationCandidate>();
  for (const item of [...enriched].sort((a, b) => a.originKm - b.originKm).slice(0, 6)) {
    selected.set(item.station.id, { station: item.station, allowedDriveMinutes: MAX_EXTENDED_DRIVE_MINUTES });
  }

  for (const item of enriched
    .filter((x) => x.station.importance >= 0.8 && x.driveEstimate <= MAX_EXTENDED_DRIVE_MINUTES && x.detourRatio <= 1.8)
    .sort((a, b) => a.driveEstimate - b.driveEstimate || b.station.importance - a.station.importance)
    .slice(0, 12)) {
    selected.set(item.station.id, { station: item.station, allowedDriveMinutes: MAX_EXTENDED_DRIVE_MINUTES });
  }

  return [...selected.values()];
}

function estimateImpact(params: {
  carKm: number;
  railKm: number;
  directCarKm: number;
  vehicleType: SearchRequest["vehicleType"];
}) {
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

function previousDateKey(request: SearchRequest) {
  const noon = zonedLocalToIso(request.date, "12:00");
  return parisDateKey(addMinutes(noon, -24 * 60));
}

function warningsFor(option: JourneyOption, request: SearchRequest) {
  const warnings: string[] = [];

  if (option.departureDay === "previousDay") warnings.push("Partir la veille");
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
      warnings.push(`Arrivée +${compactDuration(minutesBetween(target, option.destinationArrivalAt))} après l'heure souhaitée`);
    } else {
      const earlyBy = minutesBetween(option.destinationArrivalAt, target);
      if (earlyBy >= 90) warnings.push(`Arrivée ${compactDuration(earlyBy)} en avance`);
    }
  }

  return warnings.slice(0, 3);
}

function chooseBestRailLeg(legs: RailLeg[], targetIso: string) {
  const targetMs = new Date(targetIso).getTime();
  return [...legs].sort((a, b) =>
    a.durationMinutes - b.durationMinutes ||
    a.changes - b.changes ||
    Math.abs(targetMs - new Date(a.arrivalAt).getTime()) - Math.abs(targetMs - new Date(b.arrivalAt).getTime())
  )[0];
}

function buildOptionFromRail(params: {
  station: Station;
  rail: RailLeg;
  roadLeg: { distanceKm: number; durationMinutes: number };
  request: SearchRequest;
  directRoadKm: number;
  departureDay: JourneyOption["departureDay"];
}): JourneyOption {
  const driveLimitExceededBy = Math.max(0, params.roadLeg.durationMinutes - params.request.maxDriveMinutes);
  let recommendedDepartureAt: string;
  let stationArrivalAt: string;
  let latestDepartureAt: string;
  let comfortableDepartureAt: string;

  if (params.request.mode === "arriveBy") {
    latestDepartureAt = addMinutes(
      params.rail.departureAt,
      -(STATION_BUFFER_MINUTES + params.roadLeg.durationMinutes)
    );
    recommendedDepartureAt = addMinutes(latestDepartureAt, -COMFORT_EXTRA_MINUTES);
    comfortableDepartureAt = addMinutes(recommendedDepartureAt, -COMFORT_EXTRA_MINUTES);
    stationArrivalAt = addMinutes(recommendedDepartureAt, params.roadLeg.durationMinutes);
  } else {
    recommendedDepartureAt = zonedLocalToIso(params.request.date, params.request.time);
    latestDepartureAt = recommendedDepartureAt;
    comfortableDepartureAt = recommendedDepartureAt;
    stationArrivalAt = addMinutes(recommendedDepartureAt, params.roadLeg.durationMinutes);
  }

  const impact = estimateImpact({
    carKm: params.roadLeg.distanceKm,
    railKm: params.rail.distanceKm,
    directCarKm: params.directRoadKm,
    vehicleType: params.request.vehicleType
  });

  return {
    id: `${params.station.id}-${params.departureDay}-${params.rail.departureAt}-${params.rail.changes}`,
    station: params.station,
    recommendedDepartureAt,
    comfortableDepartureAt,
    latestDepartureAt,
    stationArrivalAt,
    trainDepartureAt: params.rail.departureAt,
    destinationArrivalAt: params.rail.arrivalAt,
    totalMinutes: minutesBetween(recommendedDepartureAt, params.rail.arrivalAt),
    drive: params.roadLeg,
    rail: params.rail,
    bufferMinutes: minutesBetween(stationArrivalAt, params.rail.departureAt),
    ...impact,
    isStrategicException: driveLimitExceededBy > 0,
    driveLimitExceededBy,
    departureDay: params.departureDay,
    labels: [],
    warnings: []
  };
}

async function evaluateStation(params: {
  candidate: StationCandidate;
  request: SearchRequest;
  origin: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  destination: NonNullable<ReturnType<typeof resolveKnownPlace>>;
  road: RoadProvider;
  rail: RailProvider;
  directRoadKm: number;
  requestedDateKey: string;
  previousDateKey: string;
  targetIso: string;
}): Promise<JourneyOption[]> {
  const roadLeg = await params.road.route(params.origin, params.candidate.station);
  if (roadLeg.durationMinutes > params.candidate.allowedDriveMinutes) return [];

  const railSearchAt = params.request.mode === "departAt"
    ? addMinutes(params.targetIso, roadLeg.durationMinutes + STATION_BUFFER_MINUTES)
    : params.targetIso;

  const railLegs = await params.rail.journeys({
    station: params.candidate.station,
    destination: params.destination,
    searchAt: railSearchAt,
    mode: params.request.mode,
    maxTransfers: MAX_AUTO_TRANSFERS
  });

  if (!railLegs.length) return [];

  if (params.request.mode === "departAt") {
    const best = chooseBestRailLeg(railLegs, params.targetIso);
    if (!best) return [];
    return [buildOptionFromRail({
      station: params.candidate.station,
      rail: best,
      roadLeg,
      request: params.request,
      directRoadKm: params.directRoadKm,
      departureDay: "requestedDay"
    })];
  }

  // On construit d'abord les options puis on classe selon la date du départ
  // conseillé depuis le domicile, ce qui correspond à ce que voit l'utilisateur.
  const provisional = railLegs.map((rail) => buildOptionFromRail({
    station: params.candidate.station,
    rail,
    roadLeg,
    request: params.request,
    directRoadKm: params.directRoadKm,
    departureDay: "requestedDay"
  }));

  const dayJ = provisional.filter((option) => parisDateKey(option.recommendedDepartureAt) === params.requestedDateKey);
  const previous = provisional.filter((option) => parisDateKey(option.recommendedDepartureAt) === params.previousDateKey);

  const selected: JourneyOption[] = [];
  if (dayJ.length) {
    const best = [...dayJ].sort((a, b) =>
      a.rail.durationMinutes - b.rail.durationMinutes || a.totalMinutes - b.totalMinutes || a.rail.changes - b.rail.changes
    )[0];
    selected.push({ ...best, departureDay: "requestedDay" });
  }
  if (previous.length) {
    const best = [...previous].sort((a, b) =>
      a.rail.durationMinutes - b.rail.durationMinutes || a.totalMinutes - b.totalMinutes || a.rail.changes - b.rail.changes
    )[0];
    selected.push({ ...best, departureDay: "previousDay" });
  }

  return selected;
}

type RecommendationRank = RecommendationBadge["rank"];

function mergeRecommendation(
  result: JourneyOption[],
  option: JourneyOption,
  criterion: RecommendationCriterion,
  rank: RecommendationRank,
  request: SearchRequest
) {
  // Une même gare peut être classée dans plusieurs critères/rangs. On garde
  // une seule carte par gare et par jour, avec tous ses badges de classement.
  const existing = result.find((item) => item.station.id === option.station.id);
  if (existing) {
    if (!existing.labels.some((badge) => badge.criterion === criterion && badge.rank === rank)) {
      existing.labels.push({ criterion, rank });
    }
    existing.labels.sort((a, b) => a.rank - b.rank || a.criterion.localeCompare(b.criterion));
    existing.warnings = warningsFor(existing, request);
    return;
  }

  const merged: JourneyOption = {
    ...option,
    id: `${option.id}-summary`,
    labels: [{ criterion, rank }],
    warnings: []
  };
  merged.warnings = warningsFor(merged, request);
  result.push(merged);
}

function addTopThree(
  result: JourneyOption[],
  ranked: JourneyOption[],
  criterion: RecommendationCriterion,
  request: SearchRequest
) {
  ranked.slice(0, 3).forEach((option, index) => {
    mergeRecommendation(result, option, criterion, (index + 1) as RecommendationRank, request);
  });
}

function summarizeDay(options: JourneyOption[], request: SearchRequest) {
  if (!options.length) return [];

  const result: JourneyOption[] = [];

  addTopThree(
    result,
    [...options].sort((a, b) =>
      a.drive.durationMinutes - b.drive.durationMinutes ||
      a.drive.distanceKm - b.drive.distanceKm ||
      a.totalMinutes - b.totalMinutes
    ),
    "closestStation",
    request
  );

  const withinLimit = options.filter((option) => option.drive.durationMinutes <= request.maxDriveMinutes);
  if (withinLimit.length) {
    addTopThree(
      result,
      [...withinLimit].sort((a, b) =>
        a.rail.durationMinutes - b.rail.durationMinutes ||
        a.rail.changes - b.rail.changes ||
        a.totalMinutes - b.totalMinutes
      ),
      "fastestRailWithinLimit",
      request
    );
  }

  const extended = options.filter((option) => option.drive.durationMinutes > request.maxDriveMinutes);
  if (extended.length) {
    addTopThree(
      result,
      [...extended].sort((a, b) =>
        a.rail.durationMinutes - b.rail.durationMinutes ||
        a.rail.changes - b.rail.changes ||
        a.drive.durationMinutes - b.drive.durationMinutes
      ),
      "fastestRailExtended",
      request
    );
  }

  addTopThree(
    result,
    [...options].sort((a, b) =>
      a.totalMinutes - b.totalMinutes ||
      a.rail.changes - b.rail.changes ||
      a.drive.durationMinutes - b.drive.durationMinutes
    ),
    "fastestTotal",
    request
  );

  // Les cartes ayant un meilleur classement global apparaissent en premier.
  return result.sort((a, b) => {
    const bestRankA = Math.min(...a.labels.map((label) => label.rank));
    const bestRankB = Math.min(...b.labels.map((label) => label.rank));
    return bestRankA - bestRankB || b.labels.length - a.labels.length || a.totalMinutes - b.totalMinutes;
  });
}

function simplePareto(options: JourneyOption[]) {
  return options.filter((a) => !options.some((b) => {
    if (a.id === b.id) return false;
    const noWorse = b.totalMinutes <= a.totalMinutes && b.drive.durationMinutes <= a.drive.durationMinutes;
    const better = b.totalMinutes < a.totalMinutes || b.drive.durationMinutes < a.drive.durationMinutes;
    return noWorse && better;
  }));
}

export async function searchMultimodal(request: SearchRequest): Promise<SearchResponse> {
  const origin = resolveKnownPlace(request.origin);
  const destination = resolveKnownPlace(request.destination);
  if (!origin || !destination) throw new Error("DEMO_PLACE_NOT_FOUND");

  const { road, rail, roadLive, railLive, roadName, railName } = providers(destination.countryCode);
  const directRoad = await road.route(origin, destination);
  const targetIso = zonedLocalToIso(request.date, request.time);
  const requestedDate = request.date;
  const prevDate = previousDateKey(request);
  const candidates = analysisCandidates(origin, destination);

  const settled = await Promise.allSettled(candidates.map((candidate) => evaluateStation({
    candidate,
    request,
    origin,
    destination,
    road,
    rail,
    directRoadKm: directRoad.distanceKm,
    requestedDateKey: requestedDate,
    previousDateKey: prevDate,
    targetIso
  })));

  const rawOptions: JourneyOption[] = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") rawOptions.push(...result.value);
    else {
      const station = candidates[index]?.station.name ?? `gare ${index + 1}`;
      failures.push(station);
      console.error(`Échec API pour ${station}:`, result.reason);
    }
  });

  const requestedDayOptions = rawOptions.filter((option) => option.departureDay === "requestedDay");
  const previousDayOptions = rawOptions.filter((option) => option.departureDay === "previousDay");
  const summarized = [
    ...summarizeDay(requestedDayOptions, request),
    ...summarizeDay(previousDayOptions, request)
  ];

  const mode: SearchResponse["mode"] = roadLive && railLive ? "live" : roadLive || railLive ? "hybrid" : "demo";
  const notes: string[] = [];
  if (railLive && destination.countryCode && destination.countryCode !== "FR") {
    notes.push("Horaires ferroviaires réels fournis par Transitous/MOTIS (données publiques européennes).");
  }
  if (!roadLive) notes.push("Temps voiture encore simulés : ajoutez GOOGLE_MAPS_API_KEY dans Vercel pour activer Google Routes.");
  else notes.push("Temps voiture calculés par Google Routes.");

  const uniqueFailures = [...new Set(failures)];
  if (uniqueFailures.length) notes.push(`${uniqueFailures.length} recherche(s) de gare ont échoué côté API : ${uniqueFailures.join(", ")}.`);

  notes.push("Les trois meilleurs candidats de chaque critère sont conservés : gare la plus proche, train le plus court dans le périmètre, train le plus court avec conduite étendue, et trajet porte-à-porte le plus court.");
  if (request.mode === "arriveBy") notes.push("Les mêmes critères sont affichés séparément pour un départ le jour J et pour un départ la veille lorsqu'une solution existe.");
  notes.push(`Les gares peuvent être testées jusqu'à ${compactDuration(MAX_EXTENDED_DRIVE_MINUTES)} de voiture pour la catégorie avec extension.`);
  notes.push("Les coûts et le CO₂ restent des estimations dans cette version. La comparaison 100 % voiture utilise le même provider routier que les accès aux gares.");

  const uniqueViableStations = new Set(rawOptions.map((option) => option.station.id)).size;

  return {
    mode,
    request,
    origin,
    destination,
    directCar: directRoad,
    options: summarized,
    viableStationCount: uniqueViableStations,
    paretoStationCount: simplePareto(rawOptions).length,
    usedMaxTransfers: MAX_AUTO_TRANSFERS,
    providers: {
      road: { name: roadName, live: roadLive },
      rail: { name: railName, live: railLive }
    },
    adjustment: {
      kind: "none",
      driveExtensionMinutes: 0,
      arrivalShiftMinutes: 0,
      message: "Jour J et veille sont analysés séparément."
    },
    notes
  };
}
