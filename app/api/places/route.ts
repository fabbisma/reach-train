import { GooglePlacesProvider } from "@/lib/providers/google-places";
import { TransitousLocationProvider } from "@/lib/providers/transitous-locations";
import { haversineKm } from "@/lib/utils";

function transitousContact() {
  if (process.env.TRANSITOUS_CONTACT) return process.env.TRANSITOUS_CONTACT;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : "EcoRailPlanner";
}

function placesKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const placeId = (url.searchParams.get("placeId") ?? "").trim();
  const sessionToken = (url.searchParams.get("sessionToken") ?? "").trim() || undefined;
  const googleKey = placesKey();

  try {
    if (placeId) {
      if (!googleKey) {
        return Response.json({ error: "Google Places n'est pas configuré." }, { status: 503 });
      }

      const google = new GooglePlacesProvider(googleKey);
      const resolved = await google.resolvePlace(placeId, sessionToken);

      // Transitous reste utile pour enrichir le lieu sélectionné avec un fuseau
      // horaire, sans remettre en cause les coordonnées Google choisies.
      if (resolved.place) {
        try {
          const transitous = new TransitousLocationProvider(transitousContact());
          const matches = await transitous.searchPlaces(resolved.label, 5);
          const nearest = matches
            .filter((item) => item.place?.timeZone)
            .map((item) => ({ item, km: haversineKm(resolved.place!, item.place!) }))
            .sort((a, b) => a.km - b.km)[0];
          if (nearest && nearest.km <= 25) resolved.place.timeZone = nearest.item.place?.timeZone;
        } catch (error) {
          console.warn("Transitous timezone enrichment failed:", error);
        }
      }

      return Response.json({ suggestion: resolved, provider: "google" });
    }

    if (q.length < 3) return Response.json({ suggestions: [], provider: googleKey ? "google" : "transitous" });

    if (googleKey) {
      try {
        const google = new GooglePlacesProvider(googleKey);
        const suggestions = await google.searchPlaces(q, 7, sessionToken);
        return Response.json({ suggestions, provider: "google" });
      } catch (error) {
        console.error("Google Places autocomplete failed, fallback Transitous:", error);
      }
    }

    const transitous = new TransitousLocationProvider(transitousContact());
    const suggestions = (await transitous.searchPlaces(q, 7)).map((item) => ({ ...item, provider: "transitous" as const }));
    return Response.json({ suggestions, provider: "transitous" });
  } catch (error) {
    console.error("Place autocomplete failed:", error);
    return Response.json({ suggestions: [], error: "La recherche d'adresse a échoué." }, { status: 500 });
  }
}
