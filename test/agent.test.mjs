// The rebooking agent end to end: the real @cap-js/agents plugin, the real services, in-memory SQLite,
// ZFR_REBOOK mocked from srv/external, and a scripted model (no network, no key).
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

const opts = user => ({ validateStatus: () => true, auth: { username: user, password: '' } })
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data }
const control = (action, data, user = 'dispatcher') => srv.post(`/odata/v4/control/${action}`, data, opts(user))

// A2A JSON-RPC to the agent.
const rpc = (user, method, params) => srv.post('/a2a/rebook-agent', { jsonrpc: '2.0', id: randomUUID(), method, params }, opts(user))
const message = (parts, extra = {}) => ({ message: { kind: 'message', role: 'user', messageId: randomUUID(), parts, ...extra } })
const ask = (user = 'dispatcher') => rpc(user, 'message/send', message([{ kind: 'text', text: 'LH 0400 on 2026-10-12 is cancelled. Rebook the passengers.' }]))
const task = res => res.data?.result
const resume = (t, parts, user = 'dispatcher') => rpc(user, 'message/send', message(parts, { taskId: t.id, contextId: t.contextId }))
const approve = (t, user) => resume(t, [{ kind: 'text', text: 'approve' }], user)
const reject = t => resume(t, [{ kind: 'data', data: { decisions: [{ type: 'reject', message: 'Not now.' }] } }])
const edit = (t, name, args) => resume(t, [{ kind: 'data', data: { decisions: [{ type: 'edit', editedAction: { name, args } }] } }])
const paused = t => { assert.equal(t?.status?.state, 'input-required', JSON.stringify(t?.status)); return t.status.message.metadata['sap.cds.agents.hitl'].actionRequests[0] }
const lastText = t => t.status.message.parts.filter(p => p.kind === 'text').map(p => p.text).join(' ')

const abap = {
  bookings: () => SELECT.from('ZFR_REBOOK.Bookings').columns('TravelId', 'BookingId', 'CarrierId', 'ConnectionId', 'FlightDate', 'BookingStatus').orderBy('TravelId', 'BookingId'),
  seats: () => SELECT.from('ZFR_REBOOK.Flights').columns('CarrierId', 'ConnectionId', 'FlightDate', 'SeatsFree').orderBy('CarrierId', 'ConnectionId', 'FlightDate')
}
const plans = () => SELECT.from('fr.Plans').columns('ID', 'status', 'agentTask', 'appliedBy').orderBy('createdAt')
const items = plan => SELECT.from('fr.PlanItems').columns('travelId', 'bookingId', 'toCarrierId', 'toConnectionId', 'toFlightDate', 'status', 'message').where({ plan_ID: plan }).orderBy('travelId', 'bookingId')
const onFlight = (rows, c, n, d) => rows.filter(b => b.CarrierId === c && b.ConnectionId === n && b.FlightDate === d && b.BookingStatus !== 'X').map(b => `${b.TravelId}/${b.BookingId}`)

const until = async (fn, ms = 20000) => {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 50))) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
  }
}
// ABAP's event opens the disruption; wait until the agent it started has finished.
const opened = (carrierId, connectionId, flightDate) => until(async () => {
  const d = await SELECT.one.from('fr.Disruptions').where({ carrierId, connectionId, flightDate, status: 'Open' })
  return d && d.agentStatus !== 'Working' && d
})

