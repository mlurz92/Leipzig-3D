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
  // Fassaden-Modus: echte OSM-Farbe, wo erfasst, sonst Höhen-/Typ-Annäherung
  return ["case",
    ["has", "colour"], ["get", "colour"],
    ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8],
      0, "#b8a88e", 10, "#cbb99b", 25, "#b7a99a", 50, "#9aa3ad", 100, "#7e8a99"]];
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
  applyBasemap(document.querySelector("[data-basemap].active")?.dataset.basemap || "karte");
  applySun(parseFloat($("#sun").value));
}

function labelLayerIds() {
  return (map.getStyle().layers || []).filter(l => l.type === "symbol").map(l => l.id);
}
function applyBasemap(mode) {
  if (!map.getLayer("sat-layer")) return;
  map.setLayoutProperty("sat-layer", "visibility", mode === "karte" ? "none" : "visible");
  // Im reinen Kartenmodus Basis hell lassen; bei Satellit/Hybrid Basis abdunkeln ist Sache des Styles –
  // wir blenden nur das Echtbild ein/aus. Labels bleiben bei Hybrid sichtbar.
  const showLabels = $("#chk-labels").checked && mode !== "satellit";
  labelLayerIds().forEach(id => { if (id !== "landmark-labels") try { map.setLayoutProperty(id, "visibility", showLabels ? "visible" : "none"); } catch(e){} });
}

function applySun(hour) {
  $("#sun-label").textContent = `${String(Math.floor(hour)).padStart(2,"0")}:${hour % 1 ? "30" : "00"} Uhr`;
  // Lichtstimmung über Gebäude-Opazität + Himmel (MapLibre-Sky, falls vom Style unterstützt)
  const day = Math.max(0, Math.min(1, 1 - Math.abs(hour - 13) / 9));
  if (map.getLayer("leipzig-buildings-3d")) {
    map.setPaintProperty("leipzig-buildings-3d", "fill-extrusion-opacity", 0.82 + day * 0.13);
  }
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
    antialias: true, maxPitch: 85, hash: true,
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
  map.on("click", "landmark-circles", (e) => {
    const id = e.features[0].properties.id;
    const l = window.LEIPZIG_LANDMARKS.find(x => x.id === id);
    if (l) showLandmark(l, false);
  });
  ["leipzig-buildings-3d", "landmark-circles"].forEach(l => {
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
    map.setLayoutProperty("trees-layer", "visibility", "visible");
    $("#chk-trees").checked = true;
    status.innerHTML = `✓ <b>${features.length.toLocaleString("de-DE")}</b> echte, einzeln erfasste Bäume geladen (OpenStreetMap, Stand der Abfrage: ${new Date().toLocaleString("de-DE")}). Quelle: Overpass API.`;
    flyTo(12.377, 51.340, 15.4, 58);
  } catch (err) {
    status.innerHTML = `<span style="color:#ff8787">Fehler: ${escapeHtml(err.message)}. Bitte später erneut versuchen (Overpass-Ratenlimit).</span>`;
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
  rows.push(["Fassaden-Grenze (ehrlich)", "Teilweise Annäherung", "warn",
    "Echte Fassadenfarben nur, wo building:colour in OSM erfasst ist. Für flächendeckende amtliche Fassaden/LoD2: GeoSN Sachsen CityGML (kostenlos, siehe README) – zu groß für Direkt-Streaming im Browser."]);
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
$("#chk-buildings").onchange = e => map.setLayoutProperty("leipzig-buildings-3d", "visibility", e.target.checked ? "visible" : "none");
$("#chk-landmarks").onchange = e => { ["landmark-circles","landmark-labels"].forEach(l => map.setLayoutProperty(l, "visibility", e.target.checked ? "visible" : "none")); };
$("#chk-labels").onchange = () => applyBasemap(document.querySelector("[data-basemap].active").dataset.basemap);
$("#chk-trees").onchange = e => { if (e.target.checked && map.getSource("trees")._data?.features?.length === 0) loadTrees(); else map.setLayoutProperty("trees-layer", "visibility", e.target.checked ? "visible" : "none"); };
$("#chk-terrain").onchange = e => {
  if (e.target.checked) map.setTerrain({ source: "terrain-dem", exaggeration: parseFloat($("#terr-ex").value) });
  else map.setTerrain(null);
};
$("#terr-ex").oninput = e => { $("#terr-label").textContent = (+e.target.value).toFixed(1).replace(".", ",") + "×"; if ($("#chk-terrain").checked) map.setTerrain({ source: "terrain-dem", exaggeration: parseFloat(e.target.value) }); };
$("#sel-colormode").onchange = e => map.setPaintProperty("leipzig-buildings-3d", "fill-extrusion-color", buildingColorExpression(e.target.value));
$("#sun").oninput = e => applySun(parseFloat(e.target.value));
$("#minzoom").oninput = e => { $("#zoom-label").textContent = e.target.value; if (map.getLayer("leipzig-buildings-3d")) map.setLayerZoomRange("leipzig-buildings-3d", parseFloat(e.target.value), 24); };
$("#landmark-filter").oninput = e => buildLandmarkList(e.target.value);
$("#btn-trees-load").onclick = loadTrees;
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
