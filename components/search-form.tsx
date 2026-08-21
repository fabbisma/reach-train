"use client";

import { useEffect, useMemo, useState } from "react";
import RailMap from "@/components/rail-map";
import type { JourneyOption, LocationSuggestion, Place, RecommendationBadge, SearchRequest, SearchResponse } from "@/lib/types";

function defaultArrivalDate() {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDateTime(iso: string, timeZone = "Europe/Paris") {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  }).format(new Date(iso));
}

function fmtDuration(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

function fmtDelta(minutes: number) {
  if (Math.abs(minutes) < 1) return "identique";
  return `${minutes > 0 ? "+" : "−"}${fmtDuration(Math.abs(minutes))}`;
}

const labelText = {
  closestStation: "🚗 Gare la plus proche",
  fastestRailWithinLimit: "⏱️ Transport public le plus court · dans le périmètre",
  fastestRailExtended: "🚙⏱️ Transport public le plus court · conduite étendue",
  fastestTotal: "🏁 Trajet total le plus court"
} as const;

function recommendationLabel(label: RecommendationBadge) {
  const medal = label.rank === 1 ? "🥇" : label.rank === 2 ? "🥈" : "🥉";
  return `${medal} ${labelText[label.criterion]}`;
}

function lastMileHint(distanceKm?: number) {
  if (distanceKm == null) return undefined;
  if (distanceKm <= 0.8) return "facilement faisable à pied";
  if (distanceKm <= 2) return "marche possible, taxi selon bagages";
  if (distanceKm <= 5) return "taxi ou transport local à envisager";
  return "transport local ou taxi probablement nécessaire";
}

function segmentModeLabel(mode?: string) {
  switch (mode) {
    case "SUBWAY": return "🚇 Métro";
    case "SUBURBAN": return "🚈 RER / train suburbain";
    case "TRAM": return "🚊 Tram";
    case "BUS": return "🚌 Bus";
    case "COACH": return "🚌 Car";
    case "FERRY": return "⛴️ Ferry";
    case "FUNICULAR": return "🚞 Funiculaire";
    case "AERIAL_LIFT": return "🚠 Téléphérique";
    default: return "🚆 Train";
  }
}

function RailDetails({ option, origin, destination }: { option: JourneyOption; origin: Place; destination: Place }) {
  const segments = option.rail.segments ?? [];
  const firstStation = segments[0]?.fromStation ?? option.station.name;
  const lastStation = segments[segments.length - 1]?.toStation ?? destination.name;

  return (
    <div className="rail-details">
      <div className="rail-overview">
        <span>🚆</span>
        <div>
          <strong>{firstStation} → {lastStation}</strong>
          <small>Train + transports locaux · {fmtDuration(option.rail.durationMinutes)} · {option.rail.changes} changement{option.rail.changes > 1 ? "s" : ""}{option.rail.realtime ? " · temps réel" : ""}</small>
        </div>
      </div>

      <RailMap option={option} origin={origin} destination={destination} />

      {segments.length > 0 ? (
        <div className="rail-segments">
          {segments.map((segment, index) => {
            const transfer = option.rail.transfers?.[index];
            return (
              <div className="rail-segment-block" key={`${segment.fromStation}-${segment.toStation}-${segment.departureAt}-${index}`}>
                <div className="rail-segment">
                  <div className="segment-kicker">{segmentModeLabel(segment.mode)} {index + 1}{segment.service ? ` · ${segment.service}` : ""}</div>
                  <strong className="segment-route">{segment.fromStation} → {segment.toStation}</strong>
                  <div className="segment-times">
                    <span>Départ <b>{fmtDateTime(segment.departureAt, segment.fromTimeZone ?? option.station.timeZone ?? origin.timeZone)}</b></span>
                    <span>Arrivée <b>{fmtDateTime(segment.arrivalAt, segment.toTimeZone ?? destination.timeZone)}</b></span>
                    <span>{fmtDuration(segment.durationMinutes)}</span>
                  </div>
                </div>
                {transfer && (
                  <div className="transfer-card">
                    <strong>🔁 Correspondance : {transfer.stationName}</strong>
                    <span>Arrivée {fmtDateTime(transfer.arrivalAt, transfer.timeZone ?? destination.timeZone)}</span>
                    <span>Départ suivant {fmtDateTime(transfer.departureAt, transfer.timeZone ?? destination.timeZone)}</span>
                    <b>Transit : {fmtDuration(transfer.durationMinutes)}</b>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rail-segment fallback-segment">
          <strong className="segment-route">{option.station.name} → {destination.name}</strong>
          <div className="segment-times">
            <span>Départ <b>{fmtDateTime(option.trainDepartureAt, option.station.timeZone ?? origin.timeZone)}</b></span>
            <span>Arrivée <b>{fmtDateTime(option.destinationArrivalAt, destination.timeZone)}</b></span>
          </div>
          {option.rail.services?.length ? <small className="services">{option.rail.services.join(" · ")}</small> : null}
        </div>
      )}

      {option.rail.lastMileDistanceKm != null && (
        <div className="last-mile-card">
          <div>
            <strong>📍 Dernier arrêt → adresse finale</strong>
            <span>{option.rail.lastTransitStopName ?? lastStation} → {destination.name}</span>
          </div>
          <div className="last-mile-distance">
            <b>~{option.rail.lastMileDistanceKm.toFixed(1)} km</b>
            <small>{lastMileHint(option.rail.lastMileDistanceKm)}</small>
          </div>
          <p>Distance géographique approximative entre le dernier arrêt de transport public et l’adresse demandée.</p>
        </div>
      )}
    </div>
  );
}


function LocationField({
  label,
  value,
  selected,
  placeholder,
  onTextChange,
  onSelect
}: {
  label: string;
  value: string;
  selected?: Place;
  placeholder: string;
  onTextChange: (value: string) => void;
  onSelect: (suggestion: LocationSuggestion) => void;
}) {
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<"google" | "transitous" | undefined>();
  const [fallback, setFallback] = useState(false);
  const [sessionToken, setSessionToken] = useState("");

  useEffect(() => {
    setSessionToken(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  }, []);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 3 || (selected && q.toLowerCase().startsWith(selected.name.toLowerCase()))) {
      setSuggestions([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q });
        if (sessionToken) params.set("sessionToken", sessionToken);
        const response = await fetch(`/api/places?${params.toString()}`, { signal: controller.signal });
        const data = (await response.json()) as {
          suggestions?: LocationSuggestion[];
          provider?: "google" | "transitous";
          fallback?: boolean;
        };
        setSuggestions(data.suggestions ?? []);
        setProvider(data.provider);
        setFallback(Boolean(data.fallback));
        setOpen(true);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 320);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value, selected, sessionToken]);

  async function selectSuggestion(suggestion: LocationSuggestion) {
    setResolving(true);
    try {
      let resolved = suggestion;
      if (!resolved.place && resolved.provider === "google") {
        const params = new URLSearchParams({ placeId: resolved.id });
        if (sessionToken) params.set("sessionToken", sessionToken);
        const response = await fetch(`/api/places?${params.toString()}`);
        const data = (await response.json()) as { suggestion?: LocationSuggestion; error?: string };
        if (!response.ok || !data.suggestion?.place) throw new Error(data.error ?? "Impossible de confirmer ce lieu");
        resolved = data.suggestion;
      }

      if (!resolved.place) throw new Error("Ce lieu n'a pas de coordonnées exploitables");
      onSelect(resolved);
      setOpen(false);
      setSuggestions([]);
      setSessionToken(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    } catch (error) {
      console.error(error);
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="location-field">
      <span className="location-field-label">{label}</span>
      <div className="location-input-wrap">
        <input
          value={value}
          onChange={(e) => {
            onTextChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 180)}
          placeholder={placeholder}
          autoComplete="off"
          required
        />
        <span className={`location-state ${selected ? "confirmed" : ""}`} aria-hidden="true">
          {selected ? "✓" : searching || resolving ? "…" : "⌖"}
        </span>
        {open && !selected && value.trim().length >= 3 && (
          <div className="location-suggestions" role="listbox">
            {searching && suggestions.length === 0 ? (
              <div className="location-suggestion muted">Recherche du lieu…</div>
            ) : suggestions.length ? suggestions.map((suggestion) => (
              <button
                type="button"
                className="location-suggestion"
                key={`${suggestion.provider ?? "local"}-${suggestion.id}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void selectSuggestion(suggestion)}
                disabled={resolving}
              >
                <span className="location-kind">{suggestion.type === "STOP" ? "🚉" : suggestion.type === "ADDRESS" ? "📍" : "🏙️"}</span>
                <span>
                  <strong>{suggestion.label}</strong>
                  <small>
                    {suggestion.type === "STOP" ? "Gare / arrêt" : suggestion.type === "ADDRESS" ? "Adresse" : "Ville / lieu"}
                    {suggestion.provider === "google" ? " · Google Places" : suggestion.provider === "transitous" ? " · Transitous" : ""}
                  </small>
                </span>
              </button>
            )) : (
              <div className="location-suggestion muted">Aucune suggestion. Essaie avec la ville, le code postal ou le pays.</div>
            )}
            {provider === "google" && <div className="places-attribution">Suggestions fournies par Google Maps</div>}
            {provider === "transitous" && fallback && <div className="places-attribution">⚠️ Google Places indisponible · suggestions de secours Transitous</div>}
          </div>
        )}
      </div>
      <small className={`location-confirmation ${selected ? "confirmed" : ""}`}>
        {selected ? `✓ Confirmé · ${selected.name}${selected.countryCode ? ` · ${selected.countryCode}` : ""}` : "Sélection obligatoire dans la liste de suggestions"}
      </small>
    </div>
  );
}

export default function SearchForm() {
  const [form, setForm] = useState<SearchRequest>({
    origin: "",
    destination: "",
    date: defaultArrivalDate(),
    time: "12:00",
    mode: "arriveBy",
    maxDriveMinutes: 90
  });
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const title = useMemo(() => (form.mode === "arriveBy" ? "Je dois arriver avant" : "Je veux partir vers"), [form.mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Erreur de calcul");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur de calcul");
    } finally {
      setLoading(false);
    }
  }

  const modeLabel = result?.mode === "live"
    ? "DONNÉES RÉELLES"
    : result?.mode === "hybrid"
      ? "DONNÉES PARTIELLEMENT RÉELLES"
      : "MODE DÉMO";

  return (
    <>
      <form className="search-card" onSubmit={submit}>
        <div className="mode-switch" role="group" aria-label="Mode de recherche">
          <button type="button" className={form.mode === "arriveBy" ? "active" : ""} onClick={() => setForm({ ...form, mode: "arriveBy" })}>Arriver avant</button>
          <button type="button" className={form.mode === "departAt" ? "active" : ""} onClick={() => setForm({ ...form, mode: "departAt" })}>Partir vers</button>
        </div>

        <div className="form-grid">
          <LocationField
            label="Départ"
            value={form.origin}
            selected={form.originPlace}
            placeholder="Ville, adresse ou lieu de départ"
            onTextChange={(value) => setForm({ ...form, origin: value, originPlace: undefined })}
            onSelect={(suggestion) => suggestion.place && setForm({ ...form, origin: suggestion.label, originPlace: suggestion.place })}
          />
          <LocationField
            label="Destination"
            value={form.destination}
            selected={form.destinationPlace}
            placeholder="Ville, adresse ou lieu d’arrivée"
            onTextChange={(value) => setForm({ ...form, destination: value, destinationPlace: undefined })}
            onSelect={(suggestion) => suggestion.place && setForm({ ...form, destination: suggestion.label, destinationPlace: suggestion.place })}
          />
          <label>
            <span>Date</span>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
          </label>
          <label>
            <span>{title}</span>
            <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} required />
          </label>
          <label>
            <span>Conduite préférée max jusqu'à la gare</span>
            <select value={form.maxDriveMinutes} onChange={(e) => setForm({ ...form, maxDriveMinutes: Number(e.target.value) })}>
              <option value={45}>45 min</option>
              <option value={60}>1 h</option>
              <option value={90}>1 h 30</option>
              <option value={120}>2 h</option>
              <option value={180}>3 h</option>
            </select>
          </label>
        </div>

        <button className="primary" disabled={loading || !form.originPlace || !form.destinationPlace}>{loading ? "Recherche des gares…" : !form.originPlace || !form.destinationPlace ? "Confirme le départ et la destination" : "Trouver le meilleur trajet"}</button>
        <p className="form-hint">V0.3.5.3 Global Beta : adresses via Google Places, voiture limitée à 60 % des km, plafond à 150 % du temps voiture et carte zoomable.</p>
      </form>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <section className="results">
          <div className="results-head">
            <div>
              <p className="eyebrow">{modeLabel}</p>
              <h2>{result.origin.name} → {result.destination.name}</h2>
            </div>
            <span className="result-count">{result.options.length} synthèse{result.options.length > 1 ? "s" : ""} · {result.candidateStationCount} candidates · {result.viableStationCount} avec solution</span>
          </div>

          <div className="provider-status">
            <span>🌍 V0.3.5.3 Global Beta</span>
            <span>{result.providers.road.live ? "✅" : "🧪"} 🚗 {result.providers.road.name}</span>
            <span>{result.providers.rail.live ? "✅" : "🧪"} 🚆 {result.providers.rail.name}</span>
            <span>🔀 Jusqu’à {result.usedMaxTransfers} correspondances · automatique</span>
          </div>

          <div className="direct-car-reference">
            <span>🚗 Référence 100 % voiture</span>
            <strong>{fmtDuration(result.directCar.durationMinutes)} · {result.directCar.distanceKm} km</strong>
          </div>

          {result.adjustment.kind !== "none" && (
            <div className={`adjustment-box ${result.adjustment.kind}`}>
              <strong>{result.adjustment.kind === "previousDay" ? "⚠️ Aucun départ le jour même" : "↪️ Recherche adaptée automatiquement"}</strong>
              <span>{result.adjustment.message}</span>
            </div>
          )}

          {result.options.length === 0 ? (
            <div className="empty">Aucune solution multimodale respectant les garde-fous : maximum 60 % des kilomètres en voiture et 150 % du temps de la voiture seule.</div>
          ) : (
            <>
              {[
                { key: "requestedDay" as const, title: "📅 Jour J", subtitle: `Départ le ${result.request.date}` },
                { key: "previousDay" as const, title: "🌙 La veille", subtitle: "Départ la veille de la date demandée" }
              ].map((group) => {
                const groupOptions = result.options.filter((option) => option.departureDay === group.key);
                return (
                  <div className="result-day-group" key={group.key}>
                    <div className="day-group-head">
                      <h3>{group.title}</h3>
                      <span>{group.subtitle}</span>
                    </div>
                    {groupOptions.length === 0 ? (
                      <div className="empty">Aucune solution trouvée pour ce jour de départ.</div>
                    ) : (
                      <div className="option-grid">
                        {groupOptions.map((option) => {
                          const deltaVsCar = option.totalMinutes - result.directCar.durationMinutes;
                          return (
                            <article className="option-card" key={option.id}>
                              <div className="badges">
                                {option.labels.map((label) => <span key={`${label.criterion}-${label.rank}`}>{recommendationLabel(label)}</span>)}
                              </div>
                              <h3>{option.station.name}</h3>
                              {option.warnings.length > 0 && (
                                <div className="tradeoffs" aria-label="Points d’attention">
                                  {option.warnings.map((warning) => <span key={warning}>⚠️ {warning}</span>)}
                                </div>
                              )}
                              <p className="leave-time">Départ conseillé <strong>{fmtDateTime(option.recommendedDepartureAt, result.origin.timeZone)}</strong></p>
                              {result.request.mode === "arriveBy" && <p className="comfort">Confortable : {fmtDateTime(option.comfortableDepartureAt, result.origin.timeZone)} · limite : {fmtDateTime(option.latestDepartureAt, result.origin.timeZone)}</p>}

                              <div className="timeline road-timeline">
                                <div><span>🚗</span><p><b>{fmtDateTime(option.recommendedDepartureAt, result.origin.timeZone)}</b> départ<br/><small>{fmtDuration(option.drive.durationMinutes)} · {option.drive.distanceKm} km</small></p></div>
                                <div><span>🅿️</span><p><b>{fmtDateTime(option.stationArrivalAt, option.station.timeZone ?? result.origin.timeZone)}</b> gare<br/><small>{option.bufferMinutes} min de marge</small></p></div>
                              </div>

                              <RailDetails option={option} origin={result.origin} destination={result.destination} />

                              <div className="car-comparison">
                                <div>
                                  <span>Temps total de cette option</span>
                                  <strong>{fmtDuration(option.totalMinutes)}</strong>
                                </div>
                                <div>
                                  <span>100 % voiture</span>
                                  <strong>{fmtDuration(result.directCar.durationMinutes)}</strong>
                                </div>
                                <div className={deltaVsCar > 0 ? "comparison-slower" : deltaVsCar < 0 ? "comparison-faster" : ""}>
                                  <span>Écart</span>
                                  <strong>{fmtDelta(deltaVsCar)} vs voiture</strong>
                                </div>
                              </div>

                              <div className="metrics">
                                <div><span>CO₂</span><strong>{option.co2Kg} kg</strong></div>
                                <div><span>Coût estimé</span><strong>~{option.estimatedCostEur.toFixed(1)} €</strong></div>
                                <div><span>Voiture utilisée</span><strong>{option.drive.distanceKm} km · {result.directCar.distanceKm > 0 ? Math.round((option.drive.distanceKm / result.directCar.distanceKm) * 100) : 0} %</strong></div>
                                <div><span>Voiture évitée</span><strong>{option.carKmAvoided} km</strong></div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          <div className="notes">
            <p>• {result.candidateStationCount} gares candidates testées ; {result.viableStationCount} ont fourni au moins une solution. Les 3 meilleurs candidats par critère sont affichés avec déduplication.</p>
            <p>• Les lieux et les gares sont désormais recherchés dynamiquement. La mini-carte conserve la liaison voiture puis le tracé des transports publics détaillé lorsque MOTIS le fournit.</p>
            <p>• Données transport : <a href="https://transitous.org/sources/" target="_blank" rel="noreferrer">sources Transitous/MOTIS</a>.</p>
            {result.notes.map((note) => <p key={note}>• {note}</p>)}
          </div>
        </section>
      )}
    </>
  );
}
