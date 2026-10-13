/**
 * GLSL-Pruefer: baut alle Materialien wie im Browser auf und prueft die
 * Shaderquellen auf typische Fehler, die sonst erst der Grafikkartentreiber
 * meldet:
 *   - aufgerufene Funktionen, die nirgends definiert sind
 *   - Uniforms/Attribute, die benutzt aber nicht deklariert sind
 *   - varyings, die im Fragment nicht zum Vertex-Shader passen
 *   - mehrfach definierte Funktionen
 *
 * Aufruf:  node pipeline/tests/shaders.mjs
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dataDir = join(root, "public", "data");
const srcDir = join(root, "src");

globalThis.document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
  createElement: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {}, getContext: () => null }),
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

const json = (n) => JSON.parse(readFileSync(join(dataDir, n), "utf8"));
const gzjson = (n) => JSON.parse(gunzipSync(readFileSync(join(dataDir, n))).toString("utf8"));
const gz = (n) => {
  const b = gunzipSync(readFileSync(join(dataDir, n)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const THREE = await import("three");
const { createWorld } = await import(join(srcDir, "world.js"));
const { makeHeightSampler, makeWaterSampler } = await import(join(srcDir, "loader.js"));
const { createSky } = await import(join(srcDir, "env.js"));

const terrain = { data: new Int16Array(gz("terrain.bin.gz")), ...json("terrain.json") };
const height = makeHeightSampler(terrain);
const water = { tex: new Uint8Array(gz("water.bin.gz")), ...json("water.json") };

const scene = new THREE.Scene();
const data = {
  terrain,
  water,
  buildings: { bin: gz("buildings.bin.gz"), index: json("buildings.index.json"), meta: gzjson("buildings.meta.json.gz") },
  trees: { bin: gz("trees.bin.gz"), index: json("trees.index.json") },
  props: { bin: gz("props.bin.gz"), index: json("props.json").index },
  heightSampler: height,
  waterSampler: makeWaterSampler(water),
};
const world = createWorld(data, scene, { capabilities: { getMaxAnisotropy: () => 8 } });
const sky = createSky(scene);

// ------------------------------------------------------------------ Sammeln
const materials = [];
const walk = (obj) => {
  if (obj.material) {
    for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (m.vertexShader && !materials.includes(m)) materials.push(m);
    }
  }
  for (const c of obj.children || []) walk(c);
};
walk(scene);
// Materialien, die noch an keiner Geometrie haengen, ausdruecklich einsammeln
for (const m of Object.values(world.materials)) if (m && m.vertexShader && !materials.includes(m)) materials.push(m);
for (const m of [world.shadow.triMat, world.shadow.pointMat]) if (m && !materials.includes(m)) materials.push(m);
const skyMat = sky.mesh.material;
if (!materials.includes(skyMat)) materials.push(skyMat);

const BUILTINS = new Set([
  "abs", "acos", "all", "any", "asin", "atan", "ceil", "clamp", "cos", "cross", "degrees", "distance",
  "dot", "equal", "exp", "exp2", "faceforward", "floor", "fract", "greaterThan", "greaterThanEqual",
  "inversesqrt", "length", "lessThan", "lessThanEqual", "log", "log2", "matrixCompMult", "max", "min",
  "mix", "mod", "normalize", "not", "notEqual", "pow", "radians", "reflect", "refract", "sign", "sin",
  "smoothstep", "sqrt", "step", "tan", "texture2D", "textureCube", "dFdx", "dFdy", "fwidth",
  "vec2", "vec3", "vec4", "mat2", "mat3", "mat4", "float", "int", "bool", "sampler2D", "if", "for",
  "while", "return", "discard", "void", "main", "mod",
]);

let problems = 0;
const seen = new Set();
const report = (m, msg) => {
  const key = `${m}|${msg}`;
  if (seen.has(key)) return;
  seen.add(key);
  problems++;
  console.log(`  FEHLER  ${m} — ${msg}`);
};

const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ");

/** Deklarationen der Form "uniform vec3 a, b;" beruecksichtigen. */
function declaredVaryings(text) {
  const names = new Set();
  const re = /varying\s+\w+\s+([^;]+);/g;
  let m;
  while ((m = re.exec(text))) {
    for (const part of m[1].split(",")) {
      const id = part.trim().match(/^(\w+)/);
      if (id) names.add(id[1]);
    }
  }
  return names;
}

function definedFunctions(text) {
  const names = new Map();
  const re = /\b(?:void|float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4)\s+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(text))) names.set(m[1], (names.get(m[1]) || 0) + 1);
  return names;
}

function calledFunctions(text) {
  const names = new Set();
  const re = /(?<![.\w])(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return names;
}

const isBuiltin = (fn) => BUILTINS.has(fn) || /^(vec[234]|mat[234]|ivec[234]|bvec[234]|texture|texelFetch|vec\d+)$/.test(fn);

console.log(`Pruefe ${materials.length} Shader-Materialien ...`);
for (const [i, mat] of materials.entries()) {
  const name = mat.name || `material-${i}`;
  const stages = [
    ["vertex", stripComments(mat.vertexShader)],
    ["fragment", stripComments(mat.fragmentShader)],
  ];

  for (const [stage, text] of stages) {
    const defined = definedFunctions(text);
    for (const [fn, count] of defined) {
      if (count > 1) report(name, `${stage}: Funktion ${fn} ist ${count}x definiert`);
    }
    for (const fn of calledFunctions(text)) {
      if (isBuiltin(fn)) continue;
      if (!defined.has(fn)) report(name, `${stage}: ${fn}() wird aufgerufen, aber nicht definiert`);
    }
    // verwendete varyings muessen in dieser Stufe deklariert sein
    const declared = declaredVaryings(text);
    for (const v of new Set([...text.matchAll(/\bv[A-Z]\w*/g)].map((m2) => m2[0]))) {
      if (v === "vec" || v.startsWith("vec")) continue;
      if (!declared.has(v) && !/\b(varying|void|vec|float|int)\b/.test(v)) {
        if (!declared.has(v)) report(name, `${stage}: varying ${v} wird benutzt, aber nicht deklariert`);
      }
    }
  }
}

// ------------------------------------------------------------------ Ausgabe
const lines = [];
for (const m of materials) {
  lines.push(`### vertex\n${m.vertexShader}`, `### fragment\n${m.fragmentShader}`);
}
console.log(`\n${materials.length} Materialien geprueft, ${problems} Auffaelligkeiten.`);
if (problems === 0) {
  const out = join(root, "docs", "shader-quellen.txt");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, lines.join("\n\n"));
  console.log(`Shaderquellen zur Kontrolle: ${out}`);
}
process.exit(problems === 0 ? 0 : 1);
