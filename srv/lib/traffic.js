const cds = require('@sap/cds')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const abap = require('./abap')
const agentStart = require('./agent-start')
const LOG = cds.log('traffic')

// The traffic replay (post #3): plays a recorded jam sample by sample on the demo clock and, when the rule fires, opens
// a TrafficJam disruption and starts the agent, as ABAP's event does for a cancellation. The demo clock is FRA local
// time, like /DMO/ departure times: naive 'YYYY-MM-DDTHH:MM:SS' values, computed as if UTC and never converted.
const RULE = { minDelayMin: 6, runs: 2 } // from the airport-traffic spike report (2026-10-08)
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
  const run = replay = { incident, times, offset, stepMs, step: 0, airport: f.AirportFrom, fired: null, disruption: null, done: false, paused: false, timer: null, chain: Promise.resolve() }
  schedule(run, 0)
  return state()
}

// One timer per run: scheduling replaces it, so a resume racing a tick's own reschedule leaves one.
function schedule(run, ms) {
  clearTimeout(run.timer)
  run.timer = setTimeout(() => {
    play(run, true).catch(() => {}) // logged by play
      .then(() => { if (replay === run && !run.done && !run.paused) schedule(run, run.stepMs) })
  }, ms)
}

/** Plays the next sample once every sample before it has ended. The timer and Step both come through here, so two samples
 *  never overlap and none is skipped or played twice (tick takes its sample inside the queue); stop() waits for the queue.
 *  `byTimer`: a timer's sample still queued when a pause comes gives way to it. */
function play(run, byTimer) {
  const p = run.chain.then(() => byTimer && run.paused ? null : tick(run))
  run.chain = p.catch(e => LOG.error('replay step failed:', e.message))
  return p
}

async function tick(run) {
  if (replay !== run || run.done) return
  const now = run.times[run.step++]
  if (!run.fired) {
    const hit = fires(run.incident.samples.filter(s => s.ts <= now))
    if (hit) { run.fired = hit; run.disruption = await open(run, hit) }
  }
  if (run.step >= run.times.length) { run.done = true; run.paused = false } // paused only while there is more to play
}

async function open(run, hit) {
  const clock = naive(Date.parse(hit.ts) + run.offset), r = reportAt(run.incident, hit.origin, hit.ts)
  const reason = r ? `${r.road} ${r.location ?? ''} → ${r.direction ?? ''}: ${String(r.trafficType ?? 'jam').toLowerCase().replace(/_/g, ' ')} (Autobahn report), drive time +${hit.delayMin} min`
    : `Drive time from ${hit.origin} +${hit.delayMin} min above typical`
  const ID = cds.utils.uuid()
  await cds.db.tx(tx => tx.run(INSERT.into('fr.Disruptions').entries({
    ID, kind: 'TrafficJam', airportFrom: run.airport, jamDate: clock.slice(0, 10), jamTime: clock.slice(11, 19),
    approach: hit.origin, road: r?.road ?? ROADS[hit.origin]?.[0] ?? null, delayMinutes: hit.delayMin,
    reason: reason.replace(/\s+/g, ' ').slice(0, 200), agentStatus: 'Working'
  })))
  if (replay === run) agentStart.start(ID) // after the commit, so the agent finds the disruption; not after a reset meanwhile, which deletes the row
  return ID
}

/** Stops the replay and forgets it. Waits for a step in flight, so nothing opens afterwards. */
async function stop() {
  const run = replay
  replay = null
  if (!run) return
  clearTimeout(run.timer)
  await run.chain
}

/** Pauses the replay (no more samples) or resumes it. Answers once a sample in flight has ended, so a paused clock stays. */
async function pause(paused) {
  const run = replay
  if (!run || run.done) throw cds.error(409, 'NO_REPLAY: No replay is running.')
  run.paused = !!paused
  if (!run.paused) schedule(run, run.stepMs) // a timer still pending while paused fires into play(), which skips
  await run.chain
  return state()
}

/** Plays exactly one sample of a paused replay, as the timer would (so the firing one opens the jam), and answers with the state after it. */
async function step() {
  const run = replay
  if (!run?.paused) throw cds.error(409, 'NOT_PAUSED: Pause the replay before stepping.')
  await play(run)
  return state()
}

/** What the cockpit shows: the replay so far, on the demo clock. */
function state() {
  const run = replay
  if (!run) return { running: false, done: false, paused: false, rule: RULE, samples: [], reports: [] }
  const now = run.times[run.step - 1], clock = ts => naive(Date.parse(ts) + run.offset), played = x => now !== undefined && x.ts <= now
  const geo = run.incident.geo
  return {
    running: !run.done, done: run.done, paused: run.paused, label: run.incident.label ?? null, clock: now === undefined ? null : clock(now),
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

module.exports = { fires, start, stop, pause, step, state, RULE, LEAD_MIN }
