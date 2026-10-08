// The traffic replay: the trigger rule, the demo clock, the TrafficJam disruption it opens and the agent it starts.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach, afterEach } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const incident = join(root, 'test/fixtures/traffic-incident.json')
process.env.CDS_CONFIG = JSON.stringify({ requires: {
  llm: { impl: join(root, 'test/fixtures/scripted-llm.mjs'), model: 'scripted' },
  traffic: { stepMs: 20, data: incident }
} })
delete process.env.ABAP_URL
const { default: cds } = await import('@sap/cds')
const srv = cds.test(root, '--with-mocks')
const require = createRequire(import.meta.url)
const traffic = require('../srv/lib/traffic.js')
const abap = require('../srv/lib/abap.js')

const as = user => ({ validateStatus: () => true, auth: { username: user, password: '' } })
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data }
const control = (action, data = {}) => srv.post(`/odata/v4/control/${action}`, data, as('dispatcher'))
const get = path => srv.get(`/odata/v4/control/${path}`, as('dispatcher'))
const until = async (fn, ms = 20000) => {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 20))) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
  }
}
const finished = () => until(async () => { const s = ok(await get('trafficReplay()')); return s.done && s })

beforeEach(async () => {
  await traffic.stop()
  cds.env.requires.traffic.data = incident
  await srv.data.reset()
  globalThis.FR_LLM = { idle: true } // the agent the replay starts finds nothing to do
})

describe('the trigger rule', () => {
  const s = (ts, origin, overMin) => ({ ts, origin, live: 1000 + overMin * 60, typical: 1000 })
  test('fires on the second sample in a row at or over the threshold, for that approach', () => {
    assert.deepEqual(traffic.fires([s('a', 'w', 12), s('b', 'w', 15)]), { ts: 'b', origin: 'w', delayMin: 15 })
    assert.equal(traffic.fires([s('a', 'w', 12), s('b', 'w', 5), s('c', 'w', 11)]), null, 'the run starts again')
    assert.equal(traffic.fires([s('a', 'w', 12), s('b', 'd', 12)]), null, 'per approach')
    assert.deepEqual(traffic.fires([s('a', 'w', 10), s('b', 'w', 10)]), { ts: 'b', origin: 'w', delayMin: 10 }, 'the threshold counts')
    assert.deepEqual(traffic.fires([s('a', 'w', 9)], { minDelayMin: 5, runs: 1 }), { ts: 'a', origin: 'w', delayMin: 9 })
  })
})

