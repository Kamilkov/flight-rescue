@EndUserText.label: 'Flight rescue: rebooking onto an itinerary'
// Expected* is the flight the caller believes the booking is on, as in ZA_FR_RebookTarget. Leg1* to Leg3* are the
// itinerary's flights in order; Leg3* stays initial for two legs.
define abstract entity ZA_FR_RebookItinerary
{
  ExpectedCarrierId    : /dmo/carrier_id;
  ExpectedConnectionId : /dmo/connection_id;
  ExpectedFlightDate   : /dmo/flight_date;
  Leg1CarrierId        : /dmo/carrier_id;
  Leg1ConnectionId     : /dmo/connection_id;
  Leg1FlightDate       : /dmo/flight_date;
  Leg2CarrierId        : /dmo/carrier_id;
  Leg2ConnectionId     : /dmo/connection_id;
  Leg2FlightDate       : /dmo/flight_date;
  Leg3CarrierId        : /dmo/carrier_id;
  Leg3ConnectionId     : /dmo/connection_id;
  Leg3FlightDate       : /dmo/flight_date;
}
