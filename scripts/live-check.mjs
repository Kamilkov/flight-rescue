// Live check against the deployed app: resets the demo, cancels its flight through the cockpit's API, and waits
// for ABAP's event to open the disruption and for the agent the server started. Exit code 0 only if ABAP reported
// the cancellation (S) and the agent paused for approval.
// Needs the tunnel: ssh -fN -L 4024:127.0.0.1:4024 root@<vps>
//   APP_URL=http://localhost:4024 node --env-file=$HOME/.config/ai/secrets.env scripts/live-check.mjs
const base = process.env.APP_URL ?? 'http://localhost:4024'
const auth = 'Basic ' + Buffer.from(`dispatcher:${process.env.DISPATCHER_PASSWORD ?? ''}`).toString('base64')
const call = async (path, body) => {
  const res = await fetch(`${base}/odata/v4/control/${path}`, body
    ? { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { headers: { authorization: auth } })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data?.error?.message ?? ''}`)
  return data
}

const demo = await call('resetDemo', {})
const f = { carrierId: demo.carrierId, connectionId: demo.connectionId, flightDate: demo.flightDate }
const cancellation = () => call(`cancellation(carrierId='${f.carrierId}',connectionId='${f.connectionId}',flightDate=${f.flightDate})`)
const t0 = Date.now(), seconds = () => Math.round((Date.now() - t0) / 1000)
await call('cancelFlight', { ...f, reason: 'Live check' })
console.log(`cancelled ${f.carrierId} ${f.connectionId} ${f.flightDate} in ABAP`)

for (;;) {
  // A dropped connection (SSH tunnel) is not a result: try again on the next round.
  const d = await call(`Disruptions?$filter=carrierId eq '${f.carrierId}' and connectionId eq '${f.connectionId}' and flightDate eq ${f.flightDate} and status eq 'Open'`)
    .then(r => r.value[0], e => { console.error(`poll failed, retrying: ${e.cause?.code ?? e.message}`); return undefined })
  if (d && d.agentStatus !== 'Working') {
    const c = await cancellation()
    console.log(`after ${seconds()} s: agent ${d.agentStatus}${d.agentMessage ? ` (${d.agentMessage})` : ''}; ABAP notify status ${c.notifyStatus}`)
    process.exit(d.agentStatus === 'AwaitingApproval' && c.notifyStatus === 'S' ? 0 : 1)
  }
  if (seconds() > 120) {
    const c = await cancellation()
    console.error(`No agent result after 120 s; ABAP notify status: ${c.notifyStatus ?? '(none)'} ${c.notifyMessage ?? ''}`)
    process.exit(1)
  }
  await new Promise(r => setTimeout(r, 2000))
}
