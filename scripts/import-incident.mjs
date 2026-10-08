// Builds srv/traffic/data/incident.json, the traffic replay's data, from the airport-traffic spike's results.
//   node scripts/import-incident.mjs <results dir>              a real incident: replay-incident.csv, replay-jams.csv, fra_jam_geo.csv
//   node scripts/import-incident.mjs <results dir> --simulate   no usable incident: a labelled simulated jam over a recorded calm morning
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), simulate = args.includes('--simulate')
const dir = args.find(a => !a.startsWith('--'))
if (!dir) { console.error('Usage: node scripts/import-incident.mjs <results dir> [--simulate]'); process.exit(2) }
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

let incident
if (!simulate) {
  const samples = read('replay-incident.csv').filter(r => r.airport === 'FRA')
    .map(r => ({ ts: r.ts_utc, origin: r.origin, live: Number(r.live_s), typical: Number(r.typical_s) }))
  if (!samples.length) throw new Error(`No FRA rows in ${join(dir, 'replay-incident.csv')}; run with --simulate.`)
  const worst = samples.reduce((a, s) => (s.live - s.typical > a.live - a.typical ? s : a))
  const reports = existsSync(join(dir, 'replay-jams.csv')) ? read('replay-jams.csv').map(report) : []
  const day = berlin(worst.ts)
  incident = { recordedOn: day, airport: 'FRA', approach: worst.origin, simulated: false,
    label: `Replay of a jam recorded on ${day} · passenger context simulated`,
    samples, reports: reports.map(({ id, ...r }) => r), geo: geoOf(strongest(reports, ROADS[worst.origin] ?? [])?.id) }
} else {
  // A calm weekday morning from the recording, 07:00 Frankfurt time on, with a jam added on the Bad Homburg approach, the one the passenger context drives.
  const RAMP = [0, 0, 0, 3, 8, 14, 22, 25, 25, 24, 18, 10, 4] // minutes over typical, one per 10-min sample
  const log = read('log.csv').filter(r => r.airport === 'FRA')
  const times = [...new Set(log.map(r => r.ts_utc))].sort()
  const start = times.findIndex(ts => ['Tue', 'Wed', 'Thu'].includes(berlin(ts, { weekday: 'short' })) && berlin(ts, { hour: '2-digit', hourCycle: 'h23' }) === '07')
  if (start < 0 || start + RAMP.length > times.length) throw new Error('No weekday morning from 07:00 in log.csv.')
  const window = times.slice(start, start + RAMP.length)
  const samples = log.filter(r => window.includes(r.ts_utc)).map(r => ({
    ts: r.ts_utc, origin: r.origin, live: Number(r.live_s) + (r.origin === 'badhomburg' ? RAMP[window.indexOf(r.ts_utc)] * 60 : 0), typical: Number(r.typical_s)
  }))
  const reports = window.flatMap((ts, k) => RAMP[k] >= 8
    ? [{ ts, road: 'A5', location: 'near Frankfurt Airport (simulated)', direction: 'Darmstadt', delayMin: RAMP[k], trafficType: 'QUEUING_TRAFFIC' }] : [])
  // The map shows the strongest jam the spike recorded near FRA, when there was one; the label says it is simulated.
  const real = existsSync(join(dir, 'fra_jams.csv')) ? strongest(read('fra_jams.csv').map(report), ['A3', 'A5', 'A66', 'A67', 'A661']) : null
  const day = berlin(window[0])
  incident = { recordedOn: day, airport: 'FRA', approach: 'badhomburg', simulated: true,
    label: `Simulated jam on the A5, over traffic recorded on ${day} · passenger context simulated`, samples, reports, geo: geoOf(real?.id) }
}
mkdirSync(join(root, 'srv/traffic/data'), { recursive: true })
writeFileSync(join(root, 'srv/traffic/data/incident.json'), JSON.stringify(incident, null, 1) + '\n')
console.log(`incident.json: ${incident.label}; ${incident.samples.length} samples, ${incident.reports.length} reports, map ${incident.geo ? 'yes' : 'no'}`)
