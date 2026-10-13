/**
 * Reine Auspackfunktionen fuer die gebackenen Kacheln (ohne three.js,
 * damit sie sich in Node testen lassen).
 */

/** Gebaeudekachel: Positionen (Weltkoordinaten), Farben, Indizes, Gebaeude-IDs. */
export function decodeBuildingChunk(bin, info) {
  const dv = new DataView(bin, info.off, info.len);
  const nv = dv.getUint32(0, true);
  const nt = dv.getUint32(4, true);
  const ox = dv.getFloat32(8, true);
  const oy = dv.getFloat32(12, true);
  const oz = dv.getFloat32(16, true);
  const ib = dv.getUint8(20);
  let at = 24;

  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    pos[i * 3] = ox + dv.getInt16(at, true) / 100;
    pos[i * 3 + 1] = oy + dv.getInt16(at + 2, true) / 100;
    pos[i * 3 + 2] = oz + dv.getInt16(at + 4, true) / 100;
    at += 6;
  }
  const col = new Float32Array(nv * 3);
  const flag = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    col[i * 3] = dv.getUint8(at) / 255;
    col[i * 3 + 1] = dv.getUint8(at + 1) / 255;
    col[i * 3 + 2] = dv.getUint8(at + 2) / 255;
    flag[i] = dv.getUint8(at + 3);
    at += 4;
  }
  const bid = new Uint16Array(nv);
  for (let i = 0; i < nv; i++) {
    bid[i] = dv.getUint16(at, true);
    at += 2;
  }
  let idx;
  if (ib === 2) {
    idx = new Uint16Array(nt * 3);
    for (let i = 0; i < nt * 3; i++) {
      idx[i] = dv.getUint16(at, true);
      at += 2;
    }
  } else {
    idx = new Uint32Array(nt * 3);
    for (let i = 0; i < nt * 3; i++) {
      idx[i] = dv.getUint32(at, true);
      at += 4;
    }
  }
  return { pos, col, flag, bid, idx, nv, nt };
}

/** Baumkachel: Kronenmittelpunkte, Groessen, Archetyp, Farbgruppe. */
export function decodeTreeChunk(bin, info, sampleHeight) {
  const dv = new DataView(bin, info.off, info.len);
  const n = info.n;
  const out = {
    pos: new Float32Array(n * 3),
    size: new Float32Array(n),      // Kronenradius (m)
    art: new Float32Array(n),       // Archetyp (+16 fuer reine Oberflaechenkrone)
    tint: new Float32Array(n),
    n,
  };
  let at = 0;
  for (let i = 0; i < n; i++) {
    const dx = dv.getInt16(at, true) / 100;
    const dz = dv.getInt16(at + 2, true) / 100;
    const top = dv.getUint8(at + 4) * 0.2;
    const radius = dv.getUint8(at + 5) * 0.1;
    const art = dv.getUint8(at + 6);
    const color = dv.getUint8(at + 7);
    at += 8;
    const x = info.ox + dx;
    const z = info.oz + dz;
    const ground = sampleHeight(x, z);
    out.pos[i * 3] = x;
    out.pos[i * 3 + 1] = ground + top * 0.68;
    out.pos[i * 3 + 2] = z;
    out.size[i] = radius;
    out.art[i] = art;
    out.tint[i] = color;
  }
  return out;
}

/** Requisiten-Gruppe: f32-Positionen, Farben, u32-Indizes. */
export function decodeProps(bin, info) {
  const dv = new DataView(bin, info.off, info.len);
  const nv = dv.getUint32(0, true);
  const nt = dv.getUint32(4, true);
  let at = 8;
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) {
    pos[i] = dv.getFloat32(at, true);
    at += 4;
  }
  const col = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    col[i * 3] = dv.getUint8(at) / 255;
    col[i * 3 + 1] = dv.getUint8(at + 1) / 255;
    col[i * 3 + 2] = dv.getUint8(at + 2) / 255;
    at += 4;
  }
  const idx = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) {
    idx[i] = dv.getUint32(at, true);
    at += 4;
  }
  return { pos, col, idx, nv, nt };
}

/** Requisiten-Instanzen: 8 Byte Kopf je Kachel, dann 7 Float32 je Instanz. */
export function decodePropChunk(bin, info) {
  const dv = new DataView(bin, info.off, info.len);
  const n = dv.getUint32(0, true);
  const ox = dv.getFloat32(4, true);
  const oz = dv.getFloat32(8, true);
  let at = 12;
  const out = {
    n,
    kind: new Float32Array(n),
    pos: new Float32Array(n * 3),
    scale: new Float32Array(n * 3),
    yaw: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    out.kind[i] = dv.getUint8(at);
    out.pos[i * 3] = ox + dv.getInt16(at + 1, true) / 100;
    out.pos[i * 3 + 1] = dv.getFloat32(at + 3, true);       // absolute Hoehe
    out.pos[i * 3 + 2] = oz + dv.getInt16(at + 7, true) / 100;
    out.yaw[i] = dv.getUint8(at + 9) * (Math.PI * 2 / 255);
    out.scale[i * 3] = dv.getUint16(at + 10, true) / 100;
    out.scale[i * 3 + 1] = dv.getUint16(at + 12, true) / 100;
    out.scale[i * 3 + 2] = dv.getUint16(at + 14, true) / 100;
    at += 16;
  }
  return out;
}
