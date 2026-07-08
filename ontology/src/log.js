// D1 writes, always via ctx.waitUntil so they never add latency to responses.
// Failures are swallowed after console.error — logging must never break resolution.

export async function logResolution(db, requestId, results, context) {
  try {
    const stmt = db.prepare(
      "INSERT INTO resolution_log (request_id, raw_key, status, gid, confidence, context) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const ctx = JSON.stringify(context ?? {});
    await db.batch(
      results.map((r) =>
        stmt.bind(requestId, String(r.key), r.status, r.gid ?? null, r.confidence ?? null, ctx)
      )
    );
  } catch (err) {
    console.error("resolution_log write failed:", err.message);
  }
}

export async function logFeedback(db, { key, wrongGid, correctGid, note }) {
  await db
    .prepare("INSERT INTO feedback (raw_key, wrong_gid, correct_gid, note) VALUES (?, ?, ?, ?)")
    .bind(String(key), wrongGid ?? null, correctGid, note ?? null)
    .run();
}
