import { searchMultimodal } from "@/lib/search-engine";
import type { SearchRequest } from "@/lib/types";

function validRequest(body: Partial<SearchRequest>): body is SearchRequest {
  return Boolean(
    body.origin &&
      body.destination &&
      body.date &&
      body.time &&
      (body.mode === "arriveBy" || body.mode === "departAt") &&
      typeof body.maxDriveMinutes === "number" &&
      (body.vehicleType === "electric" || body.vehicleType === "thermal")
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<SearchRequest>;
    if (!validRequest(body)) {
      return Response.json({ error: "Requête incomplète ou invalide." }, { status: 400 });
    }

    const result = await searchMultimodal(body);
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "DEMO_PLACE_NOT_FOUND") {
      return Response.json(
        { error: "Ce lieu n'est pas encore reconnu en mode démo. Essaie Courlaoux → Paris, ou ajoute les clés API pour passer en mode réel." },
        { status: 422 }
      );
    }
    console.error(error);
    return Response.json({ error: "Le calcul a échoué." }, { status: 500 });
  }
}
