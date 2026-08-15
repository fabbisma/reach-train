"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { JourneyOption, LatLng, Place } from "@/lib/types";

type MapPoint = LatLng & { name: string; kind: "origin" | "start" | "transfer" | "end" };

function sameCoord(a: LatLng, b: LatLng) {
  return Math.abs(a.lat - b.lat) < 0.00001 && Math.abs(a.lng - b.lng) < 0.00001;
}

function buildRoadGeometry(option: JourneyOption, origin: Place): LatLng[] {
  if (option.drive.geometry?.length && option.drive.geometry.length >= 2) return option.drive.geometry;
  return [
    { lat: origin.lat, lng: origin.lng },
    { lat: option.station.lat, lng: option.station.lng }
  ];
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

function buildMarkers(option: JourneyOption, origin: Place, destination: Place): MapPoint[] {
  const segments = option.rail.segments ?? [];
  const markers: MapPoint[] = [{
    lat: origin.lat,
    lng: origin.lng,
    name: origin.name,
    kind: "origin"
  }];

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

export default function RailMap({ option, origin, destination }: { option: JourneyOption; origin: Place; destination: Place }) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const roadGeometry = useMemo(() => buildRoadGeometry(option, origin), [option, origin]);
  const railGeometry = useMemo(() => buildRailGeometry(option, destination), [option, destination]);
  const markers = useMemo(() => buildMarkers(option, origin, destination), [option, origin, destination]);

  useEffect(() => {
    if (!elementRef.current) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void import("leaflet")
      .then((L) => {
        if (disposed || !elementRef.current) return;

        const map = L.map(elementRef.current, {
          zoomControl: true,
          attributionControl: true,
          scrollWheelZoom: true,
          doubleClickZoom: true,
          boxZoom: true,
          keyboard: true,
          touchZoom: true,
          dragging: true
        });

        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributeurs'
        }).addTo(map);

        const roadLine = L.polyline(roadGeometry.map((point) => L.latLng(point.lat, point.lng)), {
          color: "#4f6f9f",
          weight: 4,
          opacity: 0.85,
          dashArray: "8 8"
        }).addTo(map);

        const railLine = L.polyline(railGeometry.map((point) => L.latLng(point.lat, point.lng)), {
          color: "#2b8a5a",
          weight: 4,
          opacity: 0.9
        }).addTo(map);

        markers.forEach((marker) => {
          const radius = marker.kind === "transfer" ? 5 : 7;
          const color = marker.kind === "origin" ? "#4f6f9f" : marker.kind === "end" ? "#263238" : "#2b8a5a";
          const point = L.circleMarker([marker.lat, marker.lng], {
            radius,
            weight: 3,
            color,
            fillColor: "#ffffff",
            fillOpacity: 1
          }).addTo(map);
          point.bindTooltip(marker.name, {
            direction: "top",
            offset: [0, -7],
            permanent: marker.kind !== "transfer",
            opacity: 0.92
          });
        });

        const bounds = roadLine.getBounds();
        bounds.extend(railLine.getBounds());
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
  }, [roadGeometry, railGeometry, markers]);

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
        <strong>🗺️ Voiture + train</strong>
        <span>Carte interactive · +/−, molette, pincement et déplacement</span>
      </div>
      <div ref={elementRef} className="rail-map" aria-label={`Carte multimodale ${routeNames.join(" vers ")}`} />
      <div className="rail-map-legend">
        <span><i className="legend-road" />🚗 Voiture jusqu’à {option.station.name}</span>
        <span><i className="legend-rail" />🚆 Train jusqu’à {destination.name}</span>
      </div>
      <div className="rail-map-route">{routeNames.join(" → ")}</div>
    </div>
  );
}
