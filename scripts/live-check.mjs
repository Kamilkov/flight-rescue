// Live check against the deployed app. Exit code 0: passed (and cleaned up); 1: failed; 2: passed, but shared state was
// left behind (the output says what).
//   cancellation (default): resets the demo, cancels its flight in ABAP, and waits for ABAP's event and the paused agent.
//   traffic: resets the demo, replays the traffic incident, approves the agent's offers as the dispatcher, accepts the
//            phone booking's offer as the passenger, and expects that booking on its new flight.
//   itinerary: resets the demo, cancels the itinerary scenario's flight in ABAP and reports it to the app itself (ABAP
//            reports cancellations to the public app only), approves the agent's plan, and checks in ABAP that every
//            booking is on its itinerary: each moved booking on its first flight, a new booking for each further flight,
//            and the seats of every planned flight. Then resets the demo, here and in the public app.
//   event <carrier> <connection> <date>: reports a cancellation to the app as ABAP's event handler would.
// Secrets through scripts/secrets.mjs, only what the mode needs. The deployed app needs the tunnel:
//   ssh -fN -L 4024:127.0.0.1:4024 root@<vps>
//   node scripts/live-check.mjs [traffic]                                  (APP_URL defaults to http://localhost:4024)
//   APP_URL=http://localhost:4014 node scripts/live-check.mjs itinerary    (this branch's app on the Mac, on A4H)
import { rows } from './a4h.mjs'
import { checkPublicApp, cleanup, finish, publicUrl, resetPublicApp } from './public-app.mjs'
import { secrets } from './secrets.mjs'
const base = process.env.APP_URL ?? 'http://localhost:4024'
const basic = (user, password) => 'Basic ' + Buffer.from(`${user}:${password ?? ''}`).toString('base64')
const NEEDS = { cancellation: ['DISPATCHER_PASSWORD'], traffic: ['DISPATCHER_PASSWORD', 'PASSENGER_PASSWORD'],
  itinerary: ['DISPATCHER_PASSWORD', 'ABAP_EVENTS_PASSWORD', 'SAP_USER', 'SAP_PASSWORD'], event: ['ABAP_EVENTS_PASSWORD'] }
let dispatcher, passenger, abapEvents // set from the mode's secrets before it runs
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

/** ABAP's event for a cancelled flight, as ZCL_FR_FLIGHTCANCEL_EVENTS sends it. A repeat changes nothing. */
const report = f => http('/events/flightCancelled', { carrierId: f.carrierId, connectionId: f.connectionId, flightDate: f.flightDate, reason: f.reason ?? 'Aircraft technical issue' }, abapEvents)
const name = x => `${x.CarrierId ?? x.carrierId} ${x.ConnectionId ?? x.connectionId} ${String(x.FlightDate ?? x.flightDate).slice(0, 10)}`
/** A plan item's flights in order: to*, then its further legs. */
const flightsOf = i => [{ carrierId: i.toCarrierId, connectionId: i.toConnectionId, flightDate: i.toFlightDate },
  ...[...i.legs].sort((a, b) => a.legNo - b.legNo)]

