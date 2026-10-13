/**
 * Leipzig 3D - Anwendung.
 *
 * Laedt die gebackenen Daten, baut die Szene auf, steuert Kamera, Licht und
 * Bedienoberflaeche (Zeit, Ansicht, Suche, Rundflug, Objektinformation).
 */

import * as THREE from "three";
import { loadWorld, makeHeightSampler, makeWaterSampler, HALF, SIZE } from "./loader.js";
import { createWorld, buildChunks, U } from "./world.js";
import { createSky, applyTime } from "./env.js";
import { decodeDeckChunk } from "./decode.js";

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- Bedienung

class Orbit {
  constructor(camera, dom, height) {
    this.camera = camera;
    this.dom = dom;
    this.height = height;
    this.target = new THREE.Vector3(-820, 128, -900);
    this.lift = 0;                     // Zielhoehe ueber dem Gelaende (m)
    this.want = { yaw: 0.7, pitch: 0.42, dist: 1500 };
    this.now = { yaw: 0.7, pitch: 0.42, dist: 1500 };
    this.keys = new Set();
    this.auto = null;
    this.bind();
  }

  bind() {
    const dom = this.dom;
    let mode = null;
    let last = { x: 0, y: 0 };

    const down = (e) => {
      if (e.button === 0 && !e.shiftKey) mode = "orbit";
      else mode = "pan";
      last = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture?.(e.pointerId);
      dom.style.cursor = "grabbing";
    };
    const move = (e) => {
      if (!mode) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      this.auto = null;
      if (mode === "orbit") {
        this.want.yaw -= dx * 0.0045;
        this.want.pitch = Math.max(-0.05, Math.min(1.45, this.want.pitch + dy * 0.003));
      } else {
        this.pan(dx, dy);
      }
    };
    const up = (e) => {
      mode = null;
      dom.style.cursor = "";
      dom.releasePointerCapture?.(e.pointerId);
    };
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerup", up);
    dom.addEventListener("pointercancel", up);
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    dom.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.auto = null;
        this.want.dist = Math.max(28, Math.min(3200, this.want.dist * Math.exp(e.deltaY * 0.0012)));
      },
      { passive: false }
    );

    // Zwei-Finger-Geste
    let pinch = null;
    dom.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          pinch = {
            d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY),
            mid: [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2],
          };
        }
      },
      { passive: true }
    );
    dom.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && pinch) {
          const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
          const mid = [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2];
          this.want.dist = Math.max(28, Math.min(3200, this.want.dist * (pinch.d / Math.max(d, 1))));
          this.pan(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
          pinch = { d, mid };
        }
      },
      { passive: true }
    );
    dom.addEventListener("touchend", () => {
      pinch = null;
    });

    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (e.code === "Space") {
        e.preventDefault();
        this.nextTourStop?.();
      }
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  pan(dx, dy) {
    const scale = this.want.dist * 0.0016;
    const yaw = this.want.yaw;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(fwd, -dy * scale);
    this.clampTarget();
  }

  clampTarget() {
    this.target.x = Math.max(-HALF - 200, Math.min(HALF + 200, this.target.x));
    this.target.z = Math.max(-HALF - 200, Math.min(HALF + 200, this.target.z));
  }

  focus(point, dist, yaw, pitch) {
    this.want.dist = dist;
    if (yaw !== undefined) this.want.yaw = yaw;
    if (pitch !== undefined) this.want.pitch = pitch;
    const ground = this.height(point.x, point.z);
    this.lift = Math.max(0, Math.min(170, point.y - ground));
    this.target.set(point.x, point.y, point.z);
    this.clampTarget();
  }

  update(dt) {
    const k = 1 - Math.pow(0.0015, dt);
    this.now.yaw += (this.want.yaw - this.now.yaw) * k;
    this.now.pitch += (this.want.pitch - this.now.pitch) * k;
    this.now.dist += (this.want.dist - this.now.dist) * k;

    // Tastatur
    const speed = this.now.dist * dt * 0.55;
    const fwd = new THREE.Vector3(Math.sin(this.now.yaw), 0, Math.cos(this.now.yaw));
    const right = new THREE.Vector3(Math.cos(this.now.yaw), 0, -Math.sin(this.now.yaw));
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) this.target.addScaledVector(fwd, -speed);
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) this.target.addScaledVector(fwd, speed);
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) this.target.addScaledVector(right, -speed);
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) this.target.addScaledVector(right, speed);
    if (this.keys.has("KeyQ")) this.want.yaw += dt * 0.7;
    if (this.keys.has("KeyE")) this.want.yaw -= dt * 0.7;
    if (this.keys.has("KeyR")) this.want.dist = Math.max(28, this.want.dist * (1 - dt));
    if (this.keys.has("KeyF")) this.want.dist = Math.min(3200, this.want.dist * (1 + dt));
    this.clampTarget();

    // Ziel folgt dem Gelaende, behaelt aber die einmal gewaehlte Hoehe
    const ground = this.height(this.target.x, this.target.z) + this.lift;
    this.target.y += (ground - this.target.y) * Math.min(1, dt * 2.5);

    const cp = Math.cos(this.now.pitch);
    const pos = new THREE.Vector3(
      this.target.x + Math.sin(this.now.yaw) * cp * this.now.dist,
      this.target.y + Math.sin(this.now.pitch) * this.now.dist,
      this.target.z + Math.cos(this.now.yaw) * cp * this.now.dist
    );
    const minY = this.height(pos.x, pos.z) + 2.0;
    if (pos.y < minY) pos.y = minY;
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }
}

