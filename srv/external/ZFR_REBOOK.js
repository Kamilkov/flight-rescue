const cds = require('@sap/cds')
const { search, check } = require('../lib/itineraries')

// Local stand-in for the ABAP behavior implementation (abap/zbp_r_fr_booking.clas.locals_imp.abap):
// the same checks, in the same order, with the same messages (at most 50 characters, see there). Used only while ZFR_REBOOK is mocked.
// Seats are counters here; in ABAP they are derived from ZFR_BOOKING (ZI_FR_Flight).
// Itineraries come from the search in srv/lib/itineraries.js instead of HANA Graph (ZCL_FR_ITINERARIES).
// The mock's stand-in for ZCL_FR_FLIGHTCANCEL_EVENTS: reports the cancellation to EventsService in this process.
// In a stand-alone mock (test/remote.test.mjs) there is none, and the delivery fails, as it would in ABAP.
async function notify(c) {
  let status = 'S', message = null
  try {
    const events = cds.services.EventsService
    if (!events) throw new Error('No EventsService in this process.')
    await events.tx({ user: new cds.User({ id: 'abap-events', roles: ['EventSource'] }) }, tx => tx.send('flightCancelled',
      { carrierId: c.CarrierId, connectionId: c.ConnectionId, flightDate: String(c.FlightDate).slice(0, 10), reason: c.Reason }))
  } catch (e) {
    status = 'F'; message = String(e.message).slice(0, 200)
  }
  await cds.db.tx(tx => tx.run(UPDATE('ZFR_REBOOK.FlightCancellations').set({ NotifyStatus: status, NotifyMessage: message })
    .where({ CarrierId: c.CarrierId, ConnectionId: c.ConnectionId, FlightDate: c.FlightDate })))
}

// The equality conditions of a CQN where, by element name: { Origin: 'FRA', ... }.
function equalities(where = []) {
  const eq = {}, value = x => x !== null && typeof x === 'object' && 'val' in x
  for (let i = 0; i + 2 < where.length; i++)
    if (where[i]?.ref && where[i + 1] === '=' && value(where[i + 2])) eq[where[i].ref.at(-1)] = where[i + 2].val
  return eq
}

