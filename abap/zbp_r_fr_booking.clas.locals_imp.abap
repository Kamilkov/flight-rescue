"! The checks of rebookItinerary that need no database: the legs exist and fly, chain from the booking's origin to its
"! destination without an airport twice, connect in 90 min to 12 h, and have a free seat. The handler reads the legs
"! from ZI_FR_FlightTime; ABAP Unit checks the rules here.
CLASS lcl_itinerary DEFINITION FINAL.
  PUBLIC SECTION.
    TYPES: BEGIN OF leg,
             carrier_id    TYPE /dmo/carrier_id,
             connection_id TYPE /dmo/connection_id,
             flight_date   TYPE /dmo/flight_date,
             found         TYPE abap_bool,
             cancelled     TYPE abap_bool,
             airport_from  TYPE /dmo/airport_from_id,
             airport_to    TYPE /dmo/airport_to_id,
             dep_sec       TYPE int8,
             arr_sec       TYPE int8,
             seats_free    TYPE i,
           END OF leg,
           legs TYPE STANDARD TABLE OF leg WITH EMPTY KEY.
    "! The first problem, as the client reads it (at most 50 characters), or initial.
    CLASS-METHODS problem IMPORTING origin        TYPE /dmo/airport_from_id
                                    destination   TYPE /dmo/airport_to_id
                                    legs          TYPE legs
                          RETURNING VALUE(result) TYPE string.
ENDCLASS.


CLASS lcl_itinerary IMPLEMENTATION.

  METHOD problem.
    DATA(visited) = VALUE string_table( ( CONV string( origin ) ) ).
    LOOP AT legs INTO DATA(l) WHERE found = abap_false.
      result = |NO_FLIGHT: { l-carrier_id } { l-connection_id } { l-flight_date DATE = ISO } does not exist.|.
      RETURN.
    ENDLOOP.
    LOOP AT legs INTO l WHERE cancelled = abap_true.
      result = |NOT_FLYING: { l-carrier_id } { l-connection_id } { l-flight_date DATE = ISO } is cancelled.|.
      RETURN.
    ENDLOOP.
    LOOP AT legs INTO l.
      DATA(n) = sy-tabix.
      DATA(expected) = COND string( WHEN n = 1 THEN origin ELSE legs[ n - 1 ]-airport_to ).
      IF l-airport_from <> expected.
        result = |CHAIN: leg { n } does not leave from { expected }.|.
        RETURN.
      ENDIF.
    ENDLOOP.
    IF legs[ lines( legs ) ]-airport_to <> destination.
      result = |CHAIN: leg { lines( legs ) } does not land at { destination }.|.
      RETURN.
    ENDIF.
    LOOP AT legs INTO l.
      IF line_exists( visited[ table_line = CONV string( l-airport_to ) ] ).
        result = |CHAIN: the itinerary visits { l-airport_to } twice.|.
        RETURN.
      ENDIF.
      APPEND CONV string( l-airport_to ) TO visited.
    ENDLOOP.
    LOOP AT legs INTO l FROM 2.
      n = sy-tabix.
      DATA(gap) = l-dep_sec - legs[ n - 1 ]-arr_sec.
      IF gap < 5400 OR gap > 43200.
        result = |LAYOVER: leg { n } is not 90 min to 12 h after leg { n - 1 }.|.
        RETURN.
      ENDIF.
    ENDLOOP.
    LOOP AT legs INTO l WHERE seats_free <= 0.
      result = |FULL: { l-carrier_id } { l-connection_id } { l-flight_date DATE = ISO } has no free seat.|.
      RETURN.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.


"! Seats are booked under a lock per flight: no other request books seats on a flight this request is booking until
"! this one is saved or rolled back. The lock argument is the flight's key, in the name of ZFR_FLIGHTCANCEL (keyed by
"! flight). Locks of one request, also of several actions in one change set, do not block each other.
CLASS lcl_seats DEFINITION FINAL.
  PUBLIC SECTION.
    "! Locks the legs' flights, waiting a few seconds for another request. Returns LOCKED (at most 50 characters) for the
    "! first flight still locked by another request, or initial.
    CLASS-METHODS lock IMPORTING legs TYPE lcl_itinerary=>legs RETURNING VALUE(result) TYPE string.
