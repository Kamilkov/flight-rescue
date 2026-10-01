const cds = require('@sap/cds')

// The only module that talks to ZFR_REBOOK: the ABAP service, or its mock while ABAP_URL is unset.
// Reads go through CQL (CAP turns them into OData queries); the rebook action is a bound action call.

const FLIGHT = { CarrierId: /^[A-Z0-9]{2,3}$/, ConnectionId: /^\d{4}$/, FlightDate: /^\d{4}-\d{2}-\d{2}$/ }
const BOOKING = { TravelId: /^\d{8}$/, BookingId: /^\d{4}$/ }
// ABAP's default namespace for an OData V4 Web API binding of service definition ZFR_REBOOK, version 0001.
const RAP_NAMESPACE = 'com.sap.gateway.srvd_a2x.zfr_rebook.v0001'

// ABAP sends NUMC fields (the /DMO/ IDs) without leading zeros ("926") and accepts them with; the app uses the padded form.
const NUMC = { TravelId: 8, BookingId: 4, CustomerId: 6, ConnectionId: 4 }
const padded = row => {
  if (row) for (const [k, n] of Object.entries(NUMC)) if (row[k] != null) row[k] = String(row[k]).padStart(n, '0')
  return row
}

const api = () => cds.connect.to('ZFR_REBOOK')
const iso = d => String(d).slice(0, 10)
const plusDays = (date, n) => new Date(Date.parse(`${iso(date)}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

function check(value, patterns, what) {
  for (const [k, re] of Object.entries(patterns))
    if (!re.test(String(value?.[k] ?? ''))) throw cds.error(400, `INVALID: ${what} ${k} "${value?.[k]}" is not valid.`)
}

async function flight({ carrierId, connectionId, flightDate }) {
  const key = { CarrierId: carrierId, ConnectionId: connectionId, FlightDate: iso(flightDate) }
  check(key, FLIGHT, 'flight')
  const { Flights } = (await api()).entities
  return padded(await (await api()).run(SELECT.one.from(Flights).where(key)))
}

/** Active (not cancelled) bookings on a flight. */
async function bookingsOn(f) {
  const { Bookings } = (await api()).entities
  return (await (await api()).run(SELECT.from(Bookings)
    .columns('TravelId', 'BookingId', 'CarrierId', 'ConnectionId', 'FlightDate', 'BookingStatus')
    .where({ CarrierId: f.carrierId, ConnectionId: f.connectionId, FlightDate: iso(f.flightDate), BookingStatus: { '!=': 'X' } })
    .orderBy('TravelId', 'BookingId'))).map(padded)
}

/** Flights on the same route from the disrupted day up to `days` later, the disrupted flight excluded. */
async function sameRoute(f, days) {
  const { Flights } = (await api()).entities
  const rows = (await (await api()).run(SELECT.from(Flights)
    .where({ AirportFrom: f.airportFrom, AirportTo: f.airportTo, FlightDate: { between: iso(f.flightDate), and: plusDays(f.flightDate, days) } })
    .orderBy('FlightDate', 'DepartureTime'))).map(padded)
  return rows.filter(r => !(r.CarrierId === f.carrierId && r.ConnectionId === f.connectionId && iso(r.FlightDate) === iso(f.flightDate)))
}

/** Moves one booking in ABAP. Resolves with the updated booking or rejects with ABAP's message. */
async function rebook(booking, from, to) {
  check(booking, BOOKING, 'booking')
  check(to, FLIGHT, 'target flight')
  const srv = await api()
  const data = {
    ExpectedCarrierId: from.CarrierId, ExpectedConnectionId: from.ConnectionId, ExpectedFlightDate: iso(from.FlightDate),
    CarrierId: to.CarrierId, ConnectionId: to.ConnectionId, FlightDate: iso(to.FlightDate)
  }
  const keys = { TravelId: booking.TravelId, BookingId: booking.BookingId }
  try {
    if (!(srv instanceof cds.RemoteService)) return await srv.send({ event: 'rebook', entity: srv.entities.Bookings, params: [keys], data })
    // RAP qualifies bound actions with the binding's namespace, not the CDS service name, so the path is explicit.
    const ns = cds.env.requires.ZFR_REBOOK.actionNamespace ?? RAP_NAMESPACE
    return padded(await srv.send({ method: 'POST', path: `/Bookings(TravelId='${keys.TravelId}',BookingId='${keys.BookingId}')/${ns}.rebook`, data }))
  } catch (e) {
    throw new Error(messageOf(e))
  }
}

// ABAP (and the mock over HTTP) answer with an OData error body; keep its text, not the transport wrapper.
function messageOf(e) {
  const body = e.reason?.response?.body ?? e.response?.body
  const text = body?.error?.message ?? e.reason?.message ?? e.message ?? String(e)
  return String(typeof text === 'object' ? text.value : text).slice(0, 480)
}

const MOCK_DEMO = { carrierId: 'LH', connectionId: '0400', flightDate: '2026-10-12' } // srv/external/data
const connected = () => !!cds.env.requires.ZFR_REBOOK?.credentials?.url

/** Reseeds ZFR_BOOKING by running ZCL_FR_GENERATE_DATA. Resolves with the demo flight its last output line names. */
// ponytail: the ADT class-run endpoint is a developer API, so this works with a developer user on a trial system only.
// With a communication user (BTP ABAP environment) the reset would have to be its own released service.
async function resetDemo() {
  const { url, username, password, queryParameters } = cds.env.requires.ZFR_REBOOK.credentials
  const query = new URLSearchParams(queryParameters).toString()
  const at = path => `${new URL(url).origin}${path}${query && `?${query}`}`
  const auth = { authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') }
  const failed = (status, text) => cds.error(502, `RESET_FAILED: ${status} ${String(text).slice(0, 300)}`)

  const token = await fetch(at('/sap/bc/adt/core/discovery'), { headers: { ...auth, accept: 'application/atomsvc+xml', 'x-csrf-token': 'fetch' } })
  if (!token.ok) throw failed(token.status, await token.text())
  const run = await fetch(at('/sap/bc/adt/oo/classrun/ZCL_FR_GENERATE_DATA'), {
    method: 'POST',
    headers: { ...auth, accept: 'text/plain', 'x-csrf-token': token.headers.get('x-csrf-token') ?? '', cookie: token.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') }
  })
  const text = await run.text()
  const m = run.ok && text.match(/^DEMO_FLIGHT (\S+) (\d{4}) (\d{4}-\d{2}-\d{2})\s*$/m)
  if (!m) throw failed(run.status, text)
  return { carrierId: m[1], connectionId: m[2], flightDate: m[3] }
}

module.exports = { flight, bookingsOn, sameRoute, rebook, iso, plusDays, padded, connected, resetDemo, MOCK_DEMO }
