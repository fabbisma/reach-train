import { searchMultimodal } from "@/lib/search-engine";
import type { Place, SearchRequest } from "@/lib/types";

function validPlace(place: Place | undefined) {
  return Boolean(
    place &&
    place.name &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lng) &&
    place.lat >= -90 && place.lat <= 90 &&
    place.lng >= -180 && place.lng <= 180
  );
}

function validRequest(body: Partial<SearchRequest>): body is SearchRequest {
  return Boolean(
    body.origin &&
      body.destination &&
      validPlace(body.originPlace) &&
      validPlace(body.destinationPlace) &&
      body.date &&
      body.time &&
      (body.mode === "arriveBy" || body.mode === "departAt") &&
      typeof body.maxDriveMinutes === "number"
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<SearchRequest>;
    if (!validRequest(body)) {
      return Response.json({ error: "Confirme le départ et la destination dans les suggestions avant de lancer le calcul." }, { status: 400 });
    }

    const result = await searchMultimodal(body);
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "PLACE_NOT_FOUND_ORIGIN") {
      return Response.json(
        { error: "Lieu de départ introuvable. Sélectionne une suggestion proposée." },
        { status: 422 }
      );
    }
    if (error instanceof Error && error.message === "PLACE_NOT_FOUND_DESTINATION") {
      return Response.json(
        { error: "Destination introuvable. Sélectionne une suggestion proposée." },
        { status: 422 }
      );
    }
    if (error instanceof Error && error.message === "NO_RAIL_STATIONS_FOUND") {
      return Response.json(
        { error: "Aucune gare ferroviaire exploitable n’a été trouvée autour de ce trajet. La couverture locale Transitous/MOTIS est peut-être insuffisante." },
        { status: 422 }
      );
    }
    console.error(error);
    return Response.json({ error: "Le calcul a échoué. Réessaie dans quelques instants." }, { status: 500 });
  }
}
