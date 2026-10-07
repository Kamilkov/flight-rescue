const cds = require('@sap/cds')
const abap = require('./abap')
const { id: itineraryId } = require('./itineraries')

// Rebooking rules, shared by the agent and the control service. The server decides what is valid:
// the agent can only choose among the bookings, itineraries and alternatives impact() lists, and nothing reaches
// ABAP until apply() runs after a person approved the plan, or, for a traffic jam, until a passenger accepts an offer.

// Cancellation: ABAP's graph lists itineraries of one to three flights to the destination (srv/lib/itineraries.js).
// Traffic jam: flights leaving 60–180 min after the jam are affected; an offer is a flight on the same route, the same
// day, leaving at least 45 min after the booking's own flight. Times are FRA local, like /DMO/ departure times.
const JAM = { fromMin: 60, toMin: 180, gapMin: 45 }
const flightName = f => `${f.carrierId ?? f.CarrierId} ${f.connectionId ?? f.ConnectionId} ${abap.iso(f.flightDate ?? f.FlightDate)}`
const flightKey = f => flightName(f)
const at = (date, time) => Date.parse(`${abap.iso(date)}T${String(time).slice(0, 8)}Z`) // naive local time, for comparing only

async function openDisruption(req, ID) {
  const d = await SELECT.one.from('fr.Disruptions').where({ ID })
  if (!d) return req.reject(404, `NO_DISRUPTION: Disruption ${ID} does not exist.`)
  if (d.status !== 'Open') return req.reject(409, `CLOSED: Disruption ${ID} is closed.`)
  return d
}

/** Seats promised elsewhere, by flight: pending plans of other disruptions (every leg of their itineraries), and every
 *  offer not answered yet on an open disruption. */
async function heldSeats(disruptionID) {
  const cols = ['toCarrierId', 'toConnectionId', 'toFlightDate', 'count(*) as seats'], by = ['toCarrierId', 'toConnectionId', 'toFlightDate']
  const legs = ['carrierId as toCarrierId', 'connectionId as toConnectionId', 'flightDate as toFlightDate', 'count(*) as seats']
  const rows = [
    ...await SELECT.from('fr.PlanItems').columns(...cols).where({ 'plan.status': 'Pending', 'plan.disruption_ID': { '!=': disruptionID } }).groupBy(...by),
    ...await SELECT.from('fr.PlanItemLegs').columns(...legs).where({ 'item.plan.status': 'Pending', 'item.plan.disruption_ID': { '!=': disruptionID } })
      .groupBy('carrierId', 'connectionId', 'flightDate'),
    ...await SELECT.from('fr.PlanItems').columns(...cols).where({ status: { in: ['Offered', 'Accepting'] }, 'plan.disruption.status': 'Open' }).groupBy(...by)
  ]
  const held = {}
  for (const h of rows) {
    const key = flightKey({ carrierId: h.toCarrierId, connectionId: h.toConnectionId, flightDate: h.toFlightDate })
    held[key] = (held[key] ?? 0) + Number(h.seats)
  }
  return held
}

/** One leg of a listed itinerary, with the seats still free after other plans and open offers. */
const leg = (l, legNo, itinerary, held) => {
  const seatsHeld = held[flightKey(l)] ?? 0
  return {
    itinerary, legNo, carrierId: l.CarrierId, connectionId: l.ConnectionId, flightDate: abap.iso(l.FlightDate),
    airportFrom: l.AirportFrom, airportTo: l.AirportTo, departureTime: l.DepartureTime, arrivalTime: l.ArrivalTime,
    seatsFree: l.SeatsFree, seatsHeld, seatsAvailable: Math.max(0, l.SeatsFree - seatsHeld)
  }
}

/** One listed alternative for flight `from`. */
const alternative = (f, from, held) => {
  const seatsHeld = held[flightKey(f)] ?? 0
  return {
    carrierId: f.CarrierId, connectionId: f.ConnectionId, flightDate: abap.iso(f.FlightDate),
    departureTime: f.DepartureTime, arrivalTime: f.ArrivalTime,
    daysLater: Math.round((Date.parse(abap.iso(f.FlightDate)) - Date.parse(abap.iso(from.flightDate ?? from.FlightDate))) / 864e5),
    seatsFree: f.SeatsFree, seatsHeld, seatsAvailable: Math.max(0, f.SeatsFree - seatsHeld), forFlight: flightName(from)
  }
}
const booking = b => ({ travelId: b.TravelId, bookingId: b.BookingId, carrierId: b.CarrierId, connectionId: b.ConnectionId, flightDate: abap.iso(b.FlightDate) })
const summary = d => ({
  ID: d.ID, kind: d.kind, flight: d.kind === 'TrafficJam' ? null : flightName(d),
  carrierId: d.carrierId, connectionId: d.connectionId, flightDate: d.flightDate ? abap.iso(d.flightDate) : null,
  airportFrom: d.airportFrom, airportTo: d.airportTo, reason: d.reason,
  jamDate: d.jamDate ?? null, jamTime: d.jamTime ?? null, road: d.road ?? null, delayMinutes: d.delayMinutes ?? null
})

