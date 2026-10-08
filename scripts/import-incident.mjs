// Builds srv/traffic/data/incident.json, the traffic replay's data: simulated drive times modelled on the jam the
// airport-traffic spike measured with Google Routes on 2026-10-06, and that spike's real Autobahn reports and map.
// Google's terms forbid republishing Routes results, so no measured drive time goes in; only the Autobahn data is read.
//   node scripts/import-incident.mjs <results dir>      reads replay-jams.csv and fra_jam_geo.csv
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = process.argv[2]
if (!dir) { console.error('Usage: node scripts/import-incident.mjs <results dir>'); process.exit(2) }
const ROADS = { wiesbaden: ['A66', 'A3'], badhomburg: ['A5'], offenbach: ['A3'], darmstadt: ['A5', 'A67'] }

// The spike's CSVs come from Python's csv module: commas, and quotes doubled inside quoted fields (geometry is JSON).
function csv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false; else field += c }
    else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const [head, ...body] = rows
  return body.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, k) => [h, r[k]])))
}
const read = file => csv(readFileSync(join(dir, file), 'utf8'))
const berlin = (ts, options) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', ...options }).format(new Date(ts))
// The app words a report as "<road> <location> → <direction>"; the Autobahn text is "A5 | <from> - <to>" and "<from> -> <to>".
const report = r => ({ ts: r.ts_utc, road: r.road, location: r.where?.replace(/^\S+ \| /, ''), direction: r.direction?.split('->').at(-1).trim(), delayMin: r.delay_min ? Number(r.delay_min) : null, trafficType: r.type || null, id: r.id })
const geoOf = id => {
  if (!id || !existsSync(join(dir, 'fra_jam_geo.csv'))) return null
  const g = read('fra_jam_geo.csv').find(x => x.id === id)
  return g ? { lat: Number(g.lat), lon: Number(g.long), geometry: JSON.parse(g.geometry) } : null
}
const strongest = (reports, roads) => reports.filter(r => roads.includes(r.road)).sort((a, b) => (b.delayMin ?? 0) - (a.delayMin ?? 0))[0]

// Minutes over typical, one sample every 10 min from 15:10 CEST. Bad Homburg jams from 16:10; the rule (6 min, 2 runs)
// fires at 16:20, the run of the first Autobahn report. The other approaches stay within ±3 min.
const APPROACH = 'badhomburg', FIRE = 7, STEP_MS = 600000
const SHAPE = {
  wiesbaden: { typical: 30, over: [0, 1, 1, 2, 2, 3, 2, 2, 1, 2, 3, 2, 1, 1, 0, 0] },
  badhomburg: { typical: 30, over: [0, 1, 0, 1, 0, 1, 7, 8, 9, 10, 5, 4, 3, 2, 1, 1] },
  offenbach: { typical: 15, over: [0, 0, 1, 1, 2, 2, 3, 2, 2, 1, 1, 2, 1, 0, 0, -1] },
  darmstadt: { typical: 20, over: [0, -1, 0, 1, 1, 1, 3, 3, 3, 1, 1, 1, 0, 0, -1, -1] }
}
const reports = read('replay-jams.csv').map(report).sort((a, b) => a.ts.localeCompare(b.ts))
const first = reports.find(r => ROADS[APPROACH].includes(r.road))
if (!first) throw new Error(`No report on ${ROADS[APPROACH]} in ${join(dir, 'replay-jams.csv')}.`)
// Same format as the reports' times, so that a sample at a report's time sees it (srv/lib/traffic.js compares strings).
const at = k => new Date(Date.parse(first.ts) + (k - FIRE) * STEP_MS).toISOString().slice(0, 19) + '+00:00'
const samples = SHAPE[APPROACH].over.flatMap((_, k) => Object.entries(SHAPE).map(([origin, { typical, over }]) =>
  ({ ts: at(k), origin, live: (typical + over[k]) * 60, typical: typical * 60 })))
const day = berlin(first.ts)
const incident = { recordedOn: day, airport: 'FRA', approach: APPROACH, simulated: true,
  label: `Simulated drive times modelled on a jam measured on ${day} · Autobahn reports real · passenger context simulated`,
  samples, reports: reports.map(({ id, ...r }) => r), geo: geoOf(strongest(reports, ROADS[APPROACH])?.id) }
mkdirSync(join(root, 'srv/traffic/data'), { recursive: true })
writeFileSync(join(root, 'srv/traffic/data/incident.json'), JSON.stringify(incident, null, 1) + '\n')
console.log(`incident.json: ${incident.label}; ${incident.samples.length} samples, ${incident.reports.length} reports, map ${incident.geo ? 'yes' : 'no'}`)
