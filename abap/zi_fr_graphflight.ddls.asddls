@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Flight rescue: flights in the routing graph'
// The flights an itinerary may use: not cancelled, with a free seat, from today to 30 days out. A flight drops out of
// the graph as soon as it is cancelled.
define view entity ZI_FR_GraphFlight
  as select from ZI_FR_FlightTime
{
  key CarrierId,
  key ConnectionId,
  key FlightDate,
      AirportFrom,
      AirportTo,
      FlightKey,
      ArrivalDate,
      ArrivalDateNext,
      DepSec,
      ArrSec
}
where
      IsCancelled <> 'X'
  and SeatsFree   >  0
  and DaysOut     between 0 and 30
