// Rerouting a cancellation over itineraries: the mock's Itineraries and rebookItinerary, the impact the agent sees, the
// plan's checks per flight, the multi-leg approval and the board. The scenario: LH 0454 FRA→SFO on 2026-10-27, with
// 9 bookings in travels 90000201 (4), 90000202 (3) and 90000203 (2). ZFR_REBOOK mocked, scripted model.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.CDS_CONFIG = JSON.stringify({ requires: { llm: { impl: join(root, 'test/fixtures/scripted-llm.mjs'), model: 'scripted' } } })
delete process.env.ABAP_URL
const { default: cds } = await import('@sap/cds')
const srv = cds.test(root, '--with-mocks')

const as = user => ({ validateStatus: () => true, auth: { username: user, password: '' } })
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data }
const control = (action, data = {}) => srv.post(`/odata/v4/control/${action}`, data, as('dispatcher'))
const get = path => srv.get(`/odata/v4/control/${path}`, as('dispatcher'))
const dispatcher = new cds.User({ id: 'dispatcher', roles: ['Dispatcher'] })
const agentTool = (name, data) => cds.services.RebookAgentService.tx({ user: dispatcher }, tx => tx.send(name, data))
const rpc = (method, params) => srv.post('/a2a/rebook-agent', { jsonrpc: '2.0', id: randomUUID(), method, params }, as('dispatcher'))
const message = (parts, extra = {}) => ({ message: { kind: 'message', role: 'user', messageId: randomUUID(), parts, ...extra } })
const ask = () => rpc('message/send', message([{ kind: 'text', text: 'LH 0454 on 2026-10-27 is cancelled. Rebook the passengers.' }])).then(r => r.data?.result)
const approve = t => rpc('message/send', message([{ kind: 'text', text: 'approve' }], { taskId: t.id, contextId: t.contextId })).then(r => r.data?.result)
const paused = t => { assert.equal(t?.status?.state, 'input-required', JSON.stringify(t?.status)); return t.status.message.metadata['sap.cds.agents.hitl'].actionRequests[0] }
const until = async (fn, ms = 20000) => {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 50))) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
  }
}
const opened = (carrierId, connectionId, flightDate) => until(async () => {
  const d = await SELECT.one.from('fr.Disruptions').where({ carrierId, connectionId, flightDate, status: 'Open' })
  return d && d.agentStatus !== 'Working' && d
})
const cancel = async (carrierId, connectionId, flightDate) => {
  globalThis.FR_LLM = { idle: true } // the agent ABAP's event starts finds nothing to do; a test asks it itself
  ok(await control('cancelFlight', { carrierId, connectionId, flightDate, reason: 'Test' }))
  return (await opened(carrierId, connectionId, flightDate)).ID
}
const mock = () => cds.services.ZFR_REBOOK
const action = (event, TravelId, BookingId, data) => mock().send({ event, entity: 'ZFR_REBOOK.Bookings', params: [{ TravelId, BookingId }], data })
const travel = TravelId => SELECT.from('ZFR_REBOOK.Bookings').columns('BookingId', 'CarrierId', 'ConnectionId', 'FlightDate', 'FlightPrice', 'BookingStatus').where({ TravelId }).orderBy('BookingId')
const free = async (CarrierId, ConnectionId, FlightDate) => (await SELECT.one.from('ZFR_REBOOK.Flights').where({ CarrierId, ConnectionId, FlightDate })).SeatsFree
const D = '2026-10-27'
const FROM = { ExpectedCarrierId: 'LH', ExpectedConnectionId: '0454', ExpectedFlightDate: D }
const legs = (...flights) => Object.assign({}, ...[0, 1, 2].map(i => {
  const [c, n, d = D] = flights[i] ?? ['', '0000', null]
  return { [`Leg${i + 1}CarrierId`]: c, [`Leg${i + 1}ConnectionId`]: n, [`Leg${i + 1}FlightDate`]: d }
}))

beforeEach(async () => {
  await srv.data.reset()
  globalThis.FR_LLM_TOOLS = []
  globalThis.FR_LLM = {}
})

