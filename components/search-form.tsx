"use client";

import { useMemo, useState } from "react";
import type { SearchRequest, SearchResponse } from "@/lib/types";

function tomorrowLocal() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtTime(iso: string) {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(iso));
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
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

const labelText = {
  closestDrive: "🚗 Gare la plus proche",
  mostDirectRail: "🚆 Train le plus direct",
  bestCompromise: "⚖️ Meilleur compromis",
  bestArrivalFit: "🎯 Arrivée la plus proche"
} as const;

export default function SearchForm() {
  const [form, setForm] = useState<SearchRequest>({
    origin: "Courlaoux",
    destination: "Düsseldorf",
    date: tomorrowLocal(),
    time: "10:30",
    mode: "arriveBy",
    maxDriveMinutes: 90,
    maxTransfers: 1,
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
            <span>Correspondances max</span>
            <select value={form.maxTransfers} onChange={(e) => setForm({ ...form, maxTransfers: Number(e.target.value) })}>
              <option value={0}>0 · Direct uniquement</option>
              <option value={1}>Jusqu'à 1 correspondance · direct inclus</option>
              <option value={2}>Jusqu'à 2 correspondances · direct inclus</option>
              <option value={3}>Jusqu'à 3 correspondances · direct inclus</option>
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
        <p className="form-hint">V0.1.9 : en mode “Arriver avant”, l’app ajoute une sélection qui arrive au plus près de l’heure demandée sans dégrader fortement le temps total. Les dates et les inconvénients sont affichés clairement.</p>
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
            <span>{result.providers.road.live ? "✅" : "🧪"} 🚗 {result.providers.road.name}</span>
            <span>{result.providers.rail.live ? "✅" : "🧪"} 🚆 {result.providers.rail.name}</span>
            <span>🔀 {result.request.maxTransfers === 0 ? "Direct uniquement" : `${result.request.maxTransfers} correspondance${result.request.maxTransfers > 1 ? "s" : ""} max`}</span>
          </div>

          {result.options.length === 0 ? (
            <div className="empty">Aucune gare intéressante trouvée avec cette limite de conduite.</div>
          ) : (
            <div className="option-grid">
              {result.options.map((option) => (
                <article className="option-card" key={option.id}>
                  <div className="badges">
                    {option.labels.map((label) => <span key={label}>{labelText[label]}</span>)}
                  </div>
                  <h3>{option.station.name}</h3>
                  {option.warnings.length > 0 && (
                    <div className="tradeoffs" aria-label="Points d’attention">
                      {option.warnings.map((warning) => <span key={warning}>⚠️ {warning}</span>)}
                    </div>
                  )}
                  <p className="leave-time">Départ conseillé <strong>{fmtDateTime(option.recommendedDepartureAt)}</strong></p>
                  {result.request.mode === "arriveBy" && <p className="comfort">Confortable : {fmtDateTime(option.comfortableDepartureAt)} · limite : {fmtDateTime(option.latestDepartureAt)}</p>}

                  <div className="timeline">
                    <div><span>🚗</span><p><b>{fmtDateTime(option.recommendedDepartureAt)}</b> départ<br/><small>{fmtDuration(option.drive.durationMinutes)} · {option.drive.distanceKm} km</small></p></div>
                    <div><span>🅿️</span><p><b>{fmtDateTime(option.stationArrivalAt)}</b> gare<br/><small>{option.bufferMinutes} min de marge</small></p></div>
                    <div><span>🚆</span><p><b>{fmtDateTime(option.trainDepartureAt)}</b> train<br/><small>{fmtDuration(option.rail.durationMinutes)} · {option.rail.changes} changement{option.rail.changes > 1 ? "s" : ""}{option.rail.realtime ? " · temps réel" : ""}</small>
                      {option.rail.services?.length ? <small className="services">{option.rail.services.join(" · ")}</small> : null}</p></div>
                    {option.rail.transfers?.map((transfer, index) => (
                      <div className="transfer-step" key={`${transfer.stationName}-${transfer.arrivalAt}-${index}`}>
                        <span>🔁</span>
                        <p>
                          <b>{transfer.stationName}</b><br/>
                          <small>Arrivée {fmtDateTime(transfer.arrivalAt)} · départ suivant {fmtDateTime(transfer.departureAt)}</small>
                          <strong className="transfer-duration">Transit : {fmtDuration(transfer.durationMinutes)}</strong>
                          {(transfer.fromService || transfer.toService) && (
                            <small className="services">{transfer.fromService ?? "Train précédent"} → {transfer.toService ?? "Train suivant"}</small>
                          )}
                        </p>
                      </div>
                    ))}
                    <div><span>📍</span><p><b>{fmtDateTime(option.destinationArrivalAt)}</b> arrivée</p></div>
                  </div>

                  <div className="metrics">
                    <div><span>Total</span><strong>{fmtDuration(option.totalMinutes)}</strong></div>
                    <div><span>CO₂</span><strong>{option.co2Kg} kg</strong></div>
                    <div><span>Coût estimé</span><strong>~{option.estimatedCostEur.toFixed(1)} €</strong></div>
                    <div><span>Voiture évitée</span><strong>{option.carKmAvoided} km</strong></div>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="notes">
            <p>• {result.viableStationCount} gare{result.viableStationCount > 1 ? "s" : ""} analysée{result.viableStationCount > 1 ? "s" : ""} ; seules les meilleures synthèses sont affichées.</p>
            {result.notes.map((note) => <p key={note}>• {note}</p>)}
          </div>
        </section>
      )}
    </>
  );
}
