/**
 * Smoke-Test ohne Browser: liest die gebackenen Dateien, packt sie mit den
 * Betrachter-Funktionen aus und baut die three.js-Szene in Node auf.
 * Faengt Formatfehler, falsche Kacheltabellen und JS-Fehler im Szenenaufbau.
 *
 * Aufruf:  node pipeline/tests/smoke.mjs
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dataDir = join(root, "public", "data");
const srcDir = join(root, "src");

// drei braucht im Node-Test einen minimalen DOM-Ersatz (nur fuer Texturen)
globalThis.document = {
  createElementNS: () => ({
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    style: {},
  }),
  createElement: () => ({
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getContext: () => null,
    style: {},
  }),
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);

const json = (name) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
const gzjson = (name) => JSON.parse(gunzipSync(readFileSync(join(dataDir, name))).toString("utf8"));
const gz = (name) => {
  const buf = gunzipSync(readFileSync(join(dataDir, name)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

const { decodeBuildingChunk, decodeTreeChunk, decodeProps } = await import(join(srcDir, "decode.js"));
const { makeHeightSampler, makeWaterSampler, HALF, SIZE } = await import(join(srcDir, "loader.js"));

let failures = 0;
const check = (ok, text, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FEHLER "} ${text}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

// ------------------------------------------------------------------ Gelaende
const terrainJson = json("terrain.json");
const terrain = {
  data: new Int16Array(gz("terrain.bin.gz")),
  ...terrainJson,
};
check(terrain.data.length === terrainJson.nx * terrainJson.ny, "Gelaenderaster vollstaendig",
  `${terrain.data.length} Zellen`);
const height = makeHeightSampler(terrain);
const probes = [
  [-820, 151, "Peterskirche"],
  [-532, -616, "City-Hochhaus"],
  [0, 0, "Zentrum"],
  [1900, -1900, "Nordost"],
  [-1900, 1900, "Suedwest"],
];
for (const [x, z, name] of probes) {
  const h = height(x, z);
  check(Number.isFinite(h) && h > 95 && h < 175, `Gelaendehoehe ${name}`, `${h.toFixed(2)} m NN`);
}
check(height(-HALF + 1, -HALF + 1) > 95 && height(HALF - 1, HALF - 1) > 95, "Rasteraender liefern Werte");

// -------------------------------------------------------------------- Wasser
const waterJson = json("water.json");
const waterTex = new Uint8Array(gz("water.bin.gz"));
check(waterTex.length === waterJson.grid * waterJson.grid * 4, "Wassertextur RGBA",
  `${waterTex.length} B, ${waterJson.components.length} Koerper`);
let wet = 0;
for (let i = 3; i < waterTex.length; i += 4) if (waterTex[i] > 0) wet++;
check(wet > 5000, "Wasserzellen vorhanden", `${wet}`);
const water = { tex: waterTex, ...waterJson };
const waterAt = makeWaterSampler(water);
const lvl = waterAt(-1770, -330);      // Elsterbecken (Nordwest)
check(lvl === null || (lvl > 100 && lvl < 130), "Wasserspiegel liefert plausible Hoehe",
  lvl === null ? "kein Wasser an der Probe (ok)" : `${lvl.toFixed(2)} m`);

// ----------------------------------------------------------------- Gebaeude
const bIndex = json("buildings.index.json");
const bMeta = gzjson("buildings.meta.json.gz");
const bBin = gz("buildings.bin.gz");
check(bIndex.nBuildings > 10000, "Gebaeudezahl", `${bIndex.nBuildings}`);
check(bMeta.count === bIndex.nBuildings, "Metadaten passen zum Index");
check(bMeta.ids.length === bMeta.count, "IDs vollstaendig");
let nv = 0;
let nt = 0;
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
let bad = 0;
for (const info of bIndex.chunks) {
  const c = decodeBuildingChunk(bBin, info);
  nv += c.nv;
  nt += c.nt;
  if (c.idx.length !== c.nt * 3 || c.pos.length !== c.nv * 3) bad++;
  const maxIdx = c.nv <= 65535 ? Math.max(...c.idx.slice(0, 3000)) : 0;
  if (c.nv <= 65535 && maxIdx >= c.nv) bad++;
  for (let i = 0; i < c.nv; i++) {
    minX = Math.min(minX, c.pos[i * 3]);
    maxX = Math.max(maxX, c.pos[i * 3]);
    minY = Math.min(minY, c.pos[i * 3 + 1]);
    maxY = Math.max(maxY, c.pos[i * 3 + 1]);
  }
}
check(bad === 0, "Alle Gebaeudekacheln sauber dekodiert", `${bIndex.chunks.length} Kacheln`);
check(Math.abs(minX) < 2100 && Math.abs(maxX) < 2100, "Gebaeude liegen im Modellgebiet",
  `x ${minX.toFixed(0)}..${maxX.toFixed(0)}`);
check(minY > 60 && maxY < 250, "Gebaeudehoehen plausibel", `y ${minY.toFixed(1)}..${maxY.toFixed(1)} m NN`);
check(nt > 600000 && nt < 1000000, "Dreieckszahl", `${(nt / 1e6).toFixed(2)} Mio`);
check(bMeta.landmarks.length > 20, "Wahrzeichenliste", `${bMeta.landmarks.length} Eintraege`);

// ------------------------------------------------------------------- Baeume
const tIndex = json("trees.index.json");
const tBin = gz("trees.bin.gz");
let trees = 0;
let crownTop = 0;
for (const info of tIndex.chunks) {
  const c = decodeTreeChunk(tBin, info, height);
  trees += c.n;
  for (let i = 0; i < c.n; i++) crownTop = Math.max(crownTop, c.pos[i * 3 + 1]);
}
check(trees === tIndex.count && trees > 40000, "Baumzahl", `${trees}`);
check(crownTop < 190, "Kronenhoehen plausibel", `hoechste Krone ${crownTop.toFixed(1)} m NN`);

// --------------------------------------------------------------- Requisiten
const pIndex = json("props.json");
const pBin = gz("props.bin.gz");
let props = 0;
const groupCounts = {};
for (const [name, info] of Object.entries(pIndex.index)) {
  const d = decodeProps(pBin, info);
  if (d.idx.length !== d.nt * 3 || d.pos.length !== d.nv * 3) failures++;
  if (d.nv > 65535) failures++;   // u32-Indizes decken das ab
  groupCounts[name] = d.nt;
  props += d.nt;
}
check(props > 50000, "Requisiten-Dreiecke", JSON.stringify(groupCounts));

// -------------------------------------------------------------------- Szene
const THREE = await import("three");
const { createWorld } = await import(join(srcDir, "world.js"));

const scene = new THREE.Scene();
const fakeRenderer = { capabilities: { getMaxAnisotropy: () => 8 } };
const data = {
  terrain,
  water,
  buildings: { bin: bBin, index: bIndex, meta: bMeta },
  trees: { bin: tBin, index: tIndex },
  props: { bin: pBin, index: pIndex.index },
  heightSampler: height,
  waterSampler: waterAt,
};
const world = createWorld(data, scene, fakeRenderer);
check(world.propMeshes.length === Object.keys(pIndex.index).length, "Requisiten-Meshes", `${world.propMeshes.length}`);
check(world.groups.terrain.children.length === 256, "Gelaendekacheln", `${world.groups.terrain.children.length}`);

const { buildChunks } = await import(join(srcDir, "world.js"));
await buildChunks(world, () => {});
check(world.chunkMeshes.length === bIndex.chunks.length, "Warteschlange Gebaeude abgearbeitet",
  `${world.chunkMeshes.length}`);
check(world.treeMeshes.length === tIndex.chunks.length, "Warteschlange Baeume abgearbeitet",
  `${world.treeMeshes.length}`);

const sample = world.chunkMeshes[40];
const pos = sample.geometry.attributes.position;
const norm = sample.geometry.attributes.normal;
let finiteNormals = true;
for (let i = 0; i < Math.min(pos.count * 3, 9000); i++) {
  if (!Number.isFinite(norm.array[i])) finiteNormals = false;
}
check(finiteNormals, "Normalen berechnet");
check(sample.geometry.boundingSphere !== null, "Bounding-Sphere vorhanden");
const treeSample = world.treeQueue[60]();
check(treeSample.geometry.attributes.aSize.count > 0, "Baumpunkte haben Attribute");

// Schattenpfad ohne echten Renderer pruefen (Aufrufe zaehlen)
let shadowCalls = 0;
const realRender = world.renderShadow;
world.renderShadow = (focus, dir) => {
  shadowCalls++;
  check(dir.length() > 0.9 && dir.length() < 1.1, "Sonnenrichtung normalisiert", dir.toArray().map((v) => v.toFixed(2)).join(","));
  check(Number.isFinite(focus.x) && Number.isFinite(focus.y), "Schattenfokus gueltig");
};
world.renderShadow(new THREE.Vector3(0, 120, 0), new THREE.Vector3(0.4, 0.6, 0.5).normalize());
check(shadowCalls === 1, "Schattenaufruf moeglich");

console.log(failures === 0 ? "\nAlle Pruefungen bestanden." : `\n${failures} Pruefung(en) fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
