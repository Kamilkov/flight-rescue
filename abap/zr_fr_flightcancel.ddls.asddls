@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Flight rescue: flight cancellation'
define root view entity ZR_FR_FlightCancel
  as select from zfr_flightcancel
{
  key carrier_id     as CarrierId,
  key connection_id  as ConnectionId,
  key flight_date    as FlightDate,
      reason         as Reason,
      @Semantics.user.createdBy: true
      created_by     as CreatedBy,
      @Semantics.systemDateTime.createdAt: true
      created_at     as CreatedAt,
      notify_status  as NotifyStatus,
      notify_message as NotifyMessage
}
