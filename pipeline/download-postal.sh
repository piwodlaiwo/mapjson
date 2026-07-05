#!/usr/bin/env bash
# Downloads US ZCTA (ZIP Code Tabulation Area) source data from the Census Bureau.
# Public domain (US government work) — no license, no attribution required.
#
#   cb_2020_us_zcta520_500k     — cartographic boundary polygons, 1:500k generalized
#   tab20_zcta520_county20_natl — ZCTA↔county relationship file, used to assign each
#                                 ZCTA to a parent state by largest land-area overlap
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/data/postal"
mkdir -p "$DIR"

CB_URL="https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip"
REL_URL="https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt"

if [ ! -f "$DIR/cb_2020_us_zcta520_500k.shp" ]; then
  echo "Downloading ZCTA cartographic boundaries (64 MB)..."
  curl -fSL "$CB_URL" -o "$DIR/zcta.zip"
  unzip -o "$DIR/zcta.zip" -d "$DIR"
  rm "$DIR/zcta.zip"
else
  echo "ZCTA shapefile already present — skipping"
fi

if [ ! -f "$DIR/tab20_zcta520_county20_natl.txt" ]; then
  echo "Downloading ZCTA-to-county relationship file (7 MB)..."
  curl -fSL "$REL_URL" -o "$DIR/tab20_zcta520_county20_natl.txt"
else
  echo "Relationship file already present — skipping"
fi

echo "Done. Next: npm run process-postal"
