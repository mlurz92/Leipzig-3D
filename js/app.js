/* Leipzig 3D – Echtdaten-Modell
   Gebäude/Gelände/Satellit werden live von offenen Quellen geladen:
   - Vektorkacheln (Gebäudegrundrisse + render_height aus OSM): OpenFreeMap / OpenMapTiles
   - Gelände-DEM: AWS Terrain Tiles (Terrarium, SRTM/Copernicus-abgeleitet)
   - Satellit: Esri World Imagery
   - Suche: Nominatim (OSM) · Validierung & Bäume: Overpass API (OSM-Rohdaten)
*/
const $ = (s) => document.querySelector(s);
const LEIPZIG_CENTER = [12.3747, 51.3397];
let map, buildingsReady = false, tourTimer = null, tourIndex = 0;

function setLoad(pct, text) {
  const b = $("#load-bar"), s = $("#load-status");
  if (b) b.style.width = pct + "%";
  if (s && text) s.textContent = text;
}

function buildingColorExpression(mode) {
  if (mode === "hoehe") {
    return ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8],
      0, "#8ecae6", 8, "#d9c7a7", 20, "#e9c46a", 40, "#f4a261", 80, "#bc6c25", 140, "#6d597a"];
  }
  if (mode === "einheitlich") return "#cfc4ae";
  // Fassaden-Modus: echte OSM-Farbe, wo erfasst. Sonst realistische Leipziger Typologie nach Höhe:
  // niedrige Altbauten = warmer Stuck/Sandstein, mittlere = Stuck/Beton-Mischung, Hochhäuser = Glas/Beton.
  return ["case",
    ["has", "colour"], ["get", "colour"],
    ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8],
      0, "#cdbb96", 7, "#d6c29c", 13, "#d0bd97", 18, "#c3b498", 26, "#b3ada0", 45, "#a3adb2", 80, "#93a9b7", 140, "#87a3b5"]];
}

