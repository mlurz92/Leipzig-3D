/**
 * Aufbau und Zeichnen des Leipzig-Modells.
 *
 * Alles rechnet in Weltkoordinaten:
 *   x = Osten, z = Sueden, y = Hoehe ueber Normalnull (m).
 * Die Szene besteht aus
 *   - Gelaende   256 Kacheln a 250 m, Hoehen aus DGM1, Luftbild-Textur,
 *   - Gebaeuden  LoD2, 256 Kacheln, Fassaden mit prozeduralen Fenstern,
 *   - Baeumen    Punktkronen (Baumkataster + DOM1-Kronen),
 *   - Wasser     Spiegelflaeche aus dem Wasser-Raster,
 *   - Requisiten Mauern, Hecken, Bruecken, Denkmaeler, Laternen, Baenke ...
 *   - Himmel     Verlauf, Sonne, Sterne.
 *
 * Schatten wirft die Szene selbst in eine Tiefenkarte (gepacktes RGBA);
 * die Materialien lesen sie fuer die Beschattung.
 */

import * as THREE from "three";
import { decodeBuildingChunk, decodeTreeChunk, decodeProps } from "./decode.js";
import { CHUNK_M, HALF, SIZE } from "./loader.js";

// ---------------------------------------------------------------- Uniforms

export const U = {
  uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5) },
  uSunColor: { value: new THREE.Color(1.0, 0.96, 0.9) },
  uSkyColor: { value: new THREE.Color(0.42, 0.52, 0.68) },
  uBounceColor: { value: new THREE.Color(0.22, 0.21, 0.18) },
  uFogColor: { value: new THREE.Color(0.72, 0.77, 0.83) },
  uFogDensity: { value: 0.00055 },
  uNight: { value: 0 },
  uTime: { value: 0 },
  uEye: { value: new THREE.Vector3() },
  uAmbient: { value: 1.0 },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowMap: { value: null },
  uShadowTexel: { value: 1 / 2048 },
  uShadowStrength: { value: 0.62 },
  uPointScale: { value: 1000 },
  uGroundRef: { value: 112 },
  uWind: { value: 1.0 },
};

/** Gemeinsame Uniforms und Hilfsfunktionen (fuer beide Shaderstufen). */
const COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uBounceColor;
uniform vec3 uFogColor;
uniform vec3 uEye;
uniform float uFogDensity;
uniform float uNight;
uniform float uTime;
uniform float uAmbient;
uniform float uGroundRef;
uniform float uShadowStrength;
uniform float uShadowTexel;
uniform float uPointScale;
uniform float uWind;
uniform mat4 uShadowMatrix;
uniform sampler2D uShadowMap;

const float PI = 3.14159265359;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

vec3 srgbToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 tonemap(vec3 x) {   // ACES-Filmnäherung (Narkowicz)
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
`;

const VERTEX_PRELUDE = /* glsl */ `
precision highp float;
` + COMMON;

const PRELUDE = /* glsl */ `
precision highp float;
` + COMMON + /* glsl */ `

vec4 packDepth(float v) {
  const vec4 shift = vec4(1.0, 255.0, 65025.0, 16581375.0);
  const vec4 mask = vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  vec4 r = fract(v * shift);
  r -= r.xxyz * mask;
  return r;
}

float unpackDepth(vec4 c) {
  return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

float shadowAt(vec3 world, float ndl) {
  vec4 lp = uShadowMatrix * vec4(world, 1.0);
  if (lp.w <= 0.0) return 1.0;
  vec3 c = lp.xyz / lp.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float ref = c.z - (0.0009 + 0.0032 * (1.0 - ndl));
  float lit = 0.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      vec2 uv = c.xy + vec2(float(i), float(j)) * uShadowTexel;
      lit += step(ref, unpackDepth(texture2D(uShadowMap, uv)));
    }
  }
  return mix(1.0, lit / 9.0, uShadowStrength);
}

