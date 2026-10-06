// The passenger page's logic without any UI: what the phone shows for an offer. No dependencies, so the tests load it
// under node and the page runs its factory without UI5.
sap.ui.define([], () => {
  'use strict'
  const time = t => String(t ?? '').slice(0, 5)
  const flight = f => `${f.carrierId} ${f.connectionId} at ${time(f.departureTime)}`

  /** kind: none | offer | wait | done | error; action: show Accept. */
  function offerView(o) {
    if (!o?.status) return { kind: 'none', title: 'No offer', text: 'Nothing to do: your flight is on track.', action: false }
    const current = flight(o.current), offered = flight(o.offered)
    if (o.status === 'Offered') return { kind: 'offer', title: 'Traffic jam on your way to the airport',
      text: `${o.reason}. You may miss ${current}. Switch to ${offered}, free of charge?`, action: true }
    if (o.status === 'Accepting') return { kind: 'wait', title: 'Rebooking…', text: `Moving you to ${offered}.`, action: false }
    if (o.status === 'Rebooked') return { kind: 'done', title: 'You are rebooked', text: `You fly ${offered} instead of ${current}.`, action: false }
    return { kind: 'error', title: 'The rebooking did not work', text: o.message || 'The booking system refused the change.', action: false }
  }

  return { offerView }
})
