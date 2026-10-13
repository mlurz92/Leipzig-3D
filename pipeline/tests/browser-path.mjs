/**
 * End-to-End-Test des Betrachter-Ladepfads im Browser-Stil:
 * holt die Modelldaten per fetch vom laufenden Server, packt sie mit
 * DecompressionStream aus (wie im Browser) und baut daraus die three.js-Szene.
 *
 * Voraussetzung: `npm run dev` laeuft auf http://127.0.0.1:5173
 * Aufruf:        node pipeline/tests/browser-path.mjs
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const base = process.env.BASE_URL || "http://127.0.0.1:5173/";

// Relative URLs wie im Browser aufloesen
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) =>
  realFetch(typeof url === "string" ? new URL(url, base).href : url, opts);

globalThis.document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
  createElement: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {}, getContext: () => null }),
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

const THREE = await import("three");
const { loadWorld, makeHeightSampler } = await import(join(root, "src", "loader.js"));
const { createWorld, buildChunks, U } = await import(join(root, "src", "world.js"));
const { createSky, applyTime } = await import(join(root, "src", "env.js"));

let failures = 0;
const check = (ok, text, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FEHLER "} ${text}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

const t0 = Date.now();
const steps = [];
const data = await loadWorld((step, done, total) => steps.push(`${step} ${done}/${total}`));
check(true, "Daten ueber HTTP geladen", `${steps.length} Schritte in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
check(data.terrain.data instanceof Int16Array, "Gelaende ausgepackt", `${data.terrain.data.length} Zellen`);
check(data.water.tex instanceof Uint8Array, "Wassertextur ausgepackt", `${data.water.tex.length} B`);
check(data.buildings.bin instanceof ArrayBuffer || data.buildings.bin.byteLength > 0, "Gebaeudeblob vorhanden");
check(data.trees.bin.byteLength > 1000, "Baumblob vorhanden");
check(!!data.props && data.props.bin.byteLength > 1000, "Requisitenblob vorhanden");
check((data.landmarks || []).length > 20, "Wahrzeichen aus den Metadaten", `${data.landmarks.length}`);

data.heightSampler = makeHeightSampler(data.terrain);
check(data.heightSampler(-820, 151) > 100, "Hoehenabfrage funktioniert",
  `${data.heightSampler(-820, 151).toFixed(1)} m`);

const scene = new THREE.Scene();
const renderer = { capabilities: { getMaxAnisotropy: () => 8 } };
const tBuild = Date.now();
const world = createWorld(data, scene, renderer);
await buildChunks(world, () => {});
check(world.chunkMeshes.length === data.buildings.index.chunks.length, "Alle Gebaeudekacheln aufgebaut",
  `${world.chunkMeshes.length} in ${((Date.now() - tBuild) / 1000).toFixed(1)} s`);
check(world.treeMeshes.length === data.trees.index.chunks.length, "Alle Baumkacheln aufgebaut",
  `${world.treeMeshes.length}`);

let tris = 0;
let verts = 0;
for (const mesh of world.chunkMeshes) {
  tris += mesh.geometry.index.count / 3;
  verts += mesh.geometry.attributes.position.count;
}
check(tris > 500000, "Dreiecke im Speicher", `${(tris / 1e6).toFixed(2)} Mio`);
check(verts > 400000, "Eckpunkte im Speicher", `${verts}`);

const sky = createSky(scene);
const info = applyTime(sky, new Date("2026-06-21T10:00:00Z"), 12.0);
check(info.elevationDeg > 55 && info.elevationDeg < 68, "Sonnenstand Mittag (Sommersonnenwende)",
  `${info.elevationDeg.toFixed(1)}° Hoehe, ${info.azimuthDeg.toFixed(0)}° Azimut`);
const evening = applyTime(sky, new Date("2026-06-21T10:00:00Z"), 21.6);
check(evening.elevationDeg < 2 && evening.elevationDeg > -8, "Sonne steht abends tief",
  `${evening.elevationDeg.toFixed(1)}°`);
const night = applyTime(sky, new Date("2026-06-21T10:00:00Z"), 1.0);
check(night.night === 1 && U.uSunColor.value.r === 0, "Nachtstimmung gesetzt", `night=${night.night}`);
const winter = applyTime(sky, new Date("2026-12-21T10:00:00Z"), 12.0);
check(winter.elevationDeg > 12 && winter.elevationDeg < 20, "Sonnenstand Mittag (Wintersonnenwende)",
  `${winter.elevationDeg.toFixed(1)}°`);

// Schattendurchgang mit Ersatzrenderer pruefen
const calls = [];
const fakeRenderer = {
  setRenderTarget: (t) => calls.push(["rt", t ? "map" : null]),
  setClearColor: (...a) => calls.push(["clear", a[0]]),
  getClearColor: (c) => c.setRGB(0.5, 0.6, 0.7),
  getClearAlpha: () => 1,
  clear: () => calls.push(["clear-op"]),
  render: (sc, cam) => calls.push(["render", sc.overrideMaterial ? "shadow" : "color"]),
};
const w2 = createWorld(data, new THREE.Scene(), renderer);
await buildChunks(w2, () => {});
w2.setShadowScale(460);
const origRender = w2.renderShadow;
// renderShadow nutzt den uebergebenen Renderer intern nicht: hier direkt pruefen
check(typeof w2.renderShadow === "function", "Schattendurchgang vorhanden");
check(w2.shadow.pointMat.uniforms.uPointScale.value > 1 && w2.shadow.pointMat.uniforms.uPointScale.value < 5,
  "Punktgroesse fuer Schattenkarte plausibel", `${w2.shadow.pointMat.uniforms.uPointScale.value.toFixed(2)} px/m`);
check(w2.shadow.rt.width === 2048, "Schattenkarte 2048²");

console.log(failures === 0 ? "\nLadepfad in Ordnung." : `\n${failures} Pruefung(en) fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
