const cds = require('@sap/cds')

// Local stand-in for the ABAP behavior implementation (abap/zbp_r_fr_booking.clas.locals_imp.abap):
// the same checks, in the same order, with the same messages (at most 50 characters, see there). Used only while ZFR_REBOOK is mocked.
// Seats are counters here; in ABAP they are derived from ZFR_BOOKING (ZI_FR_Flight).
module.exports = class ZFR_REBOOK extends cds.ApplicationService {
  init() {
    const { Bookings, Flights } = this.entities
    const iso = d => String(d).slice(0, 10)

    this.on('rebook', Bookings, async req => {
      const [key] = req.params, t = req.data
      const booking = await SELECT.one.from(Bookings, key)
      const flightOf = (c, n, d) => SELECT.one.from(Flights).where({ CarrierId: c, ConnectionId: n, FlightDate: d })
      let problem
      if (!booking) problem = `NO_BOOKING: Booking ${key.TravelId}/${key.BookingId} does not exist.`
      else if (booking.BookingStatus === 'X') problem = `CANCELLED: Booking ${booking.TravelId}/${booking.BookingId} is cancelled.`
      else if (booking.CarrierId !== t.ExpectedCarrierId || booking.ConnectionId !== t.ExpectedConnectionId || iso(booking.FlightDate) !== iso(t.ExpectedFlightDate))
        problem = `STALE: ${booking.TravelId}/${booking.BookingId} is on ${booking.CarrierId} ${booking.ConnectionId} ${iso(booking.FlightDate)}.`
      else {
        const current = await flightOf(booking.CarrierId, booking.ConnectionId, booking.FlightDate)
        const target = await flightOf(t.CarrierId, t.ConnectionId, t.FlightDate)
        if (!target) problem = `NO_FLIGHT: ${t.CarrierId} ${t.ConnectionId} ${iso(t.FlightDate)} does not exist.`
        else if (target.AirportFrom !== current?.AirportFrom || target.AirportTo !== current?.AirportTo)
          problem = `ROUTE: ${t.CarrierId} ${t.ConnectionId} flies ${target.AirportFrom}-${target.AirportTo}, not ${current?.AirportFrom}-${current?.AirportTo}.`
        else if (target.SeatsFree <= 0) problem = `FULL: ${t.CarrierId} ${t.ConnectionId} ${iso(t.FlightDate)} has no free seat.`
      }
      if (problem) return req.reject(400, problem)

      const seat = (f, delta) => UPDATE(Flights).set({ SeatsBooked: { '+=': delta }, SeatsFree: { '-=': delta } })
        .where({ CarrierId: f.CarrierId, ConnectionId: f.ConnectionId, FlightDate: f.FlightDate })
      await seat(booking, -1)
      await seat(t, 1)
      await UPDATE(Bookings, key).with({ CarrierId: t.CarrierId, ConnectionId: t.ConnectionId, FlightDate: t.FlightDate, LastChangedAt: new Date().toISOString(), LocalLastChangedAt: new Date().toISOString() })
      return SELECT.one.from(Bookings, key)
    })
    return super.init()
  }
}
