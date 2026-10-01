# Flight Rescue

A flight is cancelled. A **CAP-level agent** (`@cap-js/agents`, [Sep 2026 release](https://cap.cloud.sap/docs/releases/2026/sep26#new-cap-level-agents)) reads the affected bookings from your **ABAP trial**, proposes moving them to other flights on the same route, and **pauses for a dispatcher to approve**. Only after approval are the bookings moved in ABAP, one by one, through a custom RAP action.

The server decides what is valid, the model only chooses among listed options, and the one action that changes data is `@agent.hitl`.

The flight is cancelled in ABAP itself: a RAP business event reports it to the app, which starts the agent on its own. The dispatcher meets it at the approval card.

```
 cockpit ──cancelFlight──▶ ControlService ──OData V4──▶ ABAP trial: ZR_FR_FlightCancel (create, precheck)
                                                          │ save: event FlightCancelled → bgRFC
                                                          ▼ ZCL_FR_FLIGHTCANCEL_EVENTS, HTTP via SM59 ZFR_CAP_EVENTS
                          EventsService /events ◀─────────┘ (user abap-events, role EventSource)
                                │ opens the disruption, starts the agent as the dispatcher (A2A)
                                ▼
                     RebookAgentService (@agent, ReAct loop in CAP) ── pauses at applyRebooking (@agent.hitl)
                                │ tools: query, describe, disruptionImpact, proposeRebooking, applyRebooking
                     srv/lib/rebook.js ── rules, plans (SQLite) ── srv/lib/abap.js ──OData V4──▶ ZFR_REBOOK
```

## Layout

| Path | Contents |
|---|---|
| `abap/` | ABAP sources to create in ADT: table, generator class, CDS views, behavior, service definition |
| `srv/external/` | The ZFR_REBOOK contract as CDS, and the mock used when no ABAP system is configured (same checks and messages as the ABAP action) |
| `srv/rebook-agent/` | The `@agent` service. Its doc comment is the system prompt |
| `srv/control/` | OData service for dispatchers: cancel a flight in ABAP, close a disruption, read plans |
| `srv/events/` | REST service for the booking system: ABAP reports a cancelled flight here |
| `srv/lib/agent-start.js` | Starts the agent for a reported cancellation, as the dispatcher on duty |
| `scripts/live-check.mjs` | Cancels the demo flight on the deployed app and waits for ABAP's event and the agent |
| `Dockerfile` | The container that runs next to the ABAP trial on the VPS |
| `srv/lib/` | `abap.js` (the only module that calls ABAP) and `rebook.js` (impact, propose, apply) |
| `app/cockpit/` | The dispatcher's page (SAPUI5, no build step): cancel a flight, follow the agent, approve, watch the seats |
| `db/schema.cds` | What this app owns: disruptions, plans, plan items |
| `test/` | `node --test` suites with a scripted model (no key, no network) |

## Run locally against the mock

Node.js 22 or later.

```sh
cd flight-rescue
npm ci
export ANTHROPIC_API_KEY=...   # the agent uses claude-opus-5-5 (cds.requires.llm in package.json)
npm run watch                  # http://localhost:4004
```

Without `ABAP_URL`, ZFR_REBOOK is mocked from `srv/external/` with /DMO/-shaped sample data. Sign in with `dispatcher` (empty password). `viewer` has no role and is refused.

1. Open the cockpit (below) and press **Cancel flight in ABAP**. The mock checks the flight like ABAP does, then
   reports the cancellation to the app in-process, as ABAP's event handler would over HTTP.
2. The app opens the disruption and starts the agent as `dispatcher`; the plan appears as a card. Approve or reject.
3. Follow the result: `GET /odata/v4/control/Plans?$expand=items`.

## The cockpit

One page for the whole flow, at http://localhost:4004/cockpit/index.html (sign in with `dispatcher`, empty password). It needs internet access: SAPUI5 is loaded from `ui5.sap.com`.

1. **Disruption:** enter a flight and cancel it in the booking system. The page waits for ABAP's event; after 15 s
   it also shows whether ABAP has reported it yet.
2. **Agent:** started by the server when ABAP's event arrives. Its plan appears as a card; approve or reject it.
   A cancellation from another client (for example ADT) appears the same way, but never takes the page away from a
   plan that waits for approval.
On a phone, `/cockpit/mobile.html` has just the cancel form and one status line (waiting for ABAP, agent working,
plan waiting for approval, or the error), with a link to this page for the approval.

3. **Booking system:** one map per flight of the route, one dot per seat. The affected passengers are highlighted and move to their new flights as ABAP confirms each booking.

**Reset demo** starts over. Against ABAP it runs `ZCL_FR_GENERATE_DATA` through the ADT class-run endpoint (developer user on a trial system only), which recopies `/DMO/BOOKING` and rebuilds the demo scenario, and returns the scenario's flight. Against the mock it clears disruptions, plans and the mock's cancellations; restart the app to restore the mock bookings.

The demo scenario is on FRA–EWR, two weeks after the day the generator runs: LH 0402 with 9 bookings to cancel, and five alternatives with 2, 1, 3, 0 and 0 free seats, so the agent has to split the passengers and leave some unassigned.

To start it: `npm run watch` against the mock, or `npm start` with the variables of [Connect to your ABAP trial](#connect-to-your-abap-trial). Record at 1440 × 900 or larger: in a smaller window the six maps of the ABAP scenario don't fit and pane 3 scrolls.

## Set up the ABAP side

Create a package (for example `ZFLIGHT_RESCUE`) and add the objects from `abap/` in ADT in this order, activating as you go:

| Object | File |
|---|---|
| Table `ZFR_BOOKING` | `zfr_booking.tabl.asddls` |
| Class `ZCL_FR_GENERATE_DATA` | `zcl_fr_generate_data.clas.abap`. Run it with F9: it copies `/DMO/BOOKING` into `ZFR_BOOKING` and adds the demo scenario (about 1,500 bookings with travel IDs from `90000000`), so nothing writes to `/DMO/` tables |
| CDS views `ZI_FR_FlightLoad`, `ZI_FR_Flight`, `ZR_FR_Booking` | `*.ddls.asddls` |
| Abstract entity `ZA_FR_RebookTarget` | `za_fr_rebooktarget.ddls.asddls` |
| Behavior definition `ZR_FR_Booking` | `zr_fr_booking.bdef.asbdef`. Use the quick fix to create `ZBP_R_FR_BOOKING`, then paste the local types from `zbp_r_fr_booking.clas.locals_imp.abap` |
| Service definition `ZFR_REBOOK` | `zfr_rebook.srvd.srvdsrv` |
| Service binding `ZFR_REBOOK_O4` | Create it from the service definition: OData V4 - Web API. Then publish it |

The `rebook` action refuses (and reports) when the booking is cancelled, is no longer on the expected flight (`STALE`), or when the target flight doesn't exist, flies another route, or is full. Its texts stay within 50 characters, because `new_message_with_text` fills a single message variable and anything longer is cut. The mock in `srv/external/ZFR_REBOOK.js` uses the same checks and the same messages.

With the vsp MCP server instead of ADT: create the table with `CreateTable` and replace its body with `EditSource`; create the empty class `ZBP_R_FR_BOOKING` before the behavior definition and write its local types with `EditSource` on `/sap/bc/adt/oo/classes/zbp_r_fr_booking/includes/implementations`; run the generator with `POST /sap/bc/adt/oo/classrun/ZCL_FR_GENERATE_DATA`; create the binding with `binding_version: V4`, `binding_category: 1`.

**Access from outside the system**
- **BTP ABAP environment trial:** a Web API binding is reached with a communication user. Create a communication scenario with the binding's inbound service, then a communication system and a communication arrangement, and use its user and password. Trial users may not have access to these administration apps. If that's the case for you, say so and we'll pick another route.
- **ABAP Platform Trial (Docker):** use your developer user with basic authentication and `ABAP_CLIENT=001`. No communication arrangement is needed. Over HTTPS the system uses a self-signed certificate, so start Node with `NODE_EXTRA_CA_CERTS=<exported cert>.pem`; over the HTTP port (`http://localhost:50000` through a tunnel) nothing else is needed.

## Connect to your ABAP trial

Set these as environment variables, never in a committed file:

```sh
export ABAP_URL='https://<host>/sap/opu/odata4/sap/zfr_rebook_o4/srvd_a2x/sap/zfr_rebook/0001'
export SAP_USER='<communication or developer user>'
export SAP_PASSWORD='...'
export ABAP_CLIENT=001         # Docker trial only
npm run watch
```

The user and password are read as `SAP_USER` and `SAP_PASSWORD`, so they can come from a secrets file without copying values into the project, for example `SAP_USER=$(node --env-file=<your secrets file> -p process.env.SAP_USER)`.

`server.js` turns these into credentials for `ZFR_REBOOK` (and switches on CSRF handling for SAP Gateway) before CAP decides what to mock, so with `ABAP_URL` set nothing is mocked. The log then shows `ZFR_REBOOK` being connected, not mocked.

Things to check against your published binding:
- **Names:** open `$metadata` and compare it with `srv/external/ZFR_REBOOK.cds`, or run `npx cds import <metadata.xml> --dry --as cds` from an empty folder and diff (run inside this project, `cds import` rewrites `package.json`). The CDS file matches the binding of an ABAP Platform Trial, release 816.
- **Leading zeros:** the binding returns NUMC fields without them (`"ConnectionId":"926"`, `"TravelId":"4506"`) and accepts them with. `srv/lib/abap.js` pads what it reads, so the rest of the app and the mock use the /DMO/ form (`0926`, `00004506`).
- **Action namespace:** bound actions are called at `…/Bookings(TravelId='…',BookingId='…')/<namespace>.rebook`. The default is `com.sap.gateway.srvd_a2x.zfr_rebook.v0001`. If your `$metadata` shows a different `Schema Namespace`, set `cds.requires.ZFR_REBOOK.actionNamespace`.

## Design choices

- **Human in the loop.** `applyRebooking` is `@agent.hitl`: the A2A task goes to `input-required`, and nothing reaches ABAP until a dispatcher approves. Reject closes the task and the plan stays `Pending` until superseded.
- **The server decides, the model chooses.** `disruptionImpact` lists the only valid alternatives: same route, same day up to two days later, seats left after other pending plans. `proposeRebooking` refuses any booking, flight or seat count outside that list. Tool schemas are strict, so extra arguments are refused.
- **Bound to its task.** Only the agent task that proposed a plan can request its approval. The task ID travels server-side, never as an argument. An edited resume pointing at another plan is refused (`NOT_REVIEWED`).
- **ABAP is the authority.** Each booking is moved with an expected current flight, so a booking changed in ABAP after the proposal fails alone (`STALE`) and the rest still apply (`PartiallyApplied`). Each item records ABAP's answer.
- **Narrow agent.** `@agent.connect: 'none'` means no MCP servers and no subagents. There is deliberately no `AGENTS.md`: with one, the plugin builds a deep agent with file and subagent tools. The system prompt is the service's doc comment instead.
- **Minimal data to the model.** The model sees travel and booking IDs, flights and seat counts. It doesn't see customer data.
- **SAP API Policy.** The agent only exposes this app's own services and a custom `Z` RAP service, which is within what the CAP docs allow for CAP-level agents. It does not proxy SAP application APIs.

## Tests

```sh
npm test
```

- `test/agent.test.mjs`: the real plugin and services, with ZFR_REBOOK mocked in-process. Covers impact, pause before any change, approve, reject, stale bookings, over-capacity and invented bookings, extra arguments, an edited resume, a closed disruption, and roles.
- `test/remote.test.mjs`: the same flow over HTTP. The mock runs as a separate server that requires a login, and this app reaches it only through `ABAP_URL`/`SAP_USER`/`SAP_PASSWORD`. Covers CAP's OData queries, basic auth, the explicit bound-action path and OData error messages.
- `test/events.test.mjs`: ABAP's event: only `abap-events` may report, a repeat changes nothing, the agent starts as the dispatcher and its paused task is the dispatcher's to approve; an idle or failing agent ends `Done` or `Failed`.
- `test/auth.test.mjs`: with `DISPATCHER_PASSWORD` / `ABAP_EVENTS_PASSWORD` set, the mocked users need them.
- `test/cockpit.test.mjs`: the cockpit's operations (`flightBoard`, `demoInfo`, `resetDemo`, the ADT call against a stand-in) and the page's logic and A2A client, loaded without a browser.

**Verified on 2026-09-30** against an ABAP Platform Trial (A4H, release 816, package `$ZFLIGHT_RESCUE`) with `claude-opus-5-5`: all objects active, 13,144 bookings generated, binding published. Through the chat preview, an approved plan moved 3 bookings from UA 0926 to UA 0058 on 2027-02-28 (seats booked 3 → 0 and 0 → 3 in `ZI_FR_Flight`); a rejected plan for NQ 0802 changed nothing. Called directly, the action refused with `STALE`, `NO_FLIGHT`, `ROUTE` and `NO_BOOKING`. Not exercised against ABAP: `CANCELLED` and `FULL` (the generated data has no cancelled booking and no full flight), a partially applied plan, and a BTP ABAP environment with a communication arrangement. The tests use a scripted model and the mock.

The cockpit, on the same day and system: Reset demo seeded the scenario for LH 0402 on 2026-10-14 (1,521 demo bookings; 2, 1, 3, 0 and 0 free seats on the alternatives, checked in `ZI_FR_Flight`). The agent proposed travel 90000003 (2) to UA 0043 on 14 Oct, travel 90000002 (3) to LH 0402 on 15 Oct and booking 90000001/0001 to UA 0043 on 15 Oct, leaving 3 unassigned; after approval `ZFR_BOOKING` showed exactly those moves and the three alternatives full. All six moves were done between three and six seconds after Approve (screenshots at those two moments), so the dots move in quick succession, roughly one a second at most. After a reset, a rejected plan left all nine bookings on LH 0402. Against the mock and the real model, the same flow worked with LH 0400.

## The ABAP event and the VPS

- **ABAP objects** (in `abap/`): `ZFR_FLIGHTCANCEL`, `ZR_FR_FlightCancel` with `create ( precheck )` and
  `event FlightCancelled`, `ZCL_FR_FLIGHTCANCEL_EVENTS` (local event consumer, runs in bgRFC), `IsCancelled` on
  `ZI_FR_Flight`, `FlightCancellations` in `ZFR_REBOOK`, and `ZCL_FR_CANCEL_FLIGHT` (cancel from ADT with F9).
- **bgRFC** must be configured (`SBGRFCCONF`: supervisor destination, inbound destinations `BGPF`, `DEFAULT`),
  or the event handler never runs.
- **SM59 `ZFR_CAP_EVENTS`:** type G, host `flight-rescue`, port 4004, Basic authentication `abap-events`.
- **Container:** service `flight-rescue` in the VPS's compose stack, on the same Docker network as the ABAP trial,
  bound to `127.0.0.1:4024` only. `flight-rescue.env` holds `ANTHROPIC_API_KEY`, `SAP_USER`, `SAP_PASSWORD`,
  `DISPATCHER_PASSWORD`, `ABAP_EVENTS_PASSWORD`, `ABAP_URL`, `ABAP_CLIENT`.
- **Cockpit:** `ssh -L 4024:127.0.0.1:4024 root@<vps>`, then http://localhost:4024/cockpit/index.html.
- **Live check:** `APP_URL=http://localhost:4024 node --env-file=<secrets> scripts/live-check.mjs`.
- **Limits:** a failed call from ABAP is recorded on the cancellation (`NotifyStatus F`), not retried; SQLite is in
  memory, so a container restart loses disruptions and plans. A production setup would put SAP Event Mesh between
  ABAP and the app and use real authentication.

**Verified on 2026-10-01** on the VPS (A4H trial, release 816): without the SM59 password the cancellation ended
`NotifyStatus F` with "App answered 401 Unauthorized"; with it, the live check reported the agent waiting for approval
25 s after the cancel and `NotifyStatus S`. In one run ABAP's event reached the app 4.9 s after the cancel. From ADT,
`ZCL_FR_CANCEL_FLIGHT` cancelled UA 0043 and the disruption appeared in the cockpit without a click. One approval of
six moves took 12.8 s; in another run the app stalled for about a minute during an approval. The likely cause, since
fixed: the app has a single SQLite connection, and an incoming event held it while reading the flight from ABAP.