ENDCLASS.


CLASS lcl_seats IMPLEMENTATION.

  METHOD lock.
    LOOP AT legs INTO DATA(l).
      DATA(varkey) = CONV rstable-varkey( |{ sy-mandt }{ l-carrier_id WIDTH = 3 }{ l-connection_id }{ l-flight_date }| ).
      CALL FUNCTION 'ENQUEUE_E_TABLE'
        EXPORTING
          mode_rstable   = 'E'
          tabname        = 'ZFR_FLIGHTCANCEL'
          varkey         = varkey
          _wait          = abap_true
        EXCEPTIONS
          foreign_lock   = 1
          system_failure = 2
          OTHERS         = 3.
      IF sy-subrc <> 0.
        result = |LOCKED: { l-carrier_id } { l-connection_id } { l-flight_date DATE = ISO } is being booked.|.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.


CLASS lhc_booking DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION
      IMPORTING REQUEST requested_authorizations FOR Booking RESULT result.

    METHODS rebook FOR MODIFY
      IMPORTING keys FOR ACTION Booking~rebook RESULT result.

    METHODS rebookitinerary FOR MODIFY
      IMPORTING keys FOR ACTION Booking~rebookItinerary RESULT result.

    METHODS seatsleft FOR VALIDATE ON SAVE
      IMPORTING keys FOR Booking~seatsLeft.
ENDCLASS.


