// Checks against A4H itself, not the app. Exit code 0: passed (and cleaned up); 1: failed; 2: passed, but shared state
// was left behind (the output says what).
//   reset:   runs ZCL_FR_GENERATE_DATA through ADT, as Reset demo does, and prints what it says.
//   list [origin] [destination] [day]: prints what ZFR_REBOOK/Itineraries lists (default FRA, SFO, 15 days out).
//   graph:   step 1's gate. Resets the demo, then compares ZFR_REBOOK/Itineraries for every pair of airports on the
//            scenario day with the search in srv/lib/itineraries.js over the same Flights, checks FRA→SFO and FRA→HAV,
//            and prints the slowest answer and the pairs with a four-leg path among their ten earliest.
//   booking: step 2's gate. Resets the demo; checks rebookItinerary's refusals, NOT_FLYING on a flight it cancels, the
//            rollback of a failed change set, two travels after one last seat, and one rebooking that goes through;
//            resets again, also the public app, which ABAP tells about the cancellation (scripts/public-app.mjs).
// Secrets through scripts/secrets.mjs: SAP_USER, SAP_PASSWORD, and for booking DISPATCHER_PASSWORD.
//   node scripts/abap-check.mjs graph
import { createRequire } from 'node:module'
import { NS, get, grouped, padded, plusDays, post, reset, rows, scenarioDay } from './a4h.mjs'
import { checkPublicApp, cleanup, finish, resetPublicApp } from './public-app.mjs'
import { secrets } from './secrets.mjs'
const { search, id } = createRequire(import.meta.url)('../srv/lib/itineraries.js')

