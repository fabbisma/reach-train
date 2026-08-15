"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { JourneyOption, LatLng, Place } from "@/lib/types";

type MapPoint = LatLng & { name: string; kind: "start" | "transfer" | "end" };

function sameCoord(a: LatLng, b: LatLng) {
  return Math.abs(a.lat - b.lat) < 0.00001 && Math.abs(a.lng - b.lng) < 0.00001;
}

function buildRailGeometry(option: JourneyOption, destination: Place): LatLng[] {
  const result: LatLng[] = [];

  for (const segment of option.rail.segments ?? []) {
    const geometry = segment.geometry?.length
      ? segment.geometry
      : [
          segment.fromLat != null && segment.fromLng != null ? { lat: segment.fromLat, lng: segment.fromLng } : null,
          segment.toLat != null && segment.toLng != null ? { lat: segment.toLat, lng: segment.toLng } : null
        ].filter((point): point is LatLng => Boolean(point));

    for (const point of geometry) {
      if (!result.length || !sameCoord(result[result.length - 1], point)) result.push(point);
    }
  }

  if (result.length >= 2) return result;
  return [
    { lat: option.station.lat, lng: option.station.lng },
    { lat: destination.lat, lng: destination.lng }
  ];
}

function buildMarkers(option: JourneyOption, destination: Place): MapPoint[] {
  const segments = option.rail.segments ?? [];
  const markers: MapPoint[] = [];

  const first = segments[0];
  markers.push({
    lat: first?.fromLat ?? option.station.lat,
    lng: first?.fromLng ?? option.station.lng,
    name: first?.fromStation ?? option.station.name,
    kind: "start"
  });

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment.toLat == null || segment.toLng == null) continue;
    markers.push({
      lat: segment.toLat,
      lng: segment.toLng,
      name: segment.toStation,
      kind: "transfer"
    });
  }

  const last = segments[segments.length - 1];
  markers.push({
    lat: last?.toLat ?? destination.lat,
    lng: last?.toLng ?? destination.lng,
    name: last?.toStation ?? destination.name,
    kind: "end"
  });

  return markers.filter((marker, index, all) =>
    index === 0 || !sameCoord(marker, all[index - 1]) || marker.name !== all[index - 1].name
  );
}

export default function RailMap({ option, destination }: { option: JourneyOption; destination: Place }) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const geometry = useMemo(() => buildRailGeometry(option, destination), [option, destination]);
  const markers = useMemo(() => buildMarkers(option, destination), [option, destination]);

  useEffect(() => {
    if (!elementRef.current) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void import("leaflet")
      .then((L) => {
        if (disposed || !elementRef.current) return;

        const map = L.map(elementRef.current, {
          zoomControl: false,
          attributionControl: true,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          boxZoom: false,
          keyboard: false
        });

        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributeurs'
        }).addTo(map);

        const latLngs = geometry.map((point) => L.latLng(point.lat, point.lng));
        const line = L.polyline(latLngs, {
          weight: 4,
          opacity: 0.85
        }).addTo(map);

        markers.forEach((marker) => {
          const radius = marker.kind === "transfer" ? 5 : 7;
          const point = L.circleMarker([marker.lat, marker.lng], {
            radius,
            weight: 3,
            fillOpacity: 1
          }).addTo(map);
          point.bindTooltip(marker.name, {
            direction: "top",
            offset: [0, -7],
            permanent: marker.kind !== "transfer",
            opacity: 0.92
          });
        });

        const bounds = line.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [18, 18], maxZoom: 9 });

        const timer = window.setTimeout(() => map.invalidateSize(false), 80);
        cleanup = () => {
          window.clearTimeout(timer);
          map.remove();
        };
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [geometry, markers]);

  const routeNames = markers.map((marker) => marker.name);

  if (failed) {
    return (
      <div className="rail-map-fallback">
        🗺️ Carte indisponible · {routeNames.join(" → ")}
      </div>
    );
  }

  return (
    <div className="rail-map-wrap">
      <div className="rail-map-head">
        <strong>🗺️ Parcours ferroviaire</strong>
        <span>Fond OpenStreetMap · zoomez ou déplacez la carte si besoin</span>
      </div>
      <div ref={elementRef} className="rail-map" aria-label={`Carte du parcours ferroviaire ${routeNames.join(" vers ")}`} />
      <div className="rail-map-route">{routeNames.join(" → ")}</div>
    </div>
  );
}
