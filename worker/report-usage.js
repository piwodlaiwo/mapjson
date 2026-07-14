/**
 * Usage report from the mapjson_usage Analytics Engine dataset:
 * per-IP calls, MB pulled, last-used — top talkers first.
 *
 *   CF_ACCOUNT_ID=… CF_ANALYTICS_TOKEN=… node report-usage.js [days] [limit]
 *
 * CF_ACCOUNT_ID    — dash → Workers & Pages (right sidebar)
 * CF_ANALYTICS_TOKEN — API token with "Account Analytics: Read"
 *
 * Numbers are estimates at very high volume (Analytics Engine samples adaptively;
 * SUM(_sample_interval) corrects for it) and exact at normal volume.
 */

const { CF_ACCOUNT_ID, CF_ANALYTICS_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_ANALYTICS_TOKEN) {
  console.error('Set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN (Account Analytics: Read token).');
  process.exit(1);
}

const days = parseInt(process.argv[2], 10) || 7;
const limit = parseInt(process.argv[3], 10) || 50;

async function sql(query) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_ANALYTICS_TOKEN}` },
    body: query,
  });
  if (!r.ok) throw new Error(`WAE SQL ${r.status}: ${await r.text()}`);
  return (await r.json()).data || [];
}

(async () => {
  const rows = await sql(`
    SELECT blob1 AS ip,
           SUM(_sample_interval) AS calls,
           SUM(double2 * _sample_interval) / 1e6 AS mb,
           MAX(timestamp) AS last_used
    FROM mapjson_usage
    WHERE timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY ip
    ORDER BY calls DESC
    LIMIT ${limit}
  `);

  const [total] = await sql(`
    SELECT SUM(_sample_interval) AS calls, SUM(double2 * _sample_interval) / 1e6 AS mb, COUNT(DISTINCT blob1) AS ips
    FROM mapjson_usage
    WHERE timestamp > NOW() - INTERVAL '${days}' DAY
  `);

  console.log(`mapjson usage — last ${days} day(s): ${total?.calls ?? 0} calls, ${(total?.mb ?? 0).toFixed(1)} MB, ${total?.ips ?? 0} unique IPs\n`);
  console.log('ip'.padEnd(40), 'calls'.padStart(9), 'MB'.padStart(10), '  last used');
  for (const r of rows) {
    console.log(String(r.ip).padEnd(40), String(r.calls).padStart(9), Number(r.mb).toFixed(1).padStart(10), ' ', r.last_used);
  }
  if (!rows.length) console.log('(no data yet — points appear within a minute of API traffic)');
})().catch((e) => { console.error(e.message); process.exit(1); });
