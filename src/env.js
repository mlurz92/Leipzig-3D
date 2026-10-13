/**
 * Sonnenstand, Himmel und Lichtstimmung.
 *
 * Leipzig liegt bei 51,34 N / 12,37 O (MEZ, ohne Sommerzeit-Verschiebung).
 * Aus Datum und Uhrzeit wird der Sonnenstand gerechnet; daraus ergeben sich
 * Lichtfarbe, Himmel, Nebel und die Nachtstimmung (Fenster- und Laternenlicht).
 */

import * as THREE from "three";
import { U } from "./world.js";

const LAT = 51.34 * (Math.PI / 180);
const LON = 12.37;

/** Sonnenhoehe und -azimut (Grad) fuer ein Datum und eine Uhrzeit (MEZ). */
export function sunAngles(date, hours) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((date.getTime() - start) / 86400000);
  const decl = 23.44 * Math.sin((2 * Math.PI * (day - 81)) / 365.24) * (Math.PI / 180);
  // wahre Ortszeit naeherungsweise: MEZ + Laengenkorrektur
  const solar = hours - 1 + (LON - 15) / 15 + 0;      // MEZ -> UTC + Ortszeit
  const hourAngle = (solar - 12) * 15 * (Math.PI / 180);
  const sinH = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinH)));
  const cosAz = (Math.sin(decl) - Math.sin(elevation) * Math.sin(LAT)) / (Math.cos(elevation) * Math.cos(LAT) + 1e-9);
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz)));        // 0 = Norden
  if (hourAngle > 0) azimuth = 2 * Math.PI - azimuth;
  return { elevation, azimuth };
}

function directionFrom(elevation, azimuth) {
  // x = Osten, y = oben, z = Sueden
  return new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    -Math.cos(elevation) * Math.cos(azimuth)
  ).normalize();
}

const MIX = {
  day: { zenith: [0.36, 0.55, 0.85], horizon: [0.72, 0.82, 0.92], sun: [1.0, 0.97, 0.92], sky: [0.45, 0.55, 0.7], bounce: [0.2, 0.19, 0.17], fog: [0.78, 0.83, 0.88] },
  golden: { zenith: [0.3, 0.44, 0.72], horizon: [1.0, 0.7, 0.42], sun: [1.0, 0.68, 0.36], sky: [0.4, 0.44, 0.6], bounce: [0.22, 0.17, 0.13], fog: [0.88, 0.72, 0.6] },
  dusk: { zenith: [0.1, 0.16, 0.36], horizon: [0.7, 0.38, 0.28], sun: [0.7, 0.3, 0.16], sky: [0.2, 0.23, 0.36], bounce: [0.1, 0.09, 0.1], fog: [0.4, 0.38, 0.42] },
  night: { zenith: [0.012, 0.02, 0.05], horizon: [0.05, 0.08, 0.15], sun: [0.05, 0.07, 0.12], sky: [0.05, 0.07, 0.14], bounce: [0.02, 0.02, 0.03], fog: [0.05, 0.07, 0.13] },
};

function mixColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function palette(elevDeg) {
  if (elevDeg > 12) return { key: "day", night: 0 };
  if (elevDeg > 2) {
    const t = (12 - elevDeg) / 10;
    return { key: "golden", night: 0, blend: [1 - t, t] };
  }
  if (elevDeg > -6) {
    const t = (2 - elevDeg) / 8;
    return { key: "dusk", night: Math.min(0.6, t * 0.6), blend: ["golden", t] };
  }
  return { key: "night", night: 1 };
}

