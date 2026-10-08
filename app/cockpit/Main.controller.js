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

  // The Traffic panel's model. Its GeoMap throws on an undefined configuration or zoom level, so the map's base settings
  // are in the model before any replay and after a reset, when replayView has no map.
  const jam = r => ({ map: logic.baseMap, ...logic.replayView(r) })

  return Controller.extend('fr.cockpit.Main', {
    onInit() {
      this.model = new JSONModel({
        backend: '', busy: false, busyText: '', waiting: '', agentBusy: '', errors: { disruption: '', agent: '', board: '' },
        form: { carrierId: '', connectionId: '', flightDate: '', reason: 'Aircraft technical issue' },
        disruptions: [], disruption: null, board: [], replay: jam(null), show: logic.demoMode(location.search), ...conversation()
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

    // The planes fill the Booking system pane: one seat size for all of them, the largest at which they fit (logic.seatSize),
    // set as a CSS variable on the pane, so a resize redraws nothing. The pane's element outlives the board's re-renders.
    onAfterRendering() {
      const pane = this.byId('bookingPane').getDomRef()
      if (!pane || pane === this.observed) return
      this.observed = pane
      new ResizeObserver(() => this.fitBoard()).observe(pane)
    },

    fitBoard() {
      const pane = this.byId('bookingPane').getDomRef(), board = this.byId('board').getDomRef()
      if (pane && board) pane.style.setProperty('--frS', `${logic.seatSize(this.get('/board'), board.clientWidth, board.clientHeight)}px`)
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

    // The page works on the disruption the dispatcher chose, else on the one whose plan waits here, else on the newest.
    async loadDisruptions() {
      const { value } = await control("Disruptions?$filter=status eq 'Open'&$orderby=createdAt desc")
      const list = value.map(d => ({ ...d, label: logic.disruptionLabel(d), route: logic.disruptionRoute(d) }))
      const current = this.get('/disruption'), next = logic.pick(list, current, !!this.get('/plan/waiting'), this.chosen)
      // Only a changed list is set: re-rendering it every poll would move the focus ring onto the clicked item.
      if (JSON.stringify(list) !== JSON.stringify(this.get('/disruptions'))) this.set('/disruptions', list)
      if (next?.ID !== current?.ID) this.clear()
      this.set('/disruption', next)
    },

    // The Traffic panel follows the replay on the server (started here or elsewhere). A failing read keeps the panel as it was and
    // shows in its pane until a read goes through (and only its own text goes: logic.replayError); it never throws, so it cannot
    // stop the rest of poll().
    async loadReplay() {
      let failure = ''
      try { this.set('/replay', jam(await control('trafficReplay()'))); this.frameMap() } catch (e) { failure = e.message }
      const next = logic.replayError(this.get('/errors/disruption'), this.replayWrote, failure)
      this.set('/errors/disruption', next.text)
      this.replayWrote = next.wrote
    },

    // GeoMap honours its bound centre only at its first render, so frame it by hand when the centre changes. Never for an
    // unchanged centre: that would undo the dispatcher's pan and zoom on every poll. Not rendered yet: the next poll does it.
    frameMap() {
      const center = this.get('/replay/map/center'), map = this.byId('map')
      if (!this.get('/replay/clock')) this.framed = null // the panel is hidden; the next replay frames again
      else if (center !== this.framed && map?.getDomRef()) {
        const [lon, lat] = center.split(';').map(Number)
        map.zoomToGeoPosition(lon, lat, this.get('/replay/map/zoom'))
        this.framed = center
      }
    },

    // Reads the booking system's seats and the plan. Called after every action and once a second during an approval.
    async refresh() {
      const d = this.get('/disruption'), planID = this.get('/planID')
      try {
        const board = d ? (await control(`flightBoard(disruption=${d.ID})`)).value : []
        this.set('/board', board.map(f => ({ ...f, name: `${f.carrierId} ${f.connectionId}`, when: logic.flightWhen(f), note: logic.note(f), free: logic.dots(f).free })))
        this.fitBoard()
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
        await this.loadReplay()
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
        this.set('/affected', this.get('/board').find(f => f.cancelled || f.affected)?.highlighted ?? 0)
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

    onReplay() {
      this.run('disruption', 'Starting the replay', async () => {
        this.set('/replay', jam(await control('replayTraffic', {})))
        this.frameMap()
      })
    },

    // Pause or resume the replay on the server; its answer is the replay as it stands.
    onPause() {
      const paused = !this.get('/replay/paused')
      this.run('disruption', paused ? 'Pausing the replay' : 'Resuming the replay', async () => {
        this.set('/replay', jam(await control('pauseReplay', { paused })))
        this.frameMap()
      })
    },

    // One sample of the paused replay.
    onStep() {
      this.run('disruption', 'Playing the next sample', async () => {
        this.set('/replay', jam(await control('stepReplay', {})))
        this.frameMap()
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

    // A disruption chosen in the list: the page stays on it until its plan is decided or another one is chosen.
    onSelect(event) {
      const d = event.getSource().getBindingContext().getObject()
      this.run('disruption', 'Opening the disruption', async () => {
        this.chosen = d.ID
        await this.loadDisruptions()
        const v = logic.agentView(this.get('/disruption'), this.get('/loadedTask'))
        if (v.load) { this.set('/loadedTask', v.load); await this.answer(await agent.task(v.load)) } else await this.refresh()
      })
    },

    onApprove() {
      const task = this.get('/task')
      this.run('agent', this.get('/disruption')?.kind === 'TrafficJam' ? 'Sending the offers' : 'Moving bookings in the booking system', async () => {
        // The approval call returns when every booking was tried; meanwhile show each move as ABAP confirms it.
        const timer = setInterval(() => this.refresh(), 1000)
        try { await this.answer(await agent.approve(task)) } finally { clearInterval(timer); this.chosen = null }
      })
    },

    onReject() {
      const task = this.get('/task')
      this.run('agent', 'Rejecting the plan', async () => {
        try { await this.answer(await agent.reject(task, 'Rejected by the dispatcher.')) } finally { this.chosen = null }
      })
    },

    onReset() {
      this.run('disruption', 'Resetting the demo data', async () => {
        const info = await control('resetDemo', {})
        this.clear()
        this.expected = null
        this.set('/waiting', '')
        this.demo(info)
        this.set('/replay', jam(null))
        this.frameMap()
        await this.loadDisruptions()
        await this.refresh()
      })
    }
  })
})
