#!/bin/bash
# Downloads Natural Earth source shapefiles.
# Data source: https://www.naturalearthdata.com/downloads/
# All files are hosted on S3 at naturalearth.s3.amazonaws.com

set -e

mkdir -p data/110m data/50m data/10m

fetch() {
  local url=$1
  local dest=$2
  local dir=$(dirname "$dest")
  echo "→ $url"
  curl -L -s --retry 3 -o "$dest" "$url"
  unzip -o -q "$dest" -d "$dir"
  rm "$dest"
}

echo "=== Cultural — Countries ==="
fetch "https://naturalearth.s3.amazonaws.com/110m_cultural/ne_110m_admin_0_countries.zip" "data/110m/countries.zip"
fetch "https://naturalearth.s3.amazonaws.com/50m_cultural/ne_50m_admin_0_countries.zip"  "data/50m/countries.zip"
fetch "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_0_countries.zip"  "data/10m/countries.zip"

echo "=== Cultural — Admin-1 subdivisions ==="
fetch "https://naturalearth.s3.amazonaws.com/110m_cultural/ne_110m_admin_1_states_provinces.zip" "data/110m/admin1.zip"
fetch "https://naturalearth.s3.amazonaws.com/50m_cultural/ne_50m_admin_1_states_provinces.zip"   "data/50m/admin1.zip"
fetch "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces.zip"   "data/10m/admin1.zip"

echo "=== Physical — Lakes ==="
fetch "https://naturalearth.s3.amazonaws.com/110m_physical/ne_110m_lakes.zip" "data/110m/lakes.zip"
fetch "https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_lakes.zip"   "data/50m/lakes.zip"
fetch "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_lakes.zip"   "data/10m/lakes.zip"

echo "=== Physical — Rivers ==="
fetch "https://naturalearth.s3.amazonaws.com/110m_physical/ne_110m_rivers_lake_centerlines.zip" "data/110m/rivers.zip"
fetch "https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_rivers_lake_centerlines.zip"   "data/50m/rivers.zip"
fetch "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_rivers_lake_centerlines.zip"   "data/10m/rivers.zip"

echo "=== Physical — Coastlines ==="
fetch "https://naturalearth.s3.amazonaws.com/110m_physical/ne_110m_coastline.zip" "data/110m/coastlines.zip"
fetch "https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_coastline.zip"   "data/50m/coastlines.zip"
fetch "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_coastline.zip"   "data/10m/coastlines.zip"

echo "=== Cultural — Populated places (capitals + cities) ==="
fetch "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_populated_places.zip" "data/10m/populated_places.zip"

echo "Done. Run: npm run process"
