// The cockpit: its read model and demo reset against the mocked ZFR_REBOOK and the scripted model,
// and the browser modules' pure logic (loaded with a stubbed sap.ui.define).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
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
const control = (action, data = {}) => srv.post(`/odata/v4/control/${action}`, data, as('dispatcher'))
const get = (path, user = 'dispatcher') => srv.get(`/odata/v4/control/${path}`, as(user))

// A2A JSON-RPC to the agent.
const rpc = (method, params) => srv.post('/a2a/rebook-agent', { jsonrpc: '2.0', id: randomUUID(), method, params }, as('dispatcher'))
const message = (parts, extra = {}) => ({ message: { kind: 'message', role: 'user', messageId: randomUUID(), parts, ...extra } })
const ask = () => rpc('message/send', message([{ kind: 'text', text: 'LH 0400 on 2026-10-12 is cancelled. Rebook the passengers.' }]))
const approve = t => rpc('message/send', message([{ kind: 'text', text: 'approve' }], { taskId: t.id, contextId: t.contextId }))
const task = res => res.data?.result
const lastText = t => t.status.message.parts.filter(p => p.kind === 'text').map(p => p.text).join(' ')

const row = f => [f.carrierId, f.connectionId, f.flightDate, f.seatsBooked, f.seatsFree, f.cancelled, f.highlighted]
const bookings = () => SELECT.from('ZFR_REBOOK.Bookings').columns('TravelId', 'BookingId', 'CarrierId', 'ConnectionId', 'FlightDate').orderBy('TravelId', 'BookingId')

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

describe('flightBoard', () => {
  test('lists the cancelled flight first, then every same-route flight in the window, full ones included', async () => {
    const board = ok(await get(`flightBoard(disruption=${disruption})`)).value
    assert.deepEqual(board.map(row), [
      ['LH', '0400', '2026-10-12', 372, 8, true, 9],
      ['UA', '0941', '2026-10-12', 237, 3, false, 0],
      ['LH', '0400', '2026-10-13', 378, 2, false, 0],
      ['UA', '0941', '2026-10-13', 240, 0, false, 0],
      ['LH', '0400', '2026-10-14', 379, 1, false, 0]
    ], 'highlighted on the cancelled flight counts its 9 active bookings, not its seat counter')
    assert.equal(board[0].seatsMax, 380)
    assert.equal(board[0].departureTime, '10:10:00')
  })

  test('after an approved plan, the moved bookings are highlighted on their new flights', async () => {
    const t = task(await ask())
    assert.equal(t.status.state, 'input-required', JSON.stringify(t.status))
    assert.equal(task(await approve(t)).status.state, 'completed')
    const board = ok(await get(`flightBoard(disruption=${disruption})`)).value
    assert.deepEqual(board.map(row), [
      ['LH', '0400', '2026-10-12', 366, 14, true, 3],
      ['UA', '0941', '2026-10-12', 240, 0, false, 3],
      ['LH', '0400', '2026-10-13', 380, 0, false, 2],
      ['UA', '0941', '2026-10-13', 240, 0, false, 0],
      ['LH', '0400', '2026-10-14', 380, 0, false, 1]
    ])
  })

  test('an unknown disruption is 404; a user without the role is refused', async () => {
    const unknown = await get(`flightBoard(disruption=${randomUUID()})`)
    assert.equal(unknown.status, 404)
    assert.match(unknown.data.error.message, /^NO_DISRUPTION/)
    assert.equal((await get(`flightBoard(disruption=${disruption})`, 'viewer')).status, 403)
  })
})

