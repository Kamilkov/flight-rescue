// ABAP's rerouting rules as plain JavaScript (srv/lib/itineraries.js): the search behind the mock's Itineraries and
// scripts/abap-check.mjs, and rebookItinerary's checks as the mock runs them.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
const { search, id } = createRequire(import.meta.url)('../srv/lib/itineraries.js')

const DAY = '2026-10-27'
// A flight as ZFR_REBOOK/Flights returns it: 5 free seats unless given.
const f = (carrier, connection, from, to, dep, arr, extra = {}) => ({ CarrierId: carrier, ConnectionId: connection, FlightDate: DAY,
  AirportFrom: from, AirportTo: to, DepartureTime: `${dep}:00`, ArrivalTime: `${arr}:00`, SeatsFree: 5, IsCancelled: false, ...extra })
const ids = list => list.map(i => id(i.legs))
const find = (flights, extra = {}) => search(flights, { origin: 'FRA', destination: 'SFO', fromDate: DAY, ...extra })

test('ten four-leg paths arriving before a direct flight do not crowd it out: the leg limit is part of the search', () => {
  const flights = [
    f('XX', '0001', 'FRA', 'JFK', '06:00', '07:00'), f('XX', '0002', 'JFK', 'EWR', '08:40', '09:40'), f('XX', '0003', 'EWR', 'MIA', '11:20', '12:20'),
    ...Array.from({ length: 10 }, (_, i) => f('XX', String(10 + i).padStart(4, '0'), 'MIA', 'SFO', `14:0${i}`, `15:0${i}`)),
    f('LH', '0454', 'FRA', 'SFO', '10:25', '18:00')
  ]
  assert.deepEqual(ids(find(flights)), ['LH 0454 2026-10-27'])
  const four = find(flights, { maxLegs: 4 })
  assert.equal(four.length, 10)
  assert.ok(four.every(i => i.legs.length === 4), 'with four legs allowed, the direct flight is the eleventh')
})

test('no itinerary through the destination or back to the origin', () => {
  const flights = [
    f('LH', '0454', 'FRA', 'SFO', '07:00', '09:00'), f('UA', '0001', 'SFO', 'JFK', '11:00', '13:00'), f('UA', '0002', 'JFK', 'SFO', '15:00', '17:00'),
    f('LH', '0400', 'FRA', 'JFK', '08:00', '10:00'), f('LH', '0401', 'JFK', 'FRA', '12:00', '14:00'), f('DE', '2096', 'FRA', 'SFO', '16:00', '18:00')
  ]
  assert.deepEqual(ids(find(flights)), ['LH 0454 2026-10-27', 'LH 0400 2026-10-27 > UA 0002 2026-10-27', 'DE 2096 2026-10-27'],
    'not LH 0454 > UA 0001 > UA 0002 (SFO twice), not LH 0400 > LH 0401 > DE 2096 (FRA twice)')
})

test('an earlier three-leg arrival ranks above a later direct flight; at the same arrival, fewer connections first', () => {
  const flights = [
    f('AA', '0001', 'FRA', 'EWR', '06:00', '08:00'), f('AA', '0002', 'EWR', 'MIA', '09:30', '10:30'), f('AA', '0003', 'MIA', 'SFO', '12:00', '13:00'),
    f('LH', '0454', 'FRA', 'SFO', '10:25', '13:01'),
    f('LH', '0400', 'FRA', 'JFK', '07:00', '09:00'), f('B6', '0415', 'JFK', 'SFO', '11:00', '15:00'), f('UA', '0059', 'FRA', 'SFO', '12:55', '15:00')
  ]
  const list = find(flights)
  assert.deepEqual(ids(list), ['AA 0001 2026-10-27 > AA 0002 2026-10-27 > AA 0003 2026-10-27', 'LH 0454 2026-10-27',
    'UA 0059 2026-10-27', 'LH 0400 2026-10-27 > B6 0415 2026-10-27'])
  assert.deepEqual(list.map(i => [i.arrivesOn, i.arrivesAt, i.connections]), [
    [DAY, '13:00:00', 2], [DAY, '13:01:00', 0], [DAY, '15:00:00', 0], [DAY, '15:00:00', 1]])
})

test('the window, 90 min to 12 h between flights, overnight arrivals, full and cancelled flights', () => {
  const on = (date, x) => ({ ...x, FlightDate: date })
  const flights = [
    on('2026-10-26', f('LH', '0454', 'FRA', 'SFO', '10:25', '12:40')),           // the day before the window
    on('2026-10-30', f('LH', '0454', 'FRA', 'SFO', '10:25', '12:40')),           // three days later: too late to start
    f('DE', '2096', 'FRA', 'SFO', '11:40', '14:30', { SeatsFree: 0 }),              // full
    f('UA', '0059', 'FRA', 'SFO', '12:55', '15:15', { IsCancelled: true }),        // cancelled
    f('LH', '0400', 'FRA', 'JFK', '10:00', '12:00'),
    f('B6', '0415', 'JFK', 'SFO', '13:29', '17:00'),                                // 89 min after LH 0400: too short
    f('DL', '0365', 'JFK', 'SFO', '13:30', '17:30'),                                // 90 min
    on('2026-10-28', f('AA', '0015', 'JFK', 'SFO', '00:00', '03:00')),           // 12 h
    on('2026-10-28', f('AA', '0177', 'JFK', 'SFO', '00:01', '03:01')),           // 12 h 01: too long
    on('2026-10-29', f('LH', '0402', 'FRA', 'JFK', '20:00', '01:00')),           // overnight: lands on the 30th
    on('2026-10-30', f('DL', '0666', 'JFK', 'SFO', '02:30', '05:30'))            // 90 min later, on the day after the window
  ]
  assert.deepEqual(ids(find(flights)), ['LH 0400 2026-10-27 > DL 0365 2026-10-27', 'LH 0400 2026-10-27 > AA 0015 2026-10-28',
    'LH 0402 2026-10-29 > DL 0666 2026-10-30'])
})
