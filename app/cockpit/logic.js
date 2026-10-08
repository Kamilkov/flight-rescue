// The cockpit's logic without any UI: what the controller and the seat map compute from server answers.
// No dependencies, so test/cockpit.test.mjs can load it under node.
sap.ui.define([], () => {
  'use strict'
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const count = v => Math.max(0, Math.trunc(Number(v)) || 0)

  /** "LH 0402 · 14 Oct" */
  const flightLabel = f => `${f.carrierId} ${f.connectionId} · ${Number(f.flightDate.slice(8, 10))} ${MONTHS[Number(f.flightDate.slice(5, 7)) - 1]}`

  /** The status next to a fill map. */
  const note = f => f.cancelled ? 'cancelled' : f.affected ? `${count(f.highlighted)} at risk`
    : `${f.seatsFree > 0 ? `${f.seatsFree} free` : 'full'}${count(f.held) ? `, ${count(f.held)} offered` : ''}`

  /** Dots of one flight. Whatever the counts, they are never negative and add up to the seats. Held (offered) seats
   *  come out of the free ones. */
  function dots(f) {
    const max = count(f.seatsMax), booked = Math.min(max, count(f.seatsBooked)), highlighted = Math.min(booked, count(f.highlighted))
    const held = Math.min(max - booked, count(f.held))
    return { booked: booked - highlighted, highlighted, held, free: max - booked - held }
  }

  /** The disruption list's line: the flight for a cancellation, the road for a traffic jam. */
  const disruptionLabel = d => d.kind === 'TrafficJam' ? `Traffic jam${d.road ? ` · ${d.road}` : ''}` : flightLabel(d)
  const disruptionRoute = d => d.kind === 'TrafficJam' ? `${d.airportFrom} · via ${d.approach}` : `${d.airportFrom}–${d.airportTo}`

  /** A flight as people type it ("lh", "402") in the form the server checks ("LH", "0402"). */
  function flightInput(f) {
    const connection = String(f.connectionId ?? '').trim()
    return {
      carrierId: String(f.carrierId ?? '').trim().toUpperCase(),
      connectionId: /^\d{1,4}$/.test(connection) ? connection.padStart(4, '0') : connection,
      flightDate: String(f.flightDate ?? '').trim()
    }
  }

  /** Plan items by target flight, in order of first appearance, with ABAP's answers. */
  function groupPlan(items) {
    const groups = new Map()
    for (const i of items ?? []) {
      const key = `${i.toCarrierId} ${i.toConnectionId} ${i.toFlightDate}`
      if (!groups.has(key)) groups.set(key, { label: flightLabel({ carrierId: i.toCarrierId, connectionId: i.toConnectionId, flightDate: i.toFlightDate }), count: 0, rebooked: 0, waiting: 0, failed: [] })
      const g = groups.get(key)
      g.count++
      if (i.status === 'Rebooked') g.rebooked++
      if (i.status === 'Offered' || i.status === 'Accepting') g.waiting++
      if (i.status === 'Failed') g.failed.push({ text: `${i.travelId}/${i.bookingId}: ${i.message}` })
    }
    return [...groups.values()]
  }

  const TITLES = { Applying: 'Applying the plan', Applied: 'Plan applied', PartiallyApplied: 'Plan partially applied', Failed: 'Plan failed', Superseded: 'Plan superseded', Offered: 'Offers sent' }
  /** The plan card's title. `waiting`: the agent is paused on this plan. */
  const planTitle = (status, waiting) => status === 'Pending' ? (waiting ? 'Plan needs approval' : 'Plan not applied') : TITLES[status] ?? `Plan ${status}`

  /** What an A2A task means for the chat: the plan it waits on (only while it waits), or its text. While it waits, the
   *  text is the plugin's approval request ("Tool: applyRebooking|sendOffers, Args: …"), which the plan card replaces.
   *  `failed`: the task ended in error (a failing model comes back this way, not as a JSON-RPC error). */
  function reading(task) {
    const status = task?.status, message = status?.message
    const plan = status?.state === 'input-required' ? message?.metadata?.['sap.cds.agents.hitl']?.actionRequests?.[0]?.args?.plan ?? null : null
    const text = plan ? '' : (message?.parts ?? []).filter(p => p.kind === 'text').map(p => p.text).join('\n')
    return { state: status?.state, text, plan, failed: ['failed', 'rejected', 'canceled'].includes(status?.state) }
  }

  /** The agent's markdown as the HTML sap.m.FormattedText allows: paragraphs, bullet lists, bold. Everything else is
   *  escaped. FormattedText allows no table, so table rows become list items, the header row in bold. */
  function html(text) {
    const escaped = String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const out = []
    let list = false, table = false
    for (const line of escaped.split('\n')) {
      const row = line.match(/^\s*\|(.*)\|\s*$/)
      if (row && /^[\s|:-]+$/.test(row[1])) continue // the |---|---| line under a table's header
      const cells = row && row[1].split('|').map(c => c.trim()).join(' · ')
      const item = row ? (table ? cells : `<strong>${cells}</strong>`) : line.match(/^\s*[-*] (.*)$/)?.[1]
      table = !!row
      if ((item !== undefined) !== list) out.push(item !== undefined ? '<ul>' : '</ul>')
      list = item !== undefined
      if (list) out.push(`<li>${item}</li>`)
      else if (line.trim()) out.push(`<p>${line.trim()}</p>`)
    }
    if (list) out.push('</ul>')
    return out.join('').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  }

  /** `fn` one call at a time: calls made while it runs share one more run after it, so reads never overlap and
   *  finish out of order, and the last caller still gets data read after its call. */
  function serial(fn) {
    let running = null, again = null
    return function run() {
      if (!running) return (running = Promise.resolve().then(fn).finally(() => { running = null }))
      const next = () => { again = null; return run() }
      return (again ??= running.then(next, next))
    }
  }

  /** What the page shows for the agent's work on a disruption. load: the task to fetch and show, once. */
  function agentView(d, loadedTask) {
    if (d?.agentStatus === 'Working') return { busy: `The agent is working on the ${d.kind === 'TrafficJam' ? 'traffic jam' : 'cancellation'}`, error: '', load: null }
    if (d?.agentStatus === 'Failed') return { busy: '', error: d.agentMessage || 'The agent stopped.', load: null }
    const ready = ['AwaitingApproval', 'Done'].includes(d?.agentStatus) && d.agentTask && d.agentTask !== loadedTask
    return { busy: '', error: '', load: ready ? d.agentTask : null }
  }

  /** The text while ABAP has not reported a cancellation yet; after 15 s with ABAP's delivery status.
   *  failed: ABAP gave up (its call to this app failed), so the page stops waiting. */
  function waiting(cancellation, seconds) {
    if (seconds < 15 || !cancellation) return { text: 'Waiting for ABAP to report the cancellation…', failed: false }
    if (cancellation.notifyStatus === 'F') return { text: `ABAP could not reach this app: ${cancellation.notifyMessage ?? 'no reason given'}`, failed: true }
    if (cancellation.notifyStatus === 'S') return { text: 'ABAP reported the cancellation; waiting for the disruption…', failed: false }
    return { text: 'Waiting for ABAP to report the cancellation (still queued in ABAP)…', failed: false }
  }

  /** The open disruption the page works on (list is newest first): the one the dispatcher chose in the list; else the
   *  current one while its plan waits on the page (`reviewing`), so a cancellation from elsewhere does not pull the
   *  plan away; else the newest. A closed disruption is no longer listed and no longer counts. */
  function pick(list, current, reviewing, chosen) {
    const find = id => (id && list.find(d => d.ID === id)) || null
    return find(chosen) ?? (reviewing ? find(current?.ID) : null) ?? list[0] ?? null
  }

  /** The mobile page's one status line after a cancel. d: the disruption once ABAP reported it, else null;
   *  cancellation: ABAP's delivery status (read after 15 s). kind: wait | ready | done | error. */
  function mobileStatus(d, cancellation, seconds) {
    if (!d) { const w = waiting(cancellation, seconds); return { text: w.text, kind: w.failed ? 'error' : 'wait' } }
    if (d.agentStatus === 'AwaitingApproval') return { text: 'The plan is waiting for your approval.', kind: 'ready' }
    if (d.agentStatus === 'Done') return { text: 'The agent finished without a plan to approve.', kind: 'done' }
    if (d.agentStatus === 'Failed') return { text: d.agentMessage || 'The agent stopped.', kind: 'error' }
    return { text: 'The agent is working on the cancellation…', kind: 'wait' }
  }

  // The jam card's map: OpenStreetMap tiles, as in the Drone Telemetry app's GeoMap.
  const OSM = {
    MapProvider: [{ name: 'OSM', type: '', description: 'OpenStreetMap', tileX: '256', tileY: '256', maxLOD: '19',
      copyright: '© OpenStreetMap contributors', Source: [{ id: 's1', url: 'https://tile.openstreetmap.org/{LOD}/{X}/{Y}.png' }] }],
    MapLayerStacks: [{ name: 'DEFAULT', MapLayer: [{ name: 'layer1', refMapProvider: 'OSM', opacity: '1.0', colBkgnd: 'RGB(255,255,255)' }] }]
  }
  const FRA = [8.5622, 50.0379]
  // What the jam card's GeoMap needs before there is a replay to show: it throws on an undefined configuration or zoom level.
  const BASE_MAP = { config: OSM, center: `${FRA[0]};${FRA[1]}`, zoom: 11 }

  /** The jam card's chart: drive time above typical (min) per approach as SVG coordinates. x spans the whole replay
   *  (`steps` sample times), so the lines grow left to right; y runs from 0 to above the rule's threshold. */
  function chart(r, width = 300, height = 110) {
    const samples = r?.samples ?? [], clocks = [...new Set(samples.map(s => s.clock))].sort()
    if (!clocks.length) return null
    const over = s => (s.live - s.typical) / 60, limit = r.rule?.minDelayMin ?? 10
    const top = Math.max(limit, ...samples.map(over)) * 1.2, bottom = Math.min(0, ...samples.map(over))
    const steps = Math.max(r.steps ?? clocks.length, 2)
    const x = i => Math.round(i / (steps - 1) * width), y = v => Math.round((top - v) / (top - bottom) * height)
    const lines = [...new Set(samples.map(s => s.origin))].map(origin => ({
      origin,
      points: clocks.flatMap((c, i) => samples.filter(s => s.clock === c && s.origin === origin).map(s => `${x(i)},${y(over(s))}`)).join(' ')
    }))
    return { width, height, threshold: y(limit), lines, fired: r.fired ? x(clocks.indexOf(r.fired.clock)) : null }
  }

  /** "Tue 20 Oct · 08:10" from the demo clock's naive date-time. */
  const clockText = c => { const d = new Date(`${c}Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${c.slice(11, 16)}` }

  /** The jam card: label, demo clock, chart, latest report, rule note, map. Before a replay: { running, clock: '' }. */
  function replayView(r) {
    if (!r?.clock) return { running: !!r?.running, clock: '' }
    const report = r.reports?.at(-1), point = p => `${p[0]};${p[1]};0`
    const coordinates = r.geo?.geometry ? JSON.parse(r.geo.geometry)?.coordinates ?? [] : [], route = coordinates.length > 1
    // With a route, the frame is centred on the middle of the box around FRA and the jam line, so both are in view.
    const mid = k => { const v = [FRA[k], ...coordinates.map(c => c[k])]; return Math.round((Math.min(...v) + Math.max(...v)) / 2 * 1e5) / 1e5 }
    const what = report && (report.delayMin != null ? `+${report.delayMin} min` : String(report.trafficType ?? '').toLowerCase().replace(/_/g, ' '))
    return {
      running: !!r.running, clock: r.clock, label: r.label ?? '', clockText: clockText(r.clock), chart: chart(r),
      report: report ? `${report.road} ${report.location ?? ''} → ${report.direction ?? ''}: ${what}`.replace(/\s+/g, ' ') : '',
      note: r.note ?? (r.fired ? `Rule fired at ${r.fired.clock.slice(11, 16)}: ${r.fired.origin} +${r.fired.delayMin} min over typical` : ''),
      map: { ...BASE_MAP, ...(route && { center: `${mid(0)};${mid(1)}` }), spots: [{ position: point(FRA), label: 'FRA', type: 'Default' }],
        routes: route ? [{ position: coordinates.map(point).join(';') }] : [] }
    }
  }

  return { flightLabel, note, dots, flightInput, groupPlan, planTitle, reading, html, serial, agentView, waiting, pick, mobileStatus, disruptionLabel, disruptionRoute, chart, replayView, baseMap: BASE_MAP }
})
