import type { RailProvider } from "@/lib/providers/types";
import type { Place, RailLeg, Station } from "@/lib/types";
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

export class NavitiaRailProvider implements RailProvider {
  constructor(private readonly token: string) {}

  async journey(params: {
    station: Station;
    destination: Place;
    searchAt: string;
    mode: "arriveBy" | "departAt";
    maxTransfers: number;
  }): Promise<RailLeg | null> {
    const query = new URLSearchParams({
      from: `${params.station.lng};${params.station.lat}`,
      to: `${params.destination.lng};${params.destination.lat}`,
      datetime: navitiaDate(params.searchAt),
      datetime_represents: params.mode === "arriveBy" ? "arrival" : "departure",
      max_nb_transfers: String(params.maxTransfers),
      count: "3"
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
      }>;
    };

    const journey = json.journeys?.find((item) => (item.nb_transfers ?? 0) <= params.maxTransfers);
    if (!journey) return null;

    const railMeters = (journey.distances?.train ?? 0) + (journey.distances?.rail_shuttle ?? 0);
    return {
      distanceKm: railMeters ? Math.round((railMeters / 1000) * 10) / 10 : Math.round(haversineKm(params.station, params.destination) * 1.08 * 10) / 10,
      durationMinutes: Math.round(journey.duration / 60),
      departureAt: parseNavitiaDate(journey.departure_date_time),
      arrivalAt: parseNavitiaDate(journey.arrival_date_time),
      changes: journey.nb_transfers ?? 0
    };
  }
}
