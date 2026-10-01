@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Flight rescue: booking'
define root view entity ZR_FR_Booking
  as select from zfr_booking
{
  key travel_id             as TravelId,
  key booking_id            as BookingId,
      customer_id           as CustomerId,
      carrier_id            as CarrierId,
      connection_id         as ConnectionId,
      flight_date           as FlightDate,
      @Semantics.amount.currencyCode: 'CurrencyCode'
      flight_price          as FlightPrice,
      currency_code         as CurrencyCode,
      booking_status        as BookingStatus,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at       as LastChangedAt,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      local_last_changed_at as LocalLastChangedAt
}
