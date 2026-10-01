"! Reports every new flight cancellation to the Flight Rescue app (CAP), which opens the disruption and starts the
"! rebooking agent. RAP runs it after the commit, in the background (bgRFC, inbound destination configured in
"! SBGRFCCONF). It never dumps: a dumped handler's bgRFC unit is gone, so failures are written to the cancellation
"! instead (NOTIFY_STATUS 'F' with the reason). Destination ZFR_CAP_EVENTS: SM59, type G, Basic auth abap-events.
CLASS zcl_fr_flightcancel_events DEFINITION PUBLIC ABSTRACT FINAL FOR EVENTS OF zr_fr_flightcancel.
ENDCLASS.


CLASS zcl_fr_flightcancel_events IMPLEMENTATION.
ENDCLASS.
