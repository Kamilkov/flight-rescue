const cds = require('@sap/cds')

// Connects ZFR_REBOOK to the ABAP trial when ABAP_URL is set (environment variables, never committed).
// The user and password are read as SAP_USER / SAP_PASSWORD, the names the shared secrets file uses.
// Without it, `cds watch` and the tests mock ZFR_REBOOK from srv/external (the same contract).
// Loaded before cds decides which services to mock, so setting credentials here turns the mock off.
const { ABAP_URL, SAP_USER, SAP_PASSWORD, ABAP_CLIENT } = process.env
if (ABAP_URL) {
  Object.assign(cds.env.requires.ZFR_REBOOK, {
    credentials: {
      url: ABAP_URL, username: SAP_USER, password: SAP_PASSWORD,
      ...(ABAP_CLIENT && { queryParameters: { 'sap-client': ABAP_CLIENT } }) // ABAP Platform Trial (Docker): 001
    },
    csrf: cds.env.requires.ZFR_REBOOK.csrf ?? true // SAP Gateway requires an x-csrf-token for POST
  })
}

// Passwords for the mocked users come from the environment where one is set (the VPS); locally they stay empty.
// ponytail: mocked auth with passwords suits a private demo container; a real deployment uses XSUAA or IAS.
const users = cds.env.requires.auth?.users ?? {}
for (const [id, variable] of [['dispatcher', 'DISPATCHER_PASSWORD'], ['abap-events', 'ABAP_EVENTS_PASSWORD'], ['passenger', 'PASSENGER_PASSWORD']])
  if (process.env[variable] && users[id]) users[id].password = process.env[variable]

// The agent's A2A endpoint answers 401 without a Basic challenge, so a browser never sends it the login it already
// has for the OData services (the plugin's own preview echoes the header into its page instead). The cockpit needs it.
// ponytail: only for the local mocked/basic login; a deployed app authenticates with tokens and needs none of this.
cds.on('bootstrap', app => app.use('/a2a', (req, res, next) => {
  if (!req.headers.authorization && ['mocked', 'basic'].includes(cds.env.requires.auth?.kind)) res.setHeader('WWW-Authenticate', 'Basic realm="Users"')
  next()
}))

module.exports = cds.server
