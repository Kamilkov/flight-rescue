// The rerouting rules of ABAP's graph (abap/zi_fr_graphedge.ddls.asddls, abap/zcl_fr_itineraries.clas.abap) as a plain
// search over a list of flights. The mock uses it offline; scripts/abap-check.mjs compares the graph with it live.

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

module.exports = { search, id, timed, LAYOVER, WINDOW_DAYS }
