// The cockpit page: state in one JSON model, calls to the control service (OData) and the agent (A2A).
sap.ui.define(['sap/ui/core/mvc/Controller', 'sap/ui/model/json/JSONModel', './agent', './logic'], (Controller, JSONModel, agent, logic) => {
  'use strict'
  const CONTROL = '/odata/v4/control'
  // What one conversation holds; cleared when the page switches disruption, on close and on reset.
  const conversation = () => ({ chat: [], after: [], prompt: '', task: null, planID: null, affected: 0, plan: null, loadedTask: null })

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
        backend: '', busy: false, busyText: '', waiting: '', agentBusy: '', errors: { disruption: '', agent: '', board: '' },
        form: { carrierId: '', connectionId: '', flightDate: '', reason: 'Aircraft technical issue' },
        disruptions: [], disruption: null, board: [], ...conversation()
      })
      this.getView().setModel(this.model)
      this.refresh = logic.serial(this.refresh.bind(this)) // the polls during an approval must not overlap
      this.poll = logic.serial(this.poll.bind(this))
      // ABAP's events arrive on the server, from this page's cancel or from any other RAP client: look every 2 s.
      setInterval(() => this.poll(), 2000)
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

    // The page works on the newest open disruption, unless the current one's plan waits for approval.
    async loadDisruptions() {
      const { value } = await control("Disruptions?$filter=status eq 'Open'&$orderby=createdAt desc")
      const list = value.map(d => ({ ...d, label: logic.flightLabel(d), route: `${d.airportFrom}–${d.airportTo}` }))
      const current = this.get('/disruption'), next = logic.pick(list, current)
      this.set('/disruptions', list)
      if (next?.ID !== current?.ID) this.clear()
      this.set('/disruption', next)
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

    // New disruptions, the agent's progress on the current one, and while a cancel waits, ABAP's delivery status.
    async poll() {
      if (this.get('/busy')) return // an approval runs; it refreshes the page itself
      try {
        await this.loadDisruptions()
        const d = this.get('/disruption'), e = this.expected
        if (e) {
          if (d && d.carrierId === e.carrierId && d.connectionId === e.connectionId && d.flightDate === e.flightDate) {
            this.expected = null
            this.set('/waiting', '')
          } else {
            const seconds = (Date.now() - e.since) / 1000
            const c = seconds < 15 ? null : await control(`cancellation(carrierId='${e.carrierId}',connectionId='${e.connectionId}',flightDate=${e.flightDate})`).catch(() => null)
            const w = logic.waiting(c, seconds)
            this.set('/waiting', w.failed ? '' : w.text)
            if (w.failed) { this.expected = null; this.set('/errors/disruption', w.text) }
          }
        }
        const v = logic.agentView(d, this.get('/loadedTask'))
        this.set('/agentBusy', v.busy)
        if (v.error) this.set('/errors/agent', v.error)
        if (v.load) {
          this.set('/loadedTask', v.load)
          await this.answer(await agent.task(v.load))
        } else await this.refresh()
      } catch (err) { this.set('/errors/board', err.message) }
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

    onCancel() {
      this.run('disruption', 'Cancelling the flight in ABAP', async () => {
        const f = logic.flightInput(this.get('/form'))
        await control('cancelFlight', { ...f, reason: this.get('/form/reason') })
        this.expected = { ...f, since: Date.now() }
        this.set('/waiting', logic.waiting(null, 0).text)
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
        this.expected = null
        this.set('/waiting', '')
        this.demo(info)
        await this.loadDisruptions()
        await this.refresh()
      })
    }
  })
})
