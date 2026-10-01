@EndUserText.label: 'Flight rescue: rebooking target'
// Expected* is the flight the caller believes the booking is on; the action refuses if it moved since.
define abstract entity ZA_FR_RebookTarget
{
  ExpectedCarrierId    : /dmo/carrier_id;
  ExpectedConnectionId : /dmo/connection_id;
  ExpectedFlightDate   : /dmo/flight_date;
  CarrierId            : /dmo/carrier_id;
  ConnectionId         : /dmo/connection_id;
  FlightDate           : /dmo/flight_date;
}