module.exports = class ZFR_REBOOK extends cds.ApplicationService {
  init() {
    const { Bookings, Flights, FlightCancellations, Itineraries } = this.entities
    const iso = d => String(d).slice(0, 10)
    const flightOf = (c, n, d) => SELECT.one.from(Flights).where({ CarrierId: c, ConnectionId: n, FlightDate: d })
    const seat = (f, delta) => UPDATE(Flights).set({ SeatsBooked: { '+=': delta }, SeatsFree: { '-=': delta } })
      .where({ CarrierId: f.CarrierId, ConnectionId: f.ConnectionId, FlightDate: f.FlightDate })
    // The booking's own checks, first in both actions: it exists, is active, and is on the flight the caller expects.
    const own = (booking, key, t) => !booking ? `NO_BOOKING: Booking ${key.TravelId}/${key.BookingId} does not exist.`
      : booking.BookingStatus === 'X' ? `CANCELLED: Booking ${booking.TravelId}/${booking.BookingId} is cancelled.`
      : booking.CarrierId !== t.ExpectedCarrierId || booking.ConnectionId !== t.ExpectedConnectionId || iso(booking.FlightDate) !== iso(t.ExpectedFlightDate)
        ? `STALE: ${booking.TravelId}/${booking.BookingId} is on ${booking.CarrierId} ${booking.ConnectionId} ${iso(booking.FlightDate)}.` : ''

    this.on('rebook', Bookings, async req => {
      const [key] = req.params, t = req.data
      const booking = await SELECT.one.from(Bookings, key)
      let problem = own(booking, key, t)
      if (!problem) {
        const current = await flightOf(booking.CarrierId, booking.ConnectionId, booking.FlightDate)
        const target = await flightOf(t.CarrierId, t.ConnectionId, t.FlightDate)
        if (!target) problem = `NO_FLIGHT: ${t.CarrierId} ${t.ConnectionId} ${iso(t.FlightDate)} does not exist.`
        else if (target.IsCancelled) problem = `NOT_FLYING: ${t.CarrierId} ${t.ConnectionId} ${iso(t.FlightDate)} is cancelled.`
        else if (target.AirportFrom !== current?.AirportFrom || target.AirportTo !== current?.AirportTo)
          problem = `ROUTE: ${t.CarrierId} ${t.ConnectionId} flies ${target.AirportFrom}-${target.AirportTo}, not ${current?.AirportFrom}-${current?.AirportTo}.`
        else if (target.SeatsFree <= 0) problem = `FULL: ${t.CarrierId} ${t.ConnectionId} ${iso(t.FlightDate)} has no free seat.`
      }
      if (problem) return req.reject(400, problem)

      await seat(booking, -1)
      await seat(t, 1)
      await UPDATE(Bookings, key).with({ CarrierId: t.CarrierId, ConnectionId: t.ConnectionId, FlightDate: t.FlightDate, LastChangedAt: new Date().toISOString(), LocalLastChangedAt: new Date().toISOString() })
      return SELECT.one.from(Bookings, key)
    })

    // The booking moves to leg 1; legs 2-3 become new bookings in its travel, with the next IDs and price 0. One request,
    // one transaction: a refusal or a failed write leaves nothing behind, as RAP does for a failed action.
    this.on('rebookItinerary', Bookings, async req => {
      const [key] = req.params, t = req.data
      const booking = await SELECT.one.from(Bookings, key)
      const legs = [1, 2, 3].map(n => ({ CarrierId: t[`Leg${n}CarrierId`], ConnectionId: t[`Leg${n}ConnectionId`], FlightDate: t[`Leg${n}FlightDate`] }))
        .filter((l, i) => i === 0 || l.CarrierId)
      let problem = own(booking, key, t)
      if (!problem) {
        const current = await flightOf(booking.CarrierId, booking.ConnectionId, booking.FlightDate)
        for (const l of legs) l.row = await flightOf(l.CarrierId, l.ConnectionId, l.FlightDate)
        problem = check(current?.AirportFrom, current?.AirportTo, legs)
      }
      if (problem) return req.reject(400, problem)

      const now = new Date().toISOString()
      await seat(booking, -1)
      for (const l of legs) await seat(l, 1)
      await UPDATE(Bookings, key).with({ CarrierId: legs[0].CarrierId, ConnectionId: legs[0].ConnectionId, FlightDate: legs[0].FlightDate, LastChangedAt: now, LocalLastChangedAt: now })
      const { last } = await SELECT.one.from(Bookings).columns('max(BookingId) as last').where({ TravelId: key.TravelId })
      for (const [i, l] of legs.slice(1).entries())
        await INSERT.into(Bookings).entries({ TravelId: key.TravelId, BookingId: String(Number(last) + i + 1).padStart(4, '0'),
          CustomerId: booking.CustomerId, CarrierId: l.CarrierId, ConnectionId: l.ConnectionId, FlightDate: l.FlightDate,
          FlightPrice: 0, CurrencyCode: booking.CurrencyCode, BookingStatus: 'B', LastChangedAt: now, LocalLastChangedAt: now })
      return SELECT.one.from(Bookings, key)
    })

    // Like ZCL_FR_ITINERARIES: Origin, Destination and FromDate as equality filters, the same rules, the same rows.
    this.on('READ', Itineraries, async req => {
      const { Origin, Destination, FromDate } = equalities(req.query.SELECT.where)
      if (!Origin || !Destination || !FromDate) return req.reject(400, 'FILTER: Origin, Destination and FromDate needed.')
      const found = search(await SELECT.from(Flights), { origin: Origin, destination: Destination, fromDate: FromDate })
      return found.flatMap((it, i) => it.legs.map((l, n) => ({
        ItineraryNo: i + 1, LegNo: n + 1, Origin, Destination, FromDate: iso(FromDate), Legs: it.legs.length,
        ArrivesOn: it.arrivesOn, ArrivesAt: it.arrivesAt, CarrierId: l.CarrierId, ConnectionId: l.ConnectionId,
        FlightDate: iso(l.FlightDate), AirportFrom: l.AirportFrom, AirportTo: l.AirportTo,
        DepartureTime: l.DepartureTime, ArrivalTime: l.ArrivalTime, SeatsFree: l.SeatsFree
      })))
    })

    // Like ABAP's precheck on create (abap/zbp_r_fr_flightcancel.clas.locals_imp.abap): same checks, same messages.
    this.before('CREATE', FlightCancellations, async req => {
      const k = req.data, key = { CarrierId: k.CarrierId, ConnectionId: k.ConnectionId, FlightDate: k.FlightDate }
      const name = `${k.CarrierId} ${k.ConnectionId} ${iso(k.FlightDate)}`
      if (!await SELECT.one.from(Flights).where(key)) return req.reject(400, `NO_FLIGHT: ${name} does not exist.`)
      if (await SELECT.one.from(FlightCancellations).where(key)) return req.reject(400, `ALREADY_CANCELLED: ${name}.`)
      Object.assign(req.data, { CreatedBy: req.user.id, CreatedAt: new Date().toISOString(), NotifyStatus: null, NotifyMessage: null })
    })
    this.after('CREATE', FlightCancellations, async (_, req) => {
      const c = req.data // the result of an INSERT is a count, not the row
      await UPDATE(Flights).set({ IsCancelled: true }).where({ CarrierId: c.CarrierId, ConnectionId: c.ConnectionId, FlightDate: c.FlightDate })
      // ABAP raises FlightCancelled on save, and its handler calls the app after the commit (bgRFC). So does the mock.
      // In-process the mock runs inside the app's request: only that root transaction reports 'succeeded'.
      cds.context.on('succeeded', () => notify(c))
    })
    this.on(['UPDATE', 'DELETE'], FlightCancellations, req => req.reject(405, 'A cancellation cannot be changed.'))
    return super.init()
  }
}
