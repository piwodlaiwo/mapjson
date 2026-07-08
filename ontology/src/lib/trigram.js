// Trigram utilities shared by the index builder (inverted index) and the
// resolver (similarity scoring). Same padding convention on both sides.

export function trigrams(norm) {
  const set = new Set();
  const padded = "  " + norm + " ";
  for (let i = 0; i <= padded.length - 3; i++) set.add(padded.slice(i, i + 3));
  return set;
}

// pg_trgm-style similarity: |A ∩ B| / |A ∪ B|
export function similarity(setA, setB) {
  let shared = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const t of small) if (large.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}