// A stand-in for the ABAP system's ADT endpoints: a token on GET, `answer` on POST. Records what it was sent.
const adt = answer => new Promise(resolve => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-csrf-token'], cookie: req.headers.cookie, auth: req.headers.authorization })
    if (req.method === 'GET') return res.writeHead(200, { 'x-csrf-token': 'T1', 'set-cookie': 'sap-usercontext=abc; path=/' }).end('<app/>')
    res.writeHead(answer.status, { 'content-type': 'text/plain' }).end(answer.text)
  }).listen(0, () => resolve({ server, seen, url: `http://localhost:${server.address().port}` }))
})
// Runs `run` while the app believes it is connected to that stand-in.
async function connectedTo(answer, run) {
  const { server, seen, url } = await adt(answer)
  cds.env.requires.ZFR_REBOOK.credentials = { url: `${url}/sap/opu/odata4/sap/zfr_rebook_o4/srvd_a2x/sap/zfr_rebook/0001`, username: 'DEV', password: 'pw', queryParameters: { 'sap-client': '001' } }
  try { return await run(seen) } finally { delete cds.env.requires.ZFR_REBOOK.credentials; server.close() }
}
const flight = i => ({ backend: i.backend, carrierId: i.carrierId, connectionId: i.connectionId, flightDate: i.flightDate })
const MOCK = { backend: 'mock', carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12' }

describe('demo reset', () => {
  test('demoInfo names the mock flight while ZFR_REBOOK is mocked', async () => {
    assert.deepEqual(flight(ok(await get('demoInfo()'))), MOCK)
  })

  test('resetDemo clears disruptions and plans; an approval from before the reset changes nothing', async () => {
    const t = task(await ask())
    assert.equal(t.status.state, 'input-required', JSON.stringify(t.status))
    const before = await bookings()
    assert.deepEqual(flight(ok(await control('resetDemo'))), MOCK)
    for (const entity of ['fr.Disruptions', 'fr.Plans', 'fr.PlanItems']) assert.equal((await SELECT.from(entity)).length, 0, entity)
    assert.deepEqual(await SELECT.from('ZFR_REBOOK.FlightCancellations'), [], 'the mock\'s cancellations too')
    assert.match(lastText(task(await approve(t))), /NO_PLAN/)
    assert.deepEqual(await bookings(), before)
    globalThis.FR_LLM = { idle: true }
    ok(await control('cancelFlight', { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12' })) // the demo flight can be cancelled again
  })

  test('connected to ABAP, resetDemo runs the generator through ADT with a CSRF token and returns its demo flight', async () => {
    const text = '13144 bookings copied from /DMO/BOOKING into ZFR_BOOKING.\n1521 demo bookings added on FRA-EWR.\nDEMO_FLIGHT LH 0402 2026-10-14\n'
    await connectedTo({ status: 200, text }, async seen => {
      const demo = { backend: 'abap', carrierId: 'LH', connectionId: '0402', flightDate: '2026-10-14' }
      assert.deepEqual(flight(ok(await control('resetDemo'))), demo)
      assert.deepEqual(flight(ok(await get('demoInfo()'))), demo, 'remembered until the next reset')
      assert.deepEqual(seen, [
        { method: 'GET', url: '/sap/bc/adt/core/discovery?sap-client=001', token: 'fetch', cookie: undefined, auth: 'Basic ' + Buffer.from('DEV:pw').toString('base64') },
        { method: 'POST', url: '/sap/bc/adt/oo/classrun/ZCL_FR_GENERATE_DATA?sap-client=001', token: 'T1', cookie: 'sap-usercontext=abc', auth: 'Basic ' + Buffer.from('DEV:pw').toString('base64') }
      ])
      assert.equal((await SELECT.from('fr.Disruptions')).length, 0)
    })
  })

  test('when ADT refuses the run, resetDemo reports its answer and keeps the app state', async () => {
    await connectedTo({ status: 403, text: 'No authorization' }, async () => {
      const res = await control('resetDemo')
      assert.equal(res.status, 502, JSON.stringify(res.data))
      assert.match(res.data.error.message, /^RESET_FAILED: 403 No authorization/)
      assert.equal((await SELECT.from('fr.Disruptions')).length, 1)
    })
    await connectedTo({ status: 200, text: 'Something else\n' }, async () => {
      assert.match((await control('resetDemo')).data.error.message, /^RESET_FAILED: 200 Something else/, 'no DEMO_FLIGHT line')
    })
  })
})

// The page's modules are UI5 modules; their factories run under a stubbed sap.ui.define.
const ui = file => {
  let mod
  globalThis.sap = { ui: { define: (deps, factory) => { mod = factory() } } }
  require(`../app/cockpit/${file}`)
  return mod
}

describe('cockpit logic', () => {
  const logic = ui('logic.js')
  const load = (seatsMax, seatsBooked, highlighted, extra = {}) => ({ seatsMax, seatsBooked, highlighted, seatsFree: seatsMax - seatsBooked, cancelled: false, ...extra })

  test('labels and notes', () => {
    assert.equal(logic.flightLabel({ carrierId: 'LH', connectionId: '0402', flightDate: '2026-10-14' }), 'LH 0402 · 14 Oct')
    assert.equal(logic.flightLabel({ carrierId: 'UA', connectionId: '0043', flightDate: '2027-03-01' }), 'UA 0043 · 1 Mar')
    assert.equal(logic.note(load(264, 262, 0)), '2 free')
    assert.equal(logic.note(load(264, 264, 0)), 'full')
    assert.equal(logic.note(load(364, 9, 9, { cancelled: true })), 'cancelled')
  })

  test('the agent\'s progress on a disruption: working, failed, or a task to load once', () => {
    assert.deepEqual(logic.agentView(null, null), { busy: '', error: '', load: null })
    assert.deepEqual(logic.agentView({ agentStatus: 'Working' }, null), { busy: 'The agent is working on the cancellation', error: '', load: null })
    assert.deepEqual(logic.agentView({ agentStatus: 'Failed', agentMessage: 'No API key' }, null), { busy: '', error: 'No API key', load: null })
    assert.deepEqual(logic.agentView({ agentStatus: 'Failed' }, null).error, 'The agent stopped.')
    assert.deepEqual(logic.agentView({ agentStatus: 'AwaitingApproval', agentTask: 't-1' }, null), { busy: '', error: '', load: 't-1' })
    assert.deepEqual(logic.agentView({ agentStatus: 'AwaitingApproval', agentTask: 't-1' }, 't-1').load, null, 'loaded once')
    assert.deepEqual(logic.agentView({ agentStatus: 'Done', agentTask: 't-2' }, null).load, 't-2', 'nothing to approve: still show its answer')
  })

  test('while ABAP has not reported a cancellation: wait 15 s, then show ABAP\'s delivery status', () => {
    assert.deepEqual(logic.waiting(null, 3), { text: 'Waiting for ABAP to report the cancellation…', failed: false })
    assert.deepEqual(logic.waiting({ notifyStatus: null }, 20), { text: 'Waiting for ABAP to report the cancellation (still queued in ABAP)…', failed: false })
    assert.deepEqual(logic.waiting({ notifyStatus: 'S' }, 20), { text: 'ABAP reported the cancellation; waiting for the disruption…', failed: false })
    assert.deepEqual(logic.waiting({ notifyStatus: 'F', notifyMessage: 'CAP answered 401 Unauthorized' }, 20),
      { text: 'ABAP could not reach this app: CAP answered 401 Unauthorized', failed: true })
  })

  test('a new disruption takes over the page, except from a plan the dispatcher reviews or a disruption they chose', () => {
    const current = { ID: 'a', agentStatus: 'AwaitingApproval' }, newer = { ID: 'b', agentStatus: 'Working' }
    assert.equal(logic.pick([newer, current], current, true).ID, 'a', 'the dispatcher keeps the plan they are reviewing')
    assert.equal(logic.pick([newer, current], current, false).ID, 'b', 'approved or rejected: the next disruption takes over, whatever agentStatus still says')
    assert.equal(logic.pick([newer], current, true).ID, 'b', 'a closed disruption is no longer listed')
    assert.equal(logic.pick([], current, true), null)
    assert.equal(logic.pick([newer, current], null, false, 'a').ID, 'a', 'a disruption chosen in the list wins over the newest')
    assert.equal(logic.pick([newer], null, false, 'a').ID, 'b', 'a chosen disruption that was closed no longer counts')
  })

  test('dots never exceed the seats, whatever the counts', () => {
    assert.deepEqual(logic.dots(load(364, 9, 9)), { booked: 0, highlighted: 9, free: 355 })
    assert.deepEqual(logic.dots(load(264, 264, 2)), { booked: 262, highlighted: 2, free: 0 })
    assert.deepEqual(logic.dots(load(100, 120, 0)), { booked: 100, highlighted: 0, free: 0 }, 'overbooked')
    assert.deepEqual(logic.dots(load(100, 10, 50)), { booked: 0, highlighted: 10, free: 90 }, 'more highlighted than booked')
    assert.deepEqual(logic.dots(load(-5, -1, -1)), { booked: 0, highlighted: 0, free: 0 })
    assert.deepEqual(logic.dots({}), { booked: 0, highlighted: 0, free: 0 })
  })

  test('a flight is accepted the way people type it', () => {
    assert.deepEqual(logic.flightInput({ carrierId: ' lh ', connectionId: '402', flightDate: '2026-10-14' }), { carrierId: 'LH', connectionId: '0402', flightDate: '2026-10-14' })
    assert.deepEqual(logic.flightInput({ carrierId: 'UA', connectionId: '0043', flightDate: '2026-10-14' }), { carrierId: 'UA', connectionId: '0043', flightDate: '2026-10-14' })
    assert.deepEqual(logic.flightInput({ carrierId: '', connectionId: 'abc', flightDate: '' }), { carrierId: '', connectionId: 'abc', flightDate: '' }, 'left for the server to refuse')
    assert.deepEqual(logic.flightInput({}), { carrierId: '', connectionId: '', flightDate: '' })
  })

  test('plan items are grouped by target flight, with what ABAP answered', () => {
    const item = (travelId, bookingId, toConnectionId, toFlightDate, status = 'Planned', message = null) => ({ travelId, bookingId, toCarrierId: 'UA', toConnectionId, toFlightDate, status, message })
    assert.deepEqual(logic.groupPlan([
      item('90000003', '0001', '0043', '2026-10-14', 'Rebooked'), item('90000003', '0002', '0043', '2026-10-14', 'Failed', 'FULL: UA 0043 2026-10-14 has no free seat.'),
      item('90000001', '0001', '0043', '2026-10-15')
    ]), [
      { label: 'UA 0043 · 14 Oct', count: 2, rebooked: 1, failed: [{ text: '90000003/0002: FULL: UA 0043 2026-10-14 has no free seat.' }] },
      { label: 'UA 0043 · 15 Oct', count: 1, rebooked: 0, failed: [] }
    ])
    assert.deepEqual(logic.groupPlan(undefined), [])
  })

  test('the card title follows the plan', () => {
    assert.equal(logic.planTitle('Pending', true), 'Plan needs approval')
    assert.equal(logic.planTitle('Pending', false), 'Plan not applied')
    assert.equal(logic.planTitle('Applying', false), 'Applying the plan')
    assert.equal(logic.planTitle('Applied', false), 'Plan applied')
    assert.equal(logic.planTitle('PartiallyApplied', false), 'Plan partially applied')
    assert.equal(logic.planTitle('Failed', false), 'Plan failed')
    assert.equal(logic.planTitle('Superseded', false), 'Plan superseded')
  })

  test('a paused task yields its plan and no text (the plugin\'s approval request is not for people); a finished one only its text', () => {
    const paused = { status: { state: 'input-required', message: { parts: [{ kind: 'text', text: 'Earliest arrival first.' }], metadata: { 'sap.cds.agents.hitl': { actionRequests: [{ name: 'applyRebooking', args: { plan: 'p-1' } }] } } } } }
    assert.deepEqual(logic.reading(paused), { state: 'input-required', text: '', plan: 'p-1', failed: false })
    const done = { status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'There is no open disruption for LH 0402.' }, { kind: 'data', data: {} }] } } }
    assert.deepEqual(logic.reading(done), { state: 'completed', text: 'There is no open disruption for LH 0402.', plan: null, failed: false })
    // A failing model (missing key, quota) is not a JSON-RPC error: the plugin returns a task in state 'failed'.
    const failed = { status: { state: 'failed', message: { parts: [{ kind: 'text', text: 'Agent error: Missing API key' }] } } }
    assert.deepEqual(logic.reading(failed), { state: 'failed', text: 'Agent error: Missing API key', plan: null, failed: true })
    assert.deepEqual(logic.reading({ status: { state: 'canceled' } }), { state: 'canceled', text: '', plan: null, failed: true })
    assert.deepEqual(logic.reading(undefined), { state: undefined, text: '', plan: null, failed: false })
  })

  test('refreshes run one at a time; calls during a run merge into one run after it', async () => {
    let calls = 0
    const pending = [], tick = () => new Promise(setImmediate)
    const run = logic.serial(() => { calls++; return new Promise(resolve => pending.push(resolve)) })
    const first = run(), second = run(), third = run()
    await tick()
    assert.equal(calls, 1, 'no second run while the first is in flight')
    assert.equal(second, third, 'calls made during a run share one follow-up run')
    pending[0]()
    await tick()
    assert.equal(calls, 2, 'the follow-up starts after the first ends, so it reads what changed meanwhile')
    pending[1]()
    await Promise.all([first, second, third])
    const fourth = run()
    await tick()
    assert.equal(calls, 3, 'an idle wrapper runs at once')
    pending[2]()
    await fourth
  })

  test('the agent\'s markdown becomes safe HTML', () => {
    assert.equal(logic.html('**New flight:** UA <0043>\n- a & b\n- c\nDone'),
      '<p><strong>New flight:</strong> UA &lt;0043&gt;</p><ul><li>a &amp; b</li><li>c</li></ul><p>Done</p>')
    assert.equal(logic.html('One\n\nTwo'), '<p>One</p><p>Two</p>')
    assert.equal(logic.html(undefined), '')
    assert.equal(logic.html('Plan:\n| Flight | Seats |\n|---|:--:|\n| UA 0941 | 3 |\n| LH 0400 | 2 |\nDone'),
      '<p>Plan:</p><ul><li><strong>Flight · Seats</strong></li><li>UA 0941 · 3</li><li>LH 0400 · 2</li></ul><p>Done</p>', 'FormattedText allows no table: rows become list items')
  })
})

