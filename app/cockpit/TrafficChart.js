// The Traffic panel's chart: drive time above typical per approach, the rule's threshold and where it fired.
// Geometry comes from logic.chart; this control only writes it as SVG (numbers and approach names, both sanitised).
sap.ui.define(['sap/ui/core/Control'], Control => {
  'use strict'
  const n = v => Number(v) || 0
  const name = s => String(s).replace(/[^a-z0-9-]/gi, '')
  return Control.extend('fr.cockpit.TrafficChart', {
    metadata: { properties: { chart: { type: 'object' } } },
    renderer: {
      apiVersion: 2,
      render(rm, control) {
        const c = control.getChart()
        rm.openStart('div', control).class('frChart').openEnd()
        if (c) {
          const lines = c.lines.map((l, i) => `<polyline class="frChartLine frChartLine${i % 4}" points="${String(l.points).replace(/[^0-9., ]/g, '')}"/>`).join('')
          const fired = c.fired == null ? '' : `<line class="frChartFired" x1="${n(c.fired)}" x2="${n(c.fired)}" y1="0" y2="${n(c.height)}"/>`
          rm.unsafeHtml(`<svg viewBox="0 0 ${n(c.width)} ${n(c.height)}" preserveAspectRatio="none" role="img" aria-label="Drive time above typical per approach">`
            + `<line class="frChartThreshold" x1="0" x2="${n(c.width)}" y1="${n(c.threshold)}" y2="${n(c.threshold)}"/>${lines}${fired}</svg>`)
          rm.unsafeHtml(`<div class="frChartKeys">${c.lines.map((l, i) => `<span class="frChartKey${i % 4}">${name(l.origin)}</span>`).join('')}</div>`)
        }
        rm.close('div')
      }
    }
  })
})
