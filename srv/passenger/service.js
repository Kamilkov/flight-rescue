const cds = require('@sap/cds')
const rebook = require('../lib/rebook')

// The passenger's phone in the demo: the `passenger` user stands for one booking, marked `phone` in PassengerContext.
module.exports = class PassengerService extends cds.ApplicationService {
  init() {
    const mine = () => SELECT.one.from('fr.PassengerContext').where({ phone: true })
    this.on('myOffer', async () => rebook.offerOf(await mine()))
    this.on('acceptOffer', async req => {
      const offer = await rebook.offerOf(await mine())
      if (!offer.item) return req.reject(404, 'NO_OFFER: There is no offer to accept.')
      await rebook.accept(req, offer.item)
      return rebook.offerOf(await mine())
    })
    return super.init()
  }
}