describe('the replay', () => {
  test('opens one TrafficJam disruption at the firing sample, 2 h before the scenario flight, and starts the agent', async () => {
    assert.equal(ok(await control('replayTraffic')).running, true)
    const d = await until(async () => { const x = await SELECT.one.from('fr.Disruptions').where({ kind: 'TrafficJam' }); return x?.agentStatus && x.agentStatus !== 'Working' && x })
    assert.deepEqual([d.airportFrom, d.jamDate, d.jamTime, d.approach, d.road, d.delayMinutes, d.agentStatus],
      ['FRA', '2026-10-20', '08:10:00', 'wiesbaden', 'A3', 15, 'Done'])
    assert.equal(d.reason, 'A3 Mönchhof - Frankfurter Kreuz → Würzburg: queuing traffic (Autobahn report), drive time +15 min')
    const s = await finished()
    assert.deepEqual([s.running, s.clock, s.steps, s.samples.length, s.reports.length], [false, '2026-10-20T08:30:00', 6, 12, 1])
    assert.deepEqual(s.fired, { clock: '2026-10-20T08:10:00', origin: 'wiesbaden', delayMin: 15 })
    assert.equal(s.disruption, d.ID)
    assert.deepEqual(JSON.parse(s.geo.geometry).coordinates[0], [8.47, 50.048])
    assert.equal((await SELECT.from('fr.Disruptions')).length, 1)
  })

  test('one replay at a time; after it ended, a new one can start', async () => {
    cds.env.requires.traffic.stepMs = 200
    try {
      ok(await control('replayTraffic'))
      const again = await control('replayTraffic')
      assert.equal(again.status, 409)
      assert.match(again.data.error.message, /^REPLAY_RUNNING/)
    } finally { cds.env.requires.traffic.stepMs = 20 }
    await finished()
    ok(await control('replayTraffic'))
  })

  test('Reset demo during a replay stops it: no disruption appears afterwards', async () => {
    cds.env.requires.traffic.stepMs = 30
    try {
      ok(await control('replayTraffic'))
      ok(await control('resetDemo'))
      await new Promise(r => setTimeout(r, 400))
      assert.deepEqual(await SELECT.from('fr.Disruptions'), [])
      assert.equal(ok(await get('trafficReplay()')).running, false)
    } finally { cds.env.requires.traffic.stepMs = 20 }
  })

  test('Reset demo while the firing step writes the jam: no agent starts for it', async () => {
    // The step that fires the rule is held inside its INSERT. The reset lands there and deletes the row the step writes.
    let release, entered = false, holding = true
    const held = new Promise(r => { release = r })
    cds.db.before('INSERT', 'fr.Disruptions', async () => { if (holding) { entered = true; await held } }) // inert after this test
    const agent = require('../srv/lib/agent-start.js'), realStart = agent.start, started = []
    agent.start = ID => { started.push(ID) } // a spy: no real agent runs
    try {
      ok(await control('replayTraffic'))
      await until(() => entered && traffic.state().fired) // the step is now inside the held INSERT
      const reset = control('resetDemo') // stop() waits for that step, so this does not answer yet
      await until(() => !traffic.state().running) // stop() has taken the replay away while the step is still held
      release()
      ok(await reset)
      assert.deepEqual(started, [], 'no agent starts for a disruption the reset deletes')
      assert.deepEqual(await SELECT.from('fr.Disruptions'), [])
    } finally {
      holding = false; release()
      await traffic.stop() // a step still in flight ends before the real start is back
      agent.start = realStart
    }
  })

  test('a jam that never reaches the threshold: the replay ends with "No jam detected" and nothing opens', async () => {
    cds.env.requires.traffic.data = join(root, 'test/fixtures/traffic-flat.json')
    ok(await control('replayTraffic'))
    const s = await finished()
    assert.deepEqual([s.note, s.fired, s.disruption], ['No jam detected', null, null])
    assert.deepEqual(await SELECT.from('fr.Disruptions'), [])
  })

  test('without replay data, or without a scenario flight, the replay is refused', async () => {
    cds.env.requires.traffic.data = join(root, 'test/fixtures/nothing-here.json')
    const r = await control('replayTraffic')
    assert.equal(r.status, 409)
    assert.match(r.data.error.message, /^NO_REPLAY_DATA: No recorded incident yet\./)
    await assert.rejects(traffic.start(null), /NO_SCENARIO/)
  })

  test('only dispatchers replay', async () => {
    assert.equal((await srv.post('/odata/v4/control/replayTraffic', {}, as('viewer'))).status, 403)
  })
})

