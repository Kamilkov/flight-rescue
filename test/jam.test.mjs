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

describe('impact of a traffic jam', () => {
  test('at risk: drivers via the jammed approach on flights 60–180 min after it; offers: later flights that day with seats', async () => {
    const ID = await jam()
    const impact = await agentTool('disruptionImpact', { disruption: ID })
    assert.deepEqual([impact.disruption.kind, impact.disruption.flight, impact.disruption.jamTime], ['TrafficJam', null, '08:10:00'])
    assert.deepEqual(impact.affectedBookings.map(b => `${b.travelId}/${b.bookingId} ${b.carrierId} ${b.connectionId} ${b.flightDate}`), [
      '90000101/0001 LH 0400 2026-10-20', '90000101/0002 LH 0400 2026-10-20', '90000102/0001 LH 0400 2026-10-20', '90000102/0002 LH 0400 2026-10-20'])
    assert.deepEqual(impact.alternatives.map(a => [a.carrierId, a.connectionId, a.departureTime, a.seatsAvailable, a.forFlight]),
      [['DL', '0107', '11:50:00', 2, 'LH 0400 2026-10-20'], ['LH', '0404', '17:15:00', 3, 'LH 0400 2026-10-20']])
    assert.equal(impact.note, '9 bookings with passenger context on LH 0400 2026-10-20: 4 at risk (driving via wiesbaden), 1 driving via another approach, 2 by train, 2 checked in. Enough seats to offer all 4 bookings at risk a later flight.')
  })

  test('the jammed approach decides who is at risk', async () => {
    const impact = await agentTool('disruptionImpact', { disruption: await jam({ approach: 'darmstadt', road: 'A5' }) })
    assert.deepEqual(impact.affectedBookings.map(b => `${b.travelId}/${b.bookingId}`), ['90000103/0001'])
  })

  test('a flight leaving less than 60 or more than 180 min after the jam is not affected', async () => {
    for (const jamTime of ['09:20:00', '07:00:00']) {
      const impact = await agentTool('disruptionImpact', { disruption: await jam({ jamTime }) })
      assert.deepEqual([impact.affectedBookings.length, impact.alternatives.length], [0, 0], jamTime)
      assert.match(impact.note, /^Nobody is at risk/)
    }
  })

  test('the impact of a closed jam is refused', async () => {
    const ID = await jam({ status: 'Closed' })
    await assert.rejects(agentTool('disruptionImpact', { disruption: ID }), /CLOSED/)
  })

  test('offers hold seats while their disruption is open; closing it frees them', async () => {
    const A = await jam(), B = await jam()
    const item = (travelId, bookingId) => ({ travelId, bookingId, fromCarrierId: 'LH', fromConnectionId: '0400', fromFlightDate: '2026-10-20',
      toCarrierId: 'DL', toConnectionId: '0107', toFlightDate: '2026-10-20', status: 'Offered' })
    await INSERT.into('fr.Plans').entries({ ID: randomUUID(), disruption_ID: A, status: 'Offered', items: [item('90000101', '0001'), item('90000101', '0002')] })
    const listed = async () => (await agentTool('disruptionImpact', { disruption: B })).alternatives.map(a => [a.carrierId, a.connectionId, a.seatsAvailable])
    const heldOnA = async () => ok(await get(`flightBoard(disruption=${A})`)).value.find(f => f.carrierId === 'DL' && f.connectionId === '0107').held
    assert.deepEqual(await listed(), [['LH', '0404', 3]], 'DL 0107: 2 free, 2 offered by A')
    assert.equal(await heldOnA(), 2, 'its own board shows both offers as held')
    await UPDATE('fr.Disruptions', A).set({ status: 'Closed' })
    assert.deepEqual(await listed(), [['DL', '0107', 2], ['LH', '0404', 3]], 'A is closed: its offers can no longer be answered')
    assert.equal(await heldOnA(), 0, 'closed: its own board holds nothing any more')
  })
})

