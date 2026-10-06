const cds = require('@sap/cds')
const { AsyncLocalStorage } = require('node:async_hooks')
const rebook = require('../lib/rebook')

// The plugin puts the A2A task ID on the executor's context, but action handlers run in a fresh context
// without it. Each tool is wrapped so the task ID travels server-side in this store: never an argument,
// so neither the caller nor the model can set it.
const task = new AsyncLocalStorage()
const TOOLS = ['query', 'describe', 'disruptionImpact', 'proposeRebooking', 'applyRebooking', 'sendOffers']
const OPERATIONS = ['disruptionImpact', 'proposeRebooking', 'applyRebooking', 'sendOffers']

function assertStartup(srv) {
  const ops = Object.keys(srv.operations ?? srv.actions).sort()
  if (JSON.stringify(ops) !== JSON.stringify([...OPERATIONS].sort())) throw new Error(`RebookAgentService operations ${ops} differ from the allowlist`)
  for (const a of ['applyRebooking', 'sendOffers']) if (!srv.actions[a]['@agent.hitl']) throw new Error(`${a} must be annotated @agent.hitl`)
}

module.exports = class RebookAgentService extends cds.ApplicationService {
  async init() {
    assertStartup(this)
    // Runs before the plugin's default buildTools (handlers registered here come first).
    this.on('buildTools', async (req, next) => {
      const tools = await next()
      const names = tools.map(t => t.name)
      if (JSON.stringify(names) !== JSON.stringify(TOOLS)) throw new Error(`Agent tools ${names} differ from the allowlist`)
      for (const t of tools) {
        // The plugin's schemas silently drop unknown arguments; strict ones refuse them.
        if (OPERATIONS.includes(t.name)) t.schema = t.schema.strict()
        const run = t.func
        t.func = (...args) => task.run(cds.context?.['agent.task.id'], () => run(...args))
      }
      return tools
    })
    this.on('disruptionImpact', req => rebook.impact(req, req.data.disruption))
    this.on('proposeRebooking', req => rebook.propose(req, req.data, task.getStore() ?? null))
    this.on('applyRebooking', req => rebook.apply(req, req.data.plan, task.getStore()))
    this.on('sendOffers', req => rebook.sendOffers(req, req.data.plan, task.getStore()))
    return super.init()
  }
}
