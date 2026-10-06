// Traffic jams: the scenario, the impact the agent sees, offers and the agent's flow. ZFR_REBOOK mocked, scripted model.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.CDS_CONFIG = JSON.stringify({ requires: { llm: { impl: join(root, 'test/fixtures/scripted-llm.mjs'), model: 'scripted' } } })
delete process.env.ABAP_URL
const { default: cds } = await import('@sap/cds')
const srv = cds.test(root, '--with-mocks')
const require = createRequire(import.meta.url)

const as = user => ({ validateStatus: () => true, auth: { username: user, password: '' } })
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data }
const get = path => srv.get(`/odata/v4/control/${path}`, as('dispatcher'))
const control = (action, data = {}) => srv.post(`/odata/v4/control/${action}`, data, as('dispatcher'))
const dispatcher = new cds.User({ id: 'dispatcher', roles: ['Dispatcher'] })
const agentTool = (name, data) => cds.services.RebookAgentService.tx({ user: dispatcher }, tx => tx.send(name, data))
const rpc = (method, params) => srv.post('/a2a/rebook-agent', { jsonrpc: '2.0', id: randomUUID(), method, params }, as('dispatcher'))
const message = (parts, extra = {}) => ({ message: { kind: 'message', role: 'user', messageId: randomUUID(), parts, ...extra } })
const ask = ID => rpc('message/send', message([{ kind: 'text', text: `Traffic jam at FRA (disruption ${ID}): A3 jam, about 25 min. Offer the passengers at risk a later flight.` }])).then(r => r.data?.result)
const approve = t => rpc('message/send', message([{ kind: 'text', text: 'approve' }], { taskId: t.id, contextId: t.contextId })).then(r => r.data?.result)
const paused = t => { assert.equal(t?.status?.state, 'input-required', JSON.stringify(t?.status)); return t.status.message.metadata['sap.cds.agents.hitl'].actionRequests[0] }
const lastText = t => t.status.message.parts.filter(p => p.kind === 'text').map(p => p.text).join(' ')
const bookings = () => SELECT.from('ZFR_REBOOK.Bookings').columns('TravelId', 'BookingId', 'CarrierId', 'ConnectionId', 'FlightDate').orderBy('TravelId', 'BookingId')
const until = async (fn, ms = 20000) => {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 50))) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
  }
}

/** A jam on the A3 (approach wiesbaden), 2 h before the mock's LH 0400 on 2026-10-20 (10:10). */
async function jam(fields = {}) {
  const ID = randomUUID()
  await INSERT.into('fr.Disruptions').entries({ ID, kind: 'TrafficJam', airportFrom: 'FRA', jamDate: '2026-10-20', jamTime: '08:10:00',
    approach: 'wiesbaden', road: 'A3', delayMinutes: 25, reason: 'A3 Mönchhof - Frankfurter Kreuz → Würzburg: queuing traffic, +25 min (test)', ...fields })
  return ID
}

beforeEach(async () => {
  await srv.data.reset()
  globalThis.FR_LLM_TOOLS = []
  globalThis.FR_LLM = {}
})

describe('traffic scenario data', () => {
  test('FRA departures on the scenario day, by departure time', async () => {
    const abap = require('../srv/lib/abap.js')
    const rows = await abap.departures('FRA', '2026-10-20')
    assert.deepEqual(rows.map(f => `${f.CarrierId} ${f.ConnectionId} ${f.DepartureTime} ${f.SeatsFree}`), ['LH 0400 10:10:00 9', 'DL 0107 11:50:00 2', 'LH 0404 17:15:00 3'])
    await assert.rejects(abap.departures('frankfurt', '2026-10-20'), /INVALID/)
  })

  test('passenger context: the 9 scenario bookings, one of them the phone booking', async () => {
    const rows = await SELECT.from('fr.PassengerContext').orderBy('travelId', 'bookingId')
    assert.deepEqual(rows.map(r => r.arrival === 'Car' ? `Car ${r.approach}` : r.arrival),
      ['Car wiesbaden', 'Car wiesbaden', 'Car wiesbaden', 'Car wiesbaden', 'Car darmstadt', 'Train', 'Train', 'CheckedIn', 'CheckedIn'])
    assert.deepEqual(rows.filter(r => r.phone).map(r => `${r.travelId}/${r.bookingId}`), ['90000102/0001'])
    assert.equal(cds.services.RebookAgentService.entities.PassengerContext, undefined, 'never exposed to the agent')
  })

  test('demoInfo names the traffic scenario flight', async () => {
    assert.deepEqual(ok(await get('demoInfo()')).trafficFlight, { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-20' })
  })

  test('a jam needs no flight; a disruption without a kind is a cancellation', async () => {
    const d = await SELECT.one.from('fr.Disruptions', await jam())
    assert.deepEqual([d.kind, d.carrierId, d.jamDate, d.jamTime, d.approach], ['TrafficJam', null, '2026-10-20', '08:10:00', 'wiesbaden'])
    const ID = randomUUID()
    await INSERT.into('fr.Disruptions').entries({ ID, carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12' })
    assert.equal((await SELECT.one.from('fr.Disruptions', ID)).kind, 'Cancellation')
  })
})