describe('proposals for a traffic jam', () => {
  const offer = (travelId, bookingId, carrierId, connectionId) => ({ travelId, bookingId, carrierId, connectionId, flightDate: '2026-10-20' })

  test('a plan offers at-risk bookings listed later flights; its items move from the booking\'s own flight', async () => {
    const ID = await jam()
    const r = await agentTool('proposeRebooking', { disruption: ID, rationale: 'test', assignments: [offer('90000101', '0001', 'DL', '0107'), offer('90000102', '0001', 'LH', '0404')] })
    assert.deepEqual([r.status, r.assigned, r.unassigned.length], ['Pending', 2, 2])
    const items = await SELECT.from('fr.PlanItems').columns('travelId', 'fromConnectionId', 'fromFlightDate', 'toConnectionId', 'status').where({ plan_ID: r.plan }).orderBy('travelId')
    assert.deepEqual(items.map(i => `${i.travelId} ${i.fromConnectionId} ${i.fromFlightDate} → ${i.toConnectionId} ${i.status}`),
      ['90000101 0400 2026-10-20 → 0107 Planned', '90000102 0400 2026-10-20 → 0404 Planned'])
  })

  test('refused: a passenger not at risk, a flight not listed for that booking, more than the seats', async () => {
    const ID = await jam()
    const propose = assignments => agentTool('proposeRebooking', { disruption: ID, rationale: 'test', assignments })
    await assert.rejects(propose([offer('90000104', '0001', 'DL', '0107')]), /NOT_AFFECTED/, 'by train')
    await assert.rejects(propose([{ ...offer('90000101', '0001', 'UA', '0941'), flightDate: '2026-10-12' }]), /NOT_LISTED/)
    await assert.rejects(propose([offer('90000101', '0001', 'DL', '0107'), offer('90000101', '0002', 'DL', '0107'), offer('90000102', '0001', 'DL', '0107')]), /OVER_CAPACITY/)
  })
})

describe('seat board of a traffic jam', () => {
  test('the flight in the jam with its passengers at risk, then the later flights that day', async () => {
    const ID = await jam()
    const row = f => [f.carrierId, f.connectionId, f.affected, f.cancelled, f.highlighted, f.held, f.seatsFree]
    assert.deepEqual(ok(await get(`flightBoard(disruption=${ID})`)).value.map(row), [
      ['LH', '0400', true, false, 4, 0, 9], ['DL', '0107', false, false, 0, 0, 2], ['LH', '0404', false, false, 0, 0, 3]])
  })
})

