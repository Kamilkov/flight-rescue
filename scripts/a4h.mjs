// The ABAP trial (A4H) seen from the Mac: ZFR_REBOOK over OData, and ZCL_FR_GENERATE_DATA through ADT. SAP_USER and
// SAP_PASSWORD come from scripts/secrets.mjs on first use. A4H on localhost:50000 unless ABAP_URL and ABAP_CLIENT say otherwise.
import { secrets } from './secrets.mjs'

const service = process.env.ABAP_URL ?? 'http://localhost:50000/sap/opu/odata4/sap/zfr_rebook_o4/srvd_a2x/sap/zfr_rebook/0001'
const client = process.env.ABAP_CLIENT ?? '001'
export const NS = 'com.sap.gateway.srvd_a2x.zfr_rebook.v0001' // RAP's namespace for the binding's bound actions
let authorization
const auth = () => authorization ??= (({ SAP_USER, SAP_PASSWORD }) =>
  'Basic ' + Buffer.from(`${SAP_USER}:${SAP_PASSWORD}`).toString('base64'))(secrets('SAP_USER', 'SAP_PASSWORD'))
const NUMC = { TravelId: 8, BookingId: 4, ConnectionId: 4 } // ABAP sends these without leading zeros
export const padded = r => { for (const [k, n] of Object.entries(NUMC)) if (r[k] != null) r[k] = String(r[k]).padStart(n, '0'); return r }
export const plusDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const at = (path, query = {}) => {
  const u = new URL(path, `${service}/`)
  for (const [k, v] of Object.entries({ 'sap-client': client, ...query })) u.searchParams.set(k, v)
  return u.href.replace(/\+/g, '%20') // OData reads + literally; URLSearchParams writes a space as +
}
const cookies = res => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')

/** One GET: { ok, status, data }. */
export async function get(path, query) {
  const res = await fetch(at(path, query), { headers: { authorization: auth(), accept: 'application/json' } })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
}
/** Every row of an entity set for the query, following server paging, with the NUMC keys padded. */
export async function rows(path, query) {
  const out = []
  for (let next = at(path, query); next;) {
    const res = await fetch(next, { headers: { authorization: auth(), accept: 'application/json' } })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`${path}: ${res.status} ${data?.error?.message ?? ''}`)
    out.push(...data.value.map(padded))
    next = data['@odata.nextLink'] && at(data['@odata.nextLink'])
  }
  return out
}
/** Itineraries rows as itineraries: lists of legs, in ABAP's order. */
export const grouped = legs => {
  const by = new Map()
  for (const r of legs) by.set(r.ItineraryNo, [...(by.get(r.ItineraryNo) ?? []), r])
  return [...by.keys()].sort((a, b) => a - b).map(k => by.get(k).sort((a, b) => a.LegNo - b.LegNo))
}

let session // a CSRF token with its session cookies, for every write
/** One POST: { status, message (OData error text), data, text }. */
export async function post(path, body, headers = { 'content-type': 'application/json' }) {
  if (!session) {
    const res = await fetch(at(''), { headers: { authorization: auth(), accept: 'application/json', 'x-csrf-token': 'fetch' } })
    if (!res.ok) throw new Error(`CSRF token: ${res.status}`)
    session = { 'x-csrf-token': res.headers.get('x-csrf-token'), cookie: cookies(res) }
  }
  const res = await fetch(at(path), { method: 'POST', headers: { authorization: auth(), accept: 'application/json', ...session, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* $batch answers multipart */ }
  return { status: res.status, message: data?.error?.message ?? '', data, text }
}

/** Runs ZCL_FR_GENERATE_DATA through the ADT class-run endpoint, as the app's Reset demo does; returns its output. */
export async function reset() {
  const origin = new URL(service).origin, q = `?sap-client=${client}`
  const t = await fetch(`${origin}/sap/bc/adt/core/discovery${q}`, { headers: { authorization: auth(), accept: 'application/atomsvc+xml', 'x-csrf-token': 'fetch' } })
  if (!t.ok) throw new Error(`ADT: ${t.status} ${await t.text()}`)
  const run = await fetch(`${origin}/sap/bc/adt/oo/classrun/ZCL_FR_GENERATE_DATA${q}`, { method: 'POST',
    headers: { authorization: auth(), accept: 'text/plain', 'x-csrf-token': t.headers.get('x-csrf-token') ?? '', cookie: cookies(t) } })
  const text = await run.text()
  if (!run.ok) throw new Error(`Reset demo: ${run.status} ${text.slice(0, 300)}`)
  return text
}
/** The itinerary scenario's day, from the generator's output. */
export function scenarioDay(text) {
  const m = text.match(/^ITINERARY_FLIGHT LH 0454 (\d{4}-\d{2}-\d{2})\s*$/m)
  if (!m) throw new Error(`The generator named no ITINERARY_FLIGHT: is the itinerary scenario active in ZCL_FR_GENERATE_DATA?\n${text}`)
  return m[1]
}
