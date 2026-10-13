# Quellenrecherche: realistische Fassaden & Gebäude für Leipzig

Stand der Recherche: im Repo dokumentiert. Bewertungskriterium: Nutzen für
Fassadenfarbe/-material, Dachform/-farbe, Höhe/Geometrie in Leipzig,
Lizenz, und ob die Quelle im Browser live nutzbar ist.

## Tier 1 – amtlich, für Leipzig am wertvollsten

### 1. Stadt Leipzig: 3D-Stadtmodell LoD2 (+ LoD3 im Viewer)
- Open-Data-Datensatz: https://opendata.leipzig.de/dataset/3d-stadtmodell
  (CityGML / Shapefile / DXF, dl-de/by-2.0, CKAN-API live in der App eingebunden)
- Stadt-Seite: https://www.leipzig.de/bauen-und-wohnen/bauen/geodaten-und-karten/3d-stadtmodell
  – ca. 154.000 Gebäudemodelle LoD2 mit generalisierter Dachform, dazu 10 detaillierte,
  texturierte LoD3-Markantbauten; das Gesamtmodell der Stadt enthält Fassaden-/Dachtexturen
  aus 10-cm-Orthofotos, Adresse, Funktion, Dachtyp/-neigung, Höhen.
- **Aber:** Der Open-Data-Download enthält LoD2 **ohne Texturen**. Texturierte LoD3 gibt es
  nur in der städtischen Anwendung. → In der App: Metadaten live, Downloads verlinkt,
  Offline-Pipeline (s. u.) für eigenes Rendering.

### 2. GeoSN Sachsen: LoD1/LoD2, DOM1/DGM1, Laserscan, ALKIS
- 3D-Stadtmodell (2×2-km-Kacheln, CityGML/3D-DXF/3D-Shape, kostenfrei):
  https://www.geodaten.sachsen.de/downloadbereich-digitale-3d-stadtmodelle-4875.html
- Höhenmodelle DOM1/DGM1/Laserscan (1 m, GeoTIFF/LAZ) – daraus lassen sich echte
  First-/Traufhöhen und Dachformen ableiten:
  https://www.geodaten.sachsen.de/downloadbereich-digitale-hoehenmodelle-4851.html
- Liegenschaftskataster/ALKIS inkl. Hausumringe und ALKIS-WFS:
  https://www.geodaten.sachsen.de/liegenschaftskataster-3990.html
- Amtl. Orthofoto DOP (in der App als WMS-Layer eingebunden).

### 3. OpenStreetMap Simple 3D Buildings (bereits Hauptdatenquelle, jetzt tiefer genutzt)
- Schema: https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings –
  `building:colour/material/levels/architecture`, `roof:shape/colour/material/height`,
  `building:part` + `min_height` für Türme/Anbauten/Hallen.
- Die App lädt jetzt auch `building:part`-Objekte als eigene 3D-Ebene und wertet
  Architekturstil, Denkmalschutz (`heritage`), `wikipedia/wikidata/image` aus.
- Renderer-Referenzen zum Schema: F4Map, OSMBuildings (dort dokumentierte Tag-Abbildung).

## Tier 2 – europa-/weltweite Anreicherung (Offline-Merge empfohlen)

### 4. Overture Maps Buildings
- Führt nativ genau die gesuchten Attribute: `facade_color`, `facade_material`,
  `roof_color/material/shape`, `height`, `num_floors`, Quellen-Provenienz je Attribut.
- Zugang als GeoParquet (AWS S3/Azure), z. B. per DuckDB:
  https://docs.overturemaps.org/getting-data/duckdb/ – fertige Leipzig-Abfrage:
  `scripts/overture_leipzig.sql`. Merge-Schlüssel: Quellen-Record-ID = OSM-ID, sonst Geometrie-Match.

### 5. EUBUCCO
- https://eubucco.com/ – harmonisierte Datenbank aus 55 amtlichen Katastern + OSM + Microsoft,
  322 Mio. Gebäude mit Höhe, Geschossen, Nutzungsart/-unterart und Baujahr (15,9 % Abdeckung)
  inkl. Herkunft und Unsicherheit je Attribut. Ideal, um fehlende Baujahre/Höhen in OSM zu füllen
  (GeoParquet, EPSG:3035, Download je Stadt/NUTS).

### 6. Microsoft GlobalML Building Footprints
- https://github.com/microsoft/GlobalMLBuildingFootprints – 1,4 Mrd. Grundrisse,
  Höhen-Schätzungen für 174 Mio. Gebäude (u. a. Westeuropa), inkl. Confidence.
  Nur als Lückenfüller; LiDAR-/amtliche Höhen sind zuverlässiger.

### 7. Copernicus: GHSL & Urban Atlas Gebäudehöhen
- GHSL GHS-BUILT-H (100 m Raster, 2018): https://human-settlement.emergency.copernicus.eu/datasets.php
- Urban Atlas Building Height (10 m, 2012): https://land.copernicus.eu/en/products/urban-atlas
  → Nur zur Plausibilisierung von Höhen, nicht gebäudescharf.

## Tier 3 – echte Fassadenbilder zur Kontrolle

### 8. Wikimedia Commons (in der App eingebunden)
- Freie Fotos je Wahrzeichen/Gebäude (API, `origin=*`), mit Autor/Lizenz im Info-Fenster.
  Ideal, um abgeleitete Fassadenfarben gegen die Realität zu prüfen.

### 9. Mapillary
- https://www.mapillary.com/app/ – Crowd-Straßenfotos (CC BY-SA 4.0), daraus abgeleitete
  Merkmale dürfen nach OSM übernommen werden. API v4 braucht einen eigenen Access-Token,
  daher in der App als Verifikations-Link, nicht als Live-Layer.

### 10. CC0-Texturbibliotheken (nur für texturierte Offline-Renderings)
- ambientCG (2000+ PBR-Materialien, CC0): https://ambientcg.com/
- Poly Haven (Texturen/HDRIs, CC0): https://polyhaven.com/textures
- MapLibre-`fill-extrusion` kann keine Fototexturen auf Wände legen. Wer echte Texturen
  braucht: LoD2-CityGML (Quelle 1/2) → z. B. mit 3DCityDB/citygml-tools nach glTF/OBJ →
  Blender/Cesium mit CC0-Materialien nach Materialklasse belegen.

## Empfohlene Offline-Pipeline (maximale Realität)
1. LoD2-CityGML der Stadt Leipzig oder GeoSN-Kacheln laden (amtliche Dachformen/Höhen).
2. Mit Overture/EUBUCCO-Attributen anreichern (Fassadenfarbe/-material, Baujahr, Geschosse).
3. Höhen mit DOM1 (nDOM = DOM − DGM) kontrollieren.
4. Nach Materialklassen mit CC0-PBR-Texturen belegen; LoD3-Markantbauten der Stadt als Referenz.
5. Ergebnis als 3D Tiles/glTF in Cesium statt MapLibre-Extrusion anzeigen (dann inkl. Texturen).
