@EndUserText.label : 'Flight rescue: bookings (copy of /DMO/BOOKING)'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table zfr_booking {

  key client            : abap.clnt not null;
  key travel_id         : /dmo/travel_id not null;
  key booking_id        : /dmo/booking_id not null;
  customer_id           : /dmo/customer_id;
  carrier_id            : /dmo/carrier_id;
  connection_id         : /dmo/connection_id;
  flight_date           : /dmo/flight_date;
  @Semantics.amount.currencyCode : 'zfr_booking.currency_code'
  flight_price          : /dmo/flight_price;
  currency_code         : /dmo/currency_code;
  booking_status        : abap.char(1);
  last_changed_at       : abp_lastchange_tstmpl;
  local_last_changed_at : abp_locinst_lastchange_tstmpl;

}
