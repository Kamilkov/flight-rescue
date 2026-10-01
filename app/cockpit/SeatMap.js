// One flight's cabin as dots: booked, highlighted (affected or moved passengers), free.
// Counts only; there are no seat numbers in the data.
sap.ui.define(['sap/ui/core/Control', './logic'], (Control, logic) => {
  'use strict'
  return Control.extend('fr.cockpit.SeatMap', {
    metadata: {
      properties: {
        seatsMax: { type: 'int', defaultValue: 0 },
        seatsBooked: { type: 'int', defaultValue: 0 },
        highlighted: { type: 'int', defaultValue: 0 },
        cancelled: { type: 'boolean', defaultValue: false }
      }
    },
    renderer: {
      apiVersion: 2,
      render(rm, control) {
        const d = logic.dots({ seatsMax: control.getSeatsMax(), seatsBooked: control.getSeatsBooked(), highlighted: control.getHighlighted() })
        rm.openStart('div', control).class('frSeatMap')
        if (control.getCancelled()) rm.class('frSeatMapCancelled')
        rm.attr('role', 'img').attr('aria-label', `${d.booked + d.highlighted} seats booked, ${d.highlighted} of them highlighted, ${d.free} free`).openEnd()
        const seats = (n, css) => { for (let i = 0; i < n; i++) rm.openStart('i').class(css).openEnd().close('i') }
        seats(d.booked, 'frSeatBooked')
        seats(d.highlighted, 'frSeatHot')
        seats(d.free, 'frSeatFree')
        rm.close('div')
      }
    }
  })
})