/** Sonnenlicht + Himmelslicht + Bodenreflexion, dazu Schatten und Glanz. */
vec3 shade(vec3 albedo, vec3 n, vec3 world, float gloss) {
  float ndl = dot(n, uSunDir);
  float up = n.y * 0.5 + 0.5;
  vec3 ambient = albedo * mix(uBounceColor, uSkyColor, up) * uAmbient;
  float lit = max(ndl, 0.0);
  vec3 direct = vec3(0.0);
  if (lit > 0.0) {
    float sh = shadowAt(world, lit);
    direct = albedo * uSunColor * lit * sh;
    if (gloss > 0.0 && sh > 0.5) {
      vec3 h = normalize(uSunDir + normalize(uEye - world));
      direct += uSunColor * gloss * pow(max(dot(n, h), 0.0), 42.0) * lit;
    }
  }
  return direct + ambient;
}

/** Dunst: mit der Entfernung zum Auge, oben duenner. */
vec3 finish(vec3 color, vec3 world) {
  float dist = length(world - uEye);
  float f = 1.0 - exp(-dist * uFogDensity);
  f *= exp(-max(world.y - uGroundRef, 0.0) * 0.0022);
  color = mix(color, uFogColor, clamp(f, 0.0, 0.88));
  return linearToSrgb(tonemap(color * 1.02));
}
`;

// Nachtfenster: warmes Licht in einem Teil der Fenster
const WINDOW_GLSL = /* glsl */ `
/** Fensterbild einer Fassade. n = Wandnormale, h = Hoehe ueber Sockel. */
vec3 facadeWindows(vec3 base, vec3 n, vec3 world, float baseY, float id, float floorH, float pitch, out float emis) {
  emis = 0.0;
  float h = world.y - baseY;
  vec2 t = normalize(vec2(-n.z, n.x));
  float u = dot(world.xz, t);
  float row = floor((h - 1.1) / floorH);
  float col = floor(u / pitch);
  float inRow = step(1.35, h - row * floorH) * step(h - row * floorH, 1.35 + floorH * 0.62);
  float fu = abs(fract(u / pitch + 0.5) - 0.5) * pitch;
  float fv = abs(fract((h - 1.1) / floorH + 0.35) - 0.35) * floorH;
  float pane = step(fu, 0.62) * step(fv, 0.92) * inRow;
  float rnd = hash12(vec2(id * 7.31, row * 13.7 + col * 5.1));
  float on = step(0.32, rnd);                       // nur ein Teil der Fassade hat Fenster
  float lit = step(0.55, hash12(vec2(id * 3.17, row * 29.1 + col * 11.3)));
  float glow = smoothstep(0.55, 1.0, uNight);
  vec3 glass = srgbToLinear(vec3(0.16, 0.19, 0.23));
  vec3 color = mix(base, glass, pane * on * 0.92);
  // Rahmen/Sohlbank: eine duenne helle Linie unter jeder Fensterzeile
  float sill = step(1.1, h - row * floorH) * step(h - row * floorH, 1.22) * on;
  color = mix(color, base * 1.12, sill * 0.7);
  if (glow > 0.0) {
    vec3 warm = srgbToLinear(vec3(1.0, 0.78, 0.46));
    color = mix(color, warm * 1.6, pane * on * lit * glow * 0.85);
    emis = pane * on * lit * glow;
  }
  return color;
}
`;

// ---------------------------------------------------------------- Materialien

function makeMaterial(fragment, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...U, ...(extra.uniforms || {}) },
    vertexShader: VERTEX_PRELUDE + (extra.vertex || ""),
    fragmentShader: PRELUDE + fragment,
    side: extra.side || THREE.FrontSide,
    transparent: !!extra.transparent,
    depthWrite: extra.depthWrite !== false,
  });
}

const TERRAIN_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vUv = uv;
  vWorld = position;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

export function createTerrainMaterial() {
  return makeMaterial(
    /* glsl */ `
