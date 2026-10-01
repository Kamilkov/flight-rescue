// Test-only chat model, loaded through cds.requires.llm.impl: no network, no key. It plays the agent's
// intended flow, step by step, from the tool results it is shown (set per test on globalThis.FR_LLM):
//   { disruption, assignments?, extra?, stopAfterPropose? }
// disruptionImpact → proposeRebooking (greedy earliest-first unless `assignments` is given) → applyRebooking.
// It records the tool names it is given on globalThis.FR_LLM_TOOLS.
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage } from '@langchain/core/messages'

// The plugin shows tool results to the model in TOON: arrays as `name[n]{a,b}:` followed by n CSV rows.
export function table(text, name) {
  const lines = text.split('\n'), i = lines.findIndex(l => new RegExp(`^\\s*${name}\\[\\d+\\]\\{`).test(l))
  if (i < 0) return null
  const [, n, fields] = lines[i].match(/\[(\d+)\]\{([^}]*)\}:/)
  const cell = v => /^".*"$/.test(v) ? v.slice(1, -1) : /^-?\d+$/.test(v) ? Number(v) : v
  return lines.slice(i + 1, i + 1 + Number(n)).map(l => {
    const values = l.trim().match(/("[^"]*"|[^,]+)/g).map(cell)
    return Object.fromEntries(fields.split(',').map((f, k) => [f, values[k]]))
  })
}

export function greedy(impact) {
  const seats = impact.alternatives.map(a => ({ ...a, left: a.seatsAvailable }))
  const out = []
  for (const b of impact.affectedBookings) {
    const f = seats.find(s => s.left > 0)
    if (!f) break
    f.left--
    out.push({ travelId: b.travelId, bookingId: b.bookingId, carrierId: f.carrierId, connectionId: f.connectionId, flightDate: f.flightDate })
  }
  return out
}

export default class ScriptedModel extends BaseChatModel {
  constructor(name) { super({}); this.name = name; this._tools = [] }
  _llmType() { return 'fr-scripted' }
  bindTools(tools) { const b = Object.create(this); b._tools = tools ?? []; return b }
  async _generate(messages) {
    const script = globalThis.FR_LLM ?? {}
    ;(globalThis.FR_LLM_TOOLS ??= []).push(this._tools.map(t => t.name))
    const tools = messages.filter(m => m._getType() === 'tool'), last = tools.at(-1)
    const call = (name, args) => ({ generations: [{ message: new AIMessage({ content: '', tool_calls: [{ id: `c${messages.length}`, name, args }] }) }] })
    const done = text => ({ generations: [{ message: new AIMessage(text) }] })
    const text = String(last?.content ?? '')
    if (!last) return call('disruptionImpact', { disruption: script.disruption })
    if (last.name === 'disruptionImpact') {
      const impact = { affectedBookings: table(text, 'affectedBookings'), alternatives: table(text, 'alternatives') ?? [] }
      if (!impact.affectedBookings) return done(`Scripted end. ${text.slice(0, 300)}`)
      return call('proposeRebooking', { disruption: script.disruption, assignments: script.assignments ?? greedy(impact), rationale: 'Scripted: earliest flights first.', ...script.extra })
    }
    if (last.name === 'proposeRebooking') {
      const plan = text.match(/\bplan: ([0-9a-f-]{36})/)?.[1]
      if (plan && !script.stopAfterPropose) return call('applyRebooking', { plan })
    }
    return done(`Scripted end. Last tool result: ${text.slice(0, 4000)}`)
  }
}
ScriptedModel._is_service_class = true