describe('cockpit A2A client', () => {
  const agent = ui('agent.js')
  // Answers one fetch and records the request the client made.
  const answering = async (response, call) => {
    const real = globalThis.fetch, sent = []
    globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return response }
    try { return { result: await call().then(r => ({ ok: r }), e => ({ error: e.message })), sent } } finally { globalThis.fetch = real }
  }
  const http = (status, body) => ({ ok: status < 400, status, json: async () => { if (body === undefined) throw new Error('not JSON'); return body } })
  const old = { id: 't-1', contextId: 'c-1' }

  test('ask, approve and reject are message/send calls; the last two resume the task', async () => {
    const asked = await answering(http(200, { result: { id: 't-1' } }), () => agent.ask('Rebook LH 0402.'))
    assert.deepEqual(asked.result, { ok: { id: 't-1' } })
    assert.equal(asked.sent[0].url, '/a2a/rebook-agent')
    assert.equal(asked.sent[0].body.method, 'message/send')
    assert.deepEqual(asked.sent[0].body.params.message.parts, [{ kind: 'text', text: 'Rebook LH 0402.' }])
    assert.equal(asked.sent[0].body.params.message.taskId, undefined)

    const approved = (await answering(http(200, { result: {} }), () => agent.approve(old))).sent[0].body.params.message
    assert.deepEqual([approved.taskId, approved.contextId, approved.parts], ['t-1', 'c-1', [{ kind: 'text', text: 'approve' }]])
    const rejected = (await answering(http(200, { result: {} }), () => agent.reject(old, 'Not now.'))).sent[0].body.params.message
    assert.deepEqual([rejected.taskId, rejected.parts], ['t-1', [{ kind: 'data', data: { decisions: [{ type: 'reject', message: 'Not now.' }] } }]])
  })

  test('task loads a task by its ID', async () => {
    const got = await answering(http(200, { result: { id: 't-9' } }), () => agent.task('t-9'))
    assert.deepEqual(got.result, { ok: { id: 't-9' } })
    assert.deepEqual([got.sent[0].body.method, got.sent[0].body.params], ['tasks/get', { id: 't-9' }])
  })

  test('a failing agent rejects with a message a person can read', async () => {
    assert.deepEqual((await answering(http(200, { error: { code: -32600, message: 'Invalid request' } }), () => agent.ask('x'))).result, { error: 'Invalid request' })
    assert.deepEqual((await answering(http(403, { error: { message: 'Forbidden' } }), () => agent.ask('x'))).result, { error: 'Forbidden' })
    assert.deepEqual((await answering(http(502, undefined), () => agent.ask('x'))).result, { error: 'The agent did not answer (502).' })
    assert.deepEqual((await answering(http(200, {}), () => agent.ask('x'))).result, { error: 'The agent did not answer (200).' })
  })
})

describe('cockpit in a browser', () => {
  test('the agent endpoint challenges for the login, so a browser sends the one it already has', async () => {
    const res = await srv.post('/a2a/rebook-agent', { jsonrpc: '2.0', id: '1', method: 'tasks/get', params: { id: 'x' } }, { validateStatus: () => true })
    assert.equal(res.status, 401)
    assert.equal(res.headers['www-authenticate'], 'Basic realm="Users"')
  })
})