describe('pausing and stepping', () => {
  const played = s => new Set(s.samples.map(x => x.clock)).size // sample times played so far
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const jam = () => until(async () => { const x = await SELECT.one.from('fr.Disruptions').where({ kind: 'TrafficJam' }); return x?.agentStatus && x.agentStatus !== 'Working' && x })
  // Holds the INSERT of a disruption (the firing sample's) until released; inert afterwards.
  const hold = () => {
    let open = true, free
    const gate = new Promise(r => { free = r }), h = { entered: false, release() { open = false; free() } }
    cds.db.before('INSERT', 'fr.Disruptions', async () => { if (open) { h.entered = true; await gate } })
    return h
  }
  // A long interval: the first sample plays at once, then nothing until a Step, unless a test shortens it.
  beforeEach(() => { cds.env.requires.traffic.stepMs = 5000 })
  afterEach(async () => { await traffic.stop(); cds.env.requires.traffic.stepMs = 20 })

  test('Pause stops the clock: it and the samples stay for more than two intervals; Resume plays on to the end', async () => {
    cds.env.requires.traffic.stepMs = 150
    ok(await control('replayTraffic'))
    await until(async () => played(ok(await get('trafficReplay()'))) >= 1)
    const paused = ok(await control('pauseReplay', { paused: true }))
    assert.deepEqual([paused.running, paused.paused, paused.done], [true, true, false])
    await wait(2 * 150 + 100)
    const later = ok(await get('trafficReplay()'))
    assert.deepEqual([later.clock, later.samples.length, later.paused], [paused.clock, paused.samples.length, true])

    const resumed = ok(await control('pauseReplay', { paused: false }))
    assert.deepEqual([resumed.running, resumed.paused], [true, false])
    const s = await finished()
    assert.deepEqual([s.paused, played(s), s.samples.length, s.clock], [false, 6, 12, '2026-10-20T08:30:00'])
    await jam()
  })

  test('each Step plays exactly one sample time; the firing one opens the TrafficJam disruption; the last ends the replay', async () => {
    ok(await control('replayTraffic'))
    await until(async () => played(ok(await get('trafficReplay()'))) === 1)
    let s = ok(await control('pauseReplay', { paused: true }))
    assert.deepEqual([played(s), s.fired, s.disruption], [1, null, null])
    assert.deepEqual(await SELECT.from('fr.Disruptions'), [])

    for (const n of [2, 3]) { // the fixture's rule fires at its 4th sample time
      s = ok(await control('stepReplay'))
      assert.deepEqual([played(s), s.fired, s.paused], [n, null, true], 'a Step keeps the pause')
    }
    assert.deepEqual(await SELECT.from('fr.Disruptions'), [])
    s = ok(await control('stepReplay'))
    assert.equal(played(s), 4)
    assert.deepEqual(s.fired, { clock: '2026-10-20T08:10:00', origin: 'wiesbaden', delayMin: 15 })
    const d = await jam() // the agent started for it
    assert.deepEqual([d.ID, d.kind, d.jamTime, d.approach], [s.disruption, 'TrafficJam', '08:10:00', 'wiesbaden'])

    assert.equal(played(ok(await control('stepReplay'))), 5)
    s = ok(await control('stepReplay'))
    assert.deepEqual([played(s), s.done, s.running, s.paused, s.samples.length], [6, true, false, false, 12])
    assert.equal((await SELECT.from('fr.Disruptions')).length, 1, 'the jam opened once')
    assert.equal((await control('pauseReplay', { paused: true })).status, 409, 'a finished replay cannot be paused')
  })

  test('Step without a pause, and Pause without a replay, are refused', async () => {
    const none = await control('pauseReplay', { paused: true })
    assert.equal(none.status, 409)
    assert.match(none.data.error.message, /^NO_REPLAY: /)
    ok(await control('replayTraffic'))
    const running = await control('stepReplay')
    assert.equal(running.status, 409)
    assert.match(running.data.error.message, /^NOT_PAUSED: /)
  })

  test('a Step queued behind the last sample plays nothing more', async () => {
    cds.env.requires.traffic.data = join(root, 'test/fixtures/traffic-flat.json') // no jam, so no agent
    await traffic.start(abap.MOCK_TRAFFIC)
    await traffic.pause(true)
    for (let i = 0; i < 5; i++) await traffic.step()
    await Promise.all([traffic.step(), traffic.step()]) // both pass the check before either plays
    const s = traffic.state()
    assert.deepEqual([played(s), s.done, s.paused, s.clock], [6, true, false, '2026-10-20T09:40:00'], 'the clock stays on the last sample, 30 min before departure')
  })

  test('Reset while paused leaves no replay, not paused, and no disruption opens afterwards', async () => {
    cds.env.requires.traffic.stepMs = 100
    ok(await control('replayTraffic'))
    await until(async () => played(ok(await get('trafficReplay()'))) >= 1)
    ok(await control('pauseReplay', { paused: true }))
    ok(await control('resetDemo'))
    await wait(300)
    const s = ok(await get('trafficReplay()'))
    assert.deepEqual([s.running, s.paused, s.clock ?? null], [false, false, null])
    assert.deepEqual(await SELECT.from('fr.Disruptions'), [])
  })

  test('a Step in flight holds back the timer and a pause: samples never overlap, none is skipped or played twice', async () => {
    cds.env.requires.traffic.stepMs = 30
    const held = hold()
    try {
      await traffic.start(abap.MOCK_TRAFFIC)
      await traffic.pause(true) // in the same tick as the start: before the first sample
      assert.equal(played(traffic.state()), 0)
      for (let i = 0; i < 3; i++) await traffic.step()
      const stepping = traffic.step() // the 4th sample fires the rule, held inside its INSERT
      await until(() => held.entered)
      const resumed = traffic.pause(false) // arms the timer; answers when the step ends
      await wait(200) // several intervals: the timer's sample is queued behind the step
      assert.equal(played(traffic.state()), 4, 'it waits for the step')
      let answered = false
      const paused = traffic.pause(true).then(() => { answered = true }) // the queued sample must give way to this
      await wait(50)
      assert.equal(answered, false, 'a pause answers when the sample in flight has ended')
      held.release()
      await Promise.all([stepping, resumed, paused])
      await wait(100)
      assert.deepEqual([played(traffic.state()), traffic.state().paused], [4, true])
      await traffic.pause(false)
      const s = await finished()
      assert.deepEqual([played(s), s.samples.length, s.paused, s.disruption === (await jam()).ID], [6, 12, false, true])
      assert.equal((await SELECT.from('fr.Disruptions')).length, 1)
    } finally { held.release() }
  })

  test('Pause and Resume while a sample is in flight leave one timer: the pace does not double', async () => {
    cds.env.requires.traffic.stepMs = 100
    const held = hold()
    try {
      await traffic.start(abap.MOCK_TRAFFIC)
      await until(() => held.entered) // the timer plays the 4th sample, which fires the rule
      const toggled = Promise.all([traffic.pause(true), traffic.pause(false)]) // arms a timer; the tick reschedules itself when it ends
      await wait(80)
      held.release()
      await toggled
      await wait(150) // two timers would have played the 5th and the 6th sample by now; one plays the 6th 100 ms after the 5th
      assert.equal(traffic.state().done, false)
      await finished()
      await jam()
    } finally { held.release() }
  })

  test('stop() waits for a Step in flight, and no agent starts for the jam it writes', async () => {
    const held = hold(), agent = require('../srv/lib/agent-start.js'), realStart = agent.start, started = []
    agent.start = ID => { started.push(ID) } // a spy: no real agent runs
    try {
      await traffic.start(abap.MOCK_TRAFFIC)
      await traffic.pause(true)
      for (let i = 0; i < 3; i++) await traffic.step()
      const stepping = traffic.step() // the 4th sample fires the rule, held inside its INSERT
      await until(() => held.entered)
      let stopped = false
      const stopping = traffic.stop().then(() => { stopped = true })
      await wait(50)
      assert.equal(stopped, false, 'stop waits for the step')
      held.release()
      await Promise.all([stopping, stepping])
      assert.deepEqual(started, [])
      assert.deepEqual([traffic.state().running, traffic.state().paused], [false, false])
    } finally { held.release(); agent.start = realStart }
  })
})