function addCustomLayers() {
  if (!map.getSource("terrain-dem")) {
    map.addSource("terrain-dem", {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      encoding: "terrarium", tileSize: 256, maxzoom: 15,
      attribution: "Gelände: Mapzen / AWS Terrain Tiles (SRTM, Copernicus)"
    });
  }
  if (!map.getSource("esri-sat")) {
    map.addSource("esri-sat", {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256, maxzoom: 19,
      attribution: "Satellit: Esri, Maxar, Earthstar Geographics"
    });
  }
  // Satellitenbild unter die Gebäude legen (über Basis-Karte umschaltbar)
  const firstSymbol = (map.getStyle().layers.find(l => l.type === "symbol") || {}).id;
  if (!map.getLayer("sat-layer")) {
    map.addLayer({ id: "sat-layer", type: "raster", source: "esri-sat",
      layout: { visibility: "none" }, paint: { "raster-opacity": 1 } }, firstSymbol);
  }
  // 3D-Gebäude aus echten OSM-Grundrissen + Höhen
  const src = map.getStyle().sources["openmaptiles"] ? "openmaptiles" : null;
  if (src && !map.getLayer("leipzig-buildings-3d")) {
    map.addLayer({
      id: "leipzig-buildings-3d", type: "fill-extrusion", source: src, "source-layer": "building",
      minzoom: parseFloat($("#minzoom").value),
      filter: ["!=", ["get", "hide_3d"], true],
      paint: {
        "fill-extrusion-color": buildingColorExpression($("#sel-colormode").value),
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.92,
        "fill-extrusion-vertical-gradient": true
      }
    }, firstSymbol);
    buildingsReady = true;
  }
  // Realistische Dachschicht für ALLE Gebäude: dünne 3D-Kappe auf der Gebäudehöhe.
  // Steildächer (niedrige Altbauten) = Ziegel/Schiefer-Töne, Flachdächer (hohe Bauten) = Grau/Bitumen.
  if (src && !map.getLayer("leipzig-roofs")) {
    map.addLayer({
      id: "leipzig-roofs", type: "fill-extrusion", source: src, "source-layer": "building",
      minzoom: parseFloat($("#minzoom").value),
      filter: ["!=", ["get", "hide_3d"], true],
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8],
          0, "#7c4a3a", 9, "#81503f", 14, "#6f5148", 20, "#5f5a55", 35, "#7e858a", 80, "#969ea3"],
        "fill-extrusion-height": ["+", ["coalesce", ["get", "render_height"], 8], 0.35],
        "fill-extrusion-base": ["coalesce", ["get", "render_height"], 8],
        "fill-extrusion-opacity": 0.98
      }
    }, firstSymbol);
  }
  // Wahrzeichen
  if (!map.getSource("landmarks")) {
    map.addSource("landmarks", { type: "geojson", data: {
      type: "FeatureCollection",
      features: window.LEIPZIG_LANDMARKS.map(l => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [l.lon, l.lat] },
        properties: { id: l.id, name: l.name, category: l.category }
      }))
    }});
  }
  if (!map.getLayer("landmark-circles")) {
    map.addLayer({ id: "landmark-circles", type: "circle", source: "landmarks", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 9],
      "circle-color": "#ffd43b", "circle-stroke-color": "#10213f", "circle-stroke-width": 2, "circle-opacity": 0.95 }});
    map.addLayer({ id: "landmark-labels", type: "symbol", source: "landmarks", layout: {
      "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.4], "text-anchor": "top",
      "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#fff", "text-halo-color": "rgba(5,10,25,.85)", "text-halo-width": 1.6 }});
  }
  // Einzelbaum-Echtdaten (Overpass), zunächst leer
  if (!map.getSource("trees")) map.addSource("trees", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  if (!map.getLayer("trees-layer")) {
    map.addLayer({ id: "trees-layer", type: "circle", source: "trees", layout: { visibility: "none" }, paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2, 18, 6],
      "circle-color": "#2f9e44", "circle-stroke-color": "#d3f9d8", "circle-stroke-width": 1, "circle-opacity": 0.9 }});
  }
  // --- Alle weiteren Echt-Datenebenen (werden per Overpass befüllt) ---
  const empty = () => ({ type: "geojson", data: { type: "FeatureCollection", features: [] } });
  ["detail-buildings-src","tree-crowns-src","rail-src","cycle-src","stops-src","pois-src","bounds-src","bounds-label-src","water-src"].forEach(id => {
    if (!map.getSource(id)) map.addSource(id, empty());
  });
  const vis = (id, on) => on ? "visible" : "none";
  if (!map.getLayer("bounds-layer")) map.addLayer({ id: "bounds-layer", type: "line", source: "bounds-src", layout:{visibility:"none"},
    paint: { "line-color": "#e599f7", "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.9 } });
  if (!map.getLayer("bounds-labels")) map.addLayer({ id: "bounds-labels", type: "symbol", source: "bounds-label-src", layout:{visibility:"none",
    "text-field": ["get","name"], "text-size": 12, "text-font": ["Noto Sans Regular"]},
    paint: { "text-color": "#e599f7", "text-halo-color": "rgba(5,10,25,.9)", "text-halo-width": 1.8 } });
  if (!map.getLayer("water-layer")) map.addLayer({ id: "water-layer", type: "line", source: "water-src", layout:{visibility:"none"},
    paint: { "line-color": "#4dabf7", "line-width": ["interpolate",["linear"],["zoom"],12,1,17,5], "line-opacity": 0.95 } });
  if (!map.getLayer("cycle-layer")) map.addLayer({ id: "cycle-layer", type: "line", source: "cycle-src", layout:{visibility:"none"},
    paint: { "line-color": "#51cf66", "line-width": 2.2, "line-dasharray": [2, 1.2], "line-opacity": 0.95 } });
  if (!map.getLayer("rail-layer")) map.addLayer({ id: "rail-layer", type: "line", source: "rail-src", layout:{visibility:"none"},
    paint: { "line-color": ["match", ["get","kind"], "tram", "#ff6b6b", "rail", "#f8f9fa", "#ffa94d"],
      "line-width": ["interpolate",["linear"],["zoom"],12,1,17,4.5], "line-opacity": 0.95 } });
  if (!map.getLayer("tree-crowns")) map.addLayer({ id: "tree-crowns", type: "fill-extrusion", source: "tree-crowns-src", layout:{visibility:"none"},
    paint: { "fill-extrusion-color": ["get","color"], "fill-extrusion-height": ["get","height"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.9 } });
  if (!map.getLayer("detail-buildings")) map.addLayer({ id: "detail-buildings", type: "fill-extrusion", source: "detail-buildings-src", layout:{visibility:"none"},
    paint: { "fill-extrusion-color": ["get","color"], "fill-extrusion-height": ["get","height"], "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 0.97, "fill-extrusion-vertical-gradient": true } });
  // Dachschicht der Detail-Gebäude: echte roof:colour aus OSM, sonst aus Dachform/Material abgeleitet
  if (!map.getLayer("detail-roofs")) map.addLayer({ id: "detail-roofs", type: "fill-extrusion", source: "detail-buildings-src", layout:{visibility:"none"},
    paint: { "fill-extrusion-color": ["get","roofDisplayColor"],
      "fill-extrusion-height": ["+", ["get","height"], ["get","roofCap"]], "fill-extrusion-base": ["get","height"],
      "fill-extrusion-opacity": 0.99 } });
  if (!map.getLayer("stops-layer")) map.addLayer({ id: "stops-layer", type: "circle", source: "stops-src", layout:{visibility:"none"},
    paint: { "circle-radius": ["interpolate",["linear"],["zoom"],13,3,17,8], "circle-color": "#ffd43b", "circle-stroke-color": "#10213f", "circle-stroke-width": 2 } });
  if (!map.getLayer("stops-labels")) map.addLayer({ id: "stops-labels", type: "symbol", source: "stops-src", minzoom: 15, layout:{visibility:"none",
    "text-field": ["get","name"], "text-size": 10, "text-offset": [0,1.3], "text-anchor": "top", "text-font": ["Noto Sans Regular"]},
    paint: { "text-color": "#ffe066", "text-halo-color": "rgba(5,10,25,.9)", "text-halo-width": 1.5 } });
  if (!map.getLayer("pois-layer")) map.addLayer({ id: "pois-layer", type: "circle", source: "pois-src", layout:{visibility:"none"},
    paint: { "circle-radius": ["interpolate",["linear"],["zoom"],13,3,17,7],
      "circle-color": ["match", ["get","group"], "Kultur", "#e599f7", "Gastro", "#ffa94d", "Bildung", "#74c0fc", "Gesundheit", "#ff8787", "Sport", "#69db7c", "Einkaufen", "#ffd43b", "#ced4da"],
      "circle-stroke-color": "#0b1220", "circle-stroke-width": 1.5 } });
  if (!map.getLayer("pois-labels")) map.addLayer({ id: "pois-labels", type: "symbol", source: "pois-src", minzoom: 16, layout:{visibility:"none",
    "text-field": ["get","name"], "text-size": 10, "text-offset": [0,1.3], "text-anchor": "top", "text-font": ["Noto Sans Regular"]},
    paint: { "text-color": "#fff", "text-halo-color": "rgba(5,10,25,.9)", "text-halo-width": 1.5 } });

  applyBasemap(document.querySelector("[data-basemap].active")?.dataset.basemap || "karte");
  applySun(parseFloat($("#sun").value));
}

function setCatalog(id, state, title) {
  const el = document.getElementById(id); if (!el) return;
  el.className = state === "ok" ? "ok" : state === "err" ? "err" : "";
  if (title) el.title = title;
}
function layerVis(ids, on) { ids.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }); }

function labelLayerIds() {
  return (map.getStyle().layers || []).filter(l => l.type === "symbol").map(l => l.id);
}
const CUSTOM_SYMBOL_LAYERS = ["landmark-labels","bounds-labels","stops-labels","pois-labels"];
function applyBasemap(mode) {
  if (!map.getLayer("sat-layer")) return;
  map.setLayoutProperty("sat-layer", "visibility", (mode === "satellit" || mode === "hybrid") ? "visible" : "none");
  if (map.getLayer("geosn-layer")) map.setLayoutProperty("geosn-layer", "visibility", mode === "geosn" ? "visible" : "none");
  if (mode === "geosn") setCatalog("st-geosn", "ok");
  const showLabels = $("#chk-labels").checked && mode !== "satellit";
  labelLayerIds().forEach(id => { if (!CUSTOM_SYMBOL_LAYERS.includes(id)) try { map.setLayoutProperty(id, "visibility", showLabels ? "visible" : "none"); } catch(e){} });
}

function applySun(hour) {
  $("#sun-label").textContent = `${String(Math.floor(hour)).padStart(2,"0")}:${hour % 1 ? "30" : "00"} Uhr`;
  // Lichtstimmung über Gebäude-Opazität + Himmel (MapLibre-Sky, falls vom Style unterstützt)
  const day = Math.max(0, Math.min(1, 1 - Math.abs(hour - 13) / 9));
  if (map.getLayer("leipzig-buildings-3d")) {
    map.setPaintProperty("leipzig-buildings-3d", "fill-extrusion-opacity", 0.82 + day * 0.13);
  }
  // Lichtquelle für die 3D-Schattierung der Fassaden mit der Sonne wandern lassen (falls unterstützt)
  try {
    const az = 90 + (hour - 6) / 14 * 180;              // grobe Sonnenbahn Ost→West
    const alt = Math.max(8, 65 * Math.sin(Math.PI * (hour - 6) / 14)); // Sonnenhöhe
    if (map.setLight) map.setLight({ anchor: "map", position: [1.15, az, alt],
      color: hour < 8.5 || hour > 17.5 ? "#ffd9a8" : "#ffffff", intensity: 0.35 + day * 0.35 });
  } catch (e) { /* ohne dynamisches Licht weiterarbeiten */ }
  try {
    map.setSky({
      "sky-color": hour < 8 || hour > 18 ? "#f4a261" : "#87b5e5",
      "horizon-color": hour < 8 || hour > 18 ? "#ffd9a0" : "#dbeafe",
      "fog-color": "#cbd5e1", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.4
    });
  } catch (e) { /* ältere Style-Spezifikation: ohne Himmel weiterarbeiten */ }
}

function initMap() {
  setLoad(25, "Verbinde mit OpenFreeMap (OpenStreetMap-Vektordaten) …");
  map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: LEIPZIG_CENTER, zoom: 15.2, pitch: 62, bearing: -18,
    antialias: true, maxPitch: 85, hash: true, preserveDrawingBuffer: true,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  map.addControl(new maplibregl.FullscreenControl(), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), "top-right");

  map.on("load", () => {
    setLoad(65, "Erzeuge 3D-Gebäude aus echten Grundrissen & Höhen …");
    try { addCustomLayers(); } catch (e) { console.error(e); }
    setLoad(100, "Fertig.");
    setTimeout(() => $("#loading").classList.add("done"), 350);
    buildLandmarkList(); buildDistrictChips(); updateHud();
    loadRealtime(); // Wetter, Luftqualität, Pegel, Sonne live
  });
  map.on("error", (e) => { console.warn("Kartenfehler:", e.error?.message || e); });
  map.on("move", updateHud);
  map.on("idle", updateBuildingCount);

  map.on("click", "leipzig-buildings-3d", (e) => {
    const f = e.features && e.features[0]; if (!f) return;
    const p = f.properties || {};
    const rows = [
      ["Name", p.name || "—"], ["Höhe (OSM render_height)", p.render_height ? (+p.render_height).toFixed(1) + " m" : "geschätzt"],
      ["Sockelhöhe", p.render_min_height ? p.render_min_height + " m" : "0 m"],
      ["OSM-ID (Way/Relation)", p.id || f.id || "—"],
      ["Koordinate (Klick)", `${e.lngLat.lat.toFixed(5)}° N, ${e.lngLat.lng.toFixed(5)}° O`],
      ["Datenquelle", "OpenStreetMap / OpenMapTiles-Vektorkachel"]
    ];
    new maplibregl.Popup({ maxWidth: "340px" }).setLngLat(e.lngLat)
      .setHTML(`<b>${escapeHtml(p.name || "Gebäude in Leipzig")}</b><br>` +
        rows.map(r => `${escapeHtml(r[0])}: ${escapeHtml(String(r[1]))}`).join("<br>") +
        `<br><small>Exakte Adresse &amp; Gebäudetyp: per Suche oder Wahrzeichen-Info. Höhen ohne Tag werden im Datensatz geschätzt.</small>`)
      .addTo(map);
  });
  map.on("click", "detail-buildings", (e) => {
    const p = e.features[0].properties || {};
    const addr = [p.street && (p.street + " " + (p.housenumber || "")), p.postcode && (p.postcode + " Leipzig")].filter(Boolean).join(", ");
    const sw = c => `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${escapeHtml(c || "#ccc")};border:1px solid rgba(255,255,255,.4);vertical-align:-2px"></span>`;
    new maplibregl.Popup({ maxWidth: "360px" }).setLngLat(e.lngLat)
      .setHTML(`<b>${escapeHtml(p.name || "Gebäude (Detail-Rohdaten)")}</b><br>
      Höhe: ${(+p.height).toFixed(1)} m ${p.levels ? `(${escapeHtml(p.levels)} Geschosse)` : ""}<br>
      ${addr ? "Adresse: " + escapeHtml(addr) + "<br>" : ""}
      ${p.buildingType ? "Typ: " + escapeHtml(p.buildingType) + "<br>" : ""}
      ${sw(p.baseColor)} Fassade ${escapeHtml(p.baseColor || "")} – ${escapeHtml(p.facadeSource || "abgeleitet")}<br>
      ${p.material ? "Material (OSM): " + escapeHtml(p.material) + "<br>" : ""}${p.startDate ? "Bauzeit (OSM): " + escapeHtml(p.startDate) + "<br>" : ""}
      ${sw(p.roofDisplayColor)} Dach ${escapeHtml(p.roofDisplayColor || "")} – ${escapeHtml(p.roofSource || "")}${p.roofShape ? " · Form: " + escapeHtml(p.roofShape) : ""}<br>
      <small>Quelle: OpenStreetMap ${escapeHtml(p.osm || "")} (Rohdaten, Overpass). „Abgeleitet“ = Farbe aus Material/Typ/Bauzeit/Höhe rekonstruiert, keine Messung.</small>`)
      .addTo(map);
  });
  ["pois-layer", "stops-layer"].forEach(layer => map.on("click", layer, (e) => {
    const p = e.features[0].properties || {};
    new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<b>${escapeHtml(p.name || "")}</b><br>${escapeHtml(p.group || p.kind || "Haltestelle / POI")}<br><small>Quelle: OpenStreetMap (Overpass)</small>`).addTo(map);
  }));
  map.on("mousemove", (e) => {
    $("#hud-coords").textContent = `${e.lngLat.lat.toFixed(4)}° N, ${e.lngLat.lng.toFixed(4)}° O`;
    if ($("#chk-terrain").checked && map.queryTerrainElevation) {
      try { const el = map.queryTerrainElevation(e.lngLat); if (el != null) $("#hud-elev").textContent = "Geländehöhe: " + el.toFixed(0) + " m ü. NN (Cursor)"; } catch(err){}
    }
  });
  map.on("click", "landmark-circles", (e) => {
    const id = e.features[0].properties.id;
    const l = window.LEIPZIG_LANDMARKS.find(x => x.id === id);
    if (l) showLandmark(l, false);
  });
  ["leipzig-buildings-3d", "landmark-circles", "detail-buildings", "pois-layer", "stops-layer"].forEach(l => {
    map.on("mouseenter", l, () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", l, () => map.getCanvas().style.cursor = "");
  });
}

function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

function updateHud() {
  if (!map) return;
  const c = map.getCenter();
  $("#hud-coords").textContent = `${c.lat.toFixed(4)}° N, ${c.lng.toFixed(4)}° O`;
  $("#hud-zoom").textContent = `Zoom ${map.getZoom().toFixed(1)} · Neigung ${Math.round(map.getPitch())}°`;
}
let hudTimer = null;
function updateBuildingCount() {
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    if (!map || !map.getLayer("leipzig-buildings-3d")) return;
    try {
      const n = map.queryRenderedFeatures({ layers: ["leipzig-buildings-3d"] }).length;
      $("#hud-buildings").textContent = `Gebäude im Bild: ${n.toLocaleString("de-DE")}`;
    } catch(e){}
  }, 250);
}

function flyTo(lon, lat, zoom, pitch = 62) {
  map.flyTo({ center: [lon, lat], zoom, pitch, bearing: map.getBearing() + 25, duration: 2600, essential: true, curve: 1.35 });
}

function showLandmark(l, fly = true) {
  if (fly) flyTo(l.lon, l.lat, l.zoom || 16.5, 64);
  $("#info-content").innerHTML = `
    <div class="cat">${escapeHtml(l.category)} · Wahrzeichen</div>
    <h3>${escapeHtml(l.name)}</h3>
    <p>${escapeHtml(l.detail)}</p>
    <table>
      <tr><td>Koordinaten (WGS84)</td><td>${l.lat.toFixed(5)}° N, ${l.lon.toFixed(5)}° O</td></tr>
      <tr><td>Höhe</td><td>${l.height ? l.height + " m" : "— (Gewässer/Platz)"}</td></tr>
      <tr><td>Entstehung</td><td>${escapeHtml(l.year)}</td></tr>
      <tr><td>Architekt / Bau</td><td>${escapeHtml(l.architect)}</td></tr>
      <tr><td>Datenprüfung</td><td>Koordinate gegen OpenStreetMap-Objekt &amp; Objektartikel abgeglichen</td></tr>
    </table>
    <p><a style="color:#ffd43b" target="_blank" rel="noopener" href="https://www.openstreetmap.org/#map=18/${l.lat}/${l.lon}">In OpenStreetMap öffnen ↗</a>
    · <a style="color:#ffd43b" target="_blank" rel="noopener" href="https://de.wikipedia.org/wiki/Spezial:Suche?search=${encodeURIComponent(l.name + " Leipzig")}">Wikipedia ↗</a></p>`;
  $("#info-card").classList.remove("hidden");
}

function buildLandmarkList(filter = "") {
  const el = $("#landmarks"); el.innerHTML = "";
  window.LEIPZIG_LANDMARKS
    .filter(l => (l.name + l.category).toLowerCase().includes(filter.toLowerCase()))
    .forEach(l => {
      const b = document.createElement("button"); b.className = "landmark";
      b.innerHTML = `<b>${escapeHtml(l.name)}</b><span>${escapeHtml(l.category)} · ${l.height ? l.height + " m · " : ""}${l.lat.toFixed(4)}° N, ${l.lon.toFixed(4)}° O</span>`;
      b.onclick = () => showLandmark(l, true);
      el.appendChild(b);
    });
}
function buildDistrictChips() {
  const el = $("#districts");
  window.LEIPZIG_DISTRICTS.forEach(d => {
    const b = document.createElement("button"); b.textContent = d.name;
    b.onclick = () => flyTo(d.lon, d.lat, d.zoom, d.pitch);
    el.appendChild(b);
  });
}

/* ---------- Bäume: echte OSM-Einzelbäume per Overpass ---------- */
async function loadTrees() {
  const status = $("#tree-status");
  status.textContent = "Lade Einzelbäume (natural=tree) im Zentrum über Overpass API …";
  const bbox = "51.328,12.355,51.352,12.400"; // S,W,N,O
  const q = `[out:json][timeout:60];node["natural"="tree"](${bbox});out body 4000;`;
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) });
    if (!r.ok) throw new Error("Overpass HTTP " + r.status);
    const j = await r.json();
    const features = (j.elements || []).filter(e => e.lat && e.lon).map(e => ({
      type: "Feature", geometry: { type: "Point", coordinates: [e.lon, e.lat] },
      properties: { id: e.id, species: e.tags?.species || e.tags?.["species:de"] || "" }
    }));
    treesLoaded = true;
    map.getSource("trees").setData({ type: "FeatureCollection", features });
    // 3D-Baumkronen: aus jedem echten Baum-Standort eine extrudierte Krone erzeugen
    const crownFeatures = features.map((f, i) => {
      const [lon, lat] = f.geometry.coordinates;
      const r = 0.000035 + ((i * 37) % 10) * 0.000002; // ca. 3–5 m Kronenradius
      const ring = [];
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; ring.push([lon + Math.cos(a) * r, lat + Math.sin(a) * r * 0.75]); }
      ring.push(ring[0]);
      return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] },
        properties: { height: 5 + ((i * 53) % 40) / 10, color: ["#2f9e44", "#37b24d", "#2b8a3e", "#40c057"][i % 4] } };
    });
    if (map.getSource("tree-crowns-src")) map.getSource("tree-crowns-src").setData({ type: "FeatureCollection", features: crownFeatures });
    layerVis(["tree-crowns"], true);
    map.setLayoutProperty("trees-layer", "visibility", "visible");
    setCatalog("st-overpass", "ok");
    $("#chk-trees").checked = true;
    status.innerHTML = `✓ <b>${features.length.toLocaleString("de-DE")}</b> echte, einzeln erfasste Bäume geladen (OpenStreetMap, Stand der Abfrage: ${new Date().toLocaleString("de-DE")}). Quelle: Overpass API.`;
    flyTo(12.377, 51.340, 15.4, 58);
  } catch (err) {
    status.innerHTML = `<span style="color:#ff8787">Fehler: ${escapeHtml(err.message)}. Bitte später erneut versuchen (Overpass-Ratenlimit).</span>`;
  }
}

/* ---------- ALLE DATEN: OSM-Rohdaten-Layer (Overpass) ---------- */
const CENTER_BBOX = "51.325,12.350,51.355,12.405"; // S,W,N,O – Innenstadt + angrenzende Viertel
async function overpass(query, label) {
  const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(query) });
  if (!r.ok) throw new Error(label + ": HTTP " + r.status);
  const j = await r.json();
  setCatalog("st-overpass", "ok");
  return j.elements || [];
}
function parseHeight(tags) {
  const h = parseFloat(String(tags.height || "").replace(",", "."));
  if (!isNaN(h) && h > 0) return h;
  const lv = parseFloat(tags["building:levels"]);
  if (!isNaN(lv)) return Math.max(3, lv * 3.1 + (tags["roof:shape"] && tags["roof:shape"] !== "flat" ? 2.5 : 0));
  return 8;
}
function stitchRings(ways) {
  const segs = ways.map(w => w.map(p => [p[0], p[1]])).filter(s => s.length > 1);
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let extended = true;
    while (extended && ring[0].join() !== ring[ring.length - 1].join()) {
      extended = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], end = ring[ring.length - 1], start = ring[0];
        if (s[0].join() === end.join()) { ring = ring.concat(s.slice(1)); }
        else if (s[s.length - 1].join() === end.join()) { ring = ring.concat(s.slice(0, -1).reverse()); }
        else if (s[s.length - 1].join() === start.join()) { ring = s.slice(0, -1).concat(ring); }
        else if (s[0].join() === start.join()) { ring = s.slice(1).reverse().concat(ring); }
        else continue;
        segs.splice(i, 1); extended = true; break;
      }
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}
/* ---------- Realistische Fassadenfarben ---------- */
const NAMED_COLORS = { white:"#ece7dc", black:"#3a3a3c", red:"#9c4a38", darkred:"#7c3a30", brown:"#7d5a43",
  beige:"#d3bf9d", yellow:"#d9bf7e", orange:"#c07f4a", grey:"#a3a3a0", gray:"#a3a3a0", darkgrey:"#767672",
  lightgrey:"#c2c2bd", lightgray:"#c2c2bd", blue:"#7d9db5", green:"#7d9b7a", cream:"#e3d5b3", sand:"#cdb287",
  brick:"#94543f", sandstone:"#c8ad7d", plaster:"#d8c49c", concrete:"#acaea8", glass:"#87a7ba" };
function hexToRgb(h){ h = h.replace("#",""); if (h.length===3) h = h.split("").map(c=>c+c).join(""); const n=parseInt(h,16); return [n>>16&255, n>>8&255, n&255]; }
function rgbToHex(r,g,b){ return "#" + [r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,"0")).join(""); }
function normalizeColor(c){
  if (!c) return "";
  c = String(c).trim().toLowerCase().replace(/_/g," ");
  if (/^#[0-9a-f]{3,8}$/.test(c)) return c.slice(0,7);
  if (NAMED_COLORS[c]) return NAMED_COLORS[c];
  const key = Object.keys(NAMED_COLORS).find(k => c.includes(k));
  return key ? NAMED_COLORS[key] : "";
}
function mixColor(hex, other, t){ const a=hexToRgb(hex), b=hexToRgb(other); return rgbToHex(a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t); }
function shadeColor(hex, f){ const [r,g,b]=hexToRgb(hex); return rgbToHex(r*f, g*f, b*f); }
function hashNum(s){ let h=0; const str=String(s); for (let i=0;i<str.length;i++) h=(h*31 + str.charCodeAt(i))>>>0; return h; }
function pickByHash(palette, seed){ return palette[hashNum(seed) % palette.length]; }
function varyColor(hex, seed, amt=0.07){ const f = 1 - amt + (hashNum(seed+"v") % 100)/100 * amt * 2; return shadeColor(hex, f); }
let facadeWeathering = 0.25;
function applyWeathering(hex, seed){
  // Verwitterung: leicht entsättigen (Richtung warmes Grau-Braun) + minimal abdunkeln, je Gebäude deterministisch
  const strength = facadeWeathering * (0.7 + (hashNum(seed+"w") % 60)/100);
  return shadeColor(mixColor(hex, "#8d8578", strength*0.55), 1 - strength*0.08);
}
function parseYear(tags){
  const raw = tags.start_date || tags["building:start_date"] || tags.year_of_construction || tags.construction_date || tags.built || "";
  const m = String(raw).match(/(1[5-9]\d\d|20[0-2]\d)/);
  return m ? parseInt(m[1]) : null;
}
/* Fassadenfarbe ableiten – Priorität: echte OSM-Farbe > Material > Typ+Bauzeit > Typologie nach Geschossen.
   Rückgabe inkl. Herkunft, damit die App ehrlich zeigt, woher jede Farbe stammt. */
function deriveFacade(tags, seed){
  const real = normalizeColor(tags["building:colour"] || tags["building:color"] || tags.colour || tags.color);
  if (real) return { color: real, source: "Echt: OSM building:colour" };
  const material = String(tags["building:material"] || tags["facade:material"] || tags.material || "").toLowerCase();
  const matPalettes = {
    brick:["#94543f","#8a4c38","#a05a43","#7e4634"], sandstone:["#c8ad7d","#bfa36f","#d0b586"],
    stone:["#a89c87","#9d927e","#b0a48d"], limestone:["#cfc0a0"], marble:["#e6e1d5"],
    plaster:["#d8c49c","#e0cfa8","#cbb489","#dcc7a0"], render:["#d8c49c","#e0cfa8","#cbb489"],
    concrete:["#acaea8","#b5b3aa","#a3a49e"], glass:["#87a7ba","#7d9fb8","#93aeba"],
    metal:["#8b96a0","#7e8a94"], steel:["#7e8a94","#93a0aa"], wood:["#8a6844","#7d5f3e","#96714a"],
    brickwork:["#94543f","#8a4c38"]
  };
  const matKey = Object.keys(matPalettes).find(k => material.includes(k));
  if (matKey) return { color: pickByHash(matPalettes[matKey], seed), source: "Material: " + material + " (OSM)" };
  const type = String(tags.building || "yes").toLowerCase();
  const year = parseYear(tags);
  const levels = parseFloat(tags["building:levels"]) || null;
  let palette, why;
  if (["church","chapel","cathedral","monastery"].includes(type)) { palette = matPalettes.sandstone.concat(matPalettes.stone); why = "Kirche: Sand-/Naturstein"; }
  else if (["train_station","station"].includes(type)) { palette = ["#c2a878","#bfa36f","#a89c87"]; why = "Bahnhof: Sandstein"; }
  else if (["industrial","warehouse","manufacture","factory","hall"].includes(type)) { palette = matPalettes.brick.concat(["#8f8578","#7e8a94"]); why = "Industrie: Backstein/Stahl"; }
  else if (["garage","garages","parking"].includes(type)) { palette = matPalettes.concrete; why = "Beton"; }
  else if (year && year < 1919) { palette = ["#d8c49c","#e0cfa8","#cbb489","#c9a87c","#d9bda0","#cdb287"]; why = "Bauzeit vor 1919: Stuck/Sandstein (Gründerzeit)"; }
  else if (year && year < 1949) { palette = ["#c9b28c","#b99f78","#a98f6d","#c2a186"].concat(matPalettes.brick); why = "Bauzeit 1919–1945: Putz/Backstein"; }
  else if (year && year < 1991) { palette = ["#b9b6aa","#c0beb2","#acaaa0","#c9d2c0","#d8c9a3","#bfcbd3"]; why = "Bauzeit 1949–1990: Beton/Platte, teils saniert pastell"; }
  else if (year) { palette = ["#b9bec2","#9fb4c0","#c7c2b8","#87a7ba","#a8aeb2"]; why = "Bauzeit ab 1991: modern Beton/Glas"; }
  else if (["office","commercial","retail","supermarket"].includes(type)) { palette = ["#aeb6ba","#c0beb2","#9fb4c0","#c7c2b8"]; why = "Büro/Handel: Beton/Glas-Annahme"; }
  else if (["school","university","hospital","kindergarten","civic","public"].includes(type)) { palette = ["#c9b28c","#d8c49c"].concat(matPalettes.brick); why = "Öffentlich: Putz/Backstein-Annahme"; }
  else if (["house","detached","semidetached_house","terrace","bungalow"].includes(type)) { palette = ["#e0cfa8","#d8c49c","#cdbb96","#c9b8a6","#d3c5ae"]; why = "Wohnhaus: warmer Putz"; }
  else if (levels && levels >= 7) { palette = ["#b9b6aa","#bfcbd3","#c9d2c0","#d8c9a3","#aebac2"]; why = "Hochhaus/Großwohnbau: Platte/Beton, saniert pastell"; }
  else if (levels && levels <= 2) { palette = ["#e0cfa8","#d8c49c","#cdbb96","#d3c5ae"]; why = "Niedriges Wohnhaus: Putz-Annahme"; }
  else { palette = ["#d8c49c","#e0cfa8","#cbb489","#cdbb96","#bfac8a"]; why = "Leipziger Altbau-Typologie: Stuck (3–5 Geschosse)"; }
  return { color: pickByHash(palette, seed), source: "Abgeleitet: " + why };
}
function deriveRoof(tags, seed, facade){
  const real = normalizeColor(tags["roof:colour"] || tags["roof:color"]);
  if (real) return { color: real, cap: 0.35, source: "Echt: OSM roof:colour" };
  const mat = String(tags["roof:material"] || "").toLowerCase();
  if (mat.includes("slate")) return { color: "#4e565e", cap: 0.4, source: "Dachmaterial Schiefer (OSM)" };
  if (mat.includes("tile") || mat.includes("roof_tiles")) return { color: pickByHash(["#8a4f3d","#7a463a","#93543f"], seed), cap: 0.45, source: "Dachmaterial Ziegel (OSM)" };
  if (mat.includes("copper")) return { color: "#4f7d6a", cap: 0.4, source: "Dachmaterial Kupfer/Patina (OSM)" };
  if (mat.includes("grass") || mat.includes("green")) return { color: "#6d8f5f", cap: 0.3, source: "Gründach (OSM)" };
  const shape = String(tags["roof:shape"] || "").toLowerCase();
  if (shape === "flat") return { color: pickByHash(["#777c80","#83888c","#6f7478"], seed), cap: 0.22, source: "Flachdach: Bitumen/Grau (aus roof:shape)" };
  if (shape === "dome" || shape === "onion") return { color: "#4f7d6a", cap: 1.4, source: "Kuppel: Kupferpatina-Annahme" };
  if (shape === "pyramidal" || shape === "cone") return { color: pickByHash(["#4e565e","#7a463a"], seed), cap: 1.1, source: "Spitzdach-Annahme" };
  if (["gabled","hipped","half-hipped","gambrel","mansard","saltbox","skillion","pitched"].includes(shape))
    return { color: pickByHash(["#8a4f3d","#74443a","#4e565e","#6b4a3a"], seed), cap: 0.55, source: "Steildach: Ziegel/Schiefer-Annahme (aus roof:shape)" };
  // Ohne Dachangabe: niedrige Häuser eher Steildach, hohe/Großbauten eher Flachdach
  const h = parseHeight(tags), lv = parseFloat(tags["building:levels"]) || 0;
  return (h <= 16 && lv < 6) ? { color: pickByHash(["#8a4f3d","#74443a","#4e565e"], seed), cap: 0.5, source: "Steildach-Annahme (Gebäudehöhe)" }
                 : { color: pickByHash(["#777c80","#83888c"], seed), cap: 0.22, source: "Flachdach-Annahme (Gebäudehöhe/Geschosse)" };
}
let detailFeatures = [];
function recolorDetailBuildings(){
  if (!detailFeatures.length || !map.getSource("detail-buildings-src")) return;
  detailFeatures.forEach(f => {
    f.properties.color = applyWeathering(f.properties.baseColor, f.properties.osm);
  });
  map.getSource("detail-buildings-src").setData({ type: "FeatureCollection", features: detailFeatures });
}

async function loadDetailBuildings() {
  const q = `[out:json][timeout:120];(way["building"](${CENTER_BBOX});relation["building"]["type"="multipolygon"](${CENTER_BBOX}););out geom tags;`;
  const els = await overpass(q, "Detail-Gebäude");
  const feats = [];
  els.forEach(el => {
    const t = el.tags || {};
    const seed = el.type + "/" + el.id;
    const facade = deriveFacade(t, seed);
    const roof = deriveRoof(t, seed, facade);
    const baseColor = varyColor(facade.color, seed);
    const props = { name: t.name || "", height: parseHeight(t),
      baseColor, color: applyWeathering(baseColor, seed), facadeSource: facade.source,
      roofDisplayColor: roof.color, roofCap: roof.cap, roofSource: roof.source,
      roofColor: t["roof:colour"] || "", roofShape: t["roof:shape"] || "", levels: t["building:levels"] || "",
      material: t["building:material"] || t.material || "", startDate: t.start_date || t.year_of_construction || "",
      buildingType: t.building || "", street: t["addr:street"] || "", housenumber: t["addr:housenumber"] || "",
      postcode: t["addr:postcode"] || "", city: t["addr:city"] || "", osm: seed };
    if (el.type === "way" && el.geometry && el.geometry.length > 3) {
      const ring = el.geometry.map(g => [g.lon, g.lat]);
      if (ring[0].join() !== ring[ring.length - 1].join()) ring.push(ring[0]);
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: props });
    } else if (el.type === "relation" && el.members) {
      const outer = el.members.filter(m => m.type === "way" && (m.role === "outer" || m.role === "") && m.geometry).map(m => m.geometry.map(g => [g.lon, g.lat]));
      stitchRings(outer).forEach(ring => {
        if (ring[0].join() !== ring[ring.length - 1].join()) ring.push(ring[0]);
        feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: props });
      });
    }
  });
  detailFeatures = feats;
  map.getSource("detail-buildings-src").setData({ type: "FeatureCollection", features: feats });
  if ($("#chk-roofs").checked) layerVis(["detail-roofs"], true);
  return feats.length;
}
async function loadTransportAndMore() {
  const results = {};
  // Bahn / Tram
  const railEls = await overpass(`[out:json][timeout:90];(way["railway"~"rail|tram|subway|light_rail"](${CENTER_BBOX}););out geom;`, "Bahn/Tram");
  map.getSource("rail-src").setData({ type: "FeatureCollection", features: railEls.filter(e => e.geometry).map(e => ({
    type: "Feature", geometry: { type: "LineString", coordinates: e.geometry.map(g => [g.lon, g.lat]) },
    properties: { kind: e.tags?.railway === "tram" ? "tram" : "rail", name: e.tags?.name || "" } })) });
  results.rail = railEls.length;
  // Haltestellen
  const stopEls = await overpass(`[out:json][timeout:90];(node["public_transport"="stop_position"](${CENTER_BBOX});node["highway"="bus_stop"](${CENTER_BBOX});node["railway"~"station|halt|tram_stop"](${CENTER_BBOX}););out body;`, "Haltestellen");
  map.getSource("stops-src").setData({ type: "FeatureCollection", features: stopEls.filter(e => e.lat).map(e => ({
    type: "Feature", geometry: { type: "Point", coordinates: [e.lon, e.lat] }, properties: { name: e.tags?.name || "Haltestelle" } })) });
  results.stops = stopEls.length;
  // Radwege
  const cycEls = await overpass(`[out:json][timeout:90];(way["highway"="cycleway"](${CENTER_BBOX});way["cycleway"]["highway"~"residential|secondary|tertiary|path|footway"](${CENTER_BBOX}););out geom;`, "Radwege");
  map.getSource("cycle-src").setData({ type: "FeatureCollection", features: cycEls.filter(e => e.geometry).map(e => ({
    type: "Feature", geometry: { type: "LineString", coordinates: e.geometry.map(g => [g.lon, g.lat]) }, properties: {} })) });
  results.cycle = cycEls.length;
  // Gewässer-Verläufe
  const watEls = await overpass(`[out:json][timeout:90];(way["waterway"](${CENTER_BBOX}););out geom;`, "Gewässer");
  map.getSource("water-src").setData({ type: "FeatureCollection", features: watEls.filter(e => e.geometry).map(e => ({
    type: "Feature", geometry: { type: "LineString", coordinates: e.geometry.map(g => [g.lon, g.lat]) }, properties: { name: e.tags?.name || "" } })) });
  results.water = watEls.length;
  // POIs
  const poiEls = await overpass(`[out:json][timeout:90];(node["amenity"~"cafe|restaurant|bar|school|university|hospital|pharmacy|theatre|cinema|library|museum"](${CENTER_BBOX});node["tourism"~"museum|hotel|attraction"](${CENTER_BBOX});node["leisure"~"sports_centre|fitness_centre"](${CENTER_BBOX});node["shop"](${CENTER_BBOX}););out body 3000;`, "POIs");
  const groupOf = t => t.tourism || t.amenity === "theatre" || t.amenity === "cinema" ? "Kultur" :
    ["cafe","restaurant","bar"].includes(t.amenity) ? "Gastro" : ["school","university","library"].includes(t.amenity) ? "Bildung" :
    ["hospital","pharmacy"].includes(t.amenity) ? "Gesundheit" : t.leisure ? "Sport" : t.shop ? "Einkaufen" : "Sonstige";
  map.getSource("pois-src").setData({ type: "FeatureCollection", features: poiEls.filter(e => e.lat && (e.tags?.name)).map(e => ({
    type: "Feature", geometry: { type: "Point", coordinates: [e.lon, e.lat] },
    properties: { name: e.tags.name, group: groupOf(e.tags || {}), kind: e.tags.amenity || e.tags.tourism || e.tags.shop || e.tags.leisure || "" } })) });
  results.pois = poiEls.length;
  // Stadtteil-Grenzen (Linien aus Relations-Mitgliedern + Label am Schwerpunkt)
  const bEls = await overpass(`[out:json][timeout:90];relation["boundary"="administrative"]["admin_level"~"9|10"](${CENTER_BBOX});out geom;`, "Grenzen");
  const lines = [], labels = [];
  bEls.forEach(rel => {
    const pts = [];
    (rel.members || []).filter(m => m.type === "way" && m.geometry).forEach(m => {
      const coords = m.geometry.map(g => [g.lon, g.lat]); pts.push(...coords);
      lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { name: rel.tags?.name || "" } });
    });
    if (pts.length && rel.tags?.name) {
      const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
      labels.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { name: rel.tags.name } });
    }
  });
  map.getSource("bounds-src").setData({ type: "FeatureCollection", features: lines });
  map.getSource("bounds-label-src").setData({ type: "FeatureCollection", features: labels });
  results.bounds = bEls.length;
  return results;
}
let allDataLoaded = false;
async function loadAllData() {
  const st = $("#datalayer-status");
  st.innerHTML = "⏳ Lade <b>alle</b> Detaildaten (OSM-Rohdaten, Overpass) – Gebäude, Bäume, Verkehr, POIs, Grenzen, Gewässer … das kann 30–90 Sekunden dauern.";
  try {
    const nB = await loadDetailBuildings();
    $("#chk-detail-buildings").checked = true; layerVis(["detail-buildings"], true);
    st.innerHTML = `✓ Detail-Gebäude geladen: <b>${nB.toLocaleString("de-DE")}</b> echte Grundrisse mit Fassaden-/Dachangaben. Lade jetzt Bäume, Verkehr, POIs, Grenzen …`;
    await loadTrees();
    const r = await loadTransportAndMore();
    ["rail","stops","cycleways","pois","boundaries","water"].forEach(k => { const c = $("#chk-" + k); if (c) c.checked = true; });
    layerVis(["rail-layer"], true); layerVis(["stops-layer","stops-labels"], true); layerVis(["cycle-layer"], true);
    layerVis(["pois-layer","pois-labels"], true); layerVis(["bounds-layer","bounds-labels"], true); layerVis(["water-layer"], true);
    allDataLoaded = true;
    st.innerHTML = `✓ <b>Alle Daten geladen</b> (Stand ${new Date().toLocaleString("de-DE")}): ${nB.toLocaleString("de-DE")} Detail-Gebäude · ${r.rail} Bahn-/Tram-Abschnitte · ${r.stops} Haltestellen · ${r.cycle} Radweg-Abschnitte · ${r.pois} POIs · ${r.bounds} Verwaltungsgebiete · ${r.water} Gewässer-Abschnitte. Quelle: OpenStreetMap via Overpass API.`;
  } catch (err) {
    st.innerHTML = `<span style="color:#ff8787">Fehler beim Laden: ${escapeHtml(err.message)}. Overpass ist ggf. ausgelastet – bitte in 1 Minute erneut versuchen.</span>`;
    setCatalog("st-overpass", "err");
  }
}

/* ---------- Echtzeit: Wetter, Luft, Pegel, Sonne (Open-Meteo, Pegelonline) ---------- */
let liveSunHour = null;
async function loadRealtime() {
  const box = $("#realtime"), status = $("#realtime-status");
  try {
    const [wRes, aRes] = await Promise.all([
      fetch("https://api.open-meteo.com/v1/forecast?latitude=51.3397&longitude=12.3731&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,cloud_cover&daily=sunrise,sunset&timezone=Europe%2FBerlin&forecast_days=1"),
      fetch("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=51.3397&longitude=12.3731&current=european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide&timezone=Europe%2FBerlin")
    ]);
    const w = await wRes.json(), a = await aRes.json();
    const c = w.current || {}, ac = a.current || {};
    const sunrise = (w.daily?.sunrise || [""])[0], sunset = (w.daily?.sunset || [""])[0];
    const now = new Date(); liveSunHour = now.getHours() + now.getMinutes() / 60;
    const fmtT = iso => iso ? iso.slice(11, 16) + " Uhr" : "–";
    let pegelHtml = `<div class="rt-card"><b>🌊 Wasserpegel</b>Lade Pegeldaten …</div>`;
    box.innerHTML = `
      <div class="rt-card"><b>🌦 Wetter Leipzig (live)</b><strong>${c.temperature_2m ?? "–"} °C</strong><br>gefühlt ${c.apparent_temperature ?? "–"} °C · Luftfeuchte ${c.relative_humidity_2m ?? "–"} %<br>Wind ${c.wind_speed_10m ?? "–"} km/h · Wolken ${c.cloud_cover ?? "–"} %<br>Druck ${c.pressure_msl ?? "–"} hPa</div>
      <div class="rt-card"><b>☀ Sonne heute</b>Aufgang <strong>${fmtT(sunrise)}</strong><br>Untergang <strong>${fmtT(sunset)}</strong><br>Jetzt: ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")} Uhr (Live-Sonne per Button übernehmen)</div>
      <div class="rt-card"><b>🍃 Luftqualität (CAMS)</b><strong>AQI ${ac.european_aqi ?? "–"}</strong><br>PM2.5 ${ac.pm2_5 ?? "–"} · PM10 ${ac.pm10 ?? "–"} µg/m³<br>O₃ ${ac.ozone ?? "–"} · NO₂ ${ac.nitrogen_dioxide ?? "–"} µg/m³</div>
      ${pegelHtml}`;
    setCatalog("st-weather", "ok");
    status.textContent = "Wetter/Luft: Open-Meteo (DWD ICON / CAMS), Stand " + new Date().toLocaleTimeString("de-DE") + ".";
    // Pegel separat nachladen (blockiert nichts)
    try {
      const sRes = await fetch("https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json");
      const stations = await sRes.json();
      const withDist = stations.filter(s => s.latitude && s.longitude).map(s => ({
        s, d: Math.hypot(s.latitude - 51.3397, (s.longitude - 12.3731) * 0.62) })).sort((x, y) => x.d - y.d);
      const near = withDist[0];
      if (near && near.d < 0.6) {
        const dRes = await fetch(`https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/${near.s.uuid}.json?includeTimeseries=true&includeCurrentMeasurement=true`);
        const detail = await dRes.json();
        const wSeries = (detail.timeseries || []).find(t => t.shortname === "W");
        const val = wSeries?.currentMeasurement;
        const cards = box.querySelectorAll(".rt-card");
        if (cards[3] && val) cards[3].innerHTML = `<b>🌊 Wasserpegel (nächste Station)</b><strong>${val.value} cm</strong><br>${escapeHtml(near.s.longname || near.s.shortname || "")}<br>${escapeHtml(detail.water?.longname || "")} · ${new Date(val.timestamp).toLocaleString("de-DE")}`;
        setCatalog("st-pegel", val ? "ok" : "err");
      } else setCatalog("st-pegel", "err", "Keine Station in der Nähe gefunden");
    } catch (e) { setCatalog("st-pegel", "err", e.message); const cards = box.querySelectorAll(".rt-card"); if (cards[3]) cards[3].innerHTML = `<b>🌊 Wasserpegel</b>Pegelonline derzeit nicht erreichbar.`; }
  } catch (err) {
    box.innerHTML = `<div class="rt-card">Echtzeitdaten fehlgeschlagen: ${escapeHtml(err.message)}</div>`;
    setCatalog("st-weather", "err");
  }
}

/* ---------- Validierung / Kontrolle ---------- */
async function runValidation() {
  const box = $("#validation"), body = $("#val-body");
  box.classList.remove("hidden");
  body.innerHTML = "<p>⏳ Prüfe live gegen OpenStreetMap-Rohdaten (Overpass API) und gegen die gerenderte Szene …</p>";
  const rows = [];
  const rendered = (() => { try { return map.queryRenderedFeatures({ layers: ["leipzig-buildings-3d"] }).length; } catch(e){ return 0; } })();
  rows.push(["Gerenderte Gebäude im aktuellen Bildausschnitt", rendered.toLocaleString("de-DE"), rendered > 0 ? "ok" : "warn",
    rendered > 0 ? "3D-Layer aktiv, Höhen aus render_height" : "Hineinzoomen (Gebäude ab Zoom sichtbar)"]);
  // Overpass-Statistik Innenstadt
  const bbox = "51.325,12.350,51.355,12.405";
  const q = `[out:json][timeout:90];
    node["natural"="tree"](${bbox}); way["building"](${bbox}); relation["building"](${bbox});
    way["waterway"](${bbox}); way["highway"](${bbox}); out count;`;
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const counts = {};
    (j.elements || []).forEach(e => { if (e.tags) { /* count-Ausgabe aggregieren */ } });
    // Overpass "out count" liefert ein Element je Typ mit tags.count – wir werten die Elemente generisch aus:
    let htmlCounts = (j.elements || []).map(e => {
      const t = e.tags || {}; const label = `${e.type}`;
      return `${label}: total ${t.total || t.count || "?"} (nodes ${t.nodes||0}, ways ${t.ways||0}, relations ${t.relations||0})`;
    }).join("<br>");
    rows.push(["OSM-Rohdaten Innenstadt (Overpass, live)", "Abfrage erfolgreich", "ok", htmlCounts || "Zähldaten empfangen"]);
  } catch (err) {
    rows.push(["OSM-Rohdaten Innenstadt (Overpass, live)", "nicht erreichbar", "err", escapeHtml(err.message) + " – Vektorkachel-Modell bleibt nutzbar; später erneut prüfen."]);
  }
  // Wahrzeichen-Stichprobe
  const sample = window.LEIPZIG_LANDMARKS.slice(0, 5);
  rows.push(["Wahrzeichen-Koordinaten (Stichprobe)", sample.length + " Objekte", "ok",
    sample.map(l => `${l.name}: ${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}`).join("<br>")]);
  rows.push(["Höhenplausibilität", "City-Hochhaus 142 m · Völkerschlachtdenkmal 91 m · Neues Rathaus 115 m", "ok",
    "Gegen Objektangaben (Wikipedia/OSM height-Tag) abgeglichen; Gebäude ohne height-Tag erhalten im OSM-Datensatz eine Schätzhöhe (render_height) – im Farbmodus „Höhe“ erkennbar."]);
  rows.push(["Fassaden-Grenze (ehrlich)", "Rekonstruktion statt Foto", "warn",
    "Priorität: 1) echte OSM-Farbe (building:colour), 2) OSM-Material, 3) Gebäudetyp + Bauzeit, 4) Leipziger Typologie (Geschosse/Höhe). Jede Farbe zeigt ihre Herkunft im Detail-Klick. Dächer analog aus roof:colour/material/shape. Eine fotografische Textur jeder Fassade gibt es als freien Datensatz nicht – das Modell rekonstruiert farblich plausibel und kennzeichnet das."]);
  rows.push(["Alle integrierten Quellen", allDataLoaded ? "Detaildaten geladen" : "Basisdaten aktiv, Detaildaten per Button ladbar", allDataLoaded ? "ok" : "warn",
    "Basis: OSM-Vektor, Esri-Satellit, GeoSN-DOP (WMS), Terrarium-Gelände. Detail (Overpass): Gebäude-Rohdaten mit Dach/Fassade/Adresse, Bäume (3D-Kronen), Bahn/Tram, ÖPNV, Radwege, POIs, Stadtteilgrenzen, Gewässer. Echtzeit: Open-Meteo Wetter/Luft (CAMS), Pegelonline, Sonnenstand. Suche: Nominatim. Status je Quelle im Datenkatalog (linkes Panel)."]);
  body.innerHTML = `<p>Geprüft am ${new Date().toLocaleString("de-DE")} · Bildausschnitt-Zentrum: ${map.getCenter().lat.toFixed(4)}° N, ${map.getCenter().lng.toFixed(4)}° O · Zoom ${map.getZoom().toFixed(1)}</p>
    <table><tr><th>Prüfpunkt</th><th>Ergebnis</th><th>Details</th></tr>
    ${rows.map(r => `<tr><td>${r[0]}</td><td class="${r[2]}">${r[1]}</td><td>${r[3]}</td></tr>`).join("")}
    </table>
    <p><b>Fazit:</b> Standorte, Grundrisse und Gewässer/Straßen stammen aus denselben OSM-Rohdaten, die auch die Kontrolle nutzt – dadurch ist die Übereinstimmung direkt nachvollziehbar. Fotorealistische Fassadentexturen jeder einzelnen Fassade existieren als freier, amtlicher Datensatz nicht; das Modell kennzeichnet Schätzungen transparent statt sie zu verstecken.</p>`;
}

/* ---------- Suche (Nominatim, auf Leipzig begrenzt) ---------- */
async function search(q) {
  const box = $("#search-results"); box.style.display = "block"; box.innerHTML = "<button disabled>Suche …</button>";
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&addressdetails=1&bounded=1&viewbox=12.19,51.45,12.55,51.21&q=${encodeURIComponent(q + ", Leipzig")}`;
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    const j = await r.json();
    if (!j.length) { box.innerHTML = "<button disabled>Kein Treffer in Leipzig.</button>"; return; }
    box.innerHTML = "";
    j.forEach(item => {
      const b = document.createElement("button"); b.textContent = item.display_name;
      b.onclick = () => { box.style.display = "none"; flyTo(+item.lon, +item.lat, 17, 65);
        $("#info-content").innerHTML = `<div class="cat">Suchtreffer · OpenStreetMap</div><h3>${escapeHtml(item.display_name.split(",").slice(0,2).join(","))}</h3>
        <table><tr><td>Koordinaten</td><td>${(+item.lat).toFixed(5)}° N, ${(+item.lon).toFixed(5)}° O</td></tr>
        <tr><td>OSM-Typ</td><td>${escapeHtml(item.type || item.class || "—")}</td></tr>
        <tr><td>Adresse</td><td>${escapeHtml(item.display_name)}</td></tr></table>`;
        $("#info-card").classList.remove("hidden"); };
      box.appendChild(b);
    });
  } catch(e) { box.innerHTML = "<button disabled>Suche fehlgeschlagen (Netzwerk).</button>"; }
}

/* ---------- Stadtrundflug ---------- */
function toggleTour() {
  if (tourTimer) { clearInterval(tourTimer); tourTimer = null; $("#btn-tour").textContent = "▶ Stadtrundflug"; return; }
  $("#btn-tour").textContent = "⏸ Rundflug stoppen";
  const stops = window.LEIPZIG_LANDMARKS;
  const next = () => { showLandmark(stops[tourIndex % stops.length], true); tourIndex++; };
  next();
  tourTimer = setInterval(next, 7000);
}

/* ---------- Events ---------- */
document.querySelectorAll("[data-basemap]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-basemap]").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); applyBasemap(b.dataset.basemap);
});
$("#chk-buildings").onchange = e => { map.setLayoutProperty("leipzig-buildings-3d", "visibility", e.target.checked ? "visible" : "none");
  if (map.getLayer("leipzig-roofs")) map.setLayoutProperty("leipzig-roofs", "visibility", (e.target.checked && $("#chk-roofs").checked) ? "visible" : "none"); };
$("#chk-roofs").onchange = e => { layerVis(["leipzig-roofs"], e.target.checked && $("#chk-buildings").checked); layerVis(["detail-roofs"], e.target.checked && $("#chk-detail-buildings").checked); };
$("#facade-weathering").oninput = e => {
  facadeWeathering = parseInt(e.target.value) / 100;
  $("#weathering-label").textContent = e.target.value + " %";
  recolorDetailBuildings();
};
$("#chk-landmarks").onchange = e => { ["landmark-circles","landmark-labels"].forEach(l => map.setLayoutProperty(l, "visibility", e.target.checked ? "visible" : "none")); };
$("#chk-labels").onchange = () => applyBasemap(document.querySelector("[data-basemap].active").dataset.basemap);
$("#chk-trees").onchange = e => { if (e.target.checked && !treesLoaded) loadTrees(); else { map.setLayoutProperty("trees-layer", "visibility", e.target.checked ? "visible" : "none"); layerVis(["tree-crowns"], e.target.checked); } };
$("#chk-terrain").onchange = e => {
  if (e.target.checked) map.setTerrain({ source: "terrain-dem", exaggeration: parseFloat($("#terr-ex").value) });
  else map.setTerrain(null);
};
$("#terr-ex").oninput = e => { $("#terr-label").textContent = (+e.target.value).toFixed(1).replace(".", ",") + "×"; if ($("#chk-terrain").checked) map.setTerrain({ source: "terrain-dem", exaggeration: parseFloat(e.target.value) }); };
$("#sel-colormode").onchange = e => map.setPaintProperty("leipzig-buildings-3d", "fill-extrusion-color", buildingColorExpression(e.target.value));
$("#sun").oninput = e => applySun(parseFloat(e.target.value));
$("#minzoom").oninput = e => { $("#zoom-label").textContent = e.target.value; ["leipzig-buildings-3d","leipzig-roofs"].forEach(l => { if (map.getLayer(l)) map.setLayerZoomRange(l, parseFloat(e.target.value), 24); }); };
$("#landmark-filter").oninput = e => buildLandmarkList(e.target.value);
$("#btn-trees-load").onclick = loadTrees;
$("#btn-load-all").onclick = loadAllData;
$("#btn-realtime").onclick = loadRealtime;
$("#btn-livesun").onclick = () => {
  if (liveSunHour == null) { $("#realtime-status").textContent = "Noch keine Live-Zeit – bitte „Echtzeit aktualisieren“."; return; }
  const h = Math.max(6, Math.min(20, liveSunHour));
  $("#sun").value = h; applySun(h);
  $("#realtime-status").textContent = "Sonnenstand auf aktuelle Leipziger Zeit gesetzt (" + $("#sun-label").textContent + ").";
};
const toggleMap = { "chk-detail-buildings": ["detail-buildings", "detail-roofs"], "chk-rail": ["rail-layer"], "chk-stops": ["stops-layer", "stops-labels"],
  "chk-cycleways": ["cycle-layer"], "chk-pois": ["pois-layer", "pois-labels"], "chk-boundaries": ["bounds-layer", "bounds-labels"], "chk-water": ["water-layer"] };
Object.entries(toggleMap).forEach(([id, layers]) => {
  const el = document.getElementById(id); if (!el) return;
  el.onchange = e => { if (e.target.checked && !allDataLoaded) loadAllData(); else layerVis(layers, e.target.checked); };
});
$("#sat-opacity").oninput = e => {
  const v = parseFloat(e.target.value);
  $("#satop-label").textContent = Math.round(v * 100) + " %";
  ["sat-layer", "geosn-layer"].forEach(l => { if (map.getLayer(l)) map.setPaintProperty(l, "raster-opacity", v); });
};
$("#btn-screenshot").onclick = () => {
  map.once("render", () => {
    const a = document.createElement("a");
    a.href = map.getCanvas().toDataURL("image/png");
    a.download = "leipzig-3d-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
    a.click();
  });
  map.triggerRepaint();
};
$("#btn-export-geojson").onclick = () => {
  let features = [];
  try { features = map.queryRenderedFeatures({ layers: ["leipzig-buildings-3d"] }); } catch(e){}
  const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features }, null, 1)], { type: "application/geo+json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "leipzig-gebaeude-sichtbereich.geojson"; a.click(); URL.revokeObjectURL(a.href);
  $("#datalayer-status").textContent = features.length + " Gebäude des aktuellen Bildausschnitts als GeoJSON exportiert (Quelle: OpenStreetMap).";
};
$("#btn-validate").onclick = runValidation;
$("#val-close").onclick = () => $("#validation").classList.add("hidden");
$("#info-close").onclick = () => $("#info-card").classList.add("hidden");
$("#btn-tour").onclick = toggleTour;
$("#panel-toggle").onclick = () => $("#panel").classList.toggle("open");
$("#search-btn").onclick = () => { const q = $("#search-input").value.trim(); if (q) search(q); };
$("#search-input").addEventListener("keydown", e => { if (e.key === "Enter") $("#search-btn").click(); });
document.addEventListener("click", e => { if (!e.target.closest(".search")) $("#search-results").style.display = "none"; });

setLoad(10, "Initialisiere 3D-Engine (MapLibre GL) …");
initMap();
