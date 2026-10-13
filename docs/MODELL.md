# Aufbau des Modells (Technik)

Dieses Dokument beschreibt, wie aus den Rohdaten das 3D-Modell wird und wie
der Betrachter es zeichnet.

## 1. Koordinaten und Maßeinheiten

Die Szene rechnet durchgehend in **Metern** und im amtlichen System:

```
x = Easting  - 318000      (nach Osten,   -2000 … +2000)
y = Höhe über NN           (Gelände 100 … 155 m)
z = -(Northing - 5690000)  (nach Süden,  -2000 … +2000)
```

Höhen bleiben absolute NN-Werte (nicht relativ zum Gitter), damit Schatten,
Wasserstände und Steckbriefe ohne Umrechnung zusammenpassen. Die
`camera.near`-Ebene liegt bei 0,6 m, `far` bei 22 km.

## 2. Bake-Schritte (`pipeline/`, Python)

| Schritt | Eingang | Ausgang | Inhalt |
|---|---|---|---|
| `bake_terrain.py` | DGM1 (4 Kacheln), LoD2-Grundrisse | `terrain.bin.gz`, `terrain.json` | Geländeraster 2 m (2000²), Int16 in Zentimetern über 100 m NN; unter Gebäuden auf die LoD2-Basis gezogen, damit Wände bündig stehen |
| `bake_buildings.py` | CityJSON (LoD2) | `buildings.bin.gz`, `buildings.index.json`, `buildings.meta.json.gz` | 250 Kacheln à 250 m; je Kachel Positionen (i16, cm), Farben + Flächenart + Flags (u8×4), Gebäude-ID (u16), Indizes (u16/u32); Zuordnung Wand/Dach/Sockel aus der CityGML-Semantik |
| `bake_ground.py` | Landbedeckung, Beläge, Markierungen, Kanten, Sportflächen, NDVI, SVF | `ground.jpg`, `ground_aux.png` | 4096² Textur (1 m/px): Klassenfarben, Beläge, Mittellinien, Zebrastreifen, Gleise, Kontaktschatten aus SVF; `ground_aux` trägt Wasserdeckung, Belags-ID, Schatten und Waldmaske |
| `bake_trees.py` | Baumkataster, DOM1-Kronenpunkte | `trees.bin.gz`, `trees.index.json` | 53 385 Kronen à 8 Byte; Höhe in 20-cm-, Radius in 10-cm-Schritten, Archetyp, Farbgruppe; DOM-Punkte werden gegen das Kataster entdoppelt |
| `bake_water.py` | Gewässerklassen, DGM1 | `water.bin.gz`, `water.json` | Wasserspiegel: Modus der Geländehöhen über der Wasserfläche, geglättet, in die Umgebung verlängert; R/G = Höhe als uint16, A = Deckung |
| `bake_props.py` | Mauern, Hecken, Brücken, Denkmäler, Maste, Bahnsteige, Treppen, Schotter, Nebengebäude, Stadtmöbel | `props.bin.gz`, `props.json` | zehn Gruppen mit zusammen ~150 000 Dreiecken, f32-Positionen |

`pipeline/bake_all.py` führt alles in der richtigen Reihenfolge aus.

### Binärformate

```
buildings.bin.gz   je Kachel:
  u32 nVerts, u32 nTris, f32 ox, oy, oz, u8 idxBytes, u8[3] reserviert
  i16 pos[nVerts*3]   cm relativ zum Kachelursprung
  u8  col[nVerts*4]   r, g, b, (Flächenart | Flags)
  u16 bid[nVerts]     Gebäudeindex (Verweis in buildings.meta)
  u16|u32 index[nTris*3]

trees.bin.gz       je Kachel: i16 dx, i16 dz, u8 top(20 cm), u8 radius(10 cm),
                   u8 art|16*, u8 farbgruppe            (* = nur aus DOM1)
props.bin.gz       je Gruppe: u32 nVerts, u32 nTris, f32 pos[n*3],
                   u8 col[n*4], u32 index[nTris*3]
```

