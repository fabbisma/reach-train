"use client";

import { useMemo, useState } from "react";
import RailMap from "@/components/rail-map";
import type { JourneyOption, Place, RecommendationBadge, SearchRequest, SearchResponse } from "@/lib/types";

function tomorrowLocal() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDateTime(iso: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris"
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
  fastestRailWithinLimit: "⏱️ Train le plus court · dans le périmètre",
  fastestRailExtended: "🚙⏱️ Train le plus court · conduite étendue",
  fastestTotal: "🏁 Trajet total le plus court"
} as const;

function recommendationLabel(label: RecommendationBadge) {
  const medal = label.rank === 1 ? "🥇" : label.rank === 2 ? "🥈" : "🥉";
  return `${medal} ${labelText[label.criterion]}`;
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
          <small>{fmtDuration(option.rail.durationMinutes)} · {option.rail.changes} changement{option.rail.changes > 1 ? "s" : ""}{option.rail.realtime ? " · temps réel" : ""}</small>
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
                  <div className="segment-kicker">Train {index + 1}{segment.service ? ` · ${segment.service}` : ""}</div>
                  <strong className="segment-route">{segment.fromStation} → {segment.toStation}</strong>
                  <div className="segment-times">
                    <span>Départ <b>{fmtDateTime(segment.departureAt)}</b></span>
                    <span>Arrivée <b>{fmtDateTime(segment.arrivalAt)}</b></span>
                    <span>{fmtDuration(segment.durationMinutes)}</span>
                  </div>
                </div>
                {transfer && (
                  <div className="transfer-card">
                    <strong>🔁 Correspondance : {transfer.stationName}</strong>
                    <span>Arrivée {fmtDateTime(transfer.arrivalAt)}</span>
                    <span>Départ suivant {fmtDateTime(transfer.departureAt)}</span>
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
            <span>Départ <b>{fmtDateTime(option.trainDepartureAt)}</b></span>
            <span>Arrivée <b>{fmtDateTime(option.destinationArrivalAt)}</b></span>
          </div>
          {option.rail.services?.length ? <small className="services">{option.rail.services.join(" · ")}</small> : null}
        </div>
      )}
    </div>
  );
}

export default function SearchForm() {
  const [form, setForm] = useState<SearchRequest>({
    origin: "Courlaoux",
    destination: "Düsseldorf",
    date: tomorrowLocal(),
    time: "10:30",
    mode: "arriveBy",
    maxDriveMinutes: 90,
    vehicleType: "electric"
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
          <label>
            <span>Départ</span>
            <input value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })} placeholder="Courlaoux" required />
          </label>
          <label>
            <span>Destination</span>
            <input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} placeholder="Düsseldorf" required />
          </label>
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
          <label>
            <span>Voiture</span>
            <select value={form.vehicleType} onChange={(e) => setForm({ ...form, vehicleType: e.target.value as SearchRequest["vehicleType"] })}>
              <option value="electric">Électrique</option>
              <option value="thermal">Thermique</option>
            </select>
          </label>
        </div>

        <button className="primary" disabled={loading}>{loading ? "Recherche des gares…" : "Trouver le meilleur trajet"}</button>
        <p className="form-hint">V0.2.8.1 : mini-carte OpenStreetMap avec liaison voiture + tracé ferroviaire, segments détaillés et comparaison 100 % voiture.</p>
      </form>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <section className="results">
          <div className="results-head">
            <div>
              <p className="eyebrow">{modeLabel}</p>
              <h2>{result.origin.name} → {result.destination.name}</h2>
            </div>
            <span className="result-count">{result.options.length} synthèse{result.options.length > 1 ? "s" : ""} · {result.viableStationCount} gares analysées</span>
          </div>

          <div className="provider-status">
            <span>🧩 V0.2.8.1</span>
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
            <div className="empty">Aucune solution ferroviaire trouvée pour le jour J ou la veille.</div>
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
                              <p className="leave-time">Départ conseillé <strong>{fmtDateTime(option.recommendedDepartureAt)}</strong></p>
                              {result.request.mode === "arriveBy" && <p className="comfort">Confortable : {fmtDateTime(option.comfortableDepartureAt)} · limite : {fmtDateTime(option.latestDepartureAt)}</p>}

                              <div className="timeline road-timeline">
                                <div><span>🚗</span><p><b>{fmtDateTime(option.recommendedDepartureAt)}</b> départ<br/><small>{fmtDuration(option.drive.durationMinutes)} · {option.drive.distanceKm} km</small></p></div>
                                <div><span>🅿️</span><p><b>{fmtDateTime(option.stationArrivalAt)}</b> gare<br/><small>{option.bufferMinutes} min de marge</small></p></div>
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
                                <div><span>Voiture utilisée</span><strong>{option.drive.distanceKm} km</strong></div>
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
            <p>• {result.viableStationCount} gare{result.viableStationCount > 1 ? "s" : ""} analysée{result.viableStationCount > 1 ? "s" : ""} ; les 3 meilleurs candidats par critère sont affichés, avec déduplication des gares.</p>
            <p>• La mini-carte montre maintenant la liaison voiture jusqu’à la gare puis le train. Avec Google Routes, la route voiture réelle est tracée ; sinon une liaison directe est utilisée. Avec Transitous, le tracé ferroviaire détaillé MOTIS reste prioritaire.</p>
            {result.notes.map((note) => <p key={note}>• {note}</p>)}
          </div>
        </section>
      )}
    </>
  );
}
