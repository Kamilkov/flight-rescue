const cds = require('@sap/cds')
const LOG = cds.log('agent-start')

// Starts the rebooking agent for a disruption the booking system reported or the traffic replay opened. An agent task belongs to the user who
// starts it (@cap-js/agents filters tasks, checkpoints and resumes by createdBy), so it is started as the
// dispatcher on duty: the cockpit, signed in as that user, loads the paused task and approves it.
// It goes through the app's own A2A endpoint, the plugin's documented interface.
const DISPATCHER = 'dispatcher'
const STATES = { 'input-required': 'AwaitingApproval', completed: 'Done' }
let base = null
cds.on('listening', ({ url }) => { base = url })

const prompt = d => d.kind === 'TrafficJam'
  ? `Traffic jam at ${d.airportFrom} (disruption ${d.ID}): ${d.reason}. Offer the passengers at risk a later flight.`
  : `${d.carrierId} ${d.connectionId} on ${String(d.flightDate).slice(0, 10)} was cancelled in the booking system (disruption ${d.ID}). Rebook the passengers.`

async function run(ID) {
  if (!base) throw new Error('The server URL is not known yet.')
  // Each statement in its own transaction: nothing is held while the model works.
  const d = await cds.db.tx(tx => tx.run(SELECT.one.from('fr.Disruptions').where({ ID })))
  const auth = 'Basic ' + Buffer.from(`${DISPATCHER}:${process.env.DISPATCHER_PASSWORD ?? ''}`).toString('base64')
  const message = { kind: 'message', role: 'user', messageId: cds.utils.uuid(), parts: [{ kind: 'text', text: prompt(d) }] }
  const res = await fetch(`${base}/a2a/rebook-agent`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: cds.utils.uuid(), method: 'message/send', params: { message } }),
    signal: AbortSignal.timeout(300_000)
  })
  const data = await res.json().catch(() => null)
  const task = data?.result
  if (!res.ok || !task) throw new Error(data?.error?.message ?? `The agent did not answer (${res.status}).`)
  const status = STATES[task.status?.state]
  const text = (task.status?.message?.parts ?? []).filter(p => p.kind === 'text').map(p => p.text).join(' ')
  return { agentTask: task.id, agentStatus: status ?? 'Failed', agentMessage: status ? null : (text || `The agent stopped (${task.status?.state}).`).slice(0, 500) }
}

/** Runs the agent in the background; its outcome, or why it failed, ends up on the disruption. */
function start(ID) {
  cds.spawn(async () => {
    let result
    try { result = await run(ID) } catch (e) {
      LOG.error('agent start failed for disruption', ID, e.message)
      result = { agentStatus: 'Failed', agentMessage: String(e.message).slice(0, 500) }
    }
    await cds.db.tx(tx => tx.run(UPDATE('fr.Disruptions', ID).with(result)))
  })
}

module.exports = { start, prompt }