/** Affected bookings and the only valid itineraries (cancellation) or alternatives (traffic jam), with the seats still
 *  free after other plans and open offers. */
async function impact(req, disruptionID) {
  const d = await openDisruption(req, disruptionID)
  return d.kind === 'TrafficJam' ? jamImpact(d) : cancellationImpact(d)
}

async function cancellationImpact(d) {
  const [bookings, routes, held] = await Promise.all([abap.bookingsOn(d), abap.itineraries(d), heldSeats(d.ID)])
  // Only a cancellation takes its flight out of service; a jam's flights still fly.
  const disrupted = new Set((await SELECT.from('fr.Disruptions').where({ status: 'Open', kind: 'Cancellation' })).map(flightKey))
  const itineraries = [], legs = [], uses = {}
  for (const route of routes) {
    if (route.some(l => disrupted.has(flightKey(l)))) continue
    const id = itineraryId(route), rows = route.map((l, n) => leg(l, n + 1, id, held))
    const seatsAvailable = Math.min(...rows.map(r => r.seatsAvailable))
    if (!seatsAvailable) continue
    for (const r of rows) uses[flightKey(r)] = (uses[flightKey(r)] ?? 0) + 1
    itineraries.push({ id, route: [route[0].AirportFrom, ...route.map(l => l.AirportTo)].join('→'), arrivesOn: abap.iso(route[0].ArrivesOn),
      arrivesAt: route[0].ArrivesAt, connections: route.length - 1, seatsAvailable, forFlight: flightName(d) })
    legs.push(...rows)
  }
  // Itineraries sharing a flight make the sum of their seats an upper bound, not a count.
  const n = bookings.length, seats = itineraries.reduce((sum, i) => sum + i.seatsAvailable, 0), shared = Object.values(uses).some(u => u > 1)
  return {
    disruption: summary(d),
    affectedBookings: bookings.map(booking), // no customer data for the model
    itineraries, legs, alternatives: [],
    seatsAvailable: seats,
    note: !n ? 'No active bookings on this flight: nothing to rebook.'
      : !itineraries.length ? 'No itinerary has a free seat on every flight: no rebooking is possible.'
      : [`${n} bookings, ${itineraries.length} itineraries of one to three flights, earliest arrival first.`,
        shared ? 'Itineraries share flights: per flight, keep the bookings across all itineraries within its seatsAvailable in legs.' : '',
        seats < n ? `${shared ? 'At most' : 'Only'} ${seats} seats for ${n} bookings: ${shared ? 'at least ' : ''}${n - seats} will stay unassigned.`
          : shared ? '' : `Enough seats for all ${n} bookings.`].filter(Boolean).join(' ')
  }
}

/** A traffic jam: bookings driving via the jammed approach on flights leaving 60–180 min later, and later flights that
 *  day. Bookings without passenger context are not contacted. The model sees references and counts, never context. */
