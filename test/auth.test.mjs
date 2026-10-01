// The deployed app keeps mocked users but gives them passwords from the environment (the VPS sets them).
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
delete process.env.ABAP_URL
Object.assign(process.env, { DISPATCHER_PASSWORD: 'd-secret', ABAP_EVENTS_PASSWORD: 'e-secret' })
const { default: cds } = await import('@sap/cds')
const srv = cds.test(root, '--with-mocks')

const as = (username, password) => ({ validateStatus: () => true, auth: { username, password } })

test('with passwords set, the mocked users need them', async () => {
  const disruptions = (u, p) => srv.get('/odata/v4/control/Disruptions', as(u, p)).then(r => r.status)
  assert.equal(await disruptions('dispatcher', ''), 401, 'empty password refused')
  assert.equal(await disruptions('dispatcher', 'wrong'), 401)
  assert.equal(await disruptions('dispatcher', 'd-secret'), 200)
  assert.equal(await disruptions('abap-events', 'e-secret'), 403, 'the event user has no dispatcher role')
  assert.equal(await disruptions('viewer', ''), 403)
})
