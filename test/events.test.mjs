// ABAP's event: the booking system reports a cancelled flight, the app opens the disruption and starts the agent
// as the dispatcher, and the dispatcher approves the paused task. ZFR_REBOOK mocked, scripted model.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.CDS_CONFIG = JSON.stringify({ requires: { llm: { impl: join(root, 'test/fixtures/scripted-llm.mjs'), model: 'scripted' } } })
delete process.env.ABAP_URL
delete process.env.DISPATCHER_PASSWORD
const { default: cds } = await import('@sap/cds')
const srv = cds.test(root, '--with-mocks')

const as = user => ({ validateStatus: () => true, ...(user && { auth: { username: user, password: '' } }) })
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.data)); return res.data }
const LH400 = { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12', reason: 'Bird "strike" in Köln' }
const event = (data = LH400, user = 'abap-events') => srv.post('/events/flightCancelled', data, as(user))
const rpc = (user, method, params) => srv.post('/a2a/rebook-agent', { jsonrpc: '2.0', id: randomUUID(), method, params }, as(user))
const until = async (fn, ms = 20000) => {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 50))) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
  }
}
const settled = ID => until(async () => { const d = await SELECT.one.from('fr.Disruptions', ID); return d?.agentStatus !== 'Working' && d })

beforeEach(async () => {
  await srv.data.reset()
  globalThis.FR_LLM = {}
})

describe('events from the booking system', () => {
  test('only the booking system may report events', async () => {
    assert.equal((await event(LH400, 'dispatcher')).status, 403)
    assert.equal((await event(LH400, 'viewer')).status, 403)
    assert.equal((await event(LH400, null)).status, 401)
    assert.deepEqual(await SELECT.from('fr.Disruptions'), [])
  })

  test('an event opens a disruption and starts the agent as the dispatcher; the paused task is theirs to approve', async () => {
    const r = ok(await event())
    assert.equal(r.duplicate, false)
    const d = await settled(r.disruption)
    assert.equal(d.agentStatus, 'AwaitingApproval', d.agentMessage)
    assert.deepEqual([d.airportFrom, d.airportTo, d.reason, d.status], ['FRA', 'JFK', 'Bird "strike" in Köln', 'Open'])

    const t = ok(await rpc('dispatcher', 'tasks/get', { id: d.agentTask })).result
    assert.equal(t.status.state, 'input-required')
    assert.equal((await rpc('viewer', 'tasks/get', { id: d.agentTask })).status, 403)
    assert.equal((await rpc('abap-events', 'tasks/get', { id: d.agentTask })).status, 403)

    const done = ok(await rpc('dispatcher', 'message/send', { message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: 'approve' }], taskId: t.id, contextId: t.contextId } })).result
    assert.equal(done.status.state, 'completed', JSON.stringify(done.status))
    const [plan] = await SELECT.from('fr.Plans').columns('status', 'agentTask', 'appliedBy')
    assert.deepEqual(plan, { status: 'Applied', agentTask: d.agentTask, appliedBy: 'dispatcher' })
  })

  test('a repeated event changes nothing', async () => {
    const first = ok(await event())
    await settled(first.disruption)
    const second = ok(await event())
    assert.deepEqual(second, { disruption: first.disruption, duplicate: true })
    assert.equal((await SELECT.from('fr.Disruptions')).length, 1)
    assert.equal((await SELECT.from('fr.Plans')).length, 1)
  })

  test('an unknown flight is refused', async () => {
    const r = await event({ ...LH400, flightDate: '2026-01-01' })
    assert.equal(r.status, 404)
    assert.match(r.data.error.message, /^NO_FLIGHT/)
  })

  test('when the agent has nothing to do it ends Done; when it fails, Failed with the reason', async () => {
    globalThis.FR_LLM = { idle: true }
    const idle = await settled(ok(await event()).disruption)
    assert.equal(idle.agentStatus, 'Done')
    assert.ok(idle.agentTask)

    globalThis.FR_LLM = { fail: true }
    const failed = await settled(ok(await event({ carrierId: 'LH', connectionId: '0402', flightDate: '2026-10-12' })).disruption)
    assert.equal(failed.agentStatus, 'Failed')
    assert.ok(failed.agentMessage, 'a reason a person can read')
  })

  test('the server\'s prompt names the flight and the disruption', async () => {
    const { prompt } = (await import('../srv/lib/agent-start.js')).default
    assert.equal(prompt({ ID: 'a2b4c6d8-0000-4000-8000-000000000001', carrierId: 'LH', connectionId: '0402', flightDate: '2026-10-14' }),
      'LH 0402 on 2026-10-14 was cancelled in the booking system (disruption a2b4c6d8-0000-4000-8000-000000000001). Rebook the passengers.')
  })
})