async function jamImpact(d) {
  const jam = at(d.jamDate, d.jamTime), after = f => (at(f.FlightDate, f.DepartureTime) - jam) / 6e4
  const flights = (await abap.departures(d.airportFrom, d.jamDate)).filter(f => !f.IsCancelled && after(f) >= JAM.fromMin && after(f) <= JAM.toMin)
  const context = new Map((await SELECT.from('fr.PassengerContext')).map(c => [`${c.travelId}/${c.bookingId}`, c]))
  const held = await heldSeats(d.ID)
  // One request holds the app's only DB connection while it waits for ABAP, so the flights are read in parallel.
  const found = await Promise.all(flights.map(async f => {
    const on = await abap.bookingsOn({ carrierId: f.CarrierId, connectionId: f.ConnectionId, flightDate: f.FlightDate })
    const known = on.map(b => [b, context.get(`${b.TravelId}/${b.BookingId}`)]).filter(([, c]) => c)
    if (!known.length) return null // nobody on this flight we know anything about
    const n = test => known.filter(([, c]) => test(c)).length
    const atRisk = known.filter(([, c]) => c.arrival === 'Car' && c.approach === d.approach).map(([b]) => booking(b))
    const note = `${known.length} bookings with passenger context on ${flightName(f)}: ${atRisk.length} at risk (driving via ${d.approach}), `
      + `${n(c => c.arrival === 'Car' && c.approach !== d.approach)} driving via another approach, ${n(c => c.arrival === 'Train')} by train, `
      + `${n(c => c.arrival === 'CheckedIn')} checked in${on.length > known.length ? `; ${on.length - known.length} without passenger context are not contacted` : ''}.`
    if (!atRisk.length) return { note, atRisk, alternatives: [] }
    const route = { carrierId: f.CarrierId, connectionId: f.ConnectionId, flightDate: f.FlightDate, airportFrom: f.AirportFrom, airportTo: f.AirportTo }
    const later = (await abap.sameRoute(route, 0)).filter(a => !a.IsCancelled && at(a.FlightDate, a.DepartureTime) - at(f.FlightDate, f.DepartureTime) >= JAM.gapMin * 6e4)
    return { note, atRisk, alternatives: later.map(a => alternative(a, f, held)).filter(a => a.seatsAvailable > 0) }
  }))
  const reads = found.filter(Boolean) // in the order of the flights
  const affectedBookings = reads.flatMap(r => r.atRisk), alternatives = reads.flatMap(r => r.alternatives), notes = reads.map(r => r.note)
  // ponytail: seats are summed per listed alternative; a flight listed for two affected flights counts twice, in the
  // returned seatsAvailable as well as the note (propose() checks capacity per flight). Two jammed flights on one route: count distinct flights then.
  const seats = alternatives.reduce((n, a) => n + a.seatsAvailable, 0), risk = affectedBookings.length
  return {
    disruption: summary(d), affectedBookings, alternatives, itineraries: [], legs: [], seatsAvailable: seats,
    note: [...notes,
      !risk ? 'Nobody is at risk: there is no offer to make.'
        : !alternatives.length ? 'No later flight has a free seat: no offer is possible.'
        : seats < risk ? `Only ${seats} seats for ${risk} bookings at risk: ${risk - seats} will get no offer.`
        : `Enough seats to offer all ${risk} bookings at risk a later flight.`].join(' ')
  }
}

/** A flight's seats for the cockpit's fill map. */
const load = (f, extra) => ({
  carrierId: f.CarrierId, connectionId: f.ConnectionId, flightDate: abap.iso(f.FlightDate),
  airportFrom: f.AirportFrom, airportTo: f.AirportTo, departureTime: f.DepartureTime, arrivalTime: f.ArrivalTime,
  seatsMax: f.SeatsMax, seatsBooked: f.SeatsBooked, seatsFree: f.SeatsFree,
  cancelled: false, affected: false, highlighted: 0, held: 0, ...extra
})

/** Cancellation: the cancelled flight, then the legs of up to 5 itineraries, the latest plan's first, then the listed
 *  ones; a flight shared by itineraries shows in each of their rows. Jam: see jamBoard. */
async function board(req, disruptionID) {
  const d = await SELECT.one.from('fr.Disruptions').where({ ID: disruptionID })
  if (!d) return req.reject(404, `NO_DISRUPTION: Disruption ${disruptionID} does not exist.`)
  if (d.kind === 'TrafficJam') return jamBoard(d)
  const plan = await SELECT.one.from('fr.Plans').columns('ID').where({ disruption_ID: d.ID }).orderBy('createdAt desc')
  const [own, routes, bookings, planned, rebooked] = await Promise.all([
    abap.flight(d), abap.itineraries(d), abap.bookingsOn(d), plan ? flightsOfItems({ plan_ID: plan.ID }) : [],
    flightsOfItems({ status: 'Rebooked', 'plan.disruption_ID': d.ID })
  ])
  const moved = {} // bookings moved onto each flight, as leg 1 or a further leg
  for (const f of rebooked.flat()) moved[flightKey(f)] = (moved[flightKey(f)] ?? 0) + 1
  const shown = new Map()
  for (const legs of [...planned, ...routes]) if (shown.size < 5 && !shown.has(itineraryId(legs))) shown.set(itineraryId(legs), legs)
  const keys = new Map([...shown.values()].flat().map(l => [flightKey(l), l]))
  const flights = new Map((await Promise.all([...keys.values()].map(l => abap.flight({ carrierId: l.carrierId ?? l.CarrierId,
    connectionId: l.connectionId ?? l.ConnectionId, flightDate: l.flightDate ?? l.FlightDate })))).filter(Boolean).map(f => [flightKey(f), f]))
  const rows = own ? [load(own, { cancelled: true, highlighted: bookings.length, itinerary: null, legNo: null })] : []
  for (const [itinerary, legs] of shown) legs.forEach((l, n) => {
    const f = flights.get(flightKey(l))
    if (f) rows.push(load(f, { itinerary, legNo: n + 1, highlighted: moved[flightKey(l)] ?? 0 }))
  })
  return rows
}