let disruption
beforeEach(async () => {
  await srv.data.reset()
  globalThis.FR_LLM_TOOLS = []
  globalThis.FR_LLM = { idle: true } // the agent ABAP's event starts finds nothing to do; each test asks it itself
  ok(await control('cancelFlight', { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12', reason: 'Aircraft technical issue' }))
  disruption = (await opened('LH', '0400', '2026-10-12')).ID
  globalThis.FR_LLM = { disruption }
})

describe('impact', () => {
  test('lists active bookings and only same-route alternatives within two days that have seats', async () => {
    const { RebookAgentService } = cds.services
    const impact = await RebookAgentService.tx({ user: new cds.User({ id: 'dispatcher', roles: ['Dispatcher'] }) }, tx => tx.send('disruptionImpact', { disruption }))
    assert.equal(impact.disruption.flight, 'LH 0400 2026-10-12')
    assert.equal(impact.affectedBookings.length, 9, 'the cancelled booking 00000107/0001 is excluded')
    assert.ok(!impact.affectedBookings.some(b => b.travelId === '00000107'))
    assert.deepEqual(impact.alternatives.map(a => [a.carrierId, a.connectionId, a.flightDate, a.seatsAvailable]), [
      ['UA', '0941', '2026-10-12', 3], ['LH', '0400', '2026-10-13', 2], ['LH', '0400', '2026-10-14', 1]
    ], 'no FRA-EWR flight, no full UA 0941 on 10-13, nothing after 10-14')
    assert.equal(impact.seatsAvailable, 6)
    assert.match(impact.note, /3 will stay unassigned/)
  })

  test('a flight cancelled in the booking system is no alternative, even after its disruption was closed', async () => {
    globalThis.FR_LLM = { idle: true }
    ok(await control('cancelFlight', { carrierId: 'UA', connectionId: '0941', flightDate: '2026-10-12', reason: 'Crew' }))
    const ua = await opened('UA', '0941', '2026-10-12')
    ok(await control('closeDisruption', { disruption: ua.ID }))
    const { RebookAgentService } = cds.services
    const impact = await RebookAgentService.tx({ user: new cds.User({ id: 'dispatcher', roles: ['Dispatcher'] }) }, tx => tx.send('disruptionImpact', { disruption }))
    assert.deepEqual(impact.alternatives.map(a => `${a.carrierId} ${a.connectionId} ${a.flightDate}`), ['LH 0400 2026-10-13', 'LH 0400 2026-10-14'])
  })
})

describe('agent: pause, approve, reject', () => {
  test('nothing changes in ABAP before approval; approval moves the planned bookings once', async () => {
    const before = await abap.bookings(), seatsBefore = await abap.seats()
    const t = task(await ask())
    const req = paused(t)
    assert.equal(req.name, 'applyRebooking')
    assert.deepEqual(await abap.bookings(), before, 'no ABAP write before approval')
    const [p] = await plans()
    assert.deepEqual(p, { ID: req.args.plan, status: 'Pending', agentTask: t.id, appliedBy: null })

    const done = task(await approve(t))
    assert.equal(done.status.state, 'completed', JSON.stringify(done.status))
    const after = await abap.bookings()
    assert.equal(onFlight(after, 'LH', '0400', '2026-10-12').length, 3, 'three bookings had no seat and stay')
    assert.equal(onFlight(after, 'UA', '0941', '2026-10-12').length, 3)
    assert.equal(onFlight(after, 'LH', '0400', '2026-10-13').length, 2)
    assert.equal(onFlight(after, 'LH', '0400', '2026-10-14').length, 1)
    assert.deepEqual((await plans())[0], { ID: req.args.plan, status: 'Applied', agentTask: t.id, appliedBy: 'dispatcher' })
    assert.ok((await items(req.args.plan)).every(i => i.status === 'Rebooked'))
    const free = Object.fromEntries((await abap.seats()).map(f => [`${f.CarrierId} ${f.ConnectionId} ${f.FlightDate}`, f.SeatsFree]))
    const was = Object.fromEntries(seatsBefore.map(f => [`${f.CarrierId} ${f.ConnectionId} ${f.FlightDate}`, f.SeatsFree]))
    assert.deepEqual([free['UA 0941 2026-10-12'], free['LH 0400 2026-10-13'], free['LH 0400 2026-10-14'], free['LH 0400 2026-10-12']],
      [0, 0, 0, was['LH 0400 2026-10-12'] + 6])
    assert.equal((await approve(t)).data.error?.code, -32600, 'a completed task cannot be resumed')
    assert.deepEqual(globalThis.FR_LLM_TOOLS.at(-1), ['query', 'describe', 'disruptionImpact', 'proposeRebooking', 'applyRebooking', 'sendOffers'], 'effective tool list')
  })

  test('reject: ABAP and the plan stay unchanged', async () => {
    const before = await abap.bookings()
    const t = task(await ask()), req = paused(t)
    assert.equal(task(await reject(t)).status.state, 'completed')
    assert.deepEqual(await abap.bookings(), before)
    assert.equal((await plans())[0].status, 'Pending')
    assert.equal((await approve(t)).data.error?.code, -32600, 'a rejected task cannot be resumed')
    assert.equal(req.args.plan, (await plans())[0].ID)
  })

  test('a booking that moved in ABAP after the proposal fails alone; the rest is applied', async () => {
    const t = task(await ask()), req = paused(t)
    const [first] = await items(req.args.plan)
    // Someone rebooks this passenger directly in ABAP while the plan waits for approval.
    await cds.services.ZFR_REBOOK.send({ event: 'rebook', entity: 'ZFR_REBOOK.Bookings', params: [{ TravelId: first.travelId, BookingId: first.bookingId }],
      data: { ExpectedCarrierId: 'LH', ExpectedConnectionId: '0400', ExpectedFlightDate: '2026-10-12', CarrierId: 'LH', ConnectionId: '0400', FlightDate: '2026-10-16' } })
    assert.equal(task(await approve(t)).status.state, 'completed')
    const result = await items(req.args.plan)
    assert.equal(result[0].status, 'Failed')
    assert.match(result[0].message, /^STALE: \d{8}\/\d{4} is on LH 0400 2026-10-16\.$/)
    assert.ok(result.slice(1).every(i => i.status === 'Rebooked'))
    assert.equal((await plans())[0].status, 'PartiallyApplied')
  })
})

describe('agent: refusals', () => {
  test('a viewer cannot start the agent', async () => {
    const r = await ask('viewer')
    assert.equal(r.status, 403)
    assert.deepEqual(await plans(), [])
  })

  test('a plan over a flight\'s seats, with an unaffected booking, or with an extra argument is refused and nothing is saved', async () => {
    const over = Array.from({ length: 3 }, (_, i) => ({ travelId: ['00000101', '00000102', '00000102'][i], bookingId: ['0001', '0001', '0002'][i], carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-13' }))
    for (const [script, reason] of [
      [{ assignments: over }, /OVER_CAPACITY/],
      [{ assignments: [{ travelId: '00000109', bookingId: '0001', carrierId: 'UA', connectionId: '0941', flightDate: '2026-10-12' }] }, /NOT_AFFECTED/],
      [{ assignments: [{ travelId: '00000101', bookingId: '0001', carrierId: 'LH', connectionId: '0402', flightDate: '2026-10-12' }] }, /NOT_LISTED/],
      [{ extra: { approved: true } }, /Unrecognized key/]
    ]) {
      globalThis.FR_LLM = { disruption, ...script }
      const t = task(await ask())
      assert.equal(t.status.state, 'completed', JSON.stringify(t.status))
      assert.match(lastText(t), reason)
    }
    assert.deepEqual(await plans(), [])
  })

  test('an edited resume cannot substitute another plan', async () => {
    globalThis.FR_LLM = { disruption, stopAfterPropose: true }
    const other = task(await ask())
    assert.equal(other.status.state, 'completed')
    const [otherPlan] = await plans()
    globalThis.FR_LLM = { disruption }
    const t = task(await ask()), before = await abap.bookings()
    paused(t)
    const r = task(await edit(t, 'applyRebooking', { plan: otherPlan.ID }))
    assert.match(lastText(r), /NOT_REVIEWED/)
    assert.deepEqual(await abap.bookings(), before)
  })

  test('a closed disruption supersedes its pending plan; approving it then changes nothing', async () => {
    const t = task(await ask()), before = await abap.bookings()
    paused(t)
    ok(await control('closeDisruption', { disruption }))
    assert.equal((await plans())[0].status, 'Superseded')
    assert.match(lastText(task(await approve(t))), /CLOSED/)
    assert.deepEqual(await abap.bookings(), before)
  })

  test('cancelling the same flight twice is refused by the booking system', async () => {
    const r = await control('cancelFlight', { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12' })
    assert.equal(r.status, 400)
    assert.equal(r.data.error.message, 'ALREADY_CANCELLED: LH 0400 2026-10-12.')
    const unknown = await control('cancelFlight', { carrierId: 'LH', connectionId: '0400', flightDate: '2026-01-01' })
    assert.equal(unknown.data.error.message, 'NO_FLIGHT: LH 0400 2026-01-01 does not exist.')
  })

  test('the booking system reports the cancellation to the app, and its delivery status says so', async () => {
    const c = ok(await srv.get(`/odata/v4/control/cancellation(carrierId='LH',connectionId='0400',flightDate=2026-10-12)`, opts('dispatcher')))
    assert.deepEqual([c.carrierId, c.connectionId, c.flightDate, c.reason, c.notifyStatus], ['LH', '0400', '2026-10-12', 'Aircraft technical issue', 'S'])
    assert.equal((await srv.get(`/odata/v4/control/cancellation(carrierId='UA',connectionId='0941',flightDate=2026-10-12)`, opts('dispatcher'))).status, 404)
  })
})

test('rows from ABAP get their leading zeros back', async () => {
  const { padded } = (await import('../srv/lib/abap.js')).default
  // As the real binding answers: NUMC without leading zeros.
  assert.deepEqual(padded({ TravelId: '4506', BookingId: '4', CustomerId: '285', CarrierId: 'UA', ConnectionId: '926' }),
    { TravelId: '00004506', BookingId: '0004', CustomerId: '000285', CarrierId: 'UA', ConnectionId: '0926' })
  assert.equal(padded(undefined), undefined)
})
