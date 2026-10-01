const cds = require('@sap/cds')

// Local stand-in for the ABAP behavior implementation (abap/zbp_r_fr_booking.clas.locals_imp.abap):
// the same checks, in the same order, with the same messages (at most 50 characters, see there). Used only while ZFR_REBOOK is mocked.
// Seats are counters here; in ABAP they are derived from ZFR_BOOKING (ZI_FR_Flight).
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

module.exports = class ZFR_REBOOK extends cds.ApplicationService {
  init() {
    const { Bookings, Flights, FlightCancellations } = this.entities
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
