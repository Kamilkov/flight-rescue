// The cockpit's logic without any UI: what the controller and the seat map compute from server answers.
// No dependencies, so test/cockpit.test.mjs can load it under node.
sap.ui.define([], () => {
  'use strict'
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const count = v => Math.max(0, Math.trunc(Number(v)) || 0)

  /** "LH 0402 · 14 Oct" */
  const flightLabel = f => `${f.carrierId} ${f.connectionId} · ${Number(f.flightDate.slice(8, 10))} ${MONTHS[Number(f.flightDate.slice(5, 7)) - 1]}`

  /** The status next to a fill map. Its free seats are the dots' (the seats offered come out of the free ones), not ABAP's seatsFree. */
  function note(f) {
    if (f.cancelled) return 'cancelled'
    if (f.affected) return `${count(f.highlighted)} at risk`
    const free = dots(f).free, offered = count(f.held)
    return offered ? `${offered} offered, ${free > 0 ? `${free} free` : 'none free'}` : free > 0 ? `${free} free` : 'full'
  }

  /** Dots of one flight. Whatever the counts, they are never negative and add up to the seats. Held (offered) seats
   *  come out of the free ones. */
  function dots(f) {
    const max = count(f.seatsMax), booked = Math.min(max, count(f.seatsBooked)), highlighted = Math.min(booked, count(f.highlighted))
    const held = Math.min(max - booked, count(f.held))
    return { booked: booked - highlighted, highlighted, held, free: max - booked - held }
  }

  /** The Disruption pane's error text after a replay read. A failed read writes its message there; a good one takes back
   *  only that message (`wrote`), so another error that came meanwhile (a cancel that ABAP did not deliver) stays.
   *  `failure`: the read's error message, '' when it went through. */
  const replayError = (text, wrote, failure) => failure ? { text: failure, wrote: failure } : { text: text === wrote ? '' : text, wrote: '' }

  /** Which trigger pane 1 offers, from the page's query: `?demo=cancel` or `?demo=traffic` for a focused recording;
   *  without it (or with anything else) both, as the README's links expect. */
  const demoMode = search => {
    const demo = new URLSearchParams(search).get('demo')
    return { cancel: demo !== 'traffic', traffic: demo !== 'cancel' }
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

  // The Traffic panel's map: OpenStreetMap tiles, as in the Drone Telemetry app's GeoMap.
  const OSM = {
    MapProvider: [{ name: 'OSM', type: '', description: 'OpenStreetMap', tileX: '256', tileY: '256', maxLOD: '19',
      copyright: '© OpenStreetMap contributors', Source: [{ id: 's1', url: 'https://tile.openstreetmap.org/{LOD}/{X}/{Y}.png' }] }],
    MapLayerStacks: [{ name: 'DEFAULT', MapLayer: [{ name: 'layer1', refMapProvider: 'OSM', opacity: '1.0', colBkgnd: 'RGB(255,255,255)' }] }]
  }
  const FRA = [8.5622, 50.0379]
  // What the Traffic panel's GeoMap needs before there is a replay to show: it throws on an undefined configuration or zoom level.
  const BASE_MAP = { config: OSM, center: `${FRA[0]};${FRA[1]}`, zoom: 12 }

  // The approaches' display names; the others are their id capitalised.
  const PLACES = { badhomburg: 'Bad Homburg' }
  const place = o => PLACES[o] ?? `${o.charAt(0).toUpperCase()}${o.slice(1)}`
  const r1 = v => Math.round(v * 10) / 10
  const signed = v => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`
  const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const minutes = c => Date.parse(`${c}Z`) / 60000

  /** The Traffic panel's chart: drive time above typical (min) per approach, in a fixed 498×180 viewBox that the page
   *  scales without stretching. x spans the whole replay (`steps` sample times), so the lines grow left to right and the
   *  rest is shaded until the last sample; y runs in round steps from below 0 to above the rule's threshold. Once the rule
   *  has fired, its approach is drawn heavier (`hot`) and the others fade. */
  function chart(r) {
    const samples = r?.samples ?? [], clocks = [...new Set(samples.map(s => s.clock))].sort()
    if (!clocks.length) return null
    const width = 498, height = 180, plot = { left: 32, right: 486, top: 18, bottom: 156 }
    const over = s => (s.live - s.typical) / 60, limit = r.rule?.minDelayMin ?? 10, values = samples.map(over)
    const hi = Math.max(limit, ...values), lo = Math.min(0, ...values)
    const step = [1, 2, 3, 5, 10, 15, 20, 30, 60].find(t => (hi - lo) / t <= 5) ?? 120
    let top = Math.floor(hi / step) * step + step
    if (top - hi < step / 2) top += step // room for the peak's label
    const bottom = Math.min(0, Math.floor(lo / step) * step), steps = Math.max(r.steps ?? clocks.length, 2)
    const y = v => r1(plot.top + (top - v) / (top - bottom) * (plot.bottom - plot.top))
    const x = i => r1(plot.left + i / (steps - 1) * (plot.right - plot.left))
    const yTicks = []
    for (let v = bottom; v <= top; v += step) yTicks.push({ y: y(v), label: v < 0 ? `−${-v}` : String(v), rule: v === limit })
    const xTicks = []
    if (clocks.length > 1) { // the sample interval is known from the first two samples
      const start = minutes(clocks[0]), span = (minutes(clocks[1]) - start) * (steps - 1), every = span <= 180 ? 30 : 60
      for (let m = Math.ceil(start / every) * every; m <= start + span; m += every)
        xTicks.push({ x: r1(plot.left + (m - start) / span * (plot.right - plot.left)), label: hhmm(m) })
    }
    const hot = r.fired?.origin, at = (origin, i) => samples.find(s => s.clock === clocks[i] && s.origin === origin)
    const lines = [...new Set(samples.map(s => s.origin))].map((origin, k) => {
      const own = clocks.flatMap((c, i) => { const s = at(origin, i); return s ? [[i, over(s)]] : [] })
      return { origin, name: place(origin), color: k % 4, hot: origin === hot, dim: !!hot && origin !== hot,
        value: signed(own.at(-1)[1]), own, points: own.map(([i, v]) => `${x(i)},${y(v)}`).join(' ') }
    })
    const hotLine = lines.find(l => l.hot), clamp = (v, m) => Math.min(Math.max(v, plot.left + m), plot.right - m)
    const firedAt = r.fired ? clocks.indexOf(r.fired.clock) : -1, firedPoint = hotLine?.own.find(([i]) => i === firedAt)
    const peak = hotLine?.own.reduce((a, b) => b[1] > a[1] ? b : a)
    return {
      width, height, plot, zero: y(0), yTicks, xTicks,
      threshold: { y: y(limit), label: `Rule · ${limit} min for ${r.rule?.runs ?? 2} samples` },
      lines: lines.map(({ own, ...l }) => l),
      area: hotLine ? `${hotLine.points} ${x(hotLine.own.at(-1)[0])},${y(0)} ${x(hotLine.own[0][0])},${y(0)}` : null,
      fired: firedPoint ? { x: x(firedAt), y: y(firedPoint[1]), pill: clamp(x(firedAt), 40), label: `Fired ${r.fired.clock.slice(11, 16)}`, color: hotLine.color } : null,
      peak: peak && peak[0] !== firedAt ? { x: clamp(x(peak[0]), 30), y: y(peak[1]) - 9, label: `${signed(peak[1])} peak` } : null,
      now: clocks.length < steps ? x(clocks.length - 1) : null
    }
  }

  /** The chart as SVG markup. Every number goes through Number() and every text is escaped: nothing from the server
   *  reaches the markup as markup. */
  function chartSvg(c) {
    const n = v => Number(v) || 0, t = v => String(v).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
    const pts = v => String(v).replace(/[^0-9., ]/g, ''), { left, right, top, bottom } = c.plot
    const line = (cls, x1, x2, y1, y2) => `<line class="${cls}" x1="${n(x1)}" x2="${n(x2)}" y1="${n(y1)}" y2="${n(y2)}"/>`
    const text = (cls, x, y, s) => `<text class="${cls}" x="${n(x)}" y="${n(y)}">${t(s)}</text>`
    return `<svg viewBox="0 0 ${n(c.width)} ${n(c.height)}" role="img" aria-label="Drive time above typical per approach">`
      + (c.now == null ? '' : `<rect class="frChartFuture" x="${n(c.now)}" y="${n(top)}" width="${n(right - c.now)}" height="${n(bottom - top)}"/>`)
      + c.yTicks.map(k => (k.y === n(bottom) ? '' : line(n(k.y) === n(c.zero) ? 'frChartZero' : 'frChartGrid', left, right, k.y, k.y))
        + text(k.rule ? 'frChartTick frChartTickY frChartRule' : 'frChartTick frChartTickY', left - 8, n(k.y) + 4, k.label)).join('')
      + line('frChartAxis', left, right, bottom, bottom)
      + c.xTicks.map(k => line('frChartAxis', k.x, k.x, bottom, bottom + 4) + text('frChartTick frChartTickX', k.x, bottom + 18, k.label)).join('')
      + line('frChartThreshold', left, right, c.threshold.y, c.threshold.y)
      + text('frChartRule frChartRuleLabel', right, n(c.threshold.y) - 5, c.threshold.label)
      + (c.area ? `<polygon class="frChartArea frChartC${n(c.lines.find(l => l.hot)?.color)}" points="${pts(c.area)}"/>` : '')
      + [...c.lines].sort((a, b) => a.hot - b.hot).map(l => // the hot line on top
        `<polyline class="frChartLine frChartC${n(l.color)}${l.hot ? ' frChartHot' : ''}${l.dim ? ' frChartDim' : ''}" points="${pts(l.points)}"/>`).join('')
      + (c.now == null ? '' : line('frChartNow', c.now, c.now, top, bottom))
      + (c.fired ? line('frChartFired', c.fired.x, c.fired.x, top, bottom)
        + `<rect class="frChartPill" x="${n(c.fired.pill) - 40}" y="0" width="80" height="18" rx="9"/>` + text('frChartPillText', c.fired.pill, 12.5, c.fired.label)
        + `<circle class="frChartDot frChartC${n(c.fired.color)}" cx="${n(c.fired.x)}" cy="${n(c.fired.y)}" r="4.5"/>` : '')
      + (c.peak ? text('frChartPeak', c.peak.x, c.peak.y, c.peak.label) : '')
      + '</svg>'
  }

  /** "Tue 20 Oct · 08:10" from the demo clock's naive date-time. */
  const clockText = c => { const d = new Date(`${c}Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${c.slice(11, 16)}` }

  /** The Traffic panel: label, demo clock, chart, latest report, rule note, map. Before a replay: { running, clock: '' }. */
  function replayView(r) {
    if (!r?.clock) return { running: !!r?.running, clock: '' }
    const report = r.reports?.at(-1), point = p => `${p[0]};${p[1]};0`
    const coordinates = r.geo?.geometry ? JSON.parse(r.geo.geometry)?.coordinates ?? [] : [], route = coordinates.length > 1
    // With a route, the frame is centred on the middle of the box around FRA and the jam line, so both fit at the fixed zoom while the box is smaller than the frame.
    const mid = k => { const v = [FRA[k], ...coordinates.map(c => c[k])]; return Math.round((Math.min(...v) + Math.max(...v)) / 2 * 1e5) / 1e5 }
    const what = report && (report.delayMin != null ? `+${report.delayMin} min` : String(report.trafficType ?? '').toLowerCase().replace(/_/g, ' '))
    return {
      running: !!r.running, paused: !!r.paused, clock: r.clock, label: r.label ?? '', clockText: clockText(r.clock), chart: chart(r),
      report: report ? { road: report.road ?? '', place: `${report.location ?? ''} → ${report.direction ?? ''}`.replace(/\s+/g, ' ').trim(), what } : null,
      note: r.note ?? (r.fired ? `Rule fired at ${r.fired.clock.slice(11, 16)}: ${place(r.fired.origin)} +${r.fired.delayMin} min over typical` : ''),
      map: { ...BASE_MAP, ...(route && { center: `${mid(0)};${mid(1)}` }), spots: [{ position: point(FRA), label: 'FRA', type: 'Default' }],
        routes: route ? [{ position: coordinates.map(point).join(';') }] : [] }
    }
  }

  return { flightLabel, note, dots, flightInput, groupPlan, planTitle, reading, html, serial, agentView, waiting, pick, mobileStatus, disruptionLabel, disruptionRoute, chart, chartSvg, replayView, replayError, demoMode, baseMap: BASE_MAP }
})
