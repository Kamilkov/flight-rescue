const cds = require('@sap/cds')
const abap = require('./abap')

// Rebooking rules, shared by the agent and the control service. The server decides what is valid:
// the agent can only choose among the bookings and alternatives impact() lists, and nothing reaches
// ABAP until apply() runs after a person approved the plan.

const WINDOW_DAYS = 2 // alternatives: same route, the disrupted day up to two days later
const flightName = f => `${f.carrierId ?? f.CarrierId} ${f.connectionId ?? f.ConnectionId} ${abap.iso(f.flightDate ?? f.FlightDate)}`
const flightKey = f => flightName(f)

async function openDisruption(req, ID) {
  const d = await SELECT.one.from('fr.Disruptions').where({ ID })
  if (!d) return req.reject(404, `NO_DISRUPTION: Disruption ${ID} does not exist.`)
  if (d.status !== 'Open') return req.reject(409, `CLOSED: Disruption ${ID} is closed.`)
  return d
}

/** Affected bookings and the only valid alternatives, with the seats still free after other pending plans. */
async function impact(req, disruptionID) {
  const d = await openDisruption(req, disruptionID)
  const [bookings, flights] = await Promise.all([abap.bookingsOn(d), abap.sameRoute(d, WINDOW_DAYS)])
  // Seats promised by pending plans of other disruptions are not free for this one.
  const held = await SELECT.from('fr.PlanItems')
    .columns('toCarrierId', 'toConnectionId', 'toFlightDate', 'count(*) as seats')
    .where({ 'plan.status': 'Pending', 'plan.disruption_ID': { '!=': d.ID } })
    .groupBy('toCarrierId', 'toConnectionId', 'toFlightDate')
  const heldOn = Object.fromEntries(held.map(h => [flightKey({ carrierId: h.toCarrierId, connectionId: h.toConnectionId, flightDate: h.toFlightDate }), Number(h.seats)]))
  const disrupted = new Set((await SELECT.from('fr.Disruptions').where({ status: 'Open' })).map(flightKey))

  const alternatives = flights.filter(f => !f.IsCancelled && !disrupted.has(flightKey(f))).map(f => {
    const seatsHeld = heldOn[flightKey(f)] ?? 0
    return {
      carrierId: f.CarrierId, connectionId: f.ConnectionId, flightDate: abap.iso(f.FlightDate),
      departureTime: f.DepartureTime, arrivalTime: f.ArrivalTime,
      daysLater: Math.round((Date.parse(abap.iso(f.FlightDate)) - Date.parse(abap.iso(d.flightDate))) / 864e5),
      seatsFree: f.SeatsFree, seatsHeld, seatsAvailable: Math.max(0, f.SeatsFree - seatsHeld)
    }
  }).filter(a => a.seatsAvailable > 0)

  const seats = alternatives.reduce((n, a) => n + a.seatsAvailable, 0)
  return {
    disruption: { ID: d.ID, flight: flightName(d), carrierId: d.carrierId, connectionId: d.connectionId, flightDate: abap.iso(d.flightDate), airportFrom: d.airportFrom, airportTo: d.airportTo, reason: d.reason },
    affectedBookings: bookings.map(b => ({ travelId: b.TravelId, bookingId: b.BookingId })), // no customer data for the model
    alternatives,
    seatsAvailable: seats,
    note: !bookings.length ? 'No active bookings on this flight: nothing to rebook.'
      : !alternatives.length ? 'No alternative flight has a free seat: no rebooking is possible.'
      : seats < bookings.length ? `Only ${seats} seats for ${bookings.length} bookings: ${bookings.length - seats} will stay unassigned.`
      : `Enough seats for all ${bookings.length} bookings.`
  }
}

