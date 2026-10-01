// The cockpit page: state in one JSON model, calls to the control service (OData) and the agent (A2A).
sap.ui.define(['sap/ui/core/mvc/Controller', 'sap/ui/model/json/JSONModel', './agent', './logic'], (Controller, JSONModel, agent, logic) => {
  'use strict'
  const CONTROL = '/odata/v4/control'
  // What one conversation holds; cleared by declare, close and reset.
  const conversation = () => ({ chat: [], after: [], prompt: '', task: null, planID: null, affected: 0, plan: null })

  // One call to the control service: a GET, or a POST when there is a body. Rejects with the server's message.
  async function control(path, body) {
    const res = await fetch(`${CONTROL}/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error?.message ?? `The server answered ${res.status}.`)
    return data
  }

  return Controller.extend('fr.cockpit.Main', {
    onInit() {
      this.model = new JSONModel({
        backend: '', busy: false, busyText: '', errors: { disruption: '', agent: '', board: '' },
        form: { carrierId: '', connectionId: '', flightDate: '', reason: 'Aircraft technical issue' },
        disruptions: [], disruption: null, board: [], ...conversation()
      })
      this.getView().setModel(this.model)
      this.refresh = logic.serial(this.refresh.bind(this)) // the polls during an approval must not overlap
      this.run('disruption', 'Loading', async () => {
        this.demo(await control('demoInfo()'))
        await this.loadDisruptions()
        await this.refresh()
      })
    },

    get(path) { return this.model.getProperty(path) },
    set(path, value) { this.model.setProperty(path, value) },

    // One user action: busy while it runs, its error in its pane's strip, the page usable afterwards.
    async run(pane, text, action) {
      if (this.get('/busy')) return
      this.set('/busy', true); this.set('/busyText', text); this.set(`/errors/${pane}`, '')
      try { await action() } catch (e) { this.set(`/errors/${pane}`, e.message) } finally { this.set('/busy', false) }
    },

    demo(info) {
      this.set('/backend', info.backend)
      if (info.carrierId) this.set('/form', { ...this.get('/form'), carrierId: info.carrierId, connectionId: info.connectionId, flightDate: info.flightDate })
    },

    clear() {
      for (const [key, value] of Object.entries(conversation())) this.set(`/${key}`, value)
    },

    // The most recently declared open disruption is the one the page works on.
    async loadDisruptions() {
      const { value } = await control("Disruptions?$filter=status eq 'Open'&$orderby=createdAt desc")
      const list = value.map(d => ({ ...d, label: logic.flightLabel(d), route: `${d.airportFrom}–${d.airportTo}` }))
      this.set('/disruptions', list)
      this.set('/disruption', list[0] ?? null)
    },

    // Reads the booking system's seats and the plan. Called after every action and once a second during an approval.
    async refresh() {
      const d = this.get('/disruption'), planID = this.get('/planID')
      try {
        const board = d ? (await control(`flightBoard(disruption=${d.ID})`)).value : []
        this.set('/board', board.map(f => ({ ...f, label: logic.flightLabel(f), note: logic.note(f) })))
        this.set('/errors/board', '')
        if (planID) {
          const p = await control(`Plans(${planID})?$expand=items`), groups = logic.groupPlan(p.items)
          const waiting = p.status === 'Pending' && !!this.get('/task')
          this.set('/plan', {
            title: logic.planTitle(p.status, waiting), waiting, rationale: p.rationale, groups,
            failed: groups.flatMap(g => g.failed), unassigned: Math.max(0, this.get('/affected') - p.items.length)
          })
        }
      } catch (e) { this.set('/errors/board', e.message) }
    },

    say(role, text) {
      const list = this.get('/planID') ? '/after' : '/chat' // messages after the plan was proposed go below its card
      this.set(list, [...this.get(list), { role, html: logic.html(text) }])
      // Keep the newest message in view, once UI5 has rendered it.
      setTimeout(() => { const chat = this.byId('chat').getDomRef(); if (chat) chat.scrollTop = chat.scrollHeight }, 100)
    },

    // What the agent's task means for the page: a plan to approve, an answer, or neither.
    async answer(task) {
      const r = logic.reading(task)
      this.set('/task', r.plan ? task : null)
      if (r.plan) {
        this.set('/planID', r.plan)
        this.set('/affected', this.get('/board').find(f => f.cancelled)?.highlighted ?? 0)
      }
      if (r.failed) this.set('/errors/agent', r.text || `The agent stopped (${r.state}).`)
      else if (r.text) this.say('agent', r.text)
      else if (!r.plan) this.set('/errors/agent', `The agent stopped without an answer (${r.state ?? 'no state'}).`)
      await this.refresh()
    },

    onDeclare() {
      this.run('disruption', 'Declaring the disruption', async () => {
        const f = logic.flightInput(this.get('/form'))
        await control('declareDisruption', { ...f, reason: this.get('/form/reason') })
        this.clear()
        await this.loadDisruptions()
        await this.refresh()
        this.set('/prompt', `${f.carrierId} ${f.connectionId} on ${f.flightDate} is cancelled. Rebook the passengers.`)
      })
    },

    onClose(event) {
      const d = event.getSource().getBindingContext().getObject()
      this.run('disruption', 'Closing the disruption', async () => {
        await control('closeDisruption', { disruption: d.ID })
        this.clear()
        await this.loadDisruptions()
        await this.refresh()
      })
    },

    onAsk() {
      const text = this.get('/prompt').trim()
      if (!text || this.get('/busy')) return
      this.say('user', text)
      this.set('/prompt', '')
      this.run('agent', 'The agent is working', async () => this.answer(await agent.ask(text)))
    },

    onApprove() {
      const task = this.get('/task')
      this.run('agent', 'Moving bookings in the booking system', async () => {
        // The approval call returns when every booking was tried; meanwhile show each move as ABAP confirms it.
        const timer = setInterval(() => this.refresh(), 1000)
        try { await this.answer(await agent.approve(task)) } finally { clearInterval(timer) }
      })
    },

    onReject() {
      const task = this.get('/task')
      this.run('agent', 'Rejecting the plan', async () => this.answer(await agent.reject(task, 'Rejected by the dispatcher.')))
    },

    onReset() {
      this.run('disruption', 'Resetting the demo data', async () => {
        const info = await control('resetDemo', {})
        this.clear()
        this.demo(info)
        await this.loadDisruptions()
        await this.refresh()
      })
    }
  })
})
