// The Traffic panel's chart: drive time above typical per approach, with axes, the rule's threshold and where it fired.
// Geometry comes from logic.chart and the SVG from logic.chartSvg (numbers only, text escaped); the legend is rendered as text.
sap.ui.define(['sap/ui/core/Control', './logic'], (Control, logic) => {
  'use strict'
  return Control.extend('fr.cockpit.TrafficChart', {
    metadata: { properties: { chart: { type: 'object' } } },
    renderer: {
      apiVersion: 2,
      render(rm, control) {
        const c = control.getChart()
        rm.openStart('div', control).class('frChart').openEnd()
        if (c) {
          rm.openStart('div').class('frChartHead').openEnd()
          rm.openStart('span').class('frChartTitle').openEnd().text('Drive time above typical').close('span')
          rm.openStart('span').class('frChartUnit').openEnd().text('minutes, per approach').close('span')
          rm.close('div')
          rm.unsafeHtml(logic.chartSvg(c))
          rm.openStart('div').class('frChartKeys').openEnd()
          for (const l of c.lines) {
            rm.openStart('span').class('frChartKey').class(`frChartC${Number(l.color) || 0}`)
            if (l.hot) rm.class('frChartKeyHot')
            rm.openEnd()
            rm.openStart('i').class('frChartSwatch').openEnd().close('i')
            rm.openStart('span').openEnd().text(l.name).close('span')
            rm.openStart('span').class('frChartValue').openEnd().text(l.value).close('span')
            rm.close('span')
          }
          rm.close('div')
        }
        rm.close('div')
      }
    }
  })
})
