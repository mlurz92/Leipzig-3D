-- Overture Maps Buildings für Leipzig herunterladen (DuckDB >= 1.1, keine AWS-Anmeldung nötig)
-- Enthält u. a. facade_color, facade_material, roof_color/material/shape, height, num_floors.
-- Release ggf. aktualisieren: https://docs.overturemaps.org/getting-data/duckdb/
LOAD spatial;
LOAD httpfs;
SET s3_region = 'us-west-2';

COPY (
  SELECT
    id,
    names.primary       AS name,
    subtype,
    class,
    height,
    num_floors,
    facade_color,
    facade_material,
    roof_color,
    roof_material,
    roof_shape,
    roof_height,
    sources,
    geometry
  FROM read_parquet(
    's3://overturemaps-us-west-2/release/2026-09-23.1/theme=buildings/type=building/*',
    filename = true, hive_partitioning = 1)
  WHERE bbox.xmin BETWEEN 12.19 AND 12.55
    AND bbox.ymin BETWEEN 51.21 AND 51.45
) TO 'leipzig_overture_buildings.geojson'
WITH (FORMAT GDAL, DRIVER 'GeoJSON');

-- Danach z. B. in QGIS/GeoPandas per OSM-Record-ID (sources[].record_id) oder
-- räumlichem Join mit den OSM-/LoD2-Gebäuden zusammenführen.
