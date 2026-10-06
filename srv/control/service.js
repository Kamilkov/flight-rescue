const cds = require('@sap/cds')
const abap = require('../lib/abap')
const rebook = require('../lib/rebook')

let demoFlight = null // what the last resetDemo seeded in ABAP; unknown after a restart
const demoInfo = () => abap.connected() ? { backend: 'abap', ...demoFlight } : { backend: 'mock', ...abap.MOCK_DEMO, trafficFlight: abap.MOCK_TRAFFIC }

module.exports = class ControlService extends cds.ApplicationService {
  init() {
    const { Disruptions } = this.entities

    const asCancellation = c => ({ carrierId: c.CarrierId, connectionId: c.ConnectionId, flightDate: abap.iso(c.FlightDate), reason: c.Reason, notifyStatus: c.NotifyStatus || null, notifyMessage: c.NotifyMessage || null })

    this.on('cancelFlight', async req => {
      try { return asCancellation(await abap.cancelFlight(req.data)) } catch (e) { return req.reject(e.status ?? e.code ?? 400, e.message) }
    })

    this.on('cancellation', async req => {
      const c = await abap.cancellation(req.data)
      if (!c) return req.reject(404, `NO_CANCELLATION: ${req.data.carrierId} ${req.data.connectionId} ${abap.iso(req.data.flightDate)} is not cancelled.`)
      return asCancellation(c)
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
      else await abap.resetMockCancellations()
      await DELETE.from('fr.PlanItems')
      await DELETE.from('fr.Plans')
      await DELETE.from('fr.Disruptions')
      return demoInfo()
    })
    return super.init()
  }
}
