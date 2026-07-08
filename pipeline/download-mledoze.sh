#!/bin/bash
# Downloads the mledoze/countries reference dataset (currencies, languages, idd,
# demonyms, etc.) — public domain, joined onto properties.json by ISO alpha-2 in
# build-properties.js. Used for: npm run build-props

set -e

mkdir -p data/mledoze
curl -L -s --retry 3 -f -o data/mledoze/countries.json \
  "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"

echo "✓ data/mledoze/countries.json"