describe('the shipped incident', () => {
  test('the rule fires on it, on the label\'s approach, and it has a label and samples for every approach', () => {
    const shipped = JSON.parse(require('node:fs').readFileSync(join(root, 'srv/traffic/data/incident.json'), 'utf8'))
    const hit = traffic.fires(shipped.samples)
    assert.ok(hit, 'the rule fires')
    assert.equal(hit.origin, shipped.approach)
    // The demo needs somebody at risk: the phone's booking drives via the approach the rule fires on (re-importing another incident must not break that silently).
    const [head, ...rows] = require('node:fs').readFileSync(join(root, 'db/data/fr-PassengerContext.csv'), 'utf8').trim().split('\n').map(l => l.split(';'))
    const phone = rows.map(r => Object.fromEntries(head.map((h, k) => [h, r[k].trim()]))).find(r => r.phone === 'true')
    assert.equal(traffic.fires(shipped.samples, traffic.RULE).origin, phone.approach, 'the incident fires on the phone booking\'s approach')
    assert.match(shipped.label, shipped.simulated ? /^Simulated jam/ : /^Replay of a jam recorded on \d{4}-\d{2}-\d{2}/)
    assert.deepEqual([...new Set(shipped.samples.map(s => s.origin))].sort(), ['badhomburg', 'darmstadt', 'offenbach', 'wiesbaden'])
    assert.ok(shipped.reports.every(r => !/ \| |->/.test(`${r.location} ${r.direction}`)), 'the Autobahn text is cleaned: no "<road> | " and no "->"')
  })
})
