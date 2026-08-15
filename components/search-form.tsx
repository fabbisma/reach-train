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

function fmtDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

const labelText = {
  recommended: "⚖️ Recommandé",
  greenest: "🌱 CO₂ mini",
  fastest: "⚡ Plus rapide",
  cheapest: "💰 Moins cher"
} as const;

export default function SearchForm() {
  const [form, setForm] = useState<SearchRequest>({
    origin: "Courlaoux",
    destination: "Paris",
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
            <input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} placeholder="Paris" required />
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
            <span>Conduite max jusqu'à la gare</span>
            <select value={form.maxDriveMinutes} onChange={(e) => setForm({ ...form, maxDriveMinutes: Number(e.target.value) })}>
              <option value={45}>45 min</option>
              <option value={60}>1 h</option>
              <option value={90}>1 h 30</option>
              <option value={120}>2 h</option>
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
        <p className="form-hint">V0.1 : l'app choisit elle-même la gare stratégique et calcule l'heure de départ en voiture.</p>
      </form>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <section className="results">
          <div className="results-head">
            <div>
              <p className="eyebrow">{result.mode === "demo" ? "MODE DÉMO" : "DONNÉES RÉELLES"}</p>
              <h2>{result.origin.name} → {result.destination.name}</h2>
            </div>
            <span className="result-count">{result.options.length} options retenues</span>
          </div>

          {result.options.length === 0 ? (
            <div className="empty">Aucune gare intéressante trouvée avec cette limite de conduite.</div>
          ) : (
            <div className="option-grid">
              {result.options.map((option) => (
                <article className={`option-card ${option.labels.includes("recommended") ? "recommended" : ""}`} key={option.id}>
                  <div className="badges">
                    {option.labels.map((label) => <span key={label}>{labelText[label]}</span>)}
                  </div>
                  <h3>{option.station.name}</h3>
                  <p className="leave-time">Départ conseillé <strong>{fmtTime(option.recommendedDepartureAt)}</strong></p>
                  {form.mode === "arriveBy" && <p className="comfort">Confortable : {fmtTime(option.comfortableDepartureAt)} · limite : {fmtTime(option.latestDepartureAt)}</p>}

                  <div className="timeline">
                    <div><span>🚗</span><p><b>{fmtTime(option.recommendedDepartureAt)}</b> départ<br/><small>{fmtDuration(option.drive.durationMinutes)} · {option.drive.distanceKm} km</small></p></div>
                    <div><span>🅿️</span><p><b>{fmtTime(option.stationArrivalAt)}</b> gare<br/><small>{option.bufferMinutes} min de marge</small></p></div>
                    <div><span>🚆</span><p><b>{fmtTime(option.trainDepartureAt)}</b> train<br/><small>{fmtDuration(option.rail.durationMinutes)} · {option.rail.changes} changement{option.rail.changes > 1 ? "s" : ""}</small></p></div>
                    <div><span>📍</span><p><b>{fmtTime(option.destinationArrivalAt)}</b> arrivée</p></div>
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
            {result.notes.map((note) => <p key={note}>• {note}</p>)}
          </div>
        </section>
      )}
    </>
  );
}
