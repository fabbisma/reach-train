import type { RailProvider } from "@/lib/providers/types";
import type { Place, RailLeg, RailSegment, RailTransfer, Station } from "@/lib/types";
import { haversineKm, isoToNavitiaLocal, zonedLocalToIso } from "@/lib/utils";

function navitiaDate(iso: string) {
  return isoToNavitiaLocal(iso);
}

function parseNavitiaDate(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return new Date(value).toISOString();
  const [, y, m, d, hh, mm] = match;
  return zonedLocalToIso(`${y}-${m}-${d}`, `${hh}:${mm}`);
}

type NavitiaSection = {
  type?: string;
  departure_date_time?: string;
  arrival_date_time?: string;
  from?: {
    name?: string;
    coord?: { lat?: string; lon?: string };
    stop_point?: { coord?: { lat?: string; lon?: string } };
  };
  to?: {
    name?: string;
    coord?: { lat?: string; lon?: string };
    stop_point?: { coord?: { lat?: string; lon?: string } };
  };
  geojson?: {
    type?: string;
    coordinates?: number[][];
  };
  display_informations?: {
    name?: string;
    label?: string;
    trip_short_name?: string;
    headsign?: string;
  };
};

function navitiaService(section?: NavitiaSection) {
  const info = section?.display_informations;
  return info?.trip_short_name || info?.label || info?.name || info?.headsign || undefined;
}


function navitiaCoord(place?: NavitiaSection["from"]) {
  const coord = place?.coord ?? place?.stop_point?.coord;
  if (!coord) return {};
  const lat = coord.lat != null ? Number(coord.lat) : undefined;
  const lng = coord.lon != null ? Number(coord.lon) : undefined;
  return {
    lat: Number.isFinite(lat) ? lat : undefined,
    lng: Number.isFinite(lng) ? lng : undefined
  };
}

function navitiaSegments(sections: NavitiaSection[] = []): RailSegment[] {
  return sections
    .filter((section) => section.type === "public_transport" && section.departure_date_time && section.arrival_date_time)
    .map((section) => {
      const departureAt = parseNavitiaDate(section.departure_date_time!);
      const arrivalAt = parseNavitiaDate(section.arrival_date_time!);
      const from = navitiaCoord(section.from);
      const to = navitiaCoord(section.to);
      return {
        fromStation: section.from?.name?.trim() || "Gare de départ",
        toStation: section.to?.name?.trim() || "Gare d’arrivée",
        departureAt,
        arrivalAt,
        durationMinutes: Math.max(1, Math.round((new Date(arrivalAt).getTime() - new Date(departureAt).getTime()) / 60_000)),
        service: navitiaService(section),
        fromLat: from.lat,
        fromLng: from.lng,
        toLat: to.lat,
        toLng: to.lng,
        geometry: section.geojson?.coordinates
          ?.filter((coord) => Array.isArray(coord) && coord.length >= 2 && Number.isFinite(Number(coord[0])) && Number.isFinite(Number(coord[1])))
          .map((coord) => ({ lng: Number(coord[0]), lat: Number(coord[1]) }))
      };
    });
}

function navitiaTransfers(sections: NavitiaSection[] = []): RailTransfer[] {
  const publicTransport = sections.filter((section) => section.type === "public_transport");
  const details: RailTransfer[] = [];

  for (let index = 0; index < publicTransport.length - 1; index += 1) {
    const previous = publicTransport[index];
    const next = publicTransport[index + 1];
    if (!previous.arrival_date_time || !next.departure_date_time) continue;

    const arrivalAt = parseNavitiaDate(previous.arrival_date_time);
    const departureAt = parseNavitiaDate(next.departure_date_time);
    const arrivalName = previous.to?.name?.trim();
    const departureName = next.from?.name?.trim();

    details.push({
      stationName: arrivalName && departureName && arrivalName !== departureName
        ? `${arrivalName} → ${departureName}`
        : arrivalName || departureName || "Correspondance",
      arrivalAt,
      departureAt,
      durationMinutes: Math.max(0, Math.round((new Date(departureAt).getTime() - new Date(arrivalAt).getTime()) / 60_000)),
      fromService: navitiaService(previous),
      toService: navitiaService(next)
    });
  }

  return details;
}

function localDateKey(iso: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export class NavitiaRailProvider implements RailProvider {
  constructor(private readonly token: string) {}

  async journeys(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
    maxTransfers: number;
  }): Promise<RailLeg[]> {
    const query = new URLSearchParams({
      from: `${params.station.lng};${params.station.lat}`,
      to: `${params.destination.lng};${params.destination.lat}`,
      datetime: navitiaDate(params.searchAt),
      datetime_represents: params.mode === "arriveBy" ? "arrival" : "departure",
      max_nb_transfers: String(params.maxTransfers),
      count: "10"
    });

    const response = await fetch(`https://api.navitia.io/v1/journeys?${query.toString()}`, {
      headers: { Authorization: this.token },
      cache: "no-store"
    });

    if (!response.ok) throw new Error(`Navitia error ${response.status}`);

    const json = (await response.json()) as {
      journeys?: Array<{
        departure_date_time: string;
        arrival_date_time: string;
        duration: number;
        nb_transfers?: number;
        distances?: { train?: number; rail_shuttle?: number };
        sections?: NavitiaSection[];
      }>;
    };

    return (json.journeys ?? [])
      .filter((item) => (item.nb_transfers ?? 0) <= params.maxTransfers)
      .map((journey) => {
        const railMeters = (journey.distances?.train ?? 0) + (journey.distances?.rail_shuttle ?? 0);
        const publicTransportSections = (journey.sections ?? []).filter((section) => section.type === "public_transport");
        const services = [...new Set(publicTransportSections.map(navitiaService).filter((value): value is string => Boolean(value)))].slice(0, 5);
        return {
          distanceKm: railMeters ? Math.round((railMeters / 1000) * 10) / 10 : Math.round(haversineKm(params.station, params.destination) * 1.08 * 10) / 10,
          durationMinutes: Math.round(journey.duration / 60),
          departureAt: parseNavitiaDate(journey.departure_date_time),
          arrivalAt: parseNavitiaDate(journey.arrival_date_time),
          changes: journey.nb_transfers ?? 0,
          services,
          transfers: navitiaTransfers(journey.sections),
          segments: navitiaSegments(journey.sections)
        } satisfies RailLeg;
      })
      .sort((a, b) =>
        a.durationMinutes - b.durationMinutes ||
        a.changes - b.changes ||
        new Date(b.departureAt).getTime() - new Date(a.departureAt).getTime()
      );
  }
}
