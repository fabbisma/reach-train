import type { RoadProvider } from "@/lib/providers/types";
import type { Place, RoadLeg, Station } from "@/lib/types";

export class GoogleRoutesProvider implements RoadProvider {
  constructor(private readonly apiKey: string) {}

  async route(origin: Place, destination: Place | Station, departureAt?: string): Promise<RoadLeg> {
    const body: Record<string, unknown> = {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: "DRIVE",
      routingPreference: departureAt ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE",
      computeAlternativeRoutes: false,
      languageCode: "fr-FR",
      units: "METRIC"
    };

    if (departureAt) body.departureTime = departureAt;

    const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration"
      },
      body: JSON.stringify(body),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Google Routes error ${response.status}`);
    }

    const json = (await response.json()) as {
      routes?: Array<{ distanceMeters?: number; duration?: string }>;
    };
    const route = json.routes?.[0];
    if (!route?.distanceMeters || !route.duration) throw new Error("Google Routes returned no route");

    return {
      distanceKm: Math.round((route.distanceMeters / 1000) * 10) / 10,
      durationMinutes: Math.max(1, Math.round(Number(route.duration.replace("s", "")) / 60))
    };
  }
}
