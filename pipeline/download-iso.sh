#!/bin/bash
# Downloads high-res per-country TopoJSON from piwodlaiwo/TopoJSON-Data (DIVA-GIS source).
# Used for small countries and territories that Natural Earth 10m represents poorly.
# Files are fetched when filter=ISO2&detail=high — the worker checks per-country files first
# and falls back to the global 10m file if none exists.

set -e

BASE="https://raw.githubusercontent.com/piwodlaiwo/TopoJSON-Data/master/diva-gis"

fetch() {
  local iso3=$1
  local level=$2
  local dest="data/iso/${iso3}/adm${level}.topo.json"
  local url="${BASE}/${iso3}_adm/${iso3}_adm${level}.topo.json"
  mkdir -p "data/iso/${iso3}"
  if curl -L -s --retry 3 -f -o "$dest" "$url" 2>/dev/null; then
    echo "  ✓ ${iso3} adm${level}"
  else
    rm -f "$dest"
    echo "  - ${iso3} adm${level} (not in repo)"
  fi
}

echo "=== Downloading per-country high-res TopoJSON ==="

for ISO3 in \
  VAT MCO SMR LIE AND \
  MLT GIB IMN JEY GGY \
  SGP BHR MDV \
  BRB KNA ATG DMA LCA VCT GRD \
  MTQ GLP ABW MYT REU SPM \
  CYM VGB AIA TCA MSR BMU \
  VIR GUM ASM MNP \
  CPV STP COM SYC \
  NRU TUV PLW MHL FSM KIR TON WSM NIU COK \
  TKL WLF PYF \
  CXR CCK NFK; do
  fetch "$ISO3" 0
  fetch "$ISO3" 1
done

# ANT (Netherlands Antilles) — dissolved in 2010; adm1 islands used for CUW, SXM, BES
echo "=== ANT (source for Curaçao, Sint Maarten, Caribbean Netherlands) ==="
fetch ANT 1

# Morocco and Western Sahara — needed for the global pipeline (all detail levels) as well as
# per-country high-res ISO overrides. Natural Earth combines them incorrectly (de facto vs de jure).
echo "=== MAR + ESH (Morocco / Western Sahara — de jure boundary fix) ==="
fetch MAR 0
fetch MAR 1
fetch ESH 0
fetch ESH 1

echo "Done. Run: npm run process-iso"
