import type { LocationSuggestion, Place } from "@/lib/types";

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const PLACE_DETAILS_ROOT = "https://places.googleapis.com/v1/places";

const AUTOCOMPLETE_FIELD_MASK = [
  "suggestions.placePrediction.placeId",
  "suggestions.placePrediction.text.text",
  "suggestions.placePrediction.structuredFormat.mainText.text",
  "suggestions.placePrediction.structuredFormat.secondaryText.text",
  "suggestions.placePrediction.types"
].join(",");

const DETAILS_FIELD_MASK = [
  "id",
  "formattedAddress",
  "location",
  "postalAddress"
].join(",");

type GoogleText = { text?: string };
type PlacePrediction = {
  placeId?: string;
  text?: GoogleText;
  structuredFormat?: {
    mainText?: GoogleText;
    secondaryText?: GoogleText;
  };
  types?: string[];
};

type AutocompleteResponse = {
  suggestions?: Array<{ placePrediction?: PlacePrediction }>;
};

type PlaceDetailsResponse = {
  id?: string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  postalAddress?: { regionCode?: string };
};

function suggestionType(prediction: PlacePrediction): LocationSuggestion["type"] {
  const types = new Set(prediction.types ?? []);
  if (
    types.has("train_station") ||
    types.has("transit_station") ||
    types.has("subway_station") ||
    types.has("light_rail_station")
  ) return "STOP";
  if (
    types.has("street_address") ||
    types.has("premise") ||
    types.has("subpremise") ||
    types.has("route") ||
    types.has("postal_code")
  ) return "ADDRESS";
  return "PLACE";
}

export class GooglePlacesProvider {
  constructor(private readonly apiKey: string) {}

  async searchPlaces(input: string, limit = 7, sessionToken?: string): Promise<LocationSuggestion[]> {
    const response = await fetch(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": AUTOCOMPLETE_FIELD_MASK
      },
      body: JSON.stringify({
        input,
        languageCode: "fr",
        ...(sessionToken ? { sessionToken } : {})
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Google Places autocomplete error ${response.status}: ${text.slice(0, 240)}`);
    }

    const data = (await response.json()) as AutocompleteResponse;
    return (data.suggestions ?? [])
      .flatMap((item) => item.placePrediction ? [item.placePrediction] : [])
      .filter((prediction) => prediction.placeId && prediction.text?.text)
      .slice(0, limit)
      .map((prediction) => ({
        id: prediction.placeId!,
        label: prediction.text!.text!,
        secondaryLabel: prediction.structuredFormat?.secondaryText?.text,
        type: suggestionType(prediction),
        provider: "google" as const
      }));
  }

  async resolvePlace(placeId: string, sessionToken?: string): Promise<LocationSuggestion> {
    const url = new URL(`${PLACE_DETAILS_ROOT}/${encodeURIComponent(placeId)}`);
    url.searchParams.set("languageCode", "fr");
    if (sessionToken) url.searchParams.set("sessionToken", sessionToken);

    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": DETAILS_FIELD_MASK
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Google Places details error ${response.status}: ${text.slice(0, 240)}`);
    }

    const data = (await response.json()) as PlaceDetailsResponse;
    const lat = data.location?.latitude;
    const lng = data.location?.longitude;
    if (!data.id || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error("Google Places details response has no usable coordinates");
    }

    const label = data.formattedAddress || data.id;
    const name = data.formattedAddress || data.id;
    const place: Place = {
      name,
      lat: lat!,
      lng: lng!,
      countryCode: data.postalAddress?.regionCode?.toUpperCase(),
      // Important : l'ID Google n'est PAS un stop ID MOTIS. On conserve donc
      // la destination comme lieu géographique et MOTIS utilisera lat/lng.
      sourceType: "PLACE"
    };

    return {
      id: data.id,
      label,
      type: "PLACE",
      provider: "google",
      place
    };
  }
}
