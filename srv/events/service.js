const cds = require('@sap/cds')
const abap = require('../lib/abap')
const agentStart = require('../lib/agent-start')

module.exports = class EventsService extends cds.ApplicationService {
  init() {
    this.on('flightCancelled', async req => {
      const { carrierId, connectionId, flightDate, reason } = req.data
      // ABAP first: the app has a single SQLite connection, and the first statement below holds it until the commit.
      const f = await abap.flight({ carrierId, connectionId, flightDate })
      if (!f) return req.reject(404, `NO_FLIGHT: Flight ${carrierId} ${connectionId} ${flightDate} does not exist in the booking system.`)
      const open = await SELECT.one.from('fr.Disruptions').columns('ID').where({ carrierId, connectionId, flightDate, status: 'Open' })
      if (open) return { disruption: open.ID, duplicate: true }
      const ID = cds.utils.uuid()
      await INSERT.into('fr.Disruptions').entries({ ID, carrierId, connectionId, flightDate, airportFrom: f.AirportFrom, airportTo: f.AirportTo, reason, agentStatus: 'Working' })
      // After the commit, so the agent finds the disruption; ABAP gets its answer now, not after the model's minute.
      req.on('succeeded', () => agentStart.start(ID))
      return { disruption: ID, duplicate: false }
    })
    return super.init()
  }
}
