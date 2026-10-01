// The cockpit's logic without any UI: what the controller and the seat map compute from server answers.
// No dependencies, so test/cockpit.test.mjs can load it under node.
sap.ui.define([], () => {
  'use strict'
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const count = v => Math.max(0, Math.trunc(Number(v)) || 0)

  /** "LH 0402 · 14 Oct" */
  const flightLabel = f => `${f.carrierId} ${f.connectionId} · ${Number(f.flightDate.slice(8, 10))} ${MONTHS[Number(f.flightDate.slice(5, 7)) - 1]}`

  /** The status next to a fill map. */
  const note = f => f.cancelled ? 'cancelled' : f.seatsFree > 0 ? `${f.seatsFree} free` : 'full'

  /** Dots of one flight. Whatever the counts, they are never negative and add up to the seats. */
  function dots(f) {
    const max = count(f.seatsMax), booked = Math.min(max, count(f.seatsBooked)), highlighted = Math.min(booked, count(f.highlighted))
    return { booked: booked - highlighted, highlighted, free: max - booked }
  }

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
      if (!groups.has(key)) groups.set(key, { label: flightLabel({ carrierId: i.toCarrierId, connectionId: i.toConnectionId, flightDate: i.toFlightDate }), count: 0, rebooked: 0, failed: [] })
      const g = groups.get(key)
      g.count++
      if (i.status === 'Rebooked') g.rebooked++
      if (i.status === 'Failed') g.failed.push({ text: `${i.travelId}/${i.bookingId}: ${i.message}` })
    }
    return [...groups.values()]
  }

  const TITLES = { Applying: 'Applying the plan', Applied: 'Plan applied', PartiallyApplied: 'Plan partially applied', Failed: 'Plan failed', Superseded: 'Plan superseded' }
  /** The plan card's title. `waiting`: the agent is paused on this plan. */
  const planTitle = (status, waiting) => status === 'Pending' ? (waiting ? 'Plan needs approval' : 'Plan not applied') : TITLES[status] ?? `Plan ${status}`

  /** What an A2A task means for the chat: the plan it waits on (only while it waits), or its text. While it waits, the
   *  text is the plugin's approval request ("Tool: applyRebooking, Args: …"), which the plan card replaces.
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

  return { flightLabel, note, dots, flightInput, groupPlan, planTitle, reading, html, serial }
})