describe('the agent and a traffic jam', () => {
  test('it offers later flights and pauses at sendOffers; approval sends the offers without touching ABAP', async () => {
    const ID = await jam(), before = await bookings()
    const t = await ask(ID)
    assert.equal(paused(t).name, 'sendOffers')
    const [plan] = await SELECT.from('fr.Plans').where({ disruption_ID: ID })
    assert.equal(plan.status, 'Pending')
    const done = await approve(t)
    assert.equal(done.status.state, 'completed', JSON.stringify(done.status))
    assert.deepEqual(Object.values(await SELECT.one.from('fr.Plans', plan.ID).columns('status', 'appliedBy')), ['Offered', 'dispatcher'])
    const items = await SELECT.from('fr.PlanItems').columns('travelId', 'bookingId', 'toConnectionId', 'status').where({ plan_ID: plan.ID }).orderBy('travelId', 'bookingId')
    assert.deepEqual(items.map(i => `${i.travelId}/${i.bookingId}→${i.toConnectionId} ${i.status}`),
      ['90000101/0001→0107 Offered', '90000101/0002→0107 Offered', '90000102/0001→0404 Offered', '90000102/0002→0404 Offered'])
    assert.deepEqual(await bookings(), before, 'offers change nothing in ABAP')
    assert.deepEqual(globalThis.FR_LLM_TOOLS.at(-1), ['query', 'describe', 'disruptionImpact', 'proposeRebooking', 'applyRebooking', 'sendOffers'])
  })

  test('the seat board holds the offered seats', async () => {
    const ID = await jam(), t = await ask(ID)
    paused(t)
    await approve(t)
    const row = f => [f.carrierId, f.connectionId, f.highlighted, f.held]
    assert.deepEqual(ok(await get(`flightBoard(disruption=${ID})`)).value.map(row), [['LH', '0400', 4, 0], ['DL', '0107', 0, 2], ['LH', '0404', 0, 2]])
  })

  test('offered seats are held against a cancellation on the same route', async () => {
    const t = await ask(await jam())
    paused(t)
    await approve(t)
    globalThis.FR_LLM = { idle: true }
    ok(await control('cancelFlight', { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-20', reason: 'Crew' }))
    const c = await until(async () => { const d = await SELECT.one.from('fr.Disruptions').where({ kind: 'Cancellation', flightDate: '2026-10-20' }); return d?.agentStatus && d.agentStatus !== 'Working' && d })
    const impact = await agentTool('disruptionImpact', { disruption: c.ID })
    assert.deepEqual(impact.alternatives.map(a => [a.carrierId, a.connectionId, a.flightDate, a.seatsAvailable]), [['LH', '0404', '2026-10-20', 1]],
      'DL 0107: 2 free, 2 offered; LH 0404: 3 free, 2 offered')
  })

  test('applyRebooking on a jam plan is refused and changes nothing', async () => {
    const ID = await jam(), before = await bookings()
    globalThis.FR_LLM = { finalTool: 'applyRebooking' }
    const t = await ask(ID)
    assert.equal(paused(t).name, 'applyRebooking')
    const done = await approve(t)
    assert.match(lastText(done), /WRONG_KIND: Offers are sent with sendOffers\./)
    assert.equal((await SELECT.one.from('fr.Plans').where({ disruption_ID: ID })).status, 'Pending')
    assert.deepEqual(await bookings(), before)
  })

  test('sendOffers on a cancellation plan is refused and changes nothing', async () => {
    globalThis.FR_LLM = { idle: true }
    ok(await control('cancelFlight', { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12', reason: 'Crew' }))
    const c = await until(async () => { const d = await SELECT.one.from('fr.Disruptions').where({ kind: 'Cancellation' }); return d?.agentStatus && d.agentStatus !== 'Working' && d })
    const before = await bookings()
    globalThis.FR_LLM = { disruption: c.ID, finalTool: 'sendOffers' }
    const t = await ask(c.ID)
    assert.equal(paused(t).name, 'sendOffers')
    assert.match(lastText(await approve(t)), /WRONG_KIND: A cancellation plan is applied with applyRebooking\./)
    assert.deepEqual(await bookings(), before)
  })

  test('sendOffers outside the task that proposed the plan is refused', async () => {
    const ID = await jam()
    const r = await agentTool('proposeRebooking', { disruption: ID, rationale: 'test', assignments: [{ travelId: '90000101', bookingId: '0001', carrierId: 'DL', connectionId: '0107', flightDate: '2026-10-20' }] })
    await assert.rejects(agentTool('sendOffers', { plan: r.plan }), /NOT_REVIEWED/)
  })

  test('the server\'s kickoff message names the jam and the delay', () => {
    const { prompt } = require('../srv/lib/agent-start.js')
    assert.equal(prompt({ kind: 'TrafficJam', airportFrom: 'FRA', ID: 'd-1', reason: 'A3 jam', delayMinutes: 25 }),
      'Traffic jam at FRA (disruption d-1): A3 jam, about 25 min. Offer the passengers at risk a later flight.')
    assert.equal(prompt({ carrierId: 'LH', connectionId: '0402', flightDate: '2026-10-14', ID: 'd-2' }),
      'LH 0402 on 2026-10-14 was cancelled in the booking system (disruption d-2). Rebook the passengers.')
  })
})