/** The flights of the plan items matching `where`, per item: to*, then its further legs. */
async function flightsOfItems(where) {
  const items = await SELECT.from('fr.PlanItems').columns('ID', 'toCarrierId', 'toConnectionId', 'toFlightDate').where(where).orderBy('travelId', 'bookingId')
  const legs = items.length ? await SELECT.from('fr.PlanItemLegs').where({ item_ID: { in: items.map(i => i.ID) } }).orderBy('legNo') : []
  return items.map(i => [{ carrierId: i.toCarrierId, connectionId: i.toConnectionId, flightDate: i.toFlightDate }, ...legs.filter(l => l.item_ID === i.ID)])
}

/** Jam: each flight with bookings at risk or offers (affected), then the later flights that day on its route.
 *  Offers hold seats only while the jam is open, as in heldSeats: a closed jam's board shows none as held. */
async function jamBoard(d) {
  const [now, items] = await Promise.all([jamImpact(d), SELECT.from('fr.PlanItems').where({ 'plan.disruption_ID': d.ID })])
  const own = new Map(), atRisk = {}
  for (const b of now.affectedBookings) { own.set(flightName(b), b); atRisk[flightName(b)] = (atRisk[flightName(b)] ?? 0) + 1 }
  for (const i of items) own.set(flightName({ carrierId: i.fromCarrierId, connectionId: i.fromConnectionId, flightDate: i.fromFlightDate }),
    { carrierId: i.fromCarrierId, connectionId: i.fromConnectionId, flightDate: i.fromFlightDate })
  const to = (i, f) => flightName({ carrierId: i.toCarrierId, connectionId: i.toConnectionId, flightDate: i.toFlightDate }) === flightName(f)
  const count = (statuses, f) => items.filter(i => statuses.includes(i.status) && to(i, f)).length
  // Parallel for the same reason as in jamImpact: ABAP is read while the app's only DB connection is held.
  const reads = await Promise.all([...own.values()].map(async f => {
    const flight = await abap.flight(f)
    if (!flight) return null
    const route = { carrierId: flight.CarrierId, connectionId: flight.ConnectionId, flightDate: flight.FlightDate, airportFrom: flight.AirportFrom, airportTo: flight.AirportTo }
    return { f, flight, later: await abap.sameRoute(route, 0) }
  }))
  const rows = []
  for (const { f, flight, later } of reads.filter(Boolean)) {
    rows.push(load(flight, { affected: true, highlighted: atRisk[flightName(f)] ?? 0 }))
    for (const a of later)
      if (at(a.FlightDate, a.DepartureTime) > at(flight.FlightDate, flight.DepartureTime))
        rows.push(load(a, { highlighted: count(['Rebooked'], a), held: d.status === 'Open' ? count(['Offered', 'Accepting'], a) : 0 }))
  }
  return rows
}

/** Saves a Pending plan. Every assignment must use a listed booking, and an itinerary (cancellation) or an alternative
 *  (traffic jam) listed for that booking's own flight, within the seats of every flight it uses. */