describe('the mock booking system', () => {
  test('Itineraries: one row per leg, earliest arrival first; a cancelled flight drops out; the filters are required', async () => {
    const list = async () => {
      const rows = await mock().run(SELECT.from('ZFR_REBOOK.Itineraries').where({ Origin: 'FRA', Destination: 'SFO', FromDate: D }))
      return [...new Set(rows.map(r => r.ItineraryNo))].map(no => {
        const it = rows.filter(r => r.ItineraryNo === no)
        return `${no}: ${it.map(r => `${r.CarrierId} ${r.ConnectionId}`).join(' > ')} ${it[0].ArrivesOn} ${it[0].ArrivesAt}`
      })
    }
    assert.equal((await list())[0], '1: LH 0454 2026-10-27 12:40:00', 'before it is cancelled')
    await cancel('LH', '0454', D)
    assert.deepEqual(await list(), [
      '1: DE 2096 2026-10-27 14:30:00', '2: UA 0059 2026-10-27 15:15:00', '3: LH 0400 > B6 0415 2026-10-27 19:13:00',
      '4: DL 0107 > DL 0365 2026-10-27 19:54:00', '5: LH 0400 > DL 0365 2026-10-27 19:54:00', '6: DE 2096 2026-10-28 14:30:00'
    ], 'UA 0927 is full; DL 0107 lands 59 min before B6 0415 leaves')
    await assert.rejects(mock().run(SELECT.from('ZFR_REBOOK.Itineraries').where({ Origin: 'FRA' })), /FILTER: Origin, Destination and FromDate needed\./)
  })

  test('rebook refuses a cancelled flight', async () => {
    await cancel('UA', '0059', D)
    await assert.rejects(action('rebook', '90000201', '0001', { ...FROM, CarrierId: 'UA', ConnectionId: '0059', FlightDate: D }),
      /NOT_FLYING: UA 0059 2026-10-27 is cancelled\./)
  })

  test('rebookItinerary moves the booking to leg 1 and adds leg 2 to its travel at price 0, a seat on each leg', async () => {
    const moved = await action('rebookItinerary', '90000201', '0002', { ...FROM, ...legs(['LH', '0400'], ['DL', '0365']) })
    assert.deepEqual([moved.CarrierId, moved.ConnectionId, moved.FlightDate], ['LH', '0400', D])
    assert.deepEqual((await travel('90000201')).map(b => [b.BookingId, b.CarrierId, b.ConnectionId, Number(b.FlightPrice), b.BookingStatus]), [
      ['0001', 'LH', '0454', 6341, 'B'], ['0002', 'LH', '0400', 6341, 'B'], ['0003', 'LH', '0454', 6341, 'B'], ['0004', 'LH', '0454', 6341, 'B'],
      ['0005', 'DL', '0365', 0, 'B']])
    assert.deepEqual([await free('LH', '0454', D), await free('LH', '0400', D), await free('DL', '0365', D)], [65, 2, 4])
  })

  test('rebookItinerary refuses STALE, NO_FLIGHT, NOT_FLYING, CHAIN, LAYOVER and FULL and changes nothing', async () => {
    await cancel('UA', '0059', D)
    const before = await travel('90000201')
    for (const [data, reason] of [
      [{ ...FROM, ExpectedConnectionId: '0400', ...legs(['LH', '0400'], ['DL', '0365']) }, /STALE: 90000201\/0001 is on LH 0454 2026-10-27\./],
      [{ ...FROM, ...legs(['LH', '0400'], ['DL', '0365', '2026-10-28']) }, /NO_FLIGHT: DL 0365 2026-10-28 does not exist\./],
      [{ ...FROM, ...legs(['UA', '0059']) }, /NOT_FLYING: UA 0059 2026-10-27 is cancelled\./],
      [{ ...FROM, ...legs(['LH', '0400'], ['DE', '2096']) }, /CHAIN: leg 2 does not leave from JFK\./],
      [{ ...FROM, ...legs(['DL', '0107'], ['B6', '0415']) }, /LAYOVER: leg 2 is not 90 min to 12 h after leg 1\./],
      [{ ...FROM, ...legs(['UA', '0927']) }, /FULL: UA 0927 2026-10-27 has no free seat\./]
    ]) await assert.rejects(action('rebookItinerary', '90000201', '0001', data), reason)
    assert.deepEqual(await travel('90000201'), before)
  })
})