async function itinerary() {
  if (base !== publicUrl) await checkPublicApp() // its clean-up must work, so make sure before the first change
  const f = (await call('resetDemo', {})).itineraryFlight
  if (!f?.carrierId) throw new Error('resetDemo named no itinerary scenario (ITINERARY_FLIGHT): is ZCL_FR_GENERATE_DATA with the itinerary scenario active in ABAP, and is the app on this build?')
  const own = name(f), problems = []
  console.log(`itinerary scenario: ${own}`)
  try {
    t0 = Date.now()
    await call('cancelFlight', { ...f, reason: 'Live check' })
    await report({ ...f, reason: 'Live check' }) // ABAP's own event goes to the app behind ZFR_CAP_EVENTS, the public one
    const d = await poll(async () => {
      const x = (await call(`Disruptions?$filter=carrierId eq '${f.carrierId}' and connectionId eq '${f.connectionId}' and flightDate eq ${f.flightDate} and status eq 'Open'`)).value[0]
      return x && x.agentStatus !== 'Working' && x
    }, 240, 'agent result')
    console.log(`after ${seconds()} s: agent ${d.agentStatus}${d.agentMessage ? ` (${d.agentMessage})` : ''}`)
    if (d.agentStatus !== 'AwaitingApproval') throw new Error(`the agent ended ${d.agentStatus}`)
    const task = await a2a('tasks/get', { id: d.agentTask })
    const plan = task.status.message.metadata['sap.cds.agents.hitl'].actionRequests[0].args.plan
    const planned = (await call(`Plans(${plan})?$expand=items($expand=legs)`)).items
    // What ABAP holds before the approval: the bookings on the cancelled flight, the plan's travels, the seats on its flights.
    const affected = await rows('Bookings', { $filter: `CarrierId eq '${f.carrierId}' and ConnectionId eq '${f.connectionId}' and FlightDate eq ${f.flightDate} and BookingStatus ne 'X'` })
    const travels = [...new Set(planned.map(i => i.travelId))]
    const flights = new Map([[own, f], ...planned.flatMap(flightsOf).map(x => [name(x), x])])
    const snapshot = async () => ({
      seats: Object.fromEntries(await Promise.all([...flights.values()].map(async x => [name(x), (await rows('Flights', {
        $filter: `CarrierId eq '${x.carrierId}' and ConnectionId eq '${x.connectionId}' and FlightDate eq ${String(x.flightDate).slice(0, 10)}` }))[0]?.SeatsBooked]))),
      bookings: Object.fromEntries(await Promise.all(travels.map(async t => [t, await rows('Bookings', { $filter: `TravelId eq '${t}'` })])))
    })
    const before = await snapshot()
    const done = await a2a('message/send', { message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: 'approve' }], taskId: task.id, contextId: task.contextId } })
    if (done.status?.state !== 'completed') throw new Error(`message/send: task state ${done.status?.state ?? 'unknown'}`)
    const items = (await call(`Plans(${plan})?$expand=items($expand=legs)`)).items, after = await snapshot()
    console.log(`after ${seconds()} s: ${items.map(i => `${i.travelId}/${i.bookingId} → ${flightsOf(i).map(name).join(' › ')} ${i.status}`).join('; ')}`)

    // The scenario: every booking on the cancelled flight is planned, and at least one goes over several flights.
    if (items.length !== affected.length) problems.push(`the plan assigns ${items.length} of the ${affected.length} bookings on ${own}`)
    if (!items.some(i => i.legs.length)) problems.push('no booking got an itinerary of two or three flights')
    for (const i of items.filter(i => i.status !== 'Rebooked')) problems.push(`${i.travelId}/${i.bookingId} ${i.status}: ${i.message}`)
    const moved = items.filter(i => i.status === 'Rebooked')
    // Seats, as ABAP counts them from ZFR_BOOKING: every planned flight up by the bookings planned onto it, the
    // cancelled one down by the moved bookings.
    const onto = {}
    for (const x of moved.flatMap(flightsOf)) onto[name(x)] = (onto[name(x)] ?? 0) + 1
    for (const [k, n] of Object.entries(after.seats)) {
      const expected = k === own ? -moved.length : onto[k] ?? 0
      if (n - before.seats[k] !== expected) problems.push(`${k}: ${before.seats[k]} → ${n} seats booked, expected ${expected >= 0 ? '+' : ''}${expected}`)
    }
    // Bookings: each moved booking on its first flight; for each further flight a new booking in its travel at price 0.
    for (const t of travels) {
      const was = new Set(before.bookings[t].map(b => b.BookingId))
      const added = after.bookings[t].filter(b => !was.has(b.BookingId)).map(b => `${name(b)} ${Number(b.FlightPrice)} ${b.BookingStatus}`).sort()
      const expected = moved.filter(i => i.travelId === t).flatMap(i => flightsOf(i).slice(1)).map(x => `${name(x)} 0 B`).sort()
      if (JSON.stringify(added) !== JSON.stringify(expected)) problems.push(`travel ${t}: new bookings [${added.join(', ')}], expected [${expected.join(', ')}]`)
      for (const i of moved.filter(i => i.travelId === t)) {
        const b = after.bookings[t].find(x => x.BookingId === i.bookingId)
        if (!b || name(b) !== name(flightsOf(i)[0])) problems.push(`${t}/${i.bookingId} is on ${b ? name(b) : 'nothing'}, expected ${name(flightsOf(i)[0])}`)
      }
    }
    console.log(problems.length ? `✗ ${problems.join('\n✗ ')}` : `✓ ${moved.length} bookings on their itineraries in ABAP, ${moved.filter(i => i.legs.length).length} of them over several flights; every planned flight's seats as planned`)
  } catch (e) {
    problems.push(e.message)
    console.error(`✗ ${e.message}`)
  }
  const left = await cleanup([
    [`Reset demo in the app at ${base} (ABAP keeps the cancellation of ${own} and the moved bookings)`, () => call('resetDemo', {})],
    ...(base !== publicUrl ? [[`Reset demo in the public app (it keeps its disruption for ${own})`, resetPublicApp]] : [])
  ])
  return { passed: !problems.length, left }
}

const event = async (carrierId, connectionId, flightDate) => { console.log(await report({ carrierId, connectionId, flightDate })); return true }
const modes = { cancellation, traffic, itinerary, event: () => event(...process.argv.slice(3)) }
const mode = process.argv[2] ?? 'cancellation'
if (!modes[mode]) {
  console.error(`Unknown mode "${mode}": use no argument (cancellation), traffic, itinerary or event.`)
  process.exit(1)
}

try {
  const s = secrets(...NEEDS[mode]) // before anything changes
  dispatcher = basic('dispatcher', s.DISPATCHER_PASSWORD); passenger = basic('passenger', s.PASSENGER_PASSWORD); abapEvents = basic('abap-events', s.ABAP_EVENTS_PASSWORD)
  const result = await modes[mode]()
  process.exit(finish(typeof result === 'boolean' ? { passed: result } : result))
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
