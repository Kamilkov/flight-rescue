// The same flow over real HTTP: ZFR_REBOOK runs as a separate server (`cds mock`, login required) and this
// app reaches it only through ABAP_URL / SAP_USER / SAP_PASSWORD, as it would reach the ABAP trial. This
// covers what the in-process test cannot: CAP's OData queries, basic auth, the explicit bound-action path
// and how an OData error message comes back. The mock is a CAP server, so its action namespace is ZFR_REBOOK
// (ABAP's is com.sap.gateway.srvd_a2x.zfr_rebook.v0001) and it issues no CSRF tokens.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, after } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOCKED_OFF = { alice: false, bob: false, carol: false, dave: false, erin: false, fred: false, me: false, yves: false, '*': false }

// Start the stand-alone mock on a free port and wait for its URL.
const mock = spawn(process.execPath, [join(root, 'node_modules/.bin/cds'), 'mock', 'ZFR_REBOOK', '--port', '0'], {
  cwd: root,
  env: { ...process.env, ABAP_URL: '', CDS_ENV: 'development', CDS_CONFIG: JSON.stringify({ requires: {
    ZFR_REBOOK: { model: ['srv/external/ZFR_REBOOK', 'test/fixtures/abap-auth'] },
    auth: { kind: 'mocked', users: { COMM_USER: { password: 'secret' }, ...MOCKED_OFF } }
  } }) }
})
after(() => mock.kill())
const base = await new Promise((resolve, reject) => {
  let out = ''
  mock.stdout.on('data', d => { out += d; const m = out.match(/server listening on \{ url: '([^']+)'/); if (m) resolve(m[1]) })
  mock.on('exit', code => reject(new Error(`mock exited ${code}: ${out}`)))
  setTimeout(() => reject(new Error(`mock did not start: ${out}`)), 30000)
})
const abapGet = async path => (await fetch(`${base}/odata/v4/zfr-rebook/${path}`, { headers: { authorization: 'Basic ' + Buffer.from('COMM_USER:secret').toString('base64') } })).json()

Object.assign(process.env, { ABAP_URL: `${base}/odata/v4/zfr-rebook`, SAP_USER: 'COMM_USER', SAP_PASSWORD: 'secret' })
process.env.CDS_CONFIG = JSON.stringify({ requires: {
  llm: { impl: join(root, 'test/fixtures/scripted-llm.mjs'), model: 'scripted' },
  ZFR_REBOOK: { csrf: false, actionNamespace: 'ZFR_REBOOK' }
} })
const { default: cds } = await import('@sap/cds')
const srv = cds.test(root)

const opts = { validateStatus: () => true, auth: { username: 'dispatcher', password: '' } }
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data }
const rpc = (method, params) => srv.post('/a2a/rebook-agent', { jsonrpc: '2.0', id: randomUUID(), method, params }, opts)
const message = (parts, extra = {}) => ({ message: { kind: 'message', role: 'user', messageId: randomUUID(), parts, ...extra } })

describe('over HTTP, as against the ABAP trial', () => {
  test('ZFR_REBOOK is remote, not mocked in this process', async () => {
    assert.ok(await cds.connect.to('ZFR_REBOOK') instanceof cds.RemoteService)
    assert.equal(cds.env.requires.ZFR_REBOOK.credentials.url, `${base}/odata/v4/zfr-rebook`)
  })

  test('declare, propose, approve: bookings move in the remote system; a stale booking reports its OData error', async () => {
    const disruption = ok(await srv.post('/odata/v4/control/declareDisruption', { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12' }, opts))
    assert.deepEqual([disruption.airportFrom, disruption.airportTo], ['FRA', 'JFK'], 'flight read through $filter')
    globalThis.FR_LLM = { disruption: disruption.ID }
    const t = (await rpc('message/send', message([{ kind: 'text', text: 'Rebook LH 0400 on 2026-10-12.' }]))).data.result
    assert.equal(t.status.state, 'input-required', JSON.stringify(t.status))
    const plan = t.status.message.metadata['sap.cds.agents.hitl'].actionRequests[0].args.plan
    const planned = await SELECT.from('fr.PlanItems').where({ plan_ID: plan }).orderBy('travelId', 'bookingId')
    assert.equal(planned.length, 6, 'impact read bookings (ne, orderby) and flights (between) remotely')

    // A direct change in the remote system while the plan waits.
    const [first] = planned
    const res = await fetch(`${base}/odata/v4/zfr-rebook/Bookings(TravelId='${first.travelId}',BookingId='${first.bookingId}')/ZFR_REBOOK.rebook`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('COMM_USER:secret').toString('base64') },
      body: JSON.stringify({ ExpectedCarrierId: 'LH', ExpectedConnectionId: '0400', ExpectedFlightDate: '2026-10-12', CarrierId: 'LH', ConnectionId: '0400', FlightDate: '2026-10-16' })
    })
    assert.equal(res.status, 200)

    const done = (await rpc('message/send', message([{ kind: 'text', text: 'approve' }], { taskId: t.id, contextId: t.contextId }))).data.result
    assert.equal(done.status.state, 'completed', JSON.stringify(done.status))
    const items = await SELECT.from('fr.PlanItems').where({ plan_ID: plan }).orderBy('travelId', 'bookingId')
    assert.match(items[0].message, /^STALE: \d{8}\/\d{4} is on LH 0400 2026-10-16\.$/, 'the OData error text, not a transport wrapper')
    assert.deepEqual(items.slice(1).map(i => i.status), Array(5).fill('Rebooked'))
    assert.equal((await SELECT.one.from('fr.Plans', plan)).status, 'PartiallyApplied')

    const remote = (await abapGet("Bookings?$filter=CarrierId eq 'LH' and ConnectionId eq '0400' and FlightDate eq 2026-10-12 and BookingStatus ne 'X'")).value
    assert.equal(remote.length, 3, '9 active - 1 moved directly - 5 moved by the plan')
    for (const i of items.slice(1)) {
      const b = await abapGet(`Bookings(TravelId='${i.travelId}',BookingId='${i.bookingId}')`)
      assert.deepEqual([b.CarrierId, b.ConnectionId, b.FlightDate], [i.toCarrierId, i.toConnectionId, i.toFlightDate])
    }
  })

  test('a wrong password is refused by the remote system', async () => {
    const remote = await cds.connect.to('ZFR_REBOOK-wrong', { ...cds.env.requires.ZFR_REBOOK, credentials: { ...cds.env.requires.ZFR_REBOOK.credentials, password: 'wrong' } })
    await assert.rejects(remote.run(SELECT.from('ZFR_REBOOK.Flights')), e => /401|Unauthorized/i.test(`${e.message} ${e.reason?.message ?? ''} ${e.statusCode ?? e.reason?.response?.status ?? ''}`))
  })
})
