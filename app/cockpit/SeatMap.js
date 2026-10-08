// One flight's cabin as an aircraft seen from above: booked, highlighted (affected or moved passengers), held (offered,
// not answered yet), free. Counts only; there are no seat numbers in the data, so logic.cabin places the seats, seeded by
// the flight. A one-seat map is a single seat: the legend's swatch. Every length is a multiple of the seat size, the CSS
// variable --frS, which the cockpit sets so that the planes fill the pane (logic.seatSize).
sap.ui.define(['sap/ui/core/Control', './logic'], (Control, logic) => {
  'use strict'
  const CLASS = { h: 'frSeatHot', b: 'frSeatBooked', o: 'frSeatHeld', f: 'frSeatFree' }
  const { pad: PAD, tail: TAIL, out: OUT } = logic.PLANE
  const inSeats = v => `calc(var(--frS) * ${Math.round(v * 100) / 100})`
  return Control.extend('fr.cockpit.SeatMap', {
    metadata: {
      properties: {
        seatsMax: { type: 'int', defaultValue: 0 },
        seatsBooked: { type: 'int', defaultValue: 0 },
        highlighted: { type: 'int', defaultValue: 0 },
        held: { type: 'int', defaultValue: 0 },
        cancelled: { type: 'boolean', defaultValue: false },
        seed: { type: 'string', defaultValue: '' }
      }
    },
    renderer: {
      apiVersion: 2,
      render(rm, control) {
        const f = { seatsMax: control.getSeatsMax(), seatsBooked: control.getSeatsBooked(), highlighted: control.getHighlighted(), held: control.getHeld() }
        const { groups, seats } = logic.cabin(f, control.getSeed())
        if (seats.length <= 1) {
          rm.openStart('i', control).class('frSeat').class(CLASS[seats[0] ?? 'f']).attr('aria-hidden', 'true').openEnd().close('i')
          return
        }
        const d = logic.dots(f), abreast = groups.reduce((a, b) => a + b, 0), { w, h, cols, column } = logic.planeSize(groups, seats.length)
        const cabinL = w - TAIL - logic.PLANE.nose - 1, fusH = column + 2 * PAD, mid = OUT + fusH / 2
        rm.openStart('div', control).class('frPlane')
        if (control.getCancelled()) rm.class('frSeatMapCancelled')
        rm.style('width', inSeats(w)).style('height', inSeats(h))
        rm.attr('role', 'img').attr('aria-label', `${d.booked + d.highlighted} seats booked, ${d.highlighted} of them highlighted, ${d.held} offered, ${d.free} free`).openEnd()
        const part = (cls, style) => { rm.openStart('i').class(cls); for (const [k, v] of Object.entries(style)) rm.style(k, inSeats(v)); rm.openEnd().close('i') }
        const wing = { left: TAIL + cabinL * 0.36, width: cabinL * 0.34, height: OUT + fusH / 2 }
        part('frWing frWingUp', { ...wing, top: 0 })
        part('frWing frWingDown', { ...wing, top: mid })
        part('frWing frStabUp', { top: OUT * 0.25, width: TAIL + 2, height: OUT * 0.75 + fusH / 2 })
        part('frWing frStabDown', { top: mid, width: TAIL + 2, height: OUT * 0.75 + fusH / 2 })
        part('frFuselage', { top: OUT, width: w, height: fusH })
        part('frShield', { left: w - 3, top: mid - 1.2 })
        rm.openStart('div').class('frCabin').style('left', inSeats(TAIL)).style('top', inSeats(OUT + PAD)).openEnd()
        for (let c = 0; c < cols; c++) {
          rm.openStart('div').class('frCol').openEnd()
          let k = c * abreast
          for (const n of groups) {
            rm.openStart('div').class('frGroup').openEnd()
            for (let i = 0; i < n; i++, k++) rm.openStart('i').class('frSeat').class(k < seats.length ? CLASS[seats[k]] : 'frSeatNone').openEnd().close('i')
            rm.close('div')
          }
          rm.close('div')
        }
        rm.close('div')
        rm.close('div')
      }
    }
  })
})