async function propose(req, { disruption, assignments = [], rationale }, agentTask = null) {
  const now = await impact(req, disruption)
  if (!assignments.length) return req.reject(400, `EMPTY: A plan needs at least one assignment. ${now.note}`)
  const jam = now.disruption.kind === 'TrafficJam'
  const bookings = new Map(now.affectedBookings.map(b => [`${b.travelId}/${b.bookingId}`, b]))
  const seen = new Set(), used = {}, items = []
  for (const a of assignments) {
    const key = `${a.travelId}/${a.bookingId}`, b = bookings.get(key)
    if (!b) return req.reject(400, `NOT_AFFECTED: Booking ${key} is not an affected booking of this disruption.`)
    if (seen.has(key)) return req.reject(400, `DUPLICATE: Booking ${key} is assigned twice.`)
    let flights // the flights this assignment puts the booking on, in order, each with its seatsAvailable
    if (jam) {
      const listed = now.alternatives.find(x => flightKey(x) === flightKey(a) && x.forFlight === flightName(b))
      if (!listed) return req.reject(400, `NOT_LISTED: Flight ${flightKey(a)} is not a listed alternative for ${key} on ${flightName(b)}.`)
      flights = [listed]
    } else {
      const listed = now.itineraries.find(i => i.id === a.itinerary && i.forFlight === flightName(b))
      if (!listed) return req.reject(400, `NOT_LISTED: Itinerary ${a.itinerary} is not listed for ${key} on ${flightName(b)}.`)
      flights = now.legs.filter(l => l.itinerary === listed.id)
    }
    seen.add(key)
    for (const f of flights)
      if ((used[flightKey(f)] = (used[flightKey(f)] ?? 0) + 1) > f.seatsAvailable)
        return req.reject(400, `OVER_CAPACITY: Flight ${flightKey(f)} has ${f.seatsAvailable} seats available, the plan uses more.`)
    const [first, ...further] = flights
    items.push({
      travelId: a.travelId, bookingId: a.bookingId,
      fromCarrierId: b.carrierId, fromConnectionId: b.connectionId, fromFlightDate: b.flightDate,
      toCarrierId: first.carrierId, toConnectionId: first.connectionId, toFlightDate: abap.iso(first.flightDate),
      legs: further.map((l, n) => ({ legNo: n + 2, carrierId: l.carrierId, connectionId: l.connectionId, flightDate: abap.iso(l.flightDate) }))
    })
  }

  await UPDATE('fr.Plans').set({ status: 'Superseded' }).where({ disruption_ID: disruption, status: 'Pending' })
  const plan = { ID: cds.utils.uuid(), disruption_ID: disruption, status: 'Pending', rationale: String(rationale ?? '').slice(0, 1000), agentTask, items }
  await INSERT.into('fr.Plans').entries(plan)
  const unassigned = now.affectedBookings.filter(b => !seen.has(`${b.travelId}/${b.bookingId}`)).map(b => ({ travelId: b.travelId, bookingId: b.bookingId }))
  return { plan: plan.ID, disruption, assigned: assignments.length, unassigned, status: 'Pending',
    message: `Plan saved as Pending. Nothing changed in the booking system yet.${unassigned.length ? ` ${unassigned.length} booking(s) stay unassigned.` : ''}` }
}

/** Moves one plan item's booking in ABAP, onto one flight (rebook) or an itinerary (rebookItinerary, all or nothing),
 *  and records ABAP's answer on the item: Rebooked, or Failed with ABAP's message. */
async function moveItem(i) {
  const legs = [{ carrierId: i.toCarrierId, connectionId: i.toConnectionId, flightDate: i.toFlightDate },
    ...await SELECT.from('fr.PlanItemLegs').columns('carrierId', 'connectionId', 'flightDate').where({ item_ID: i.ID }).orderBy('legNo')]
  const flights = legs.map(l => ({ CarrierId: l.carrierId, ConnectionId: l.connectionId, FlightDate: l.flightDate }))
  const booking = { TravelId: i.travelId, BookingId: i.bookingId }, from = { CarrierId: i.fromCarrierId, ConnectionId: i.fromConnectionId, FlightDate: i.fromFlightDate }
  let status = 'Rebooked', message = `Moved to ${legs.map(flightName).join(' › ')}.`
  try {
    await (flights.length > 1 ? abap.rebookItinerary(booking, from, flights) : abap.rebook(booking, from, flights[0]))
  } catch (e) { status = 'Failed'; message = e.message }
  await UPDATE('fr.PlanItems', i.ID).with({ status, message })
  return { status, message }
}

