// The cockpit's client for the rebooking agent: A2A JSON-RPC, one message/send per call.
// The approval is the agent's own @agent.hitl pause; this only resumes the paused task.
sap.ui.define([], () => {
  'use strict'
  const id = () => crypto.randomUUID()

  async function send(parts, task) {
    const message = { kind: 'message', role: 'user', messageId: id(), parts, ...(task && { taskId: task.id, contextId: task.contextId }) }
    const res = await fetch('/a2a/rebook-agent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id(), method: 'message/send', params: { message } })
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.error || !data?.result) throw new Error(data?.error?.message ?? `The agent did not answer (${res.status}).`)
    return data.result
  }

  return {
    ask: text => send([{ kind: 'text', text }]),
    approve: task => send([{ kind: 'text', text: 'approve' }], task),
    reject: (task, message) => send([{ kind: 'data', data: { decisions: [{ type: 'reject', message }] } }], task)
  }
})
