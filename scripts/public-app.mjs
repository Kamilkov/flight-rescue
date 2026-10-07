// ABAP reports every cancellation to the public app (SM59 ZFR_CAP_EVENTS), which then opens a disruption and runs its
// agent. A check that cancels a flight makes sure first that it can clean up there, and ends with the public app's
// Reset demo, which clears its disruptions and plans and reseeds ABAP. PUBLIC_URL defaults to the tunnel:
//   ssh -fN -L 4024:127.0.0.1:4024 root@<vps>
import { secrets } from './secrets.mjs'

export const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:4024'

async function call(path, init = {}) {
  const auth = 'Basic ' + Buffer.from(`dispatcher:${secrets('DISPATCHER_PASSWORD').DISPATCHER_PASSWORD}`).toString('base64')
  let res
  try {
    res = await fetch(`${publicUrl}${path}`, { ...init, headers: { authorization: auth, 'content-type': 'application/json' } })
  } catch (e) {
    throw new Error(`the public app at ${publicUrl} is not reachable (${e.cause?.code ?? e.message}); open the tunnel: ssh -fN -L 4024:127.0.0.1:4024 root@<vps>`)
  }
  if (!res.ok) throw new Error(`the public app at ${publicUrl} answered ${res.status} ${(await res.text()).slice(0, 200)}`)
}

/** Before any change: throws unless the public app answers its dispatcher. */
export const checkPublicApp = () => call('/odata/v4/control/demoInfo()')
/** Reset demo through the public app; throws unless it happened. */
export const resetPublicApp = () => call('/odata/v4/control/resetDemo', { method: 'POST', body: '{}' })

/** Runs every cleanup step, also after one failed; returns what each failed step left behind. */
export async function cleanup(steps) {
  const left = []
  for (const [what, step] of steps) {
    try { await step() } catch (e) { left.push(`${what}: ${e.message}`) }
  }
  return left
}

/** The exit code of a check: 0 passed and cleaned up, 1 failed, 2 passed but shared state was left behind. */
export function finish({ passed, left = [] }) {
  if (left.length) console.error(`INCOMPLETE: shared state left behind\n- ${left.join('\n- ')}`)
  return !passed ? 1 : left.length ? 2 : 0
}
