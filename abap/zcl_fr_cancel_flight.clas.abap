"! For the post's second clip: cancels one flight through the RAP BO from ADT (F9), without the cockpit.
"! ABAP then reports it to the app by itself; the cockpit shows the disruption and the agent's plan.
"! It cancels UA 0043 on the first day, two weeks out or later, that is not cancelled yet.
CLASS zcl_fr_cancel_flight DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.


CLASS zcl_fr_cancel_flight IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
    CONSTANTS carrier    TYPE /dmo/carrier_id    VALUE 'UA'.
    CONSTANTS connection TYPE /dmo/connection_id VALUE '0043'.
    DATA(from) = CONV d( sy-datum + 14 ).

    SELECT FROM /dmo/flight AS f
      FIELDS f~flight_date
      WHERE f~carrier_id = @carrier AND f~connection_id = @connection AND f~flight_date >= @from
        AND NOT EXISTS ( SELECT carrier_id FROM zfr_flightcancel AS c
                         WHERE c~carrier_id = f~carrier_id AND c~connection_id = f~connection_id AND c~flight_date = f~flight_date )
      ORDER BY f~flight_date
      INTO @DATA(day)
      UP TO 1 ROWS.
    ENDSELECT.
    IF sy-subrc <> 0.
      out->write( |No { carrier } { connection } left to cancel from { from DATE = ISO } on.| ).
      RETURN.
    ENDIF.

    MODIFY ENTITIES OF zr_fr_flightcancel
      ENTITY Cancellation
        CREATE FIELDS ( CarrierId ConnectionId FlightDate Reason )
        WITH VALUE #( ( %cid = 'c1' CarrierId = carrier ConnectionId = connection FlightDate = day Reason = 'Crew shortage' ) )
      FAILED DATA(failed)
      REPORTED DATA(reported).
    COMMIT ENTITIES RESPONSE OF zr_fr_flightcancel FAILED DATA(commit_failed) REPORTED DATA(commit_reported).

    IF failed IS INITIAL AND commit_failed IS INITIAL.
      out->write( |Cancelled { carrier } { connection } { day DATE = ISO }. ABAP reports it to the app in the background.| ).
      RETURN.
    ENDIF.
    LOOP AT reported-cancellation INTO DATA(message).
      out->write( message-%msg->if_message~get_text( ) ).
    ENDLOOP.
    LOOP AT commit_reported-cancellation INTO DATA(late_message).
      out->write( late_message-%msg->if_message~get_text( ) ).
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
