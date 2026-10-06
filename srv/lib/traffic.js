const cds = require('@sap/cds')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const abap = require('./abap')
const agentStart = require('./agent-start')
const LOG = cds.log('traffic')

// The traffic replay (post #3): plays a recorded jam sample by sample on the demo clock and, when the rule fires, opens
// a TrafficJam disruption and starts the agent, as ABAP's event does for a cancellation. The demo clock is FRA local
// time, like /DMO/ departure times: naive 'YYYY-MM-DDTHH:MM:SS' values, computed as if UTC and never converted.
const RULE = { minDelayMin: 10, runs: 2 } // ponytail: placeholder until the spike report (2026-10-08) sets it (Task 9)
const LEAD_MIN = 120 // the rule fires this long before the scenario flight departs
const ROADS = { wiesbaden: ['A66', 'A3'], badhomburg: ['A5'], offenbach: ['A3'], darmstadt: ['A5', 'A67'] }
const settings = () => ({ stepMs: 2000, data: join(__dirname, '../traffic/data/incident.json'), ...cds.env.requires.traffic })
const naive = ms => new Date(ms).toISOString().slice(0, 19)

let replay = null // the running or the last run, until stop()

/** The first sample time at which one approach is at least minDelayMin over typical for `runs` samples in a row. */
function fires(samples, rule = RULE) {
  const streak = {}
  for (const ts of [...new Set(samples.map(s => s.ts))].sort()) {
    for (const s of samples.filter(x => x.ts === ts)) {
      const delayMin = (s.live - s.typical) / 60
      streak[s.origin] = delayMin >= rule.minDelayMin ? (streak[s.origin] ?? 0) + 1 : 0
      if (streak[s.origin] >= rule.runs) return { ts, origin: s.origin, delayMin: Math.round(delayMin) }
    }
  }
  return null
}

function load(file) {
  let incident
  try { incident = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    throw cds.error(409, `NO_REPLAY_DATA: ${e.code === 'ENOENT' ? 'No recorded incident yet.' : e.message}`)
  }
  if (!incident.samples?.length) throw cds.error(409, 'NO_REPLAY_DATA: The incident has no samples.')
  return incident
}

/** The latest report on one of the approach's roads at `ts`. */
const reportAt = (incident, origin, ts) => (incident.reports ?? [])
  .filter(r => r.ts <= ts && (ROADS[origin] ?? []).includes(r.road)).sort((a, b) => a.ts.localeCompare(b.ts)).at(-1) ?? null

/** Starts the replay so that the rule fires LEAD_MIN before `flight` (the traffic scenario's) departs. */
async function start(flight) {
  if (replay && !replay.done) throw cds.error(409, 'REPLAY_RUNNING: A replay is already running.')
  if (!flight?.carrierId) throw cds.error(409, 'NO_SCENARIO: The traffic scenario is not known; run Reset demo first.')
  const { stepMs, data } = settings()
  const incident = load(data)
  const f = await abap.flight(flight)
  if (!f) throw cds.error(409, `NO_SCENARIO: ${flight.carrierId} ${flight.connectionId} ${flight.flightDate} is not in the booking system.`)
  const times = [...new Set(incident.samples.map(s => s.ts))].sort()
  const hit = fires(incident.samples), departure = Date.parse(`${abap.iso(f.FlightDate)}T${f.DepartureTime}Z`)
  // The firing sample lands LEAD_MIN before departure; without one, the replay ends 30 min before it.
  const offset = hit ? departure - LEAD_MIN * 6e4 - Date.parse(hit.ts) : departure - 30 * 6e4 - Date.parse(times.at(-1))
  const run = replay = { incident, times, offset, stepMs, step: 0, airport: f.AirportFrom, fired: null, disruption: null, done: false, timer: null, pending: null }
  schedule(run, 0)
  return state()
}

function schedule(run, ms) {
  run.timer = setTimeout(() => {
    run.pending = tick(run).catch(e => LOG.error('replay step failed:', e.message))
      .then(() => { if (replay === run && !run.done) schedule(run, run.stepMs) })
  }, ms)
}

async function tick(run) {
  if (replay !== run) return
  const now = run.times[run.step++]
  if (!run.fired) {
    const hit = fires(run.incident.samples.filter(s => s.ts <= now))
    if (hit) { run.fired = hit; run.disruption = await open(run, hit) }
  }
  if (run.step >= run.times.length) run.done = true
}

async function open(run, hit) {
  if (replay !== run) return null // stopped meanwhile
  const clock = naive(Date.parse(hit.ts) + run.offset), r = reportAt(run.incident, hit.origin, hit.ts)
  const reason = r ? `${r.road} ${r.location ?? ''} → ${r.direction ?? ''}: ${String(r.trafficType ?? 'jam').toLowerCase().replace(/_/g, ' ')}${r.delayMin ? `, +${r.delayMin} min` : ''} (Autobahn report)`
    : `Drive time from ${hit.origin} +${hit.delayMin} min above typical`
  const ID = cds.utils.uuid()
  await cds.db.tx(tx => tx.run(INSERT.into('fr.Disruptions').entries({
    ID, kind: 'TrafficJam', airportFrom: run.airport, jamDate: clock.slice(0, 10), jamTime: clock.slice(11, 19),
    approach: hit.origin, road: r?.road ?? ROADS[hit.origin]?.[0] ?? null, delayMinutes: r?.delayMin ?? hit.delayMin,
    reason: reason.replace(/\s+/g, ' ').slice(0, 200), agentStatus: 'Working'
  })))
  agentStart.start(ID) // after the commit, so the agent finds the disruption
  return ID
}

/** Stops the replay and forgets it. Waits for a step in flight, so nothing opens afterwards. */
async function stop() {
  const run = replay
  replay = null
  if (!run) return
  clearTimeout(run.timer)
  await run.pending
}

/** What the cockpit shows: the replay so far, on the demo clock. */
function state() {
  const run = replay
  if (!run) return { running: false, done: false, rule: RULE, samples: [], reports: [] }
  const now = run.times[run.step - 1], clock = ts => naive(Date.parse(ts) + run.offset), played = x => now !== undefined && x.ts <= now
  const geo = run.incident.geo
  return {
    running: !run.done, done: run.done, label: run.incident.label ?? null, clock: now === undefined ? null : clock(now),
    steps: run.times.length, rule: RULE,
    samples: run.incident.samples.filter(played).map(s => ({ clock: clock(s.ts), origin: s.origin, live: s.live, typical: s.typical })),
    reports: (run.incident.reports ?? []).filter(played)
      .map(r => ({ clock: clock(r.ts), road: r.road, location: r.location, direction: r.direction, delayMin: r.delayMin, trafficType: r.trafficType })),
    fired: run.fired ? { clock: clock(run.fired.ts), origin: run.fired.origin, delayMin: run.fired.delayMin } : null,
    disruption: run.disruption,
    geo: geo ? { lat: geo.lat, lon: geo.lon, geometry: JSON.stringify(geo.geometry) } : null,
    note: run.done && !run.fired ? 'No jam detected' : null
  }
}

module.exports = { fires, start, stop, state, RULE, LEAD_MIN }
