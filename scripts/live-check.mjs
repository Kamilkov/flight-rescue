// Live check against the deployed app. Exit code 0 only on success.
//   cancellation (default): resets the demo, cancels its flight in ABAP, and waits for ABAP's event and the paused agent.
//   traffic: resets the demo, replays the traffic incident, approves the agent's offers as the dispatcher, accepts the
//            phone booking's offer as the passenger, and expects that booking on its new flight.
// Needs the tunnel: ssh -fN -L 4024:127.0.0.1:4024 root@<vps>
//   APP_URL=http://localhost:4024 node --env-file=$HOME/.config/ai/secrets.env scripts/live-check.mjs [traffic]
const base = process.env.APP_URL ?? 'http://localhost:4024'
const basic = (user, password) => 'Basic ' + Buffer.from(`${user}:${password ?? ''}`).toString('base64')
const dispatcher = basic('dispatcher', process.env.DISPATCHER_PASSWORD), passenger = basic('passenger', process.env.PASSENGER_PASSWORD)
let t0 = Date.now(), seconds = () => Math.round((Date.now() - t0) / 1000)

async function http(path, body, auth = dispatcher) {
  const res = await fetch(`${base}${path}`, body
    ? { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { headers: { authorization: auth } })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data?.error?.message ?? ''}`)
  return data
}
const call = (path, body) => http(`/odata/v4/control/${path}`, body)
const a2a = async (method, params) => {
  const envelope = await http('/a2a/rebook-agent', { jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  if (envelope.error) throw new Error(`${method}: ${envelope.error.message}`)
  return envelope.result
}
// Polls `fn` every 2 s until it returns something, for at most `limit` seconds. A dropped tunnel is retried, not a result.
async function poll(fn, limit, what) {
  for (const end = Date.now() + limit * 1000; Date.now() < end; await new Promise(r => setTimeout(r, 2000))) {
    const v = await fn().catch(e => { if (e.cause?.code) { console.error(`poll failed, retrying: ${e.cause.code}`); return undefined } throw e })
    if (v) return v
  }
  throw new Error(`No ${what} after ${limit} s.`)
}

async function cancellation() {
  const demo = await call('resetDemo', {})
  const f = { carrierId: demo.carrierId, connectionId: demo.connectionId, flightDate: demo.flightDate }
  const status = () => call(`cancellation(carrierId='${f.carrierId}',connectionId='${f.connectionId}',flightDate=${f.flightDate})`)
  t0 = Date.now()
  await call('cancelFlight', { ...f, reason: 'Live check' })
  console.log(`cancelled ${f.carrierId} ${f.connectionId} ${f.flightDate} in ABAP`)
  const d = await poll(async () => {
    const x = (await call(`Disruptions?$filter=carrierId eq '${f.carrierId}' and connectionId eq '${f.connectionId}' and flightDate eq ${f.flightDate} and status eq 'Open'`)).value[0]
    return x && x.agentStatus !== 'Working' && x
  }, 120, 'agent result').catch(async e => { const c = await status(); throw new Error(`${e.message} ABAP notify status: ${c.notifyStatus ?? '(none)'} ${c.notifyMessage ?? ''}`) })
  const c = await status()
  console.log(`after ${seconds()} s: agent ${d.agentStatus}${d.agentMessage ? ` (${d.agentMessage})` : ''}; ABAP notify status ${c.notifyStatus}`)
  return d.agentStatus === 'AwaitingApproval' && c.notifyStatus === 'S'
}

async function traffic() {
  const demo = await call('resetDemo', {})
  const tf = demo.trafficFlight
  if (!tf?.carrierId) throw new Error('resetDemo named no traffic scenario (TRAFFIC_FLIGHT): is ZCL_FR_GENERATE_DATA with the traffic scenario active in ABAP, and is the app on this build?')
  console.log(`traffic scenario: ${tf.carrierId} ${tf.connectionId} ${tf.flightDate}`)
  t0 = Date.now()
  await call('replayTraffic', {})
  const d = await poll(async () => {
    const s = await call('trafficReplay()')
    if (s.done && !s.disruption) throw new Error(`The replay ended without a jam: ${s.note ?? ''}`)
    const x = s.disruption && await call(`Disruptions(${s.disruption})`)
    return x && x.agentStatus !== 'Working' && x
  }, 240, 'agent result')
  console.log(`after ${seconds()} s: ${d.reason}; agent ${d.agentStatus}${d.agentMessage ? ` (${d.agentMessage})` : ''}`)
  if (d.agentStatus !== 'AwaitingApproval') return false
  const task = await a2a('tasks/get', { id: d.agentTask })
  const done = await a2a('message/send', { message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: 'approve' }], taskId: task.id, contextId: task.contextId } })
  if (done.status?.state !== 'completed') throw new Error(`message/send: task state ${done.status?.state ?? 'unknown'}`)
  console.log(`offers approved: task ${done.status.state}`)
  const offer = await poll(async () => { const o = await http('/odata/v4/passenger/myOffer()', undefined, passenger); return o.status === 'Offered' && o }, 60, 'offer for the phone booking')
  console.log(`offer: ${offer.current.carrierId} ${offer.current.connectionId} → ${offer.offered.carrierId} ${offer.offered.connectionId} ${offer.offered.departureTime}`)
  const accepted = await http('/odata/v4/passenger/acceptOffer', {}, passenger)
  console.log(`accepted after ${seconds()} s: ${accepted.status} ${accepted.message ?? ''}`)
  const board = (await call(`flightBoard(disruption=${d.ID})`)).value
  const target = board.find(f => f.carrierId === offer.offered.carrierId && f.connectionId === offer.offered.connectionId)
  console.log(`seat board: ${board.map(f => `${f.carrierId} ${f.connectionId} ${f.affected ? 'at risk' : 'moved'} ${f.highlighted}, held ${f.held}`).join('; ')}`)
  return accepted.status === 'Rebooked' && target?.highlighted >= 1
}

const mode = process.argv[2]
if (mode !== undefined && mode !== 'traffic') {
  console.error(`Unknown mode "${mode}": use no argument (cancellation) or traffic.`)
  process.exit(1)
}

try {
  process.exit(await (mode === 'traffic' ? traffic() : cancellation()) ? 0 : 1)
} catch (e) {
  if (e.cause?.code) {
    console.error(`${e.message} (${e.cause.code})`)
  } else if (e instanceof TypeError || !e.message) {
    console.error(e.stack)
  } else {
    console.error(e.message)
  }
  process.exit(1)
}
