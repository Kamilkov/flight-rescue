// The rerouting rules of ABAP's graph (abap/zi_fr_graphedge.ddls.asddls, abap/zcl_fr_itineraries.clas.abap) as a plain
// search over a list of flights, and rebookItinerary's checks (abap/zbp_r_fr_booking.clas.locals_imp.abap). The mock
// uses both offline; scripts/abap-check.mjs compares the graph with the search live.

const DAY = 86400
const LAYOVER = { min: 90 * 60, max: 12 * 3600 } // seconds between one flight's arrival and the next one's departure
const WINDOW_DAYS = 2 // the first flight leaves on the cancelled flight's day up to two days later

const iso = d => String(d).slice(0, 10)
const seconds = (date, time) => Date.parse(`${iso(date)}T${String(time).slice(0, 8)}Z`) / 1000 // naive local time
/** A flight's departure and arrival in seconds. ponytail: /DMO/ has local times without arrival dates or time zones; an
 *  arrival before the departure lands the next day, as in ZI_FR_FlightTime. Wrong for SFO→SIN. */
function timed(f) {
  const dep = seconds(f.FlightDate, f.DepartureTime)
  return { flight: f, dep, arr: seconds(f.FlightDate, f.ArrivalTime) + (String(f.ArrivalTime) < String(f.DepartureTime) ? DAY : 0) }
}

/** An itinerary's id: its flights in order, "LH 0400 2026-10-20 > B6 0415 2026-10-20". Rows from ABAP or plan legs. */
const id = legs => legs.map(l => `${l.CarrierId ?? l.carrierId} ${l.ConnectionId ?? l.connectionId} ${iso(l.FlightDate ?? l.flightDate)}`).join(' > ')

/** The k best itineraries of one to maxLegs flights from origin to destination, earliest arrival first, then fewer
 *  connections. The first flight leaves on fromDate up to two days later, the others up to a day after that; 90 min to
 *  12 h between flights; no airport twice; only flights that are not cancelled and have a free seat.
 *  Each: { legs (the flight rows), arrives (seconds), connections, arrivesOn, arrivesAt }. */
function search(flights, { origin, destination, fromDate, k = 10, maxLegs = 3 }) {
  const start = seconds(fromDate, '00:00:00'), end = start + (WINDOW_DAYS + 1) * DAY - 1, last = end + DAY
  const from = new Map()
  for (const f of flights) {
    if (f.IsCancelled || !(f.SeatsFree > 0)) continue
    const t = timed(f)
    if (t.dep >= start && t.dep <= last) from.set(f.AirportFrom, [...(from.get(f.AirportFrom) ?? []), t])
  }
  const found = []
  const extend = (path, visited) => {
    const at = path.at(-1)
    if (at.flight.AirportTo === destination) return void found.push(path)
    if (path.length === maxLegs) return
    for (const t of from.get(at.flight.AirportTo) ?? [])
      if (t.dep >= at.arr + LAYOVER.min && t.dep <= at.arr + LAYOVER.max && !visited.has(t.flight.AirportTo))
        extend([...path, t], new Set([...visited, t.flight.AirportTo]))
  }
  for (const t of from.get(origin) ?? [])
    if (t.dep <= end && t.flight.AirportTo !== origin) extend([t], new Set([origin, t.flight.AirportTo]))
  return found
    .map(path => ({ legs: path.map(t => t.flight), arrives: path.at(-1).arr, connections: path.length - 1 }))
    .sort((a, b) => a.arrives - b.arrives || a.connections - b.connections || id(a.legs).localeCompare(id(b.legs)))
    .slice(0, k)
    .map(i => { const at = new Date(i.arrives * 1000).toISOString(); return { ...i, arrivesOn: at.slice(0, 10), arrivesAt: at.slice(11, 19) } })
}

/** rebookItinerary's checks after the booking's own, in ABAP's order and with ABAP's texts: the legs exist and fly, chain
 *  from origin to destination without an airport twice, connect in 90 min to 12 h, and have a free seat.
 *  legs: [{ CarrierId, ConnectionId, FlightDate, row }] in order, row being the flight from Flights or undefined.
 *  Returns the first problem, or ''. */
function check(origin, destination, legs) {
  const name = l => `${l.CarrierId} ${l.ConnectionId} ${iso(l.FlightDate)}`
  for (const l of legs) if (!l.row) return `NO_FLIGHT: ${name(l)} does not exist.`
  for (const l of legs) if (l.row.IsCancelled) return `NOT_FLYING: ${name(l)} is cancelled.`
  for (const [i, l] of legs.entries()) {
    const from = i ? legs[i - 1].row.AirportTo : origin
    if (l.row.AirportFrom !== from) return `CHAIN: leg ${i + 1} does not leave from ${from}.`
  }
  if (legs.at(-1).row.AirportTo !== destination) return `CHAIN: leg ${legs.length} does not land at ${destination}.`
  const seen = new Set([origin])
  for (const l of legs) {
    if (seen.has(l.row.AirportTo)) return `CHAIN: the itinerary visits ${l.row.AirportTo} twice.`
    seen.add(l.row.AirportTo)
  }
  for (let i = 1; i < legs.length; i++) {
    const gap = timed(legs[i].row).dep - timed(legs[i - 1].row).arr
    if (gap < LAYOVER.min || gap > LAYOVER.max) return `LAYOVER: leg ${i + 1} is not 90 min to 12 h after leg ${i}.`
  }
  for (const l of legs) if (l.row.SeatsFree <= 0) return `FULL: ${name(l)} has no free seat.`
  return ''
}

module.exports = { search, check, id, timed, LAYOVER, WINDOW_DAYS }
