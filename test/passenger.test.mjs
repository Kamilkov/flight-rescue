// The passenger's phone: the offer after a traffic jam, and accepting it. ZFR_REBOOK mocked, scripted model.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.CDS_CONFIG = JSON.stringify({ requires: { llm: { impl: join(root, 'test/fixtures/scripted-llm.mjs'), model: 'scripted' } } })
delete process.env.ABAP_URL
delete process.env.PASSENGER_PASSWORD
const { default: cds } = await import('@sap/cds')
const srv = cds.test(root, '--with-mocks')

const as = user => ({ validateStatus: () => true, ...(user && { auth: { username: user, password: '' } }) })
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data }
const myOffer = (user = 'passenger') => srv.get('/odata/v4/passenger/myOffer()', as(user))
const accept = (user = 'passenger') => srv.post('/odata/v4/passenger/acceptOffer', {}, as(user))
const rpc = (method, params) => srv.post('/a2a/rebook-agent', { jsonrpc: '2.0', id: randomUUID(), method, params }, as('dispatcher'))
const message = (parts, extra = {}) => ({ message: { kind: 'message', role: 'user', messageId: randomUUID(), parts, ...extra } })
const booking = (TravelId, BookingId) => SELECT.one.from('ZFR_REBOOK.Bookings', { TravelId, BookingId })

async function jam() {
  const ID = randomUUID()
  await INSERT.into('fr.Disruptions').entries({ ID, kind: 'TrafficJam', airportFrom: 'FRA', jamDate: '2026-10-20', jamTime: '08:10:00',
    approach: 'badhomburg', road: 'A5', delayMinutes: 25, reason: 'A5 Niederrad - Flughafen-Nord → Darmstadt: queuing traffic, +25 min (test)' })
  return ID
}
/** A jam whose offers the agent proposed (paused at sendOffers), and with `send`, the dispatcher approved. */
async function offers(send = true) {
  const ID = await jam()
  const t = (await rpc('message/send', message([{ kind: 'text', text: `Traffic jam at FRA (disruption ${ID}). Offer the passengers at risk a later flight.` }]))).data.result
  assert.equal(t.status.state, 'input-required', JSON.stringify(t.status))
  if (send) assert.equal((await rpc('message/send', message([{ kind: 'text', text: 'approve' }], { taskId: t.id, contextId: t.contextId }))).data.result.status.state, 'completed')
  return ID
}

beforeEach(async () => {
  await srv.data.reset()
  globalThis.FR_LLM = {}
})

describe('the passenger\'s offer', () => {
  test('only the passenger reads and accepts offers', async () => {
    for (const [user, status] of [['dispatcher', 403], ['viewer', 403], [null, 401]]) {
      assert.equal((await myOffer(user)).status, status, String(user))
      assert.equal((await accept(user)).status, status, String(user))
    }
  })

  test('no offer before the dispatcher sends them', async () => {
    assert.equal(ok(await myOffer()).status, null)
    await offers(false)
    assert.equal(ok(await myOffer()).status, null, 'proposed but not sent')
    const r = await accept()
    assert.equal(r.status, 404)
    assert.match(r.data.error.message, /^NO_OFFER/)
  })

  test('the phone booking sees its offer; accepting moves it in ABAP, once', async () => {
    const ID = await offers()
    const o = ok(await myOffer())
    assert.deepEqual([o.status, o.travelId, o.bookingId, o.current.connectionId, o.current.departureTime, o.offered.connectionId, o.offered.departureTime],
      ['Offered', '90000102', '0001', '0400', '10:10:00', '0404', '17:15:00'])
    assert.match(o.reason, /^A5 Niederrad/)
    const a = ok(await accept())
    assert.deepEqual([a.status, a.message], ['Rebooked', 'Moved to LH 0404 2026-10-20.'])
    const b = await booking('90000102', '0001')
    assert.deepEqual([b.CarrierId, b.ConnectionId, b.FlightDate], ['LH', '0404', '2026-10-20'])
    const again = await accept()
    assert.equal(again.status, 409)
    assert.match(again.data.error.message, /^NOT_OFFERED: This offer is Rebooked, not open\./)
    const board = ok(await srv.get(`/odata/v4/control/flightBoard(disruption=${ID})`, as('dispatcher'))).value
    assert.deepEqual(board.map(f => [f.connectionId, f.highlighted, f.held]), [['0400', 3, 0], ['0107', 0, 2], ['0404', 1, 1]])
  })

  test('when ABAP refuses, the offer fails with ABAP\'s message and the booking stays', async () => {
    await offers()
    await UPDATE('ZFR_REBOOK.Flights').set({ SeatsFree: 0 }).where({ CarrierId: 'LH', ConnectionId: '0404', FlightDate: '2026-10-20' })
    const a = ok(await accept())
    assert.equal(a.status, 'Failed')
    assert.match(a.message, /^FULL: LH 0404 2026-10-20 has no free seat\./)
    assert.equal((await booking('90000102', '0001')).ConnectionId, '0400')
  })

  test('a closed disruption takes no answers', async () => {
    const ID = await offers()
    ok(await srv.post('/odata/v4/control/closeDisruption', { disruption: ID }, as('dispatcher')))
    const r = await accept()
    assert.equal(r.status, 409)
    assert.match(r.data.error.message, /^CLOSED/)
    assert.equal((await booking('90000102', '0001')).ConnectionId, '0400')
  })
})