// ---------------------------------------------------------------- Anwendung

const state = {
  time: 11.0,
  date: new Date(),
  picked: null,
  tour: null,
  fps: 0,
};

async function main() {
  const canvas = $("#scene");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (err) {
    throw new Error(
      "WebGL ist nicht verfügbar. Bitte Hardware-Beschleunigung im Browser aktivieren " +
        `oder einen aktuellen Browser verwenden. (${err.message})`
    );
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.NoToneMapping;      // Tonemapping macht der Shader
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = gl.getProgramInfoLog(program) || "";
    const source = (gl.getShaderSource?.(fs) || "").split("\n").slice(0, 60).join("\n");
    const el = $("#shader-error");
    if (el) {
      el.hidden = false;
      el.querySelector("pre").textContent = `${log}\n\n${source}`;
    }
    console.error("Shader-Fehler:", log);
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.6, 22000);

  const loading = $("#loading");
  const bar = $("#loading-bar");
  const label = $("#loading-label");
  const setProgress = (text, p) => {
    if (label) label.textContent = text;
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  };

  setProgress("Daten werden geladen ...", 0.02);
  const data = await loadWorld((step, done, total) => {
    setProgress(`${step} ...`, 0.03 + 0.72 * (done / total));
  });
  data.heightSampler = makeHeightSampler(data.terrain);
  data.waterSampler = makeWaterSampler(data.water);
  if (typeof data.water.tex === "undefined") {
    data.water.tex = new Uint8Array(4);
  }

  setProgress("Szene wird aufgebaut ...", 0.78);
  const world = createWorld(data, scene, renderer);
  const sky = createSky(scene);

  setProgress("Gebaeude und Baeume ...", 0.82);
  await buildChunks(world, (p) => setProgress("Gebaeude und Baeume ...", 0.82 + 0.16 * p));

  const controls = new Orbit(camera, canvas, data.heightSampler);
  applyTime(sky, state.date, state.time);

  // ------------------------------------------------------------- Beleuchtung
  const sunDir = new THREE.Vector3();
  function updateLight() {
    const info = applyTime(sky, state.date, state.time);
    sunDir.copy(info.sunDir);
    U.uShadowStrength.value = info.night > 0.5 ? 0.25 : 0.62;
    world.setShadowScale(info.elevationDeg < 12 ? 700 : 460);
    const clock = $("#clock");
    if (clock) {
      const h = Math.floor(state.time);
      const m = Math.floor((state.time - h) * 60);
      clock.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  updateLight();

  // ------------------------------------------------------------- Auswahl
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const highlight = new THREE.Group();
  scene.add(highlight);
  const highlightMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.5, depthTest: true });

  function clearHighlight() {
    for (const child of [...highlight.children]) {
      child.geometry.dispose();
      highlight.remove(child);
    }
  }

  function pickAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const meshes = world.chunkMeshes.filter((m) => m.visible);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const geo = hit.object.geometry;
    const bid = geo.attributes.bid.getX(hit.face.a);
    return { bid, point: hit.point, mesh: hit.object, face: hit.face };
  }

  function showBuilding(bid, hit) {
    const meta = data.buildings.meta;
    const id = meta.ids[bid];
    const fn = meta.fn[bid];
    const h = meta.h[bid] / 100;
    const area = meta.a[bid];
    const flags = meta.f[bid];
    const lm = meta.lm[bid];
    const levels = Math.max(1, Math.round((h - 1.0) / 3.05));
    const kind = fn === 31001 ? "Wohngebäude" : fn >= 50000 ? "Gewerbe-, Handels- oder Sonderbau" : "Gebäude";
    const heritage = (flags & 8) > 0;
    const shop = (flags & 4) > 0;
    const name = meta.names && meta.names[bid];
    const landmark = lm >= 0 ? meta.lmNames[lm] : null;

    $("#info").hidden = false;
    $("#info-title").textContent = name || landmark || kind;
    $("#info-body").innerHTML = `
      <dl>
        ${landmark ? `<dt>Wahrzeichen</dt><dd>${landmark}</dd>` : ""}
        <dt>Nutzung</dt><dd>${kind} <span class="muted">(Code ${fn})</span></dd>
        <dt>Traufhöhe</dt><dd>${h.toFixed(1)} m · ca. ${levels} Geschosse</dd>
        <dt>Gelände</dt><dd>${(meta.z0[bid] / 100).toFixed(1)} m über NN</dd>
        <dt>Grundfläche</dt><dd>${area.toLocaleString("de-DE")} m²</dd>
        ${heritage ? `<dt>Denkmalschutz</dt><dd>ausgewiesen (OSM)</dd>` : ""}
        ${shop ? `<dt>Erdgeschoss</dt><dd>Ladenlokal (OSM)</dd>` : ""}
        <dt>Datenquelle</dt><dd class="muted">LoD2-Sachsen (GeoSN), Objekt ${id}</dd>
      </dl>`;

    // Hervorhebung: die Dreiecke des Gebaeudes heraussuchen
    clearHighlight();
    const geo = hit.mesh.geometry;
    const attrs = geo.attributes;
    const idx = geo.index.array;
    const pos = attrs.position.array;
    const picked = [];
    for (let t = 0; t < idx.length; t += 3) {
      let match = false;
      for (let k = 0; k < 3; k++) {
        if (attrs.bid.getX(idx[t + k]) === bid) match = true;
      }
      if (match) picked.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    if (picked.length) {
      const g = new THREE.BufferGeometry();
      const verts = new Float32Array(picked.length * 3);
      for (let i = 0; i < picked.length; i++) {
        verts[i * 3] = pos[picked[i] * 3];
        verts[i * 3 + 1] = pos[picked[i] * 3 + 1];
        verts[i * 3 + 2] = pos[picked[i] * 3 + 2];
      }
      g.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, highlightMat);
      highlight.add(mesh);
    }
    state.picked = { bid, height };
  }

  canvas.addEventListener("click", (e) => {
    if (e.detail === 0) return;
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) showBuilding(hit.bid, hit);
  });

  // ------------------------------------------------------------- Minimap
  const minimap = $("#minimap");
  const mctx = minimap.getContext("2d");
  const base = new Image();
  base.src = "data/ground.jpg";
  let baseReady = false;
  base.onload = () => {
    baseReady = true;
  };

  function drawMinimap() {
    const size = minimap.width;
    mctx.clearRect(0, 0, size, size);
    if (baseReady) mctx.drawImage(base, 0, 0, size, size);
    else {
      mctx.fillStyle = "#2b3038";
      mctx.fillRect(0, 0, size, size);
    }
    const toPx = (x, z) => [((x + HALF) / SIZE) * size, ((z + HALF) / SIZE) * size];
    // Umriss
    mctx.strokeStyle = "rgba(255,255,255,0.7)";
    mctx.lineWidth = 2;
    mctx.strokeRect(1, 1, size - 2, size - 2);
    // Zielpunkt und Blickrichtung
    const [tx, ty] = toPx(controls.target.x, controls.target.z);
    const yaw = controls.now.yaw;
    const len = 26;
    mctx.strokeStyle = "rgba(255,210,120,0.95)";
    mctx.lineWidth = 2.5;
    mctx.beginPath();
    mctx.moveTo(tx, ty);
    mctx.lineTo(tx - Math.sin(yaw) * len, ty - Math.cos(yaw) * len);
    mctx.stroke();
    mctx.fillStyle = "#ffd278";
    mctx.beginPath();
    mctx.arc(tx, ty, 4, 0, Math.PI * 2);
    mctx.fill();
    // Sichtfeld
    mctx.strokeStyle = "rgba(255,255,255,0.35)";
    mctx.lineWidth = 1.5;
    mctx.beginPath();
    const spread = 0.55;
    mctx.moveTo(tx, ty);
    mctx.lineTo(tx - Math.sin(yaw - spread) * 40, ty - Math.cos(yaw - spread) * 40);
    mctx.moveTo(tx, ty);
    mctx.lineTo(tx - Math.sin(yaw + spread) * 40, ty - Math.cos(yaw + spread) * 40);
    mctx.stroke();
  }

  minimap.addEventListener("click", (e) => {
    const rect = minimap.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * SIZE - HALF;
    const z = ((e.clientY - rect.top) / rect.height) * SIZE - HALF;
    controls.focus({ x, y: data.heightSampler(x, z), z }, Math.min(controls.want.dist, 900));
  });

  // ------------------------------------------------------------- Rundflug
  const stopQueries = [
    "Altes Rathaus",
    "Thomaskirche",
    "Nikolaischule",
    "Hauptbahnhof",
    "Gewandhaus",
    "City-Hochhaus",
    "Neues Rathaus",
    "Peterskirche",
    "Moritzbastei",
    "Reichsgerichtsgebäude",
  ];
  const stops = [];
  for (const q of stopQueries) {
    const needle = q.toLowerCase();
    const lm = (data.landmarks || [])
      .filter((l) => l.name.toLowerCase().includes(needle))
      .sort((a, b) => (b.links || 0) - (a.links || 0))[0];
    if (lm && stops.length < 8) stops.push(lm);
  }
  const tour = { active: false, index: 0, t: 0, from: null, to: null };

  function startTour() {
    if (!stops.length) return;
    tour.active = true;
    tour.index = -1;
    tour.next();
  }

  function tourPose(stop, i) {
    if (i < 0) {
      return {
        target: new THREE.Vector3(0, 130, 0),
        yaw: 0.8,
        pitch: 0.5,
        dist: 2500,
        text: "Überblick über die Leipziger Innenstadt",
      };
    }
    const h = stop.h || 25;
    return {
      target: new THREE.Vector3(stop.x, h + 12, stop.z),
      yaw: 0.5 + (i % 3) * 0.7,
      pitch: 0.28,
      dist: Math.max(150, h * 6),
      text: stop.name,
    };
  }

  tour.next = () => {
    tour.index += 1;
    if (tour.index >= stops.length + 1) tour.index = 0;
    const pose = tourPose(stops[tour.index - 1], tour.index - 1);
    tour.from = { target: controls.target.clone(), yaw: controls.now.yaw, pitch: controls.now.pitch, dist: controls.now.dist };
    tour.to = pose;
    tour.t = 0;
    // Zielhoehe ueber dem Gelaende fuer die Bodenverfolgung uebernehmen
    controls.lift = Math.max(
      0,
      Math.min(170, pose.target.y - data.heightSampler(pose.target.x, pose.target.z))
    );
    const caption = $("#tour-caption");
    if (caption) {
      caption.textContent = pose.text;
      caption.classList.add("visible");
      clearTimeout(caption._timer);
      caption._timer = setTimeout(() => caption.classList.remove("visible"), 5200);
    }
  };
  controls.nextTourStop = () => {
    if (tour.active) tour.next();
  };

  // ------------------------------------------------------------- Bedienfelder
  const timeSlider = $("#time");
  timeSlider.value = String(state.time);
  timeSlider.addEventListener("input", () => {
    state.time = Number(timeSlider.value);
    updateLight();
  });
  for (const btn of document.querySelectorAll("[data-time]")) {
    btn.addEventListener("click", () => {
      state.time = Number(btn.dataset.time);
      timeSlider.value = String(state.time);
      updateLight();
    });
  }
  $("#toggle-trees").addEventListener("change", (e) => {
    world.settings.showTrees = e.target.checked;
  });
  $("#toggle-props").addEventListener("change", (e) => {
    world.settings.showProps = e.target.checked;
  });
  $("#toggle-shadows").addEventListener("change", (e) => {
    world.settings.shadows = e.target.checked;
  });
  $("#view-distance").addEventListener("input", (e) => {
    world.settings.viewDistance = Number(e.target.value);
    $("#view-distance-value").textContent = `${(world.settings.viewDistance / 1000).toFixed(1)} km`;
  });
  $("#tour-start").addEventListener("click", startTour);
  $("#tour-stop").addEventListener("click", () => {
    tour.active = false;
    $("#tour-caption")?.classList.remove("visible");
  });

  const search = $("#search");
  const results = $("#results");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    results.innerHTML = "";
    if (q.length < 2) return;
    const hits = (data.landmarks || []).filter((l) => l.name.toLowerCase().includes(q)).slice(0, 8);
    for (const l of hits) {
      const li = document.createElement("li");
      li.innerHTML = `<button><strong>${l.name}</strong><span>${l.h ? `${l.h.toFixed(0)} m` : ""}</span></button>`;
      li.querySelector("button").addEventListener("click", () => {
        controls.focus(new THREE.Vector3(l.x, (l.h || 25) + 10, l.z), Math.max(180, (l.h || 25) * 6), 0.6, 0.3);
      });
      results.appendChild(li);
    }
  });

  $("#info-close").addEventListener("click", () => {
    $("#info").hidden = true;
    clearHighlight();
    state.picked = null;
  });

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  // ------------------------------------------------------------- Schleife
  const clock = new THREE.Clock();
  let acc = 0;
  let frames = 0;
  let lastShadow = 0;

  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, clock.getDelta());
    const t = clock.elapsedTime;
    U.uTime.value = t;
    U.uEye.value.copy(camera.position);
    U.uPointScale.value = (innerHeight / (2 * Math.tan(((camera.fov / 2) * Math.PI) / 180))) * Math.min(devicePixelRatio || 1, 2) * 0.5;

    if (tour.active) {
      tour.t += dt / 5.5;
      const k = Math.min(1, tour.t);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const a = tour.from;
      const b = tour.to;
      controls.target.lerpVectors(a.target, b.target, e);
      controls.want.yaw = a.yaw + (b.yaw - a.yaw) * e;
      controls.want.pitch = a.pitch + (b.pitch - a.pitch) * e;
      controls.want.dist = a.dist + (b.dist - a.dist) * e;
      if (k >= 1 && !tour.pending) {
        tour.pending = true;
        setTimeout(() => {
          tour.pending = false;
          if (tour.active) tour.next();
        }, 1400);
      }
    }

    controls.update(dt);
    world.updateVisibility(camera.position);

    if (world.settings.shadows !== false && t - lastShadow > 0.0) {
      const focus = camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 260);
      focus.y = controls.target.y;
      world.renderShadow(focus, sunDir);
      lastShadow = t;
    } else {
      U.uShadowStrength.value = 0;
    }

    sky.mesh.position.copy(camera.position);
    renderer.render(scene, camera);

    frames++;
    acc += dt;
    if (acc > 0.5) {
      state.fps = frames / acc;
      frames = 0;
      acc = 0;
      const fps = $("#fps");
      if (fps) fps.textContent = `${state.fps.toFixed(0)} fps`;
    }
    drawMinimap();
  }

  // Startpose: Blick von Suedwesten ueber die Innenstadt
  const startTarget = { x: -700, z: -800 };
  controls.focus(
    new THREE.Vector3(startTarget.x, data.heightSampler(startTarget.x, startTarget.z) + 40, startTarget.z),
    1500,
    0.72,
    0.40
  );
  controls.now.yaw = controls.want.yaw;
  controls.now.pitch = controls.want.pitch;
  controls.now.dist = 2400;

  loading.classList.add("done");
  frame();
}

main().catch((err) => {
  console.error(err);
  const el = $("#loading");
  if (el) {
    el.innerHTML = `<div class="loading-card"><h2>Das Modell konnte nicht geladen werden</h2><p>${err.message}</p></div>`;
  }
});