/** Runs an approved cancellation plan against ABAP, booking by booking, and records each answer. Never throws after the first call. */
async function apply(req, planID, agentTask) {
  const plan = await SELECT.one.from('fr.Plans').where({ ID: planID })
  if (!plan) return req.reject(404, `NO_PLAN: Plan ${planID} does not exist.`)
  if (!agentTask || plan.agentTask !== agentTask) return req.reject(409, 'NOT_REVIEWED: This plan was not proposed in this agent task.')
  const d = await openDisruption(req, plan.disruption_ID)
  if (d.kind === 'TrafficJam') return req.reject(409, 'WRONG_KIND: Offers are sent with sendOffers.')
  // Claims the plan; a second approval of the same plan finds it no longer Pending.
  const claimed = await UPDATE('fr.Plans').set({ status: 'Applying' }).where({ ID: planID, status: 'Pending' })
  if (claimed !== 1) return req.reject(409, `NOT_PENDING: Plan ${planID} is ${plan.status}, not Pending.`)

  const items = await SELECT.from('fr.PlanItems').where({ plan_ID: planID }).orderBy('travelId', 'bookingId')
  const failed = []
  for (const i of items) {
    const { status, message } = await moveItem(i)
    if (status === 'Failed') failed.push({ travelId: i.travelId, bookingId: i.bookingId, message })
  }
  const rebooked = items.length - failed.length
  const status = !failed.length ? 'Applied' : rebooked ? 'PartiallyApplied' : 'Failed'
  await UPDATE('fr.Plans', planID).with({ status, appliedBy: req.user.id, appliedAt: new Date().toISOString() })
  return { plan: planID, status, rebooked, failed,
    message: `${rebooked} of ${items.length} booking(s) moved in the booking system.${failed.length ? ` ${failed.length} failed; see failed.` : ''}` }
}

/** Sends an approved traffic-jam plan's offers: the plan and its items become Offered. Nothing reaches ABAP. */
async function sendOffers(req, planID, agentTask) {
  const plan = await SELECT.one.from('fr.Plans').where({ ID: planID })
  if (!plan) return req.reject(404, `NO_PLAN: Plan ${planID} does not exist.`)
  if (!agentTask || plan.agentTask !== agentTask) return req.reject(409, 'NOT_REVIEWED: This plan was not proposed in this agent task.')
  const d = await openDisruption(req, plan.disruption_ID)
  if (d.kind !== 'TrafficJam') return req.reject(409, 'WRONG_KIND: A cancellation plan is applied with applyRebooking.')
  const claimed = await UPDATE('fr.Plans').set({ status: 'Offered', appliedBy: req.user.id, appliedAt: new Date().toISOString() }).where({ ID: planID, status: 'Pending' })
  if (claimed !== 1) return req.reject(409, `NOT_PENDING: Plan ${planID} is ${plan.status}, not Pending.`)
  const offered = await UPDATE('fr.PlanItems').set({ status: 'Offered', message: 'Waiting for the passenger.' }).where({ plan_ID: planID })
  return { plan: planID, status: 'Offered', offered,
    message: `${offered} offer(s) sent. Nothing changed in the booking system: each passenger accepts or not.` }
}

/** The latest sent offer for a booking, with both flights' departure times; { status: null } when there is none. */
async function offerOf(b) {
  if (!b) return { status: null }
  for (const p of await SELECT.from('fr.Plans').columns('ID', 'disruption_ID').where({ status: 'Offered' }).orderBy('createdAt desc')) {
    const i = await SELECT.one.from('fr.PlanItems').where({ plan_ID: p.ID, travelId: b.travelId, bookingId: b.bookingId })
    if (!i) continue
    const current = { carrierId: i.fromCarrierId, connectionId: i.fromConnectionId, flightDate: abap.iso(i.fromFlightDate) }
    const offered = { carrierId: i.toCarrierId, connectionId: i.toConnectionId, flightDate: abap.iso(i.toFlightDate) }
    const [d, from, to] = await Promise.all([SELECT.one.from('fr.Disruptions', p.disruption_ID).columns('reason'), abap.flight(current), abap.flight(offered)])
    return { item: i.ID, status: i.status, message: i.message, reason: d?.reason ?? null, travelId: i.travelId, bookingId: i.bookingId,
      current: { ...current, departureTime: from?.DepartureTime ?? null }, offered: { ...offered, departureTime: to?.DepartureTime ?? null } }
  }
  return { status: null }
}

/** A passenger accepts an offer: ABAP moves that one booking. The claim makes a second answer NOT_OFFERED. */
async function accept(req, itemID) {
  const i = await SELECT.one.from('fr.PlanItems').where({ ID: itemID })
  if (!i) return req.reject(404, 'NO_OFFER: There is no offer to accept.')
  const plan = await SELECT.one.from('fr.Plans').columns('disruption_ID').where({ ID: i.plan_ID })
  await openDisruption(req, plan.disruption_ID)
  const claimed = await UPDATE('fr.PlanItems').set({ status: 'Accepting' }).where({ ID: itemID, status: 'Offered' })
  if (claimed !== 1) return req.reject(409, `NOT_OFFERED: This offer is ${i.status}, not open.`)
  await moveItem(i)
}

module.exports = { impact, board, propose, apply, sendOffers, offerOf, accept, JAM }