let failures = 0
const expect = (what, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${what}${detail ? `: ${detail}` : ''}`) }

async function list(origin = 'FRA', destination = 'SFO', day = plusDays(new Date().toISOString().slice(0, 10), 15)) {
  const t0 = Date.now()
  const its = grouped(await rows('Itineraries', { $filter: `Origin eq '${origin}' and Destination eq '${destination}' and FromDate eq ${day}` }))
  console.log(`${origin}→${destination} from ${day}: ${its.length} itineraries in ${Date.now() - t0} ms`)
  for (const l of its) {
    const seats = Math.min(...l.map(x => x.SeatsFree))
    console.log(`${l[0].ItineraryNo}. ${id(l)}, arrives ${l[0].ArrivesOn} ${l[0].ArrivesAt}, ${seats} seat${seats === 1 ? '' : 's'}`)
  }
  return { passed: true }
}

async function graph() {
  const day = scenarioDay(await reset())
  console.log(`scenario day ${day}`)
  // What the graph may use for that window: first flights on day to day + 2, later ones up to a day after.
  const flights = await rows('Flights', { $filter: `FlightDate ge ${day} and FlightDate le ${plusDays(day, 3)}` })
  const airports = [...new Set(flights.flatMap(f => [f.AirportFrom, f.AirportTo]))].sort()
  const listed = {}, four = []
  let slowest = { ms: 0 }, differ = 0
  for (const origin of airports) for (const destination of airports) {
    if (origin === destination) continue
    const pair = `${origin}→${destination}`, t0 = Date.now()
    const legs = await rows('Itineraries', { $filter: `Origin eq '${origin}' and Destination eq '${destination}' and FromDate eq ${day}` })
    const ms = Date.now() - t0
    if (ms > slowest.ms) slowest = { ms, pair }
    const graphs = listed[pair] = grouped(legs).map(l => ({ id: id(l), arrives: `${l[0].ArrivesOn} ${l[0].ArrivesAt}`, connections: l.length - 1 }))
    const query = { origin, destination, fromDate: day }
    const best = search(flights, query).map(i => ({ arrives: `${i.arrivesOn} ${i.arrivesAt}`, connections: i.connections }))
    const valid = new Set(search(flights, { ...query, k: Infinity }).map(i => id(i.legs)))
    // Rank by rank the same arrival and connections (tied itineraries may swap), each one a valid itinerary.
    const wrong = [
      ...(graphs.length !== best.length ? [`${graphs.length} itineraries, the search ${best.length}`] : []),
      ...graphs.flatMap((g, r) => [
        ...(best[r] && (g.arrives !== best[r].arrives || g.connections !== best[r].connections)
          ? [`rank ${r + 1}: ${g.arrives} with ${g.connections} connections, the search ${best[r].arrives} with ${best[r].connections}`] : []),
        ...(valid.has(g.id) ? [] : [`${g.id} is no valid itinerary`])])
    ]
    if (wrong.length) { differ++; expect(pair, false, wrong.join('; ')) }
    if (search(flights, { ...query, maxLegs: 4 }).some(i => i.legs.length === 4)) four.push(pair)
  }
  console.log(`${airports.length * (airports.length - 1) - differ} of ${airports.length * (airports.length - 1)} pairs match the search`)
  const sfo = listed['FRA→SFO'] ?? []
  expect('FRA→SFO: LH 0454, DE 2096 and UA 0059 direct, then LH 0400 › B6 0415 via JFK',
    JSON.stringify(sfo.slice(0, 4).map(i => i.id)) === JSON.stringify([`LH 0454 ${day}`, `DE 2096 ${day}`, `UA 0059 ${day}`, `LH 0400 ${day} > B6 0415 ${day}`]),
    sfo.slice(0, 6).map(i => `${i.id} ${i.arrives}`).join(' | '))
  const hav = listed['FRA→HAV']?.[0]
  expect('FRA→HAV: the first itinerary has three flights', hav?.connections === 2, hav?.id)
  const refused = await get('Itineraries', { $filter: `Origin eq 'FRA' and Destination eq 'SFO'` })
  const why = refused.data?.error?.message ?? ''
  expect('Itineraries without FromDate is refused', !refused.ok && why.includes('FILTER: Origin, Destination and FromDate needed.'), `${refused.status} ${why}`)
  expect('an unknown airport gives no itineraries',
    !(await rows('Itineraries', { $filter: `Origin eq 'XXX' and Destination eq 'SFO' and FromDate eq ${day}` })).length)
  console.log(`slowest answer: ${slowest.pair} in ${slowest.ms} ms${slowest.ms > 2000 ? ': over 2 s, stop and decide' : ''}`)
  console.log(`pairs with a four-leg path among their ten earliest: ${four.length}${four.length ? ` (${four.join(', ')})` : ''}`)
  return { passed: failures === 0 }
}

/** One $batch with one change set: rebookItinerary for each [booking, body]. Returns the raw multipart answer. */
function changeSet(calls) {
  const boundary = crypto.randomUUID(), crlf = '\r\n'
  const parts = calls.map(([b, body], i) => [`--changeset_${boundary}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary',
    `Content-ID: ${i + 1}`, '', `POST Bookings(TravelId='${b.TravelId}',BookingId='${b.BookingId}')/${NS}.rebookItinerary HTTP/1.1`,
    'Content-Type: application/json', 'Accept: application/json', '', JSON.stringify(body)].join(crlf))
  const body = [`--batch_${boundary}`, `Content-Type: multipart/mixed; boundary=changeset_${boundary}`, '', ...parts,
    `--changeset_${boundary}--`, `--batch_${boundary}--`, ''].join(crlf)
  return post('$batch', body, { 'content-type': `multipart/mixed; boundary=batch_${boundary}` })
}