describe('impact and proposals over itineraries', () => {
  test('itineraries with their legs, seats held by other plans on any leg, and a note that they share flights', async () => {
    const other = await cancel('LH', '0400', '2026-10-12')
    // A pending plan of another disruption: LH 0400 on 10-27 as leg 1, DL 0365 as leg 2.
    await INSERT.into('fr.Plans').entries({ ID: randomUUID(), disruption_ID: other, status: 'Pending', items: [{
      travelId: '00000101', bookingId: '0001', fromCarrierId: 'LH', fromConnectionId: '0400', fromFlightDate: '2026-10-12',
      toCarrierId: 'LH', toConnectionId: '0400', toFlightDate: D, legs: [{ legNo: 2, carrierId: 'DL', connectionId: '0365', flightDate: D }] }] })
    const ID = await cancel('LH', '0454', D)
    const impact = await agentTool('disruptionImpact', { disruption: ID })
    assert.equal(impact.affectedBookings.length, 9)
    assert.deepEqual(impact.itineraries.map(i => [i.id, i.route, i.arrivesOn, i.arrivesAt, i.connections, i.seatsAvailable]), [
      ['DE 2096 2026-10-27', 'FRA→SFO', D, '14:30:00', 0, 2],
      ['UA 0059 2026-10-27', 'FRA→SFO', D, '15:15:00', 0, 1],
      ['LH 0400 2026-10-27 > B6 0415 2026-10-27', 'FRA→JFK→SFO', D, '19:13:00', 1, 1],
      ['DL 0107 2026-10-27 > DL 0365 2026-10-27', 'FRA→JFK→SFO', D, '19:54:00', 1, 2],
      ['LH 0400 2026-10-27 > DL 0365 2026-10-27', 'FRA→JFK→SFO', D, '19:54:00', 1, 2],
      ['DE 2096 2026-10-28', 'FRA→SFO', '2026-10-28', '14:30:00', 0, 10]])
    assert.deepEqual(impact.legs.filter(l => l.connectionId === '0365').map(l => [l.itinerary, l.legNo, l.seatsFree, l.seatsHeld, l.seatsAvailable]), [
      ['DL 0107 2026-10-27 > DL 0365 2026-10-27', 2, 5, 1, 4], ['LH 0400 2026-10-27 > DL 0365 2026-10-27', 2, 5, 1, 4]])
    assert.match(impact.note, /^9 bookings, 6 itineraries .* Itineraries share flights/)
  })

  test('a plan names listed itineraries; another flight\'s itinerary and a shared flight overfilled are refused', async () => {
    await cancel('LH', '0400', '2026-10-12')
    const ID = await cancel('LH', '0454', D)
    const propose = assignments => agentTool('proposeRebooking', { disruption: ID, assignments, rationale: 'Test.' })
    const on = (travelId, bookingId, itinerary) => ({ travelId, bookingId, itinerary })
    await assert.rejects(propose([on('90000201', '0001', 'UA 0941 2026-10-12')]),
      /NOT_LISTED: Itinerary UA 0941 2026-10-12 is not listed for 90000201\/0001 on LH 0454 2026-10-27\./, 'listed for LH 0400 on 10-12 only')
    const viaDL = 'LH 0400 2026-10-27 > DL 0365 2026-10-27', viaB6 = 'LH 0400 2026-10-27 > B6 0415 2026-10-27'
    await assert.rejects(propose([on('90000202', '0001', viaDL), on('90000202', '0002', viaDL), on('90000202', '0003', viaDL), on('90000203', '0001', viaB6)]),
      /OVER_CAPACITY: Flight LH 0400 2026-10-27 has 3 seats available, the plan uses more\./, 'each itinerary fits; together they overfill LH 0400')
    assert.deepEqual(await SELECT.from('fr.Plans').where({ disruption_ID: ID }), [])
    const { plan } = await propose([on('90000202', '0001', viaDL), on('90000203', '0001', 'DE 2096 2026-10-27')])
    const items = await SELECT.from('fr.PlanItems').where({ plan_ID: plan }).orderBy('travelId')
    assert.deepEqual(items.map(i => [i.travelId, i.toCarrierId, i.toConnectionId, i.toFlightDate]), [['90000202', 'LH', '0400', D], ['90000203', 'DE', '2096', D]])
    assert.deepEqual((await SELECT.from('fr.PlanItemLegs').where({ item_ID: items[0].ID })).map(l => [l.legNo, l.carrierId, l.connectionId, l.flightDate]),
      [[2, 'DL', '0365', D]])
  })
})

