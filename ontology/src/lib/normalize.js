// Single source of truth for key normalization — used by the offline index
// builder and the worker's resolver. Both sides MUST normalize identically or
// exact-match lookups silently fail.

// Letters NFKD won't decompose to ASCII.
const FOLD = {
  ß: "ss", ø: "o", đ: "d", þ: "th", æ: "ae", œ: "oe", ł: "l", ð: "d",
};
const FOLD_RE = /[ßøđþæœłð]/g;

export function normalize(raw) {
  let s = String(raw).trim().toLowerCase();
  s = s.replace(FOLD_RE, (c) => FOLD[c]);
  s = s.normalize("NFKD").replace(/\p{M}+/gu, "");
  s = s.replace(/['’`]/g, "");
  s = s.replace(/[^a-z0-9]+/g, " ").trim().replace(/ +/g, " ");
  s = s.replace(/\bst\b/g, "saint");
  // "u s a" → "usa", "d c" → "dc" (dotted initialisms after punctuation collapse)
  s = s.replace(/\b([a-z]) (?=[a-z]\b)/g, "$1");
  return s;
}

// Query-time helper for district keys: "Autauga County" → "autauga".
// The index stores district names without the generic suffix, so the resolver
// tries the stripped form as an additional lookup.
const DISTRICT_SUFFIX_RE =
  / (county|parish|borough|census area|city and borough|municipality|municipio)$/;

export function stripDistrictSuffix(norm) {
  const stripped = norm.replace(DISTRICT_SUFFIX_RE, "");
  return stripped === norm ? null : stripped;
}
