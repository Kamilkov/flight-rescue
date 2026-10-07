@EndUserText.label: 'Flight rescue: itineraries to a destination'
@ObjectModel.query.implementedBy: 'ABAP:ZCL_FR_ITINERARIES'
// The ten best itineraries of one to three flights from Origin to Destination, the first flight leaving on FromDate up
// to two days later: one row per leg, ItineraryNo 1 arriving first. Origin, Destination and FromDate must be filtered by
// equality. HANA Graph computes them (ZCL_FR_ITINERARIES).
define custom entity ZI_FR_Itinerary
{
  key ItineraryNo   : abap.int4;
  key LegNo         : abap.int4;
      Origin        : /dmo/airport_id;
      Destination   : /dmo/airport_id;
      FromDate      : /dmo/flight_date;
      Legs          : abap.int4;
      ArrivesOn     : /dmo/flight_date;
      ArrivesAt     : /dmo/flight_arrival_time;
      CarrierId     : /dmo/carrier_id;
      ConnectionId  : /dmo/connection_id;
      FlightDate    : /dmo/flight_date;
      AirportFrom   : /dmo/airport_from_id;
      AirportTo     : /dmo/airport_to_id;
      DepartureTime : /dmo/flight_departure_time;
      ArrivalTime   : /dmo/flight_arrival_time;
      SeatsFree     : abap.int4;
}
