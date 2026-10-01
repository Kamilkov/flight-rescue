CLASS lhc_cancellation DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION
      IMPORTING REQUEST requested_authorizations FOR Cancellation RESULT result.

    METHODS precheck_create FOR PRECHECK
      IMPORTING entities FOR CREATE Cancellation.
ENDCLASS.


CLASS lhc_cancellation IMPLEMENTATION.

  METHOD get_global_authorizations.
    " Who may call the service is decided by the service binding, as for the bookings.
    IF requested_authorizations-%create = if_abap_behv=>mk-on.
      result-%create = if_abap_behv=>auth-allowed.
    ENDIF.
  ENDMETHOD.

  METHOD precheck_create.
    " Runs before the framework's own duplicate-key check, so the caller gets these messages.
    LOOP AT entities ASSIGNING FIELD-SYMBOL(<c>).
      DATA(flight) = |{ <c>-CarrierId } { <c>-ConnectionId } { <c>-FlightDate DATE = ISO }|.
      DATA(problem) = ``.
      SELECT SINGLE @abap_true FROM /dmo/flight
        WHERE carrier_id = @<c>-CarrierId AND connection_id = @<c>-ConnectionId AND flight_date = @<c>-FlightDate
        INTO @DATA(exists).
      IF exists = abap_false.
        problem = |NO_FLIGHT: { flight } does not exist.|.
      ELSE.
        SELECT SINGLE @abap_true FROM zfr_flightcancel
          WHERE carrier_id = @<c>-CarrierId AND connection_id = @<c>-ConnectionId AND flight_date = @<c>-FlightDate
          INTO @DATA(cancelled).
        IF cancelled = abap_true.
          problem = |ALREADY_CANCELLED: { flight }.|.
        ENDIF.
      ENDIF.

      IF problem IS NOT INITIAL.
        " new_message_with_text fills one message variable: keep every text within 50 characters.
        APPEND VALUE #( %cid = <c>-%cid %key = <c>-%key ) TO failed-cancellation.
        APPEND VALUE #( %cid = <c>-%cid %key = <c>-%key
                        %msg = new_message_with_text( severity = if_abap_behv_message=>severity-error
                                                      text     = problem ) ) TO reported-cancellation.
      ENDIF.
      CLEAR: exists, cancelled.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.


CLASS lsc_cancellation DEFINITION INHERITING FROM cl_abap_behavior_saver.
  PROTECTED SECTION.
    METHODS save_modified REDEFINITION.
ENDCLASS.


CLASS lsc_cancellation IMPLEMENTATION.

  METHOD save_modified.
    " Every new cancellation is reported to the app after the commit, by ZCL_FR_FLIGHTCANCEL_EVENTS (bgRFC).
    IF create-cancellation IS NOT INITIAL.
      RAISE ENTITY EVENT zr_fr_flightcancel~FlightCancelled
        FROM VALUE #( FOR c IN create-cancellation ( %key = c-%key ) ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