describe('approving a plan of itineraries', () => {
  test('two legs go through rebookItinerary, one through rebook; each item is Rebooked with its legs and ABAP has the new bookings', async () => {
    const ID = await cancel('LH', '0454', D)
    globalThis.FR_LLM = { disruption: ID }
    const t = await ask(), req = paused(t)
    assert.equal(req.name, 'applyRebooking')
    assert.equal((await approve(t)).status.state, 'completed')
    const items = await SELECT.from('fr.PlanItems').where({ plan_ID: req.args.plan }).orderBy('travelId', 'bookingId')
    assert.deepEqual(items.map(i => [`${i.travelId}/${i.bookingId}`, i.status, i.message]), [
      ['90000201/0001', 'Rebooked', 'Moved to DE 2096 2026-10-27.'],
      ['90000201/0002', 'Rebooked', 'Moved to DE 2096 2026-10-27.'],
      ['90000201/0003', 'Rebooked', 'Moved to UA 0059 2026-10-27.'],
      ['90000201/0004', 'Rebooked', 'Moved to LH 0400 2026-10-27 › B6 0415 2026-10-27.'],
      ['90000202/0001', 'Rebooked', 'Moved to DL 0107 2026-10-27 › DL 0365 2026-10-27.'],
      ['90000202/0002', 'Rebooked', 'Moved to DL 0107 2026-10-27 › DL 0365 2026-10-27.'],
      ['90000202/0003', 'Rebooked', 'Moved to LH 0400 2026-10-27 › DL 0365 2026-10-27.'],
      ['90000203/0001', 'Rebooked', 'Moved to LH 0400 2026-10-27 › DL 0365 2026-10-27.'],
      ['90000203/0002', 'Rebooked', 'Moved to DE 2096 2026-10-28.']
    ], 'the same day takes eight; the ninth goes the next day')
    assert.equal((await SELECT.one.from('fr.Plans', req.args.plan)).status, 'Applied')
    assert.deepEqual((await travel('90000202')).map(b => `${b.BookingId} ${b.CarrierId} ${b.ConnectionId} ${Number(b.FlightPrice)}`), [
      '0001 DL 0107 6341', '0002 DL 0107 6341', '0003 LH 0400 6341', '0004 DL 0365 0', '0005 DL 0365 0', '0006 DL 0365 0'])
    assert.deepEqual([await free('LH', '0400', D), await free('DL', '0107', D), await free('B6', '0415', D), await free('DL', '0365', D)], [0, 0, 0, 1])
  })

  test('a booking moved since fails with STALE, a leg cancelled since with NOT_FLYING; the rest is applied', async () => {
    const ID = await cancel('LH', '0454', D)
    globalThis.FR_LLM = { disruption: ID }
    const t = await ask(), req = paused(t)
    await action('rebook', '90000201', '0001', { ...FROM, CarrierId: 'DE', ConnectionId: '2096', FlightDate: '2026-10-28' })
    await cancel('B6', '0415', D)
    assert.equal((await approve(t)).status.state, 'completed')
    const items = await SELECT.from('fr.PlanItems').where({ plan_ID: req.args.plan }).orderBy('travelId', 'bookingId')
    assert.deepEqual(items.filter(i => i.status === 'Failed').map(i => [`${i.travelId}/${i.bookingId}`, i.message]), [
      ['90000201/0001', 'STALE: 90000201/0001 is on DE 2096 2026-10-28.'],
      ['90000201/0004', 'NOT_FLYING: B6 0415 2026-10-27 is cancelled.']])
    assert.equal(items.filter(i => i.status === 'Rebooked').length, 7)
    assert.equal((await SELECT.one.from('fr.Plans', req.args.plan)).status, 'PartiallyApplied')
    assert.deepEqual((await travel('90000201')).map(b => `${b.BookingId} ${b.CarrierId} ${b.ConnectionId}`),
      ['0001 DE 2096', '0002 DE 2096', '0003 UA 0059', '0004 LH 0454'], 'the refused itinerary left no booking behind')
  })
})

describe('the seat board of an itinerary cancellation', () => {
  test('the cancelled flight, then the legs of up to five itineraries, the plan\'s first; moved bookings count on every leg', async () => {
    const ID = await cancel('LH', '0454', D)
    const row = f => [f.itinerary, f.legNo, `${f.carrierId} ${f.connectionId} ${f.flightDate}`, f.highlighted]
    const viaB6 = 'LH 0400 2026-10-27 > B6 0415 2026-10-27', viaDL = 'DL 0107 2026-10-27 > DL 0365 2026-10-27', viaLH = 'LH 0400 2026-10-27 > DL 0365 2026-10-27'
    assert.deepEqual(ok(await get(`flightBoard(disruption=${ID})`)).value.map(row), [
      [null, null, 'LH 0454 2026-10-27', 9],
      ['DE 2096 2026-10-27', 1, 'DE 2096 2026-10-27', 0],
      ['UA 0059 2026-10-27', 1, 'UA 0059 2026-10-27', 0],
      [viaB6, 1, 'LH 0400 2026-10-27', 0], [viaB6, 2, 'B6 0415 2026-10-27', 0],
      [viaDL, 1, 'DL 0107 2026-10-27', 0], [viaDL, 2, 'DL 0365 2026-10-27', 0],
      [viaLH, 1, 'LH 0400 2026-10-27', 0], [viaLH, 2, 'DL 0365 2026-10-27', 0]
    ], 'the sixth itinerary, DE 2096 the next day, is not shown')
    globalThis.FR_LLM = { disruption: ID }
    const t = await ask()
    paused(t)
    await approve(t)
    const after = ok(await get(`flightBoard(disruption=${ID})`)).value
    assert.deepEqual(after.slice(0, 3).map(row), [[null, null, 'LH 0454 2026-10-27', 0],
      ['DE 2096 2026-10-27', 1, 'DE 2096 2026-10-27', 2], ['UA 0059 2026-10-27', 1, 'UA 0059 2026-10-27', 1]])
    assert.deepEqual(after.filter(f => f.connectionId === '0365').map(f => f.highlighted), [4, 4], 'DL 0365 in two rows, the same four bookings')
    assert.equal(after.length, 9)
  })
})
