@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Flight rescue: flights with free seats'
// Seats come from ZFR_BOOKING, so a rebooking moves a seat from one flight to the other.
define view entity ZI_FR_Flight
  as select from    /dmo/flight      as Flight
    inner join      /dmo/connection  as Connection on  Connection.carrier_id    = Flight.carrier_id
                                                   and Connection.connection_id = Flight.connection_id
    left outer join ZI_FR_FlightLoad as Load       on  Load.CarrierId    = Flight.carrier_id
                                                   and Load.ConnectionId = Flight.connection_id
                                                   and Load.FlightDate   = Flight.flight_date
{
  key Flight.carrier_id                                                 as CarrierId,
  key Flight.connection_id                                              as ConnectionId,
  key Flight.flight_date                                                as FlightDate,
      Connection.airport_from_id                                        as AirportFrom,
      Connection.airport_to_id                                          as AirportTo,
      Connection.departure_time                                         as DepartureTime,
      Connection.arrival_time                                           as ArrivalTime,
      @Semantics.amount.currencyCode: 'CurrencyCode'
      Flight.price                                                      as Price,
      Flight.currency_code                                              as CurrencyCode,
      Flight.plane_type_id                                              as PlaneType,
      Flight.seats_max                                                  as SeatsMax,
      cast( coalesce( Load.SeatsBooked, 0 ) as abap.int4 )              as SeatsBooked,
      cast( Flight.seats_max - coalesce( Load.SeatsBooked, 0 ) as abap.int4 ) as SeatsFree
}