async function booking() {
  // Everything the clean-up needs, before the first change: the public app's login, and the public app itself.
  secrets('DISPATCHER_PASSWORD')
  await checkPublicApp()
  const day = scenarioDay(await reset())
  console.log(`scenario day ${day}`)
  try {
    const flights = await rows('Flights', { $filter: `FlightDate ge ${day} and FlightDate le ${plusDays(day, 3)}` })
    const flight = (c, n, d = day) => {
      const f = flights.find(x => x.CarrierId === c && x.ConnectionId === n && x.FlightDate === d)
      if (!f) throw new Error(`${c} ${n} ${d} is not in Flights`)
      return f
    }
    const bookings = travel => rows('Bookings', { $filter: `TravelId eq '${travel}'`, $orderby: 'BookingId' })
    const itineraries = async () => grouped(await rows('Itineraries', { $filter: `Origin eq 'FRA' and Destination eq 'SFO' and FromDate eq ${day}` }))
    const seatsBooked = async f => (await rows('Flights', { $filter: `CarrierId eq '${f.CarrierId}' and ConnectionId eq '${f.ConnectionId}' and FlightDate eq ${f.FlightDate}` }))[0].SeatsBooked
    const from = { ExpectedCarrierId: 'LH', ExpectedConnectionId: '0454', ExpectedFlightDate: day }
    // Leg1* to Leg3*; a missing leg goes as ABAP's initial values.
    const legs = (...fs) => Object.assign({}, ...[0, 1, 2].map(i => ({ [`Leg${i + 1}CarrierId`]: fs[i]?.CarrierId ?? '',
      [`Leg${i + 1}ConnectionId`]: fs[i]?.ConnectionId ?? '0000', [`Leg${i + 1}FlightDate`]: fs[i]?.FlightDate ?? null })))
    const act = (b, action, body) => post(`Bookings(TravelId='${b.TravelId}',BookingId='${b.BookingId}')/${NS}.${action}`, body)
    const refused = async (what, b, action, body, re) => {
      const r = await act(b, action, body)
      expect(what, r.status >= 400 && re.test(r.message), `${r.status} ${r.message}`)
    }

    const [b1, b2] = await bookings('90000201'), [c1, c2] = await bookings('90000203')
    const lh0400 = flight('LH', '0400'), dl0365 = flight('DL', '0365'), b6 = flight('B6', '0415')
    await refused('STALE', b1, 'rebookItinerary', { ...from, ExpectedConnectionId: '0400', ...legs(lh0400, dl0365) }, /^STALE: 90000201\/0001 is on LH 0454 /)
    await refused('CHAIN', b1, 'rebookItinerary', { ...from, ...legs(lh0400, flight('DE', '2096')) }, /^CHAIN: leg 2 does not leave from JFK\.$/)
    await refused('LAYOVER (DL 0107 lands 59 min before B6 0415 leaves)', b1, 'rebookItinerary', { ...from, ...legs(flight('DL', '0107'), b6) },
      /^LAYOVER: leg 2 is not 90 min to 12 h after leg 1\.$/)
    await refused('FULL (the generator leaves SQ 0026 no seat)', b1, 'rebookItinerary', { ...from, ...legs(flight('SQ', '0026'), flight('DL', '0679')) },
      /^FULL: SQ 0026 /)

    // NOT_FLYING: a flight of a listed itinerary that has no bookings, cancelled for the check.
    const quiet = (await itineraries()).flat().find(l => l.FlightDate !== day && flight(l.CarrierId, l.ConnectionId, l.FlightDate).SeatsBooked === 0)
    if (!quiet) expect('a flight without bookings among the FRA→SFO itineraries', false)
    else {
      const name = `${quiet.CarrierId} ${quiet.ConnectionId} ${quiet.FlightDate}`
      const c = await post('FlightCancellations', { CarrierId: quiet.CarrierId, ConnectionId: quiet.ConnectionId, FlightDate: quiet.FlightDate, Reason: 'abap-check' })
      expect(`cancelled ${name}; ABAP reports it to the public app`, c.status === 201, `${c.status} ${c.message}`)
      expect(`Itineraries no longer list ${name}`, !(await itineraries()).flat().some(l => `${l.CarrierId} ${l.ConnectionId} ${l.FlightDate}` === name))
      await refused('rebook refuses it: NOT_FLYING', b1, 'rebook', { ...from, CarrierId: quiet.CarrierId, ConnectionId: quiet.ConnectionId, FlightDate: quiet.FlightDate },
        new RegExp(`^NOT_FLYING: ${name} is cancelled\\.$`))
      await refused('rebookItinerary refuses it: NOT_FLYING', b1, 'rebookItinerary', { ...from, ...legs(quiet) }, new RegExp(`^NOT_FLYING: ${name} is cancelled\\.$`))
    }

    // The rollback gate: two bookings of one travel onto the same two-leg itinerary, in one change set. Both compute the
    // same new booking ID, so one create collides with the other's, and RAP must save nothing of the change set.
    const [x, y] = await bookings('90000202')
    const state = async () => JSON.stringify([await bookings('90000202'), await seatsBooked(flight('LH', '0454')), await seatsBooked(lh0400), await seatsBooked(dl0365)])
    const before = await state()
    const batch = await changeSet([x, y].map(b => [b, { ...from, ...legs(lh0400, dl0365) }]))
    const saved = /NOT_SAVED: (\d{8})\\?\/(\d{4}) stays where it was\./.exec(batch.text)
    expect('the change set fails with NOT_SAVED for one of its two bookings, nothing else',
      !!saved && [x, y].some(b => b.TravelId === saved[1] && b.BookingId === saved[2]) && !/HTTP\/1\.1 2\d\d/.test(batch.text),
      saved ? saved[0] : batch.text.slice(0, 800))
    expect('nothing of it was saved: the bookings, the travel\'s rows and the seats are as before', await state() === before)

    // Two travels after the last seat on B6 0415, via LH 0400. In one change set, each action sees the free seat in the
    // database; the check at save sees both bookings and refuses. In two requests at once, one waits for the other.
    const seats = async () => JSON.stringify([await bookings('90000201'), await bookings('90000203'), await seatsBooked(b6), await seatsBooked(lh0400)])
    const s0 = await seats(), b6Before = await seatsBooked(b6)
    const both = await changeSet([[b1, { ...from, ...legs(lh0400, b6) }], [c1, { ...from, ...legs(lh0400, b6) }]])
    expect('two travels in one change set do not share the last seat: FULL, nothing saved',
      /FULL: B6 0415 /.test(both.text) && !/HTTP\/1\.1 2\d\d/.test(both.text) && await seats() === s0, both.text.match(/"message"\s*:\s*"[^"]*"/)?.[0] ?? both.text.slice(0, 800))
    const race = await Promise.all([b2, c2].map(b => act(b, 'rebookItinerary', { ...from, ...legs(lh0400, b6) })))
    const won = race.filter(r => r.status === 200).length, b6After = await seatsBooked(b6)
    expect('two travels at once: one gets the last seat, the other FULL or LOCKED',
      won === 1 && race.some(r => /^(FULL|LOCKED): /.test(r.message)) && b6After === b6Before + 1,
      `${race.map(r => `${r.status} ${r.message}`).join(' | ')}; B6 0415 booked ${b6Before} → ${b6After}`)

    // One rebooking that goes through: the booking on leg 1, a new booking in its travel for leg 2, at price 0.
    const moved = await act(x, 'rebookItinerary', { ...from, ...legs(lh0400, dl0365) })
    const after = await bookings('90000202'), added = after.find(b => b.BookingId === '0004')
    expect('rebookItinerary moves the booking and adds its second flight to the travel',
      moved.status === 200 && padded({ ...moved.data }).ConnectionId === '0400' && added?.CarrierId === 'DL' && added?.ConnectionId === '0365'
        && Number(added?.FlightPrice) === 0 && added?.BookingStatus === 'B' && added?.CustomerId === x.CustomerId,
      `${moved.status} ${moved.message} | ${after.map(b => `${b.BookingId} ${b.CarrierId} ${b.ConnectionId} ${b.FlightPrice}`).join(', ')}`)
  } catch (e) {
    expect('the check ran to its end', false, e.message)
  }
  const left = await cleanup([
    ['Reset demo in A4H (the check\'s cancellation and moved bookings stay)', reset],
    ['Reset demo in the public app (its disruption for the cancelled flight stays)', resetPublicApp]
  ])
  return { passed: failures === 0, left }
}

const modes = { reset: async () => { console.log(await reset()); return { passed: true } }, list: () => list(...process.argv.slice(3)), graph, booking }
const mode = process.argv[2]
if (!modes[mode]) {
  console.error(`Unknown mode "${mode ?? ''}": use reset, list, graph or booking.`)
  process.exit(1)
}
try {
  secrets('SAP_USER', 'SAP_PASSWORD') // before anything changes
  process.exit(finish(await modes[mode]()))
} catch (e) {
  console.error(e.cause?.code ? `${e.message} (${e.cause.code})` : e.message)
  process.exit(1)
}
