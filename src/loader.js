/**
 * Laden und Auspacken der gebackenen Modelldaten.
 *
 * Alle Dateien liegen als einzelne, komprimierte Blobs in public/data und
 * werden beim Start (mit Fortschrittsanzeige) geholt. Gebaeude und Baeume
 * kommen als ein Blob mit Index (Kacheltabelle), damit sie nach und nach
 * zu Meshes verarbeitet werden koennen.
 *
 * Weltkoordinaten: x nach Osten, z nach Sueden, y = Hoehe ueber Normalnull.
 */

export const ORIGIN = { x: 318000, y: 5690000, z: 100 };
export const SIZE = 4000;                      // Kantenlaenge des Modells (m)
export const CHUNK_M = 250;                    // Kantenlaenge der Gebietskacheln
export const HALF = SIZE / 2;

export function toWorld(easting, northing, height) {
  return [easting - ORIGIN.x, height - ORIGIN.z, -(northing - ORIGIN.y)];
}

/**
 * Packt gzip-Daten aus. Manche Server (auch der Entwicklungsserver) liefern
 * `.gz`-Dateien bereits entpackt aus (Content-Encoding) - dann fehlt die
 * gzip-Kennung und die Daten werden unveraendert zurueckgegeben.
 */
async function gunzip(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) return buffer;
  if (typeof DecompressionStream === "undefined") return buffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

async function get(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  if (!onBytes || !res.body || !total) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    seen += value.length;
    onBytes(seen, total);
  }
  const out = new Uint8Array(seen);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.json();
}

async function getGzipJSON(url, onBytes) {
  return JSON.parse(new TextDecoder().decode(await gunzip(await get(url, onBytes))));
}

/**
 * Laedt alles, was das Modell braucht.
 * @param {(step: string, done: number, total: number) => void} onProgress
 */
export async function loadWorld(onProgress = () => {}) {
  const steps = [
    ["Gelaende", () => getJSON("data/terrain.json")],
    ["Gelaende", () => get("data/terrain.bin.gz")],
    ["Wasser", () => getJSON("data/water.json")],
    ["Wasser", () => get("data/water.bin.gz")],
    ["Gebaeude", () => getJSON("data/buildings.index.json")],
    ["Gebaeude", () => get("data/buildings.bin.gz")],
    ["Gebaeude", () => getGzipJSON("data/buildings.meta.json.gz")],
    ["Baeume", () => getJSON("data/trees.index.json")],
    ["Baeume", () => get("data/trees.bin.gz")],
    ["Requisiten", () => getJSON("data/props.json").catch(() => null)],
    ["Requisiten", () => get("data/props.bin.gz").catch(() => null)],
  ];
  let done = 0;
  const results = [];
  for (const [label, fn] of steps) {
    onProgress(label, done, steps.length);
    try {
      results.push(await fn());
    } catch (err) {
      if (label === "Requisiten") results.push(null);
      else throw err;
    }
    done += 1;
    onProgress(label, done, steps.length);
  }
  const [terrainJson, terrainBin, waterJson, waterBin, bIndex, bBin, bMeta, tIndex, tBin, propsJson, propsBin] = results;

  const terrain = {
    data: new Int16Array(await gunzip(terrainBin)),
    nx: terrainJson.nx,
    ny: terrainJson.ny,
    res: terrainJson.res,
    originZ: terrainJson.originZ,
    bbox: terrainJson.bbox,
    min: terrainJson.min,
    max: terrainJson.max,
  };

  const water = {
    tex: new Uint8Array(await gunzip(waterBin)),
    grid: waterJson.grid,
    cellM: waterJson.cellM,
    components: waterJson.components,
    originZ: waterJson.originZ,
  };

  const trees = {
    bin: await gunzip(tBin),
    index: tIndex,
  };

  const buildings = {
    bin: await gunzip(bBin),
    index: bIndex,
    meta: bMeta,
  };

  const props = propsJson && propsBin ? { index: propsJson.index, bin: await gunzip(propsBin) } : null;

  return {
    terrain,
    water,
    trees,
    buildings,
    props,
    landmarks: bMeta.landmarks || [],
  };
}

/** Texturdatei als Image/Blob-URL laden (fuer THREE.TextureLoader). */
export function assetURL(name) {
  return `data/${name}`;
}

/**
 * Bilineare Hoehenabfrage im Gelaenderaster.
 * @param {*} terrain wie von loadWorld
 * @param {number} x lokale X-Koordinate (m)
 * @param {number} z lokale Z-Koordinate (m)
 * @returns {number} Hoehe ueber Normalnull (m)
 */
export function makeHeightSampler(terrain) {
  const { data, nx, ny, res, originZ } = terrain;
  const x0 = -HALF;
  const z0 = -HALF;
  return function height(x, z) {
    const fx = (x - x0) / res;
    const fz = (z - z0) / res;
    const i = Math.min(nx - 2, Math.max(0, Math.floor(fx)));
    const j = Math.min(ny - 2, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i));
    const tz = Math.min(1, Math.max(0, fz - j));
    const h00 = data[j * nx + i];
    const h10 = data[j * nx + i + 1];
    const h01 = data[(j + 1) * nx + i];
    const h11 = data[(j + 1) * nx + i + 1];
    const h = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    return h / 100 + originZ;
  };
}

/**
 * Wasserspiegel an einer Stelle (null, wenn dort kein Wasser ist).
 * Die Textur traegt R/G = Hoehe als uint16 (Zentimeter + 32768), A = Deckung.
 */
export function makeWaterSampler(water) {
  const { tex, grid, cellM, originZ } = water;
  const x0 = -HALF;
  const z0 = -HALF;
  return function waterHeight(x, z) {
    const i = Math.min(grid - 1, Math.max(0, Math.round((x - x0) / cellM)));
    const j = Math.min(grid - 1, Math.max(0, Math.round((z - z0) / cellM)));
    const o = (j * grid + i) * 4;
    if (tex[o + 3] === 0) return null;
    const cm = tex[o] + tex[o + 1] * 256 - 32768;
    return cm / 100 + originZ;
  };
}
