@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Flight rescue: flights with absolute times'
// The one place of the arrival-day rule: the graph views and rebookItinerary read the times from here.
// ponytail: /DMO/ stores local times without time zones or arrival dates. An arrival before the departure is taken to
// land the next day: right for FRA, JFK, EWR, SFO, MIA and HAV, wrong for SFO-SIN. Routing elsewhere needs airport
// time zones. DepSec and ArrSec count seconds from 2000-01-01 00:00 in each airport's local time.
define view entity ZI_FR_FlightTime
  as select from ZI_FR_Flight
{
  key CarrierId,
  key ConnectionId,
  key FlightDate,
      AirportFrom,
      AirportTo,
      DepartureTime,
      ArrivalTime,
      SeatsFree,
      IsCancelled,
      cast( concat_with_space( concat_with_space( CarrierId, ConnectionId, 1 ),
                               cast( FlightDate as abap.char( 8 ) ), 1 ) as abap.char( 20 ) )        as FlightKey,
      dats_add_days( FlightDate, case when ArrivalTime < DepartureTime then 1 else 0 end, 'NULL' ) as ArrivalDate,
      dats_add_days( FlightDate, case when ArrivalTime < DepartureTime then 2 else 1 end, 'NULL' ) as ArrivalDateNext,
      dats_days_between( $session.system_date, FlightDate )                                         as DaysOut,
      cast( tstmp_seconds_between(
              dats_tims_to_tstmp( cast( '20000101' as abap.dats ), cast( '000000' as abap.tims ), 'UTC', $session.client, 'NULL' ),
              dats_tims_to_tstmp( FlightDate, DepartureTime, 'UTC', $session.client, 'NULL' ),
              'NULL' ) as abap.int8 )                                                                as DepSec,
      cast( tstmp_seconds_between(
              dats_tims_to_tstmp( cast( '20000101' as abap.dats ), cast( '000000' as abap.tims ), 'UTC', $session.client, 'NULL' ),
              dats_tims_to_tstmp( dats_add_days( FlightDate, case when ArrivalTime < DepartureTime then 1 else 0 end, 'NULL' ),
                                  ArrivalTime, 'UTC', $session.client, 'NULL' ),
              'NULL' ) as abap.int8 )                                                                as ArrSec
}
