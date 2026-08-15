import { TransitousLocationProvider } from "@/lib/providers/transitous-locations";

function transitousContact() {
  if (process.env.TRANSITOUS_CONTACT) return process.env.TRANSITOUS_CONTACT;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : "EcoRailPlanner";
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 2) return Response.json({ suggestions: [] });

    const provider = new TransitousLocationProvider(transitousContact());
    const suggestions = await provider.searchPlaces(q, 7);
    return Response.json({ suggestions });
  } catch (error) {
    console.error("Place autocomplete failed:", error);
    return Response.json({ suggestions: [] }, { status: 200 });
  }
}
