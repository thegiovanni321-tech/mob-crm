// Call activity counts for the header badge and /calls chart.
// Every logged call counts, whatever page it was saved from. Days are America/New_York.
const { AsyncLocalStorage } = require('async_hooks');
const store = new AsyncLocalStorage();

const TZ = 'America/New_York';
// kind = 'call' is the only logged-call row. The property log form (every list context)
// posts that kind; Left voicemail, Texted, and the other outcomes are stored on it.
// The day that counts is activity_date. An untouched form date is corrected to
// today in the browser before submit, so a tab left open overnight is not filed yesterday.
// Notes do not. Imported Talked rows are past conversations and count on their activity date.
// Imported Called rows are spreadsheet last-contacted dates, not logged calls.
// A call logged once for an owner who has several properties is stored on each property,
// and the copies point at the original. Only the original counts.
const CALL_WHERE = `(
  parent_activity_id IS NULL
  AND (
    kind = 'call'
    OR (kind = 'import' AND outcome = 'Talked')
  )
)`;
const CALL_DAY = `COALESCE(activity_date, (created_at AT TIME ZONE '${TZ}')::date)`;

function run(ctx, fn) { return store.run(ctx || {}, fn); }
function get() { return store.getStore() || {}; }

async function todayCount(db) {
  const [{ n }] = await db.query(
    `SELECT count(*)::int n FROM activities WHERE ${CALL_WHERE} AND ${CALL_DAY} = (now() AT TIME ZONE '${TZ}')::date`,
  );
  return n;
}

async function dailyCounts(db, days) {
  const n = Math.max(1, Math.min(366, parseInt(days, 10) || 90));
  const rows = await db.query(
    `WITH bounds AS (
       SELECT ((now() AT TIME ZONE '${TZ}')::date - ($1::int - 1)) AS start_d,
              (now() AT TIME ZONE '${TZ}')::date AS end_d
     ),
     days AS (
       SELECT generate_series(bounds.start_d, bounds.end_d, interval '1 day')::date AS d FROM bounds
     ),
     counts AS (
       SELECT ${CALL_DAY} AS d, count(*)::int AS n
       FROM activities, bounds
       WHERE ${CALL_WHERE}
         AND ${CALL_DAY} BETWEEN bounds.start_d AND bounds.end_d
       GROUP BY 1
     )
     SELECT days.d::text AS d, COALESCE(counts.n, 0)::int AS n
     FROM days LEFT JOIN counts ON counts.d = days.d
     ORDER BY days.d`,
    [n],
  );
  return rows;
}

function label(n) {
  const c = Number(n) || 0;
  return c === 1 ? '1 call today' : `${c} calls today`;
}


function svgChart(rows) {
  const W = 900, H = 280, padL = 36, padR = 12, padT = 16, padB = 40;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const barW = Math.max(2, innerW / Math.max(rows.length, 1) - 1);
  const bars = rows.map((r, i) => {
    const x = padL + (i + 0.1) * (innerW / rows.length);
    const h = (r.n / max) * innerH;
    const y = padT + innerH - h;
    const title = `${r.d}: ${r.n} call${r.n === 1 ? '' : 's'}`;
    const cls = r.n === 0 ? 'bar zero' : 'bar';
    return `<rect class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(h, r.n ? 1 : 0).toFixed(2)}" data-n="${r.n}"><title>${title}</title></rect>`;
  }).join('');
  // x labels: first, last, and ~monthly ticks
  const labelIdx = new Set([0, rows.length - 1]);
  const step = Math.max(1, Math.floor(rows.length / 6));
  for (let i = 0; i < rows.length; i += step) labelIdx.add(i);
  const xLabels = [...labelIdx].sort((a, b) => a - b).map((i) => {
    const r = rows[i]; if (!r) return '';
    const x = padL + (i + 0.5) * (innerW / rows.length);
    const [, m, d] = String(r.d).split('-');
    return `<text x="${x.toFixed(1)}" y="${H - 12}" text-anchor="middle" class="axis">${m}/${d}</text>`;
  }).join('');
  const yTicks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const yLabels = yTicks.map((v) => {
    const y = padT + innerH - (v / max) * innerH;
    return `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" class="axis">${v}</text>
      <line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="grid"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calls per day">
    <style>
      .bar{fill:#0f3d5e}.bar.zero{fill:#d7e0ea}.axis{fill:#5b6b7c;font:11px system-ui,sans-serif}.grid{stroke:#eef2f6;stroke-width:1}
    </style>
    ${yLabels}${bars}${xLabels}
  </svg>`;
}

module.exports = { TZ, CALL_WHERE, CALL_DAY, run, get, todayCount, dailyCounts, label, svgChart };