uniform sampler2D uGround;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 tex = srgbToLinear(texture2D(uGround, vUv).rgb);
  float grain = fbm(vWorld.xz * 0.9) * 0.6 + vnoise(vWorld.xz * 3.1) * 0.4;
  vec3 albedo = tex * (0.9 + 0.2 * grain);
  vec3 n = normalize(vNormal);
  vec3 color = shade(albedo, n, vWorld, 0.02);
  gl_FragColor = vec4(finish(color, vWorld), 1.0);
}
`,
    { vertex: TERRAIN_VERT, uniforms: { uGround: { value: null } } }
  );
}

const BUILDING_VERT = /* glsl */ `
attribute vec3 color;
attribute float flag;
attribute vec2 baseId;     // x = Sockelhoehe (m ueber Origin), y = Gebaeudeindex
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vFlag;
varying vec2 vBaseId;
void main() {
  vColor = color;
  vFlag = flag;
  vWorld = position;
  vNormal = normal;
  vBaseId = baseId;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

export function createBuildingMaterial() {
  return makeMaterial(
    WINDOW_GLSL + /* glsl */ `
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vFlag;
varying vec2 vBaseId;
void main() {
  vec3 n = normalize(vNormal);
  vec3 base = srgbToLinear(vColor);
  float kind = mod(vFlag, 4.0);                 // 0 Wand, 1 Dach, 2 Sockel, 3 sonst
  float shop = mod(floor(vFlag / 4.0), 2.0);    // Ladenlokal
  float heritage = mod(floor(vFlag / 8.0), 2.0);
  vec3 color;
  float gloss = 0.0;
  if (kind < 0.5 || kind > 2.5) {
    // Wand
    float floorH = 3.05;
    float pitch = 2.35;
    float id = floor(vBaseId.y * 0.37 + 3.1);
    float emis = 0.0;
    if (shop > 0.5) {
      float h = vWorld.y - vBaseId.x;
      float glassBand = step(0.55, h) * step(h, 3.05);
      float band = glassBand * step(0.4, fract(vWorld.x * 0.31 + vWorld.z * 0.27));
      base = mix(base, srgbToLinear(vec3(0.28, 0.31, 0.34)), band * 0.75);
    }
    color = facadeWindows(base, n, vWorld, vBaseId.x, id, floorH, pitch, emis);
    color = mix(color, color * vec3(1.04, 1.0, 0.94), heritage);
    gloss = mix(0.04, 0.08, heritage);
  } else if (kind < 1.5) {
    // Dach: leicht noisige Ziegel/Abdichtung
    float v = vnoise(vWorld.xz * 1.7) * 0.5 + fbm(vWorld.xz * 0.35) * 0.5;
    color = srgbToLinear(vColor) * (0.88 + 0.24 * v);
    gloss = 0.04;
  } else {
    // Sockel / Bodenplatte
    color = srgbToLinear(vColor) * (0.85 + 0.3 * vnoise(vWorld.xz * 2.3));
  }
  vec3 shaded = shade(color, n, vWorld, gloss);
  gl_FragColor = vec4(finish(shaded, vWorld), 1.0);
}
`,
    { vertex: BUILDING_VERT }
  );
}

const TREE_VERT = /* glsl */ `
attribute float aSize;
attribute float aArt;
attribute float aTint;
varying vec2 vSprite;
varying float vArt;
varying float vTint;
varying vec3 vWorld;
varying float vSeed;
void main() {
  vec3 world = position;
  float sway = sin(uTime * 0.9 + world.x * 0.05 + world.z * 0.04) * 0.09 * uWind * aSize * 0.12;
  world.x += sway;
  world.z += sway * 0.6;
  vWorld = world;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 1.0);
  gl_PointSize = clamp(aSize * 2.0 * uPointScale / dist, 2.0, 1400.0);
  vSprite = vec2(aTint, aArt);
  vArt = aArt;
  vTint = aTint;
  vSeed = hash12(world.xz * 0.37);
}
`;

const TREE_FRAG = /* glsl */ `
varying vec2 vSprite;
varying float vArt;
varying float vTint;
varying vec3 vWorld;
varying float vSeed;

vec3 crownColor() {
  // 0 dunkelgruen, 1 mittelgruen, 2 hellgruen, 3 gelbgruen,
  // 4 blaugruen (Nadel), 5 rotbraun, 6 silbergrau, 7 Bluete
  int g = int(vTint + 0.5);
  if (g == 0) return srgbToLinear(vec3(0.16, 0.28, 0.14));
  if (g == 1) return srgbToLinear(vec3(0.24, 0.36, 0.18));
  if (g == 2) return srgbToLinear(vec3(0.36, 0.46, 0.24));
  if (g == 3) return srgbToLinear(vec3(0.48, 0.52, 0.22));
  if (g == 4) return srgbToLinear(vec3(0.14, 0.26, 0.22));
  if (g == 5) return srgbToLinear(vec3(0.42, 0.26, 0.16));
  if (g == 6) return srgbToLinear(vec3(0.44, 0.48, 0.42));
  return srgbToLinear(vec3(0.72, 0.55, 0.62));
}

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = length(d);
  float art = mod(vArt, 16.0);
  float alpha;
  if (art > 2.5 && art < 3.5) {
    // Nadelbaum: dreieckige Krone
    float tri = 1.0 - abs(d.x) * (1.0 + d.y) * 1.35;
    alpha = step(0.0, tri) * (1.0 - smoothstep(0.55, 1.0, r));
  } else {
    alpha = 1.0 - smoothstep(0.62, 1.0, r);
  }
  if (alpha <= 0.02) discard;
  // Blattwerk: Loecher in der Silhouette
  float holes = fbm(d * 3.1 + vSeed * 17.0);
  float keep = smoothstep(0.30, 0.52, holes + (1.0 - r) * 0.55);
  if (keep < 0.35) discard;

  vec3 color = crownColor() * (0.82 + 0.36 * vSeed);
  // Kugelbeleuchtung: Normale aus der Scheibe
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 fwd = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float z = sqrt(max(0.0, 1.0 - r * r));
  vec3 n = normalize(right * d.x + up * d.y + fwd * z);
  float inner = 0.75 + 0.25 * z;                      // Rand dunkler (Tiefe)
  vec3 shaded = shade(color * inner, n, vWorld, 0.0);
  gl_FragColor = vec4(finish(shaded, vWorld), 1.0);
}
`;

const PROPS_VERT = /* glsl */ `
attribute vec3 color;
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vColor = color;
  vWorld = position;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const WATER_VERT = /* glsl */ `
uniform sampler2D uWater;
uniform vec2 uAreaMin;
uniform vec2 uAreaSize;
varying vec2 vWorldXZ;
varying float vLevel;
varying float vMask;
void main() {
  vec2 p = position.xz;
  vec2 wuv = (p - uAreaMin) / uAreaSize;
  vec4 texel = texture2D(uWater, wuv);
  float level = (texel.r * 255.0 + texel.g * 255.0 * 256.0) - 32768.0;
  level = level / 100.0 + 100.0;              // Zentimeter ueber Origin -> Hoehe NN
  vMask = texel.a;
  vLevel = level;
  vec3 world = vec3(p.x, level, p.y);
  vec2 wxz = p;
  // Wellen: kleine Vertikalverschiebung, wellenlaengig nach Wind
  float wave = sin(p.x * 0.42 + uTime * 1.1) * cos(p.y * 0.37 - uTime * 0.9);
  world.y += wave * 0.025 * step(0.35, texel.a);
  vWorldXZ = wxz;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vLevel = world.y;
}
`;

const WATER_FRAG = /* glsl */ `
varying vec2 vWorldXZ;
varying float vLevel;
varying float vMask;
uniform sampler2D uWater;
void main() {
  if (vMask < 0.45) discard;
  vec2 p = vWorldXZ;
  // Wellen + Glanz
  float w1 = fbm(p * 0.55 + vec2(uTime * 0.06, -uTime * 0.04));
  float w2 = fbm(p * 1.7 - vec2(uTime * 0.11, uTime * 0.07));
  vec3 n = normalize(vec3((w1 - 0.5) * 0.55 + (w2 - 0.5) * 0.35, 1.0,
                          (w2 - 0.5) * 0.5 + (w1 - 0.5) * 0.3));
  vec3 eye = normalize(uEye - vec3(p.x, vLevel, p.y));
  float fres = pow(1.0 - clamp(dot(n, eye), 0.0, 1.0), 2.4);
  vec3 deep = srgbToLinear(vec3(0.10, 0.17, 0.19));
  vec3 shallow = srgbToLinear(vec3(0.22, 0.30, 0.28));
  vec3 body = mix(deep, shallow, 0.35 + 0.3 * fbm(p * 0.2));
  vec3 sky = uSkyColor * 1.35 + uSunColor * 0.25;
  vec3 color = mix(body, sky, clamp(fres * 0.85 + 0.12, 0.0, 0.9));
  // Sonnenglanz
  vec3 h = normalize(uSunDir + eye);
  float spec = pow(max(dot(n, h), 0.0), 220.0);
  color += uSunColor * spec * 2.2 * (1.0 - uNight * 0.6);
  // Lampenspiegelungen bei Nacht
  color += vec3(1.0, 0.72, 0.4) * uNight * 0.05 * (0.5 + 0.5 * w2);
  float edge = smoothstep(0.45, 0.85, vMask);
  gl_FragColor = vec4(finish(color, vec3(p.x, vLevel, p.y)), edge * 0.96);
}
`;

// ---------------------------------------------------------------- Schatten

const DEPTH_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vWorld = position;
  gl_Position = uShadowMatrix * vec4(position, 1.0);
}
`;

const DEPTH_FRAG = /* glsl */ `
varying vec3 vWorld;
void main() {
  gl_FragColor = packDepth(gl_FragCoord.z);
}
`;

const DEPTH_POINT_VERT = /* glsl */ `
attribute float aSize;
attribute float aArt;
varying vec2 vSprite;
varying float vSeed;
void main() {
  vec4 clip = uShadowMatrix * vec4(position, 1.0);
  gl_Position = clip;
  gl_PointSize = clamp(aSize * 2.0 * uPointScale / max(clip.w, 1.0), 2.0, 1400.0);
  vSprite = vec2(aArt, 0.0);
  vSeed = hash12(position.xz * 0.37);
}
`;

const DEPTH_POINT_FRAG = /* glsl */ `
varying vec2 vSprite;
varying float vSeed;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = length(d);
  float art = vSprite.x;
  if (art > 2.5 && art < 3.5) {
    if (r > 0.98) discard;
  } else if (r > 1.0) {
    discard;
  }
  float holes = fbm(d * 3.1 + vSeed * 17.0);
  float keep = smoothstep(0.30, 0.52, holes + (1.0 - r) * 0.55);
  if (keep < 0.35) discard;
  gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- Welt

export function createWorld(data, scene, renderer) {
  const world = {
    scene,
    groups: {},
    chunkMeshes: [],
    treeMeshes: [],
    propMeshes: [],
    materials: {},
    water: null,
    height: data.heightSampler,
    update: null,
    dispose: null,
  };

  const height = data.heightSampler;

  // ------------------------------------------------------------ Gelaende
  const groundTex = new THREE.TextureLoader().load("data/ground.jpg");
  groundTex.wrapS = groundTex.wrapT = THREE.ClampToEdgeWrapping;
  groundTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  groundTex.colorSpace = THREE.NoColorSpace;      // wird im Shader dekodiert

  const terrainMat = createTerrainMaterial();
  terrainMat.uniforms.uGround.value = groundTex;
  world.materials.terrain = terrainMat;

  const terrainGroup = new THREE.Group();
  terrainGroup.name = "gelaende";
  const tiles = 16;
  const tileM = SIZE / tiles;
  const seg = Math.ceil(tileM / 4);
  for (let tz = 0; tz < tiles; tz++) {
    for (let tx = 0; tx < tiles; tx++) {
      const x0 = -HALF + tx * tileM;
      const z0 = -HALF + tz * tileM;
      const geo = new THREE.PlaneGeometry(tileM, tileM, seg, seg);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      const uvs = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const x = x0 + pos.getX(i) + tileM / 2;
        const z = z0 + pos.getZ(i) + tileM / 2;
        pos.setX(i, x);
        pos.setZ(i, z);
        pos.setY(i, height(x, z));
        uvs.setXY(i, (x + HALF) / SIZE, (z + HALF) / SIZE);
      }
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, terrainMat);
      mesh.name = `gelaende-${tx}-${tz}`;
      terrainGroup.add(mesh);
    }
  }
  scene.add(terrainGroup);
  world.groups.terrain = terrainGroup;

  // ------------------------------------------------------------ Wasser
  const waterTex = new THREE.DataTexture(
    new Uint8Array(data.waterTex),
    data.water.grid,
    data.water.grid,
    THREE.RGBAFormat
  );
  waterTex.minFilter = THREE.LinearFilter;
  waterTex.magFilter = THREE.LinearFilter;
  waterTex.needsUpdate = true;

  const waterMat = makeMaterial(WATER_FRAG, {
    vertex: WATER_VERT,
    uniforms: {
      uWater: { value: waterTex },
      uAreaMin: { value: new THREE.Vector2(-HALF, -HALF) },
      uAreaSize: { value: new THREE.Vector2(SIZE, SIZE) },
    },
    transparent: true,
    depthWrite: false,
  });
  const waterGroup = new THREE.Group();
  waterGroup.name = "wasser";
  for (const c of data.water.components) {
    const w = c.x1 - c.x0;
    const h = c.z1 - c.z0;
    if (w < 4 || h < 4) continue;
    const steps = Math.max(2, Math.min(120, Math.round(Math.max(w, h) / 6)));
    const geo = new THREE.PlaneGeometry(w, h, steps, steps);
    geo.rotateX(-Math.PI / 2);
    geo.translate(c.x0 + w / 2, 0, c.z0 + h / 2);
    const mesh = new THREE.Mesh(geo, waterMat);
    mesh.renderOrder = 2;
    waterGroup.add(mesh);
  }
  scene.add(waterGroup);
  world.groups.water = waterGroup;
  world.materials.water = waterMat;
  world.water = waterMat;

  // ------------------------------------------------------------ Gebaeude
  const buildingMat = createBuildingMaterial();
  world.materials.buildings = buildingMat;
  const buildingGroup = new THREE.Group();
  buildingGroup.name = "gebaeude";
  scene.add(buildingGroup);
  world.groups.buildings = buildingGroup;
  world.casterGroups = [buildingGroup];
  world.buildingQueue = data.buildings.index.chunks.map((info) => () => {
    const chunk = decodeBuildingChunk(data.buildings.bin, info);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(chunk.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(chunk.col, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(chunk.pos.length), 3));
    const flags = new Float32Array(chunk.nv);
    const baseId = new Float32Array(chunk.nv * 2);
    for (let i = 0; i < chunk.nv; i++) {
      flags[i] = chunk.flag[i];
      const bid = chunk.bid[i];
      baseId[i * 2] = data.buildings.meta.z0[bid] / 100;   // Sockelhoehe in m ueber NN
      baseId[i * 2 + 1] = bid;
    }
    geo.setAttribute("flag", new THREE.BufferAttribute(flags, 1));
    geo.setAttribute("bid", new THREE.BufferAttribute(chunk.bid, 1));
    geo.setAttribute("baseId", new THREE.BufferAttribute(baseId, 2));
    geo.setIndex(new THREE.BufferAttribute(chunk.idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, buildingMat);
    mesh.name = `gebaeude-${info.i}`;
    mesh.userData = {
      chunk: info.i,
      center: new THREE.Vector3(info.ox + CHUNK_M / 2, 0, info.oz + CHUNK_M / 2),
      radius: CHUNK_M * 0.72,
      nBuildings: chunk.nv,
    };
    buildingGroup.add(mesh);
    world.chunkMeshes.push(mesh);
    return mesh;
  });

  // ------------------------------------------------------------ Baeume
  const treeMat = makeMaterial(TREE_FRAG, { vertex: TREE_VERT });
  world.materials.trees = treeMat;
  const treeGroup = new THREE.Group();
  treeGroup.name = "baeume";
  scene.add(treeGroup);
  world.groups.trees = treeGroup;
  world.casterGroups.push(treeGroup);
  const treeIndex = data.trees.index;
  world.treeQueue = treeIndex.chunks.map((info) => () => {
    const chunk = decodeTreeChunk(data.trees.bin, info, height);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(chunk.pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(chunk.size, 1));
    geo.setAttribute("aArt", new THREE.BufferAttribute(chunk.art, 1));
    geo.setAttribute("aTint", new THREE.BufferAttribute(chunk.tint, 1));
    geo.computeBoundingSphere();
    const points = new THREE.Points(geo, treeMat);
    points.name = `baeume-${info.i}`;
    points.userData = {
      chunk: info.i,
      center: new THREE.Vector3(info.ox + CHUNK_M / 2, 0, info.oz + CHUNK_M / 2),
      radius: CHUNK_M * 0.72,
      count: chunk.n,
    };
    treeGroup.add(points);
    world.treeMeshes.push(points);
    return points;
  });

  // ------------------------------------------------------------ Requisiten
  const propsMat = makeMaterial(
    /* glsl */ `
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 base = srgbToLinear(vColor) * (0.92 + 0.2 * vnoise(vWorld.xz * 1.3));
  vec3 color = shade(base, n, vWorld, 0.03);
  gl_FragColor = vec4(finish(color, vWorld), 1.0);
}
`,
    { vertex: PROPS_VERT }
  );
  world.materials.props = propsMat;
  const propsGroup = new THREE.Group();
  propsGroup.name = "requisiten";
  scene.add(propsGroup);
  world.groups.props = propsGroup;
  world.casterGroups.push(propsGroup);
  if (data.props) {
    for (const [name, info] of Object.entries(data.props.index)) {
      const deck = decodeProps(data.props.bin, info);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(deck.pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(deck.col, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(deck.pos.length), 3));
      geo.setIndex(new THREE.BufferAttribute(deck.idx, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const bs = geo.boundingSphere;
      const mesh = new THREE.Mesh(geo, propsMat);
      mesh.name = `prop-${name}`;
      mesh.userData = {
        center: bs ? bs.center.clone() : new THREE.Vector3(),
        radius: bs ? bs.radius : 3000,
        kind: name,
      };
      propsGroup.add(mesh);
      world.propMeshes.push(mesh);
    }
  }
  world.propsQueued = true;

  // ------------------------------------------------------------ Schatten
  const shadowRT = new THREE.WebGLRenderTarget(2048, 2048, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    generateMipmaps: false,
  });
  U.uShadowMap.value = shadowRT.texture;
  world.shadow = {
    rt: shadowRT,
    light: new THREE.OrthographicCamera(-420, 420, 420, -420, 1, 2600),
    triMat: new THREE.ShaderMaterial({
      uniforms: { uShadowMatrix: U.uShadowMatrix, uPointScale: U.uPointScale, uTime: U.uTime, uWind: U.uWind },
      vertexShader: VERTEX_PRELUDE + DEPTH_VERT,
      fragmentShader: PRELUDE + DEPTH_FRAG,
      side: THREE.DoubleSide,
    }),
    pointMat: new THREE.ShaderMaterial({
      uniforms: {
        uShadowMatrix: U.uShadowMatrix,
        uPointScale: { value: 2.2 },        // Pixel je Meter in der Schattenkarte
        uTime: U.uTime,
        uWind: U.uWind,
      },
      vertexShader: VERTEX_PRELUDE + DEPTH_POINT_VERT,
      fragmentShader: PRELUDE + DEPTH_POINT_FRAG,
      side: THREE.DoubleSide,
    }),
    matrix: new THREE.Matrix4(),
    bias: new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1),
    target: new THREE.Vector3(),
    radius: 420,
  };

  // ------------------------------------------------------------ Sichtbarkeit
  const tmp = new THREE.Vector3();
  world.settings = { viewDistance: 2600, shadowDistance: 850, showTrees: true, showProps: true };

  function visibleDistanceFor(mesh) {
    const d = tmp.copy(mesh.userData.center).distanceTo(world.cameraPosition);
    return d - mesh.userData.radius;
  }

  world.updateVisibility = function (cameraPos) {
    world.cameraPosition = cameraPos;
    const far = world.settings.viewDistance;
    for (const mesh of world.chunkMeshes) {
      mesh.visible = visibleDistanceFor(mesh) < far;
    }
    for (const mesh of world.treeMeshes) {
      mesh.visible = world.settings.showTrees && visibleDistanceFor(mesh) < far * 0.62;
    }
    for (const mesh of world.propMeshes) {
      mesh.visible = world.settings.showProps && visibleDistanceFor(mesh) < far * 0.5;
    }
  };

  world.renderShadow = function (focus, sunDir) {
    const s = world.shadow;
    s.target.copy(focus);
    s.target.y = height(focus.x, focus.z);
    const dist = 900;
    s.light.position.copy(s.target).addScaledVector(sunDir, dist);
    s.light.up.set(0, 1, 0);
    s.light.lookAt(s.target);
    const r = s.radius;
    s.light.left = -r;
    s.light.right = r;
    s.light.top = r;
    s.light.bottom = -r;
    s.light.near = dist - 700;
    s.light.far = dist + 700;
    s.light.updateProjectionMatrix();
    s.light.updateMatrixWorld(true);
    s.matrix.multiplyMatrices(s.bias, s.light.projectionMatrix).multiply(s.light.matrixWorldInverse);
    U.uShadowMatrix.value.copy(s.matrix);
    U.uShadowTexel.value = (2 * r) / 2048;

    // Nur die Werfer zeigen, den Rest der Szene ausblenden
    const groupState = new Map();
    for (const child of scene.children) {
      groupState.set(child, child.visible);
      child.visible = world.casterGroups.includes(child);
    }
    const meshState = [];
    const near = (mesh) => tmp.copy(mesh.userData.center).distanceTo(s.target) < r * 2.2;
    for (const mesh of world.propMeshes) {
      meshState.push([mesh, mesh.visible]);
      mesh.visible = world.settings.showProps && near(mesh);
    }
    for (const mesh of world.chunkMeshes) {
      meshState.push([mesh, mesh.visible]);
      mesh.visible = near(mesh);
    }
    for (const mesh of world.treeMeshes) {
      meshState.push([mesh, mesh.visible]);
      mesh.visible = false;                        // im Dreiecksdurchgang aus
    }

    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(s.rt);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear(true, true, false);

    scene.overrideMaterial = s.triMat;
    renderer.render(scene, s.light);

    for (const [mesh, was] of meshState) {
      mesh.visible = mesh.isPoints && world.settings.showTrees && near(mesh);
    }
    scene.overrideMaterial = s.pointMat;
    renderer.render(scene, s.light);

    scene.overrideMaterial = null;
    for (const [mesh, was] of meshState) mesh.visible = was;
    for (const [child, was] of groupState) child.visible = was;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(null);
  };

  world.setShadowScale = function (radius) {
    world.shadow.radius = radius;
    // Krone in Schattenkartenpixeln: Karte 2048 ueber 2 * radius Meter
    world.shadow.pointMat.uniforms.uPointScale.value = 2048 / (2 * radius);
  };
  world.setShadowScale(world.shadow.radius);

  return world;
}

/** Baut die Meshes nach und nach auf (haelt die Oberflaeche fluessig). */
export async function buildChunks(world, onProgress) {
  const tasks = [...world.buildingQueue];
  const treeTasks = [...world.treeQueue];
  const total = Math.max(1, tasks.length + treeTasks.length);
  let done = 0;
  await new Promise((resolve) => {
    const tick = () => {
      const t0 = performance.now();
      while ((tasks.length || treeTasks.length) && performance.now() - t0 < 14) {
        (tasks.length ? tasks : treeTasks).shift()();
        done++;
      }
      if (onProgress) onProgress(done / total);
      if (tasks.length || treeTasks.length) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}
