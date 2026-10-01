@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Flight rescue: seats booked per flight'
define view entity ZI_FR_FlightLoad
  as select from zfr_booking
{
  key carrier_id    as CarrierId,
  key connection_id as ConnectionId,
  key flight_date   as FlightDate,
      count( * )    as SeatsBooked
}
where
  booking_status <> 'X'
group by
  carrier_id,
  connection_id,
  flight_date
