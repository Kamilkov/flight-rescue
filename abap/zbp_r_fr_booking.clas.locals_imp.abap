CLASS lhc_booking DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION
      IMPORTING REQUEST requested_authorizations FOR Booking RESULT result.

    METHODS rebook FOR MODIFY
      IMPORTING keys FOR ACTION Booking~rebook RESULT result.
ENDCLASS.


CLASS lhc_booking IMPLEMENTATION.

  METHOD get_global_authorizations.
    " Who may call the service is decided by the service binding (communication arrangement or developer user).
    IF requested_authorizations-%action-rebook = if_abap_behv=>mk-on.
      result-%action-rebook = if_abap_behv=>auth-allowed.
    ENDIF.
  ENDMETHOD.

  METHOD rebook.
    DATA rebooked TYPE TABLE FOR READ IMPORT zr_fr_booking.

    READ ENTITIES OF zr_fr_booking IN LOCAL MODE
      ENTITY Booking ALL FIELDS WITH CORRESPONDING #( keys )
      RESULT DATA(bookings).

    LOOP AT keys ASSIGNING FIELD-SYMBOL(<key>).
      DATA(target) = <key>-%param.
      DATA(problem) = ``.

      READ TABLE bookings WITH KEY id COMPONENTS %tky = <key>-%tky INTO DATA(booking).
      IF sy-subrc <> 0.
        problem = |NO_BOOKING: Booking { <key>-TravelId }/{ <key>-BookingId } does not exist.|.
      ELSEIF booking-BookingStatus = 'X'.
        problem = |CANCELLED: Booking { booking-TravelId }/{ booking-BookingId } is cancelled.|.
      ELSEIF booking-CarrierId    <> target-ExpectedCarrierId
          OR booking-ConnectionId <> target-ExpectedConnectionId
          OR booking-FlightDate   <> target-ExpectedFlightDate.
        problem = |STALE: { booking-TravelId }/{ booking-BookingId } is on { booking-CarrierId } { booking-ConnectionId } { booking-FlightDate DATE = ISO }.|.
      ELSE.
        SELECT SINGLE FROM zi_fr_flight FIELDS AirportFrom, AirportTo
          WHERE CarrierId = @booking-CarrierId AND ConnectionId = @booking-ConnectionId AND FlightDate = @booking-FlightDate
          INTO @DATA(current_flight).
        SELECT SINGLE FROM zi_fr_flight FIELDS AirportFrom, AirportTo, SeatsFree
          WHERE CarrierId = @target-CarrierId AND ConnectionId = @target-ConnectionId AND FlightDate = @target-FlightDate
          INTO @DATA(target_flight).
        IF sy-subrc <> 0.
          problem = |NO_FLIGHT: { target-CarrierId } { target-ConnectionId } { target-FlightDate DATE = ISO } does not exist.|.
        ELSEIF target_flight-AirportFrom <> current_flight-AirportFrom OR target_flight-AirportTo <> current_flight-AirportTo.
          problem = |ROUTE: { target-CarrierId } { target-ConnectionId } flies { target_flight-AirportFrom }-{ target_flight-AirportTo }, not { current_flight-AirportFrom }-{ current_flight-AirportTo }.|.
        ELSEIF target_flight-SeatsFree <= 0.
          problem = |FULL: { target-CarrierId } { target-ConnectionId } { target-FlightDate DATE = ISO } has no free seat.|.
        ENDIF.
      ENDIF.

      IF problem IS NOT INITIAL.
        " new_message_with_text fills one message variable: keep every text within 50 characters.
        APPEND VALUE #( %tky = <key>-%tky ) TO failed-booking.
        APPEND VALUE #( %tky = <key>-%tky
                        %msg = new_message_with_text( severity = if_abap_behv_message=>severity-error
                                                      text     = problem ) ) TO reported-booking.
        CONTINUE.
      ENDIF.

      " The customer keeps the price they paid; only the flight changes.
      MODIFY ENTITIES OF zr_fr_booking IN LOCAL MODE
        ENTITY Booking
          UPDATE FIELDS ( CarrierId ConnectionId FlightDate )
          WITH VALUE #( ( %tky         = <key>-%tky
                          CarrierId    = target-CarrierId
                          ConnectionId = target-ConnectionId
                          FlightDate   = target-FlightDate ) ).
      INSERT VALUE #( %tky = <key>-%tky ) INTO TABLE rebooked.
    ENDLOOP.

    READ ENTITIES OF zr_fr_booking IN LOCAL MODE
      ENTITY Booking ALL FIELDS WITH rebooked
      RESULT DATA(updated).
    result = VALUE #( FOR u IN updated ( %tky = u-%tky %param = u ) ).
  ENDMETHOD.

ENDCLASS.
