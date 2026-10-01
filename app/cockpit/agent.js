// The cockpit's client for the rebooking agent: A2A JSON-RPC. The server starts the agent when ABAP reports a cancellation;
// the cockpit loads that task, and resumes it when the dispatcher approves or rejects (the agent's own @agent.hitl pause).
sap.ui.define([], () => {
  'use strict'
  const id = () => crypto.randomUUID()

  async function call(method, params) {
    const res = await fetch('/a2a/rebook-agent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id(), method, params })
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.error || !data?.result) throw new Error(data?.error?.message ?? `The agent did not answer (${res.status}).`)
    return data.result
  }
  const send = (parts, task) => call('message/send', { message: { kind: 'message', role: 'user', messageId: id(), parts, ...(task && { taskId: task.id, contextId: task.contextId }) } })

  return {
    ask: text => send([{ kind: 'text', text }]),
    approve: task => send([{ kind: 'text', text: 'approve' }], task),
    reject: (task, message) => send([{ kind: 'data', data: { decisions: [{ type: 'reject', message }] } }], task),
    /** A task the server started (ABAP's event): the cockpit's user owns it, so it may load and resume it. */
    task: taskId => call('tasks/get', { id: taskId })
  }
})
