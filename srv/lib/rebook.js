const cds = require('@sap/cds')
const abap = require('./abap')

// Rebooking rules, shared by the agent and the control service. The server decides what is valid:
// the agent can only choose among the bookings and alternatives impact() lists, and nothing reaches
// ABAP until apply() runs after a person approved the plan, or, for a traffic jam, until a passenger accepts an offer.

const WINDOW_DAYS = 2 // cancellation: same route, the disrupted day up to two days later
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

/** Seats promised elsewhere, by flight: pending plans of other disruptions, and every offer not answered yet on an open disruption. */
async function heldSeats(disruptionID) {
  const cols = ['toCarrierId', 'toConnectionId', 'toFlightDate', 'count(*) as seats'], by = ['toCarrierId', 'toConnectionId', 'toFlightDate']
  const rows = [
    ...await SELECT.from('fr.PlanItems').columns(...cols).where({ 'plan.status': 'Pending', 'plan.disruption_ID': { '!=': disruptionID } }).groupBy(...by),
    ...await SELECT.from('fr.PlanItems').columns(...cols).where({ status: { in: ['Offered', 'Accepting'] }, 'plan.disruption.status': 'Open' }).groupBy(...by)
  ]
  const held = {}
  for (const h of rows) {
    const key = flightKey({ carrierId: h.toCarrierId, connectionId: h.toConnectionId, flightDate: h.toFlightDate })
    held[key] = (held[key] ?? 0) + Number(h.seats)
  }
  return held
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

/** Affected bookings and the only valid alternatives, with the seats still free after other plans and open offers. */
async function impact(req, disruptionID) {
  const d = await openDisruption(req, disruptionID)
  return d.kind === 'TrafficJam' ? jamImpact(d) : cancellationImpact(d)
}

async function cancellationImpact(d) {
  const [bookings, flights, held] = await Promise.all([abap.bookingsOn(d), abap.sameRoute(d, WINDOW_DAYS), heldSeats(d.ID)])
  // Only a cancellation takes its flight out of service; a jam's flights still fly.
  const disrupted = new Set((await SELECT.from('fr.Disruptions').where({ status: 'Open', kind: 'Cancellation' })).map(flightKey))
  const alternatives = flights.filter(f => !f.IsCancelled && !disrupted.has(flightKey(f))).map(f => alternative(f, d, held)).filter(a => a.seatsAvailable > 0)
  const seats = alternatives.reduce((n, a) => n + a.seatsAvailable, 0)
  return {
    disruption: summary(d),
    affectedBookings: bookings.map(booking), // no customer data for the model
    alternatives,
    seatsAvailable: seats,
    note: !bookings.length ? 'No active bookings on this flight: nothing to rebook.'
      : !alternatives.length ? 'No alternative flight has a free seat: no rebooking is possible.'
      : seats < bookings.length ? `Only ${seats} seats for ${bookings.length} bookings: ${bookings.length - seats} will stay unassigned.`
      : `Enough seats for all ${bookings.length} bookings.`
  }
}

/** A traffic jam: bookings driving via the jammed approach on flights leaving 60–180 min later, and later flights that
 *  day. Bookings without passenger context are not contacted. The model sees references and counts, never context. */
async function jamImpact(d) {
  const jam = at(d.jamDate, d.jamTime), after = f => (at(f.FlightDate, f.DepartureTime) - jam) / 6e4
  const flights = (await abap.departures(d.airportFrom, d.jamDate)).filter(f => !f.IsCancelled && after(f) >= JAM.fromMin && after(f) <= JAM.toMin)
  const context = new Map((await SELECT.from('fr.PassengerContext')).map(c => [`${c.travelId}/${c.bookingId}`, c]))
  const held = await heldSeats(d.ID)
  const affectedBookings = [], alternatives = [], notes = []
  for (const f of flights) {
    const on = await abap.bookingsOn({ carrierId: f.CarrierId, connectionId: f.ConnectionId, flightDate: f.FlightDate })
    const known = on.map(b => [b, context.get(`${b.TravelId}/${b.BookingId}`)]).filter(([, c]) => c)
    if (!known.length) continue // nobody on this flight we know anything about
    const n = test => known.filter(([, c]) => test(c)).length
    const atRisk = known.filter(([, c]) => c.arrival === 'Car' && c.approach === d.approach).map(([b]) => booking(b))
    notes.push(`${known.length} bookings with passenger context on ${flightName(f)}: ${atRisk.length} at risk (driving via ${d.approach}), `
      + `${n(c => c.arrival === 'Car' && c.approach !== d.approach)} driving via another approach, ${n(c => c.arrival === 'Train')} by train, `
      + `${n(c => c.arrival === 'CheckedIn')} checked in${on.length > known.length ? `; ${on.length - known.length} without passenger context are not contacted` : ''}.`)
    if (!atRisk.length) continue
    affectedBookings.push(...atRisk)
    const route = { carrierId: f.CarrierId, connectionId: f.ConnectionId, flightDate: f.FlightDate, airportFrom: f.AirportFrom, airportTo: f.AirportTo }
    const later = (await abap.sameRoute(route, 0)).filter(a => !a.IsCancelled && at(a.FlightDate, a.DepartureTime) - at(f.FlightDate, f.DepartureTime) >= JAM.gapMin * 6e4)
    alternatives.push(...later.map(a => alternative(a, f, held)).filter(a => a.seatsAvailable > 0))
  }
  // ponytail: seats are summed per listed alternative; a flight listed for two affected flights counts twice in this
  // note only (propose() checks capacity per flight). Two jammed flights on one route: count distinct flights then.
  const seats = alternatives.reduce((n, a) => n + a.seatsAvailable, 0), risk = affectedBookings.length
  return {
    disruption: summary(d), affectedBookings, alternatives, seatsAvailable: seats,
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
  departureTime: f.DepartureTime, arrivalTime: f.ArrivalTime,
  seatsMax: f.SeatsMax, seatsBooked: f.SeatsBooked, seatsFree: f.SeatsFree,
  cancelled: false, affected: false, highlighted: 0, held: 0, ...extra
})

/** Cancellation: the disrupted flight, then every same-route flight in the window. Jam: see jamBoard. */
async function board(req, disruptionID) {
  const d = await SELECT.one.from('fr.Disruptions').where({ ID: disruptionID })
  if (!d) return req.reject(404, `NO_DISRUPTION: Disruption ${disruptionID} does not exist.`)
  if (d.kind === 'TrafficJam') return jamBoard(d)
  const [own, others, bookings, moved] = await Promise.all([
    abap.flight(d), abap.sameRoute(d, WINDOW_DAYS), abap.bookingsOn(d),
    SELECT.from('fr.PlanItems').columns('toCarrierId', 'toConnectionId', 'toFlightDate', 'count(*) as n')
      .where({ status: 'Rebooked', 'plan.disruption_ID': d.ID }).groupBy('toCarrierId', 'toConnectionId', 'toFlightDate')
  ])
  const movedTo = Object.fromEntries(moved.map(m => [flightKey({ carrierId: m.toCarrierId, connectionId: m.toConnectionId, flightDate: m.toFlightDate }), Number(m.n)]))
  return [...(own ? [load(own, { cancelled: true, highlighted: bookings.length })] : []), ...others.map(f => load(f, { highlighted: movedTo[flightKey(f)] ?? 0 }))]
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
  const rows = []
  for (const f of own.values()) {
    const flight = await abap.flight(f)
    if (!flight) continue
    rows.push(load(flight, { affected: true, highlighted: atRisk[flightName(f)] ?? 0 }))
    const route = { carrierId: flight.CarrierId, connectionId: flight.ConnectionId, flightDate: flight.FlightDate, airportFrom: flight.AirportFrom, airportTo: flight.AirportTo }
    for (const a of await abap.sameRoute(route, 0))
      if (at(a.FlightDate, a.DepartureTime) > at(flight.FlightDate, flight.DepartureTime))
        rows.push(load(a, { highlighted: count(['Rebooked'], a), held: d.status === 'Open' ? count(['Offered', 'Accepting'], a) : 0 }))
  }
  return rows
}

/** Saves a Pending plan. Every assignment must use a listed booking and an alternative listed for that booking's
 *  own flight, within its seats. */
async function propose(req, { disruption, assignments = [], rationale }, agentTask = null) {
  const now = await impact(req, disruption)
  if (!assignments.length) return req.reject(400, `EMPTY: A plan needs at least one assignment. ${now.note}`)
  const bookings = new Map(now.affectedBookings.map(b => [`${b.travelId}/${b.bookingId}`, b]))
  const seen = new Set(), used = {}
  for (const a of assignments) {
    const key = `${a.travelId}/${a.bookingId}`, b = bookings.get(key), f = flightKey(a)
    if (!b) return req.reject(400, `NOT_AFFECTED: Booking ${key} is not an affected booking of this disruption.`)
    if (seen.has(key)) return req.reject(400, `DUPLICATE: Booking ${key} is assigned twice.`)
    const listed = now.alternatives.find(x => flightKey(x) === f && x.forFlight === flightName(b))
    if (!listed) return req.reject(400, `NOT_LISTED: Flight ${f} is not a listed alternative for ${key} on ${flightName(b)}.`)
    seen.add(key)
    if ((used[f] = (used[f] ?? 0) + 1) > listed.seatsAvailable)
      return req.reject(400, `OVER_CAPACITY: Flight ${f} has ${listed.seatsAvailable} seats available, the plan uses more.`)
  }

  await UPDATE('fr.Plans').set({ status: 'Superseded' }).where({ disruption_ID: disruption, status: 'Pending' })
  const plan = {
    ID: cds.utils.uuid(), disruption_ID: disruption, status: 'Pending', rationale: String(rationale ?? '').slice(0, 1000), agentTask,
    items: assignments.map(a => {
      const b = bookings.get(`${a.travelId}/${a.bookingId}`)
      return {
        travelId: a.travelId, bookingId: a.bookingId,
        fromCarrierId: b.carrierId, fromConnectionId: b.connectionId, fromFlightDate: b.flightDate,
        toCarrierId: a.carrierId, toConnectionId: a.connectionId, toFlightDate: abap.iso(a.flightDate)
      }
    })
  }
  await INSERT.into('fr.Plans').entries(plan)
  const unassigned = now.affectedBookings.filter(b => !seen.has(`${b.travelId}/${b.bookingId}`)).map(b => ({ travelId: b.travelId, bookingId: b.bookingId }))
  return { plan: plan.ID, disruption, assigned: assignments.length, unassigned, status: 'Pending',
    message: `Plan saved as Pending. Nothing changed in the booking system yet.${unassigned.length ? ` ${unassigned.length} booking(s) stay unassigned.` : ''}` }
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
    let status = 'Rebooked', message = `Moved to ${flightName({ carrierId: i.toCarrierId, connectionId: i.toConnectionId, flightDate: i.toFlightDate })}.`
    try {
      await abap.rebook({ TravelId: i.travelId, BookingId: i.bookingId },
        { CarrierId: i.fromCarrierId, ConnectionId: i.fromConnectionId, FlightDate: i.fromFlightDate },
        { CarrierId: i.toCarrierId, ConnectionId: i.toConnectionId, FlightDate: i.toFlightDate })
    } catch (e) {
      status = 'Failed'; message = e.message
      failed.push({ travelId: i.travelId, bookingId: i.bookingId, message })
    }
    await UPDATE('fr.PlanItems', i.ID).with({ status, message })
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

module.exports = { impact, board, propose, apply, sendOffers, WINDOW_DAYS, JAM }