/** The disrupted flight, then every same-route flight in the window (full ones too), with seat and highlight counts. */
async function board(req, disruptionID) {
  const d = await SELECT.one.from('fr.Disruptions').where({ ID: disruptionID })
  if (!d) return req.reject(404, `NO_DISRUPTION: Disruption ${disruptionID} does not exist.`)
  const [own, others, bookings, moved] = await Promise.all([
    abap.flight(d), abap.sameRoute(d, WINDOW_DAYS), abap.bookingsOn(d),
    SELECT.from('fr.PlanItems').columns('toCarrierId', 'toConnectionId', 'toFlightDate', 'count(*) as n')
      .where({ status: 'Rebooked', 'plan.disruption_ID': d.ID }).groupBy('toCarrierId', 'toConnectionId', 'toFlightDate')
  ])
  const movedTo = Object.fromEntries(moved.map(m => [flightKey({ carrierId: m.toCarrierId, connectionId: m.toConnectionId, flightDate: m.toFlightDate }), Number(m.n)]))
  const load = (f, cancelled) => ({
    carrierId: f.CarrierId, connectionId: f.ConnectionId, flightDate: abap.iso(f.FlightDate),
    departureTime: f.DepartureTime, arrivalTime: f.ArrivalTime,
    seatsMax: f.SeatsMax, seatsBooked: f.SeatsBooked, seatsFree: f.SeatsFree,
    cancelled, highlighted: cancelled ? bookings.length : movedTo[flightKey(f)] ?? 0
  })
  return [...(own ? [load(own, true)] : []), ...others.map(f => load(f, false))]
}

/** Saves a Pending plan. Every assignment must use a listed booking and a listed alternative, within its seats. */
async function propose(req, { disruption, assignments = [], rationale }, agentTask = null) {
  const now = await impact(req, disruption)
  if (!assignments.length) return req.reject(400, `EMPTY: A plan needs at least one assignment. ${now.note}`)
  const bookings = new Map(now.affectedBookings.map(b => [`${b.travelId}/${b.bookingId}`, b]))
  const flights = new Map(now.alternatives.map(a => [flightKey(a), a]))
  const seen = new Set(), used = {}
  for (const a of assignments) {
    const b = `${a.travelId}/${a.bookingId}`, f = flightKey(a)
    if (!bookings.has(b)) return req.reject(400, `NOT_AFFECTED: Booking ${b} is not an affected booking of this disruption.`)
    if (seen.has(b)) return req.reject(400, `DUPLICATE: Booking ${b} is assigned twice.`)
    if (!flights.has(f)) return req.reject(400, `NOT_LISTED: Flight ${f} is not a listed alternative.`)
    seen.add(b)
    if ((used[f] = (used[f] ?? 0) + 1) > flights.get(f).seatsAvailable)
      return req.reject(400, `OVER_CAPACITY: Flight ${f} has ${flights.get(f).seatsAvailable} seats available, the plan uses more.`)
  }

  await UPDATE('fr.Plans').set({ status: 'Superseded' }).where({ disruption_ID: disruption, status: 'Pending' })
  const plan = {
    ID: cds.utils.uuid(), disruption_ID: disruption, status: 'Pending', rationale: String(rationale ?? '').slice(0, 1000), agentTask,
    items: assignments.map(a => ({
      travelId: a.travelId, bookingId: a.bookingId,
      fromCarrierId: now.disruption.carrierId, fromConnectionId: now.disruption.connectionId, fromFlightDate: now.disruption.flightDate,
      toCarrierId: a.carrierId, toConnectionId: a.connectionId, toFlightDate: abap.iso(a.flightDate)
    }))
  }
  await INSERT.into('fr.Plans').entries(plan)
  const unassigned = now.affectedBookings.filter(b => !seen.has(`${b.travelId}/${b.bookingId}`)).map(b => ({ travelId: b.travelId, bookingId: b.bookingId }))
  return { plan: plan.ID, disruption, assigned: assignments.length, unassigned, status: 'Pending',
    message: `Plan saved as Pending. Nothing changed in the booking system yet.${unassigned.length ? ` ${unassigned.length} booking(s) stay unassigned.` : ''}` }
}

/** Runs an approved plan against ABAP, booking by booking, and records each answer. Never throws after the first call. */
async function apply(req, planID, agentTask) {
  const plan = await SELECT.one.from('fr.Plans').where({ ID: planID })
  if (!plan) return req.reject(404, `NO_PLAN: Plan ${planID} does not exist.`)
  if (!agentTask || plan.agentTask !== agentTask) return req.reject(409, 'NOT_REVIEWED: This plan was not proposed in this agent task.')
  await openDisruption(req, plan.disruption_ID)
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

module.exports = { impact, board, propose, apply, WINDOW_DAYS }