`buildings.meta.json.gz` enthält je Gebäude: ID, Wand-/Dachcode, Traufhöhe,
Geländehöhe, Grundfläche, Flags (Ladenlokal, Denkmalschutz, Wahrzeichen),
Wahrzeichenzuordnung sowie die Liste der 74 Wahrzeichen mit Name und Lage.

## 3. Betrachter (`src/`, three.js)

* **Gelände** – 256 Kacheln à 250 m, Höhen aus `terrain.bin.gz`, Textur
  `ground.jpg`. Der Fragment-Shader mischt Klassenfarbe, Untergrundrauschen
  und Kontaktschatten.
* **Gebäude** – eine Geometrie je Kachel. Ein eigener Shader zeichnet
  **Fenster je Geschoss** (3,05 m), Sockel, Ladenzeilen im Erdgeschoss und
  bei Nacht beleuchtete Fenster. Die Fensterlage folgt der Wandfläche, damit
  die Rhythmen an Ecken zusammenlaufen.
* **Bäume** – Punktkronen; die Silhouette kommt aus dem Fragment-Shader
  (Blattlöcher, Nadelbaum-Dreieck), die Beleuchtung aus einer aus der
  Scheibe rekonstruierten Kugelnormale. Weht im Wind.
* **Wasser** – je Wasserkörper eine wellige Fläche, deren Höhe aus
  `water.bin.gz` gelesen wird (echter Spiegel, kein Raten). Fresnel,
  Himmelsfarbe und Sonnenglanz, Glitzer bei Nacht.
* **Schatten** – die Szene wirft sich selbst in eine 2048²-Tiefenkarte
  (RGBA-gepackt, PCF 3×3). Der Durchgang wird um die Kameramitte gelegt und
  nur mit Gebäuden, Requisiten und Bäumen gerendert.
* **Licht und Himmel** – Sonnenstand aus Datum und Uhrzeit für 51,34° N
  (Höhe und Azimut), daraus Lichtfarbe, Himmel, Dunst und Nachtstimmung;
  Sterne und Fensterlicht ab Dämmerung.
* **Level of Detail** – Gelände und Gebäude bis zur eingestellten Sichtweite
  (Vorgabe 2,6 km), Bäume bis 62 %, Requisiten bis 50 % davon.
  Der Betrachter arbeitet ohne Kachel-Streaming: alles liegt nach dem Laden
  im Speicher (rund 70 MB), damit es beim Drehen keine Nachladeruckler gibt.

## 4. Tests

```bash
npm test                                     # node pipeline/tests/smoke.mjs
node pipeline/tests/shaders.mjs              # GLSL: Funktionen, Uniforms, varyings
node pipeline/tests/browser-path.mjs         # Ladepfad über HTTP (Server muss laufen)
python3 pipeline/tools/render_check.py out.png sued   # Sichtkontrolle ohne Browser
```

* `smoke.mjs` liest alle gebackenen Dateien, packt sie mit den
  Betrachterfunktionen aus, baut die three.js-Szene in Node auf und prüft
  Kennzahlen (Gebäudezahl, Dreiecke, Höhenbereiche, Wasserstände).
* `shaders.mjs` baut alle acht Materialien auf und sucht in den GLSL-Quellen
  nach aufgerufenen, aber nicht definierten Funktionen, doppelten
  Definitionen und varyings, die in einer Stufe fehlen.
* `browser-path.mjs` holt die Daten wie der Browser (fetch,
  `DecompressionStream`), prüft den Sonnenstand für Sommer- und
  Wintersommersonnenwende und baut die Szene.

## 5. Bekannte Grenzen

* Kein Kachel-Streaming: das Modell ist auf 4 × 4 km ausgelegt. Größere
  Gebiete brauchen Nachladen (der Bake ist bereits gekachelt).
* Der Gelände-Shader nutzt die 1-m-Textur auch dort, wo Geometrie nur 4 m
  Auflösung hat – die Silhouette ist also glatter als das Raster.
* Die Wasserspiegel sind aus dem DGM abgeleitet; bei Wehren oder stark
  bewegtem Wasser kann der Spiegel um einige Zentimeter daneben liegen.
* Brücken, Treppen und Bahnsteige sind vereinfachte Körper (Quader/Prismen),
  keine Bauwerksmodelle.