export function createSky(scene) {
  const geo = new THREE.SphereGeometry(9000, 32, 20);
  const uniforms = {
    uZenith: { value: new THREE.Color(0.36, 0.55, 0.85) },
    uHorizon: { value: new THREE.Color(0.72, 0.82, 0.92) },
    uSunColor: { value: new THREE.Color(1, 0.97, 0.92) },
    uSunDir: U.uSunDir,
    uNight: U.uNight,
    uTime: U.uTime,
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uZenith, uHorizon, uSunColor, uSunDir;
      uniform float uNight, uTime;
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      vec3 linearToSrgb(vec3 c) {
        c = max(c, vec3(0.0));
        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
      }
      vec3 tonemap(vec3 x) {
        const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -1.0, 1.0);
        vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.62));
        sky = mix(sky, uHorizon * 0.75, smoothstep(0.0, -0.25, h));
        float sd = max(dot(d, uSunDir), 0.0);
        sky += uSunColor * pow(sd, 1600.0) * 22.0;                 // Sonnenscheibe
        sky += uSunColor * pow(sd, 8.0) * 0.30;                    // Hof
        sky += uSunColor * pow(sd, 2.0) * 0.05;
        if (uNight > 0.05) {
          vec2 sp = vec2(atan(d.z, d.x) * 28.0, d.y * 46.0);
          vec2 cell = floor(sp);
          float star = pow(hash12(cell), 90.0);
          float twinkle = 0.65 + 0.35 * sin(uTime * 2.4 + hash12(cell + 3.7) * 30.0);
          sky += vec3(0.9, 0.94, 1.0) * star * uNight * 2.4 * twinkle * smoothstep(0.0, 0.25, h);
        }
        gl_FragColor = vec4(linearToSrgb(tonemap(sky)), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "himmel";
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  scene.add(mesh);
  return { mesh, uniforms };
}

/** Setzt Sonne, Licht und Himmel fuer eine Uhrzeit (Stunden, MEZ) und ein Datum. */
export function applyTime(sky, date, hours) {
  const { elevation, azimuth } = sunAngles(date, hours);
  const elevDeg = (elevation * 180) / Math.PI;
  const p = palette(elevDeg);
  const sunDir = directionFrom(elevation, azimuth);
  U.uSunDir.value.copy(sunDir);

  const day = MIX.day;
  const golden = MIX.golden;
  const dusk = MIX.dusk;
  const night = MIX.night;

  let col;
  if (elevDeg > 12) col = day;
  else if (elevDeg > 2) {
    const t = (12 - elevDeg) / 10;
    col = {
      zenith: mixColor(day.zenith, golden.zenith, t),
      horizon: mixColor(day.horizon, golden.horizon, t),
      sun: mixColor(day.sun, golden.sun, t),
      sky: mixColor(day.sky, golden.sky, t),
      bounce: mixColor(day.bounce, golden.bounce, t),
      fog: mixColor(day.fog, golden.fog, t),
    };
  } else if (elevDeg > -6) {
    const t = (2 - elevDeg) / 8;
    col = {
      zenith: mixColor(golden.zenith, dusk.zenith, t),
      horizon: mixColor(golden.horizon, dusk.horizon, t),
      sun: mixColor(golden.sun, dusk.sun, t),
      sky: mixColor(golden.sky, dusk.sky, t),
      bounce: mixColor(golden.bounce, dusk.bounce, t),
      fog: mixColor(golden.fog, dusk.fog, t),
    };
  } else {
    col = night;
  }

  const setLin = (target, rgb) => target.setRGB(rgb[0], rgb[1], rgb[2]).convertSRGBToLinear();
  setLin(U.uSunColor.value, col.sun);
  if (elevDeg <= 0) U.uSunColor.value.multiplyScalar(0.0);
  const ambient = elevDeg > 12 ? 0.95 : elevDeg > 0 ? 0.45 + (elevDeg / 12) * 0.5 : 0.14 + Math.max(0, elevDeg + 6) / 6 * 0.16;
  U.uAmbient.value = ambient;
  setLin(U.uSkyColor.value, col.sky);
  U.uSkyColor.value.multiplyScalar(ambient + 0.25);
  setLin(U.uBounceColor.value, col.bounce);
  setLin(U.uFogColor.value, col.fog);
  U.uNight.value = p.night;
  U.uFogDensity.value = 0.00042 + (1 - Math.min(1, Math.max(0, elevDeg / 20))) * 0.00035;

  sky.uniforms.uZenith.value.setRGB(col.zenith[0], col.zenith[1], col.zenith[2]).convertSRGBToLinear();
  sky.uniforms.uHorizon.value.setRGB(col.horizon[0], col.horizon[1], col.horizon[2]).convertSRGBToLinear();
  sky.uniforms.uSunColor.value.setRGB(col.sun[0], col.sun[1], col.sun[2]).convertSRGBToLinear();

  return { elevationDeg: elevDeg, azimuthDeg: (azimuth * 180) / Math.PI, night: p.night, sunDir };
}