CLASS lhc_booking IMPLEMENTATION.

  METHOD get_global_authorizations.
    " Who may call the service is decided by the service binding (communication arrangement or developer user).
    IF requested_authorizations-%action-rebook = if_abap_behv=>mk-on.
      result-%action-rebook = if_abap_behv=>auth-allowed.
    ENDIF.
    IF requested_authorizations-%action-rebookItinerary = if_abap_behv=>mk-on.
      result-%action-rebookItinerary = if_abap_behv=>auth-allowed.
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
        problem = lcl_seats=>lock( VALUE #( ( carrier_id = target-CarrierId connection_id = target-ConnectionId flight_date = target-FlightDate ) ) ).
        IF problem IS INITIAL.
          SELECT SINGLE FROM zi_fr_flight FIELDS AirportFrom, AirportTo
            WHERE CarrierId = @booking-CarrierId AND ConnectionId = @booking-ConnectionId AND FlightDate = @booking-FlightDate
            INTO @DATA(current_flight).
          SELECT SINGLE FROM zi_fr_flight FIELDS AirportFrom, AirportTo, SeatsFree, IsCancelled
            WHERE CarrierId = @target-CarrierId AND ConnectionId = @target-ConnectionId AND FlightDate = @target-FlightDate
            INTO @DATA(target_flight).
          IF sy-subrc <> 0.
            problem = |NO_FLIGHT: { target-CarrierId } { target-ConnectionId } { target-FlightDate DATE = ISO } does not exist.|.
          ELSEIF target_flight-IsCancelled = abap_true.
            problem = |NOT_FLYING: { target-CarrierId } { target-ConnectionId } { target-FlightDate DATE = ISO } is cancelled.|.
          ELSEIF target_flight-AirportFrom <> current_flight-AirportFrom OR target_flight-AirportTo <> current_flight-AirportTo.
            problem = |ROUTE: { target-CarrierId } { target-ConnectionId } flies { target_flight-AirportFrom }-{ target_flight-AirportTo }, not { current_flight-AirportFrom }-{ current_flight-AirportTo }.|.
          ELSEIF target_flight-SeatsFree <= 0.
            problem = |FULL: { target-CarrierId } { target-ConnectionId } { target-FlightDate DATE = ISO } has no free seat.|.
          ENDIF.
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

  METHOD rebookitinerary.
    DATA moved TYPE TABLE FOR READ IMPORT zr_fr_booking.
    DATA creates TYPE TABLE FOR CREATE zr_fr_booking.

    READ ENTITIES OF zr_fr_booking IN LOCAL MODE
      ENTITY Booking ALL FIELDS WITH CORRESPONDING #( keys )
      RESULT DATA(bookings).

    LOOP AT keys ASSIGNING FIELD-SYMBOL(<key>).
      DATA(p) = <key>-%param.
      DATA(problem) = ``.
      " The legs in order; Leg2* and Leg3* stay initial when the itinerary is shorter.
      DATA(legs) = VALUE lcl_itinerary=>legs( ( carrier_id = p-Leg1CarrierId connection_id = p-Leg1ConnectionId flight_date = p-Leg1FlightDate ) ).
      IF p-Leg2CarrierId IS NOT INITIAL.
        APPEND VALUE #( carrier_id = p-Leg2CarrierId connection_id = p-Leg2ConnectionId flight_date = p-Leg2FlightDate ) TO legs.
      ENDIF.
      IF p-Leg3CarrierId IS NOT INITIAL.
        APPEND VALUE #( carrier_id = p-Leg3CarrierId connection_id = p-Leg3ConnectionId flight_date = p-Leg3FlightDate ) TO legs.
      ENDIF.

      READ TABLE bookings WITH KEY id COMPONENTS %tky = <key>-%tky INTO DATA(booking).
      IF sy-subrc <> 0.
        problem = |NO_BOOKING: Booking { <key>-TravelId }/{ <key>-BookingId } does not exist.|.
      ELSEIF booking-BookingStatus = 'X'.
        problem = |CANCELLED: Booking { booking-TravelId }/{ booking-BookingId } is cancelled.|.
      ELSEIF booking-CarrierId    <> p-ExpectedCarrierId
          OR booking-ConnectionId <> p-ExpectedConnectionId
          OR booking-FlightDate   <> p-ExpectedFlightDate.
        problem = |STALE: { booking-TravelId }/{ booking-BookingId } is on { booking-CarrierId } { booking-ConnectionId } { booking-FlightDate DATE = ISO }.|.
      ELSE.
        problem = lcl_seats=>lock( legs ).
        IF problem IS INITIAL.
          SELECT SINGLE FROM zi_fr_flight FIELDS AirportFrom, AirportTo
            WHERE CarrierId = @booking-CarrierId AND ConnectionId = @booking-ConnectionId AND FlightDate = @booking-FlightDate
            INTO @DATA(current_flight).
          " The legs' times come from ZI_FR_FlightTime, the one place of the arrival-day guess.
          LOOP AT legs ASSIGNING FIELD-SYMBOL(<leg>).
            SELECT SINGLE FROM zi_fr_flighttime FIELDS AirportFrom, AirportTo, DepSec, ArrSec, SeatsFree, IsCancelled
              WHERE CarrierId = @<leg>-carrier_id AND ConnectionId = @<leg>-connection_id AND FlightDate = @<leg>-flight_date
              INTO @DATA(flight).
            IF sy-subrc = 0.
              <leg>-found        = abap_true.
              <leg>-cancelled    = flight-IsCancelled.
              <leg>-airport_from = flight-AirportFrom.
              <leg>-airport_to   = flight-AirportTo.
              <leg>-dep_sec      = flight-DepSec.
              <leg>-arr_sec      = flight-ArrSec.
              <leg>-seats_free   = flight-SeatsFree.
            ENDIF.
          ENDLOOP.
          problem = lcl_itinerary=>problem( origin = current_flight-AirportFrom destination = current_flight-AirportTo legs = legs ).
        ENDIF.
      ENDIF.

      IF problem IS INITIAL.
        " Every check passed: one MODIFY moves the booking to leg 1 at its price and creates a booking per further leg.
        " ponytail: new IDs are the travel's highest in the database + 1 and + 2, without a lock on the travel. Two
        " rebookings into one travel at once collide, and the second fails whole (NOT_SAVED); a real system uses a number range.
        SELECT MAX( booking_id ) FROM zfr_booking WHERE travel_id = @booking-TravelId INTO @DATA(last_id).
        CLEAR creates.
        LOOP AT legs INTO DATA(further) FROM 2.
          APPEND VALUE #( %cid          = |leg{ sy-tabix }|
                          TravelId      = booking-TravelId
                          BookingId     = last_id + sy-tabix - 1
                          CustomerId    = booking-CustomerId
                          CarrierId     = further-carrier_id
                          ConnectionId  = further-connection_id
                          FlightDate    = further-flight_date
                          FlightPrice   = 0
                          CurrencyCode  = booking-CurrencyCode
                          BookingStatus = 'B' ) TO creates.
        ENDLOOP.
        MODIFY ENTITIES OF zr_fr_booking IN LOCAL MODE
          ENTITY Booking
            UPDATE FIELDS ( CarrierId ConnectionId FlightDate )
            WITH VALUE #( ( %tky         = <key>-%tky
                            CarrierId    = legs[ 1 ]-carrier_id
                            ConnectionId = legs[ 1 ]-connection_id
                            FlightDate   = legs[ 1 ]-flight_date ) )
            CREATE FIELDS ( TravelId BookingId CustomerId CarrierId ConnectionId FlightDate FlightPrice CurrencyCode BookingStatus )
            WITH creates
          FAILED DATA(not_saved).
        " In OData a failed action fails its request, or its whole change set, and RAP saves nothing of it.
        IF not_saved IS NOT INITIAL.
          problem = |NOT_SAVED: { booking-TravelId }/{ booking-BookingId } stays where it was.|.
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
      INSERT VALUE #( %tky = <key>-%tky ) INTO TABLE moved.
    ENDLOOP.

    READ ENTITIES OF zr_fr_booking IN LOCAL MODE
      ENTITY Booking ALL FIELDS WITH moved
      RESULT DATA(updated).
    result = VALUE #( FOR u IN updated ( %tky = u-%tky %param = u ) ).
  ENDMETHOD.

  METHOD seatsleft.
    " Every flight a booking of this save is on: its active bookings after the save may not exceed its seats. The actions
    " check seats one booking at a time against the database; this also counts the other bookings of the same change set.
    READ ENTITIES OF zr_fr_booking IN LOCAL MODE
      ENTITY Booking FIELDS ( CarrierId ConnectionId FlightDate BookingStatus ) WITH CORRESPONDING #( keys )
      RESULT DATA(changed).
    LOOP AT changed INTO DATA(c) WHERE BookingStatus <> 'X'.
      SELECT travel_id, booking_id FROM zfr_booking
        WHERE carrier_id = @c-CarrierId AND connection_id = @c-ConnectionId AND flight_date = @c-FlightDate
          AND booking_status <> 'X'
        INTO TABLE @DATA(stored).
      " The stored bookings this save leaves alone, and this save's bookings on the flight.
      DATA(load) = 0.
      LOOP AT stored INTO DATA(s).
        IF NOT line_exists( changed[ TravelId = s-travel_id BookingId = s-booking_id ] ).
          load += 1.
        ENDIF.
      ENDLOOP.
      LOOP AT changed TRANSPORTING NO FIELDS WHERE CarrierId = c-CarrierId AND ConnectionId = c-ConnectionId
                                               AND FlightDate = c-FlightDate AND BookingStatus <> 'X'.
        load += 1.
      ENDLOOP.
      SELECT SINGLE seats_max FROM /dmo/flight
        WHERE carrier_id = @c-CarrierId AND connection_id = @c-ConnectionId AND flight_date = @c-FlightDate
        INTO @DATA(seats_max).
      IF load > seats_max.
        APPEND VALUE #( %tky = c-%tky ) TO failed-booking.
        APPEND VALUE #( %tky = c-%tky
                        %msg = new_message_with_text( severity = if_abap_behv_message=>severity-error
                                                      text     = |FULL: { c-CarrierId } { c-ConnectionId } { c-FlightDate DATE = ISO } has no free seat.| ) )
          TO reported-booking.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
