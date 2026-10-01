const cds = require('@sap/cds')
const abap = require('../lib/abap')
const rebook = require('../lib/rebook')

let demoFlight = null // what the last resetDemo seeded in ABAP; unknown after a restart
const demoInfo = () => abap.connected() ? { backend: 'abap', ...demoFlight } : { backend: 'mock', ...abap.MOCK_DEMO }

module.exports = class ControlService extends cds.ApplicationService {
  init() {
    const { Disruptions } = this.entities

    this.on('declareDisruption', async req => {
      const { carrierId, connectionId, flightDate, reason } = req.data
      const f = await abap.flight({ carrierId, connectionId, flightDate })
      if (!f) return req.reject(404, `NO_FLIGHT: Flight ${carrierId} ${connectionId} ${flightDate} does not exist in the booking system.`)
      const open = await SELECT.one.from('fr.Disruptions').where({ carrierId, connectionId, flightDate, status: 'Open' })
      if (open) return req.reject(409, `ALREADY_OPEN: Flight ${carrierId} ${connectionId} ${flightDate} already has open disruption ${open.ID}.`)
      const ID = cds.utils.uuid()
      await INSERT.into('fr.Disruptions').entries({ ID, carrierId, connectionId, flightDate, airportFrom: f.AirportFrom, airportTo: f.AirportTo, reason })
      return SELECT.one.from(Disruptions, ID)
    })

    this.on('closeDisruption', async req => {
      const ID = req.data.disruption
      const closed = await UPDATE('fr.Disruptions').set({ status: 'Closed' }).where({ ID, status: 'Open' })
      if (closed !== 1) return req.reject(409, `NOT_OPEN: Disruption ${ID} does not exist or is already closed.`)
      await UPDATE('fr.Plans').set({ status: 'Superseded' }).where({ disruption_ID: ID, status: 'Pending' })
      return SELECT.one.from(Disruptions, ID)
    })
    this.on('flightBoard', req => rebook.board(req, req.data.disruption))
    this.on('demoInfo', demoInfo)
    this.on('resetDemo', async () => {
      if (abap.connected()) demoFlight = await abap.resetDemo() // first: if ABAP refuses, the app keeps its state
      await DELETE.from('fr.PlanItems')
      await DELETE.from('fr.Plans')
      await DELETE.from('fr.Disruptions')
      return demoInfo()
    })
    return super.init()
  }
}
