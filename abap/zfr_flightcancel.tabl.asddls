@EndUserText.label : 'Flight rescue: flight cancellations'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table zfr_flightcancel {

  key client        : abap.clnt not null;
  key carrier_id    : /dmo/carrier_id not null;
  key connection_id : /dmo/connection_id not null;
  key flight_date   : /dmo/flight_date not null;
  reason            : abap.char(100);
  created_by        : abp_creation_user;
  created_at        : abp_creation_tstmpl;
  notify_status     : abap.char(1);
  notify_message    : abap.char(200);

}
