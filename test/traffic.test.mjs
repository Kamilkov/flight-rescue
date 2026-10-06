// The traffic replay: the trigger rule, the demo clock, the TrafficJam disruption it opens and the agent it starts.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'

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
      ['FRA', '2026-10-20', '08:10:00', 'wiesbaden', 'A3', 25, 'Done'])
    assert.equal(d.reason, 'A3 Mönchhof - Frankfurter Kreuz → Würzburg: queuing traffic, +25 min (Autobahn report)')
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
