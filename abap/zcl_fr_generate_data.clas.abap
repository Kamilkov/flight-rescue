"! Copies the flight reference bookings (/DMO/BOOKING) into ZFR_BOOKING, so the rebooking
"! service never writes to /DMO/ tables, and adds three demo scenarios: on FRA-EWR a flight to
"! cancel with 9 bookings and five alternatives with 6 free seats between them; on FRA-JFK a flight
"! in a traffic jam (LH 0400) with 9 bookings, and later flights that day with 2 and 3 free seats; on
"! FRA-SFO a flight to cancel (LH 0454) with 9 bookings, whose passengers need itineraries via JFK.
"! Run it with F9 in ADT; running it again resets the data and clears the flight cancellations.
"! The output names the demo flight (DEMO_FLIGHT), the traffic scenario's flight (TRAFFIC_FLIGHT) and the
"! itinerary scenario's flight (ITINERARY_FLIGHT).
CLASS zcl_fr_generate_data DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PRIVATE SECTION.
    TYPES booking_table TYPE STANDARD TABLE OF zfr_booking WITH EMPTY KEY.
    TYPES: BEGIN OF seat_plan,
             carrier_id    TYPE /dmo/carrier_id,
             connection_id TYPE /dmo/connection_id,
             days_later    TYPE i,
             free          TYPE i, " seats to leave free; -1 is the scenario's own flight
           END OF seat_plan.
    TYPES seat_plans TYPE STANDARD TABLE OF seat_plan WITH EMPTY KEY.
    TYPES travel_sizes TYPE STANDARD TABLE OF i WITH EMPTY KEY.

    "! First day, two weeks out or later, from which UA 0043 and LH 0402 both fly three days in a row. Initial if none.
    METHODS demo_day RETURNING VALUE(result) TYPE d.
    "! Appends the demo bookings for the flights from that day on.
    METHODS add_demo IMPORTING day TYPE d
                               now TYPE timestampl
                     CHANGING  bookings TYPE booking_table.
    "! First day, two weeks out or later, on which LH 0400, DL 0107 and LH 0404 all fly. Initial if none.
    METHODS traffic_day RETURNING VALUE(result) TYPE d.
    "! Appends the traffic scenario: 9 bookings on LH 0400 in travels 90000101-105, and the later FRA-JFK flights
    "! of that day filled to leave 2 (DL 0107), 3 (LH 0404) and 0 (DE 2016) free seats.
    METHODS add_traffic IMPORTING day TYPE d
                                  now TYPE timestampl
                        CHANGING  bookings TYPE booking_table.
    "! First day, two weeks out or later and not the traffic scenario's, on which LH 0454, DE 2096, UA 0059, LH 0400,
    "! DL 0107, B6 0415 and DL 0365 all fly and no copied booking is on LH 0454. Initial if none.
    METHODS itinerary_day IMPORTING traffic       TYPE d
                                    bookings      TYPE booking_table
                          RETURNING VALUE(result) TYPE d.
    "! Appends the itinerary scenario: 9 bookings on LH 0454 in travels 90000201-203, and that day's flights to SFO
    "! and via JFK filled to leave few seats, so that 8 of the 9 fit that day at most.
    METHODS add_itinerary IMPORTING day TYPE d
                                    now TYPE timestampl
                          CHANGING  bookings TYPE booking_table.
ENDCLASS.


CLASS zcl_fr_generate_data IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
    DATA bookings TYPE booking_table.
    DATA now TYPE timestampl.

    SELECT FROM /dmo/booking AS booking
      INNER JOIN /dmo/travel AS travel ON travel~travel_id = booking~travel_id
      FIELDS booking~travel_id, booking~booking_id, booking~customer_id, booking~carrier_id,
             booking~connection_id, booking~flight_date, booking~flight_price, booking~currency_code,
             travel~status AS travel_status
      INTO TABLE @DATA(source).

    GET TIME STAMP FIELD now.
    bookings = VALUE #( FOR s IN source ( travel_id             = s-travel_id
                                          booking_id            = s-booking_id
                                          customer_id           = s-customer_id
                                          carrier_id            = s-carrier_id
                                          connection_id         = s-connection_id
                                          flight_date           = s-flight_date
                                          flight_price          = s-flight_price
                                          currency_code         = s-currency_code
                                          " A cancelled travel cancels its bookings.
                                          booking_status        = COND #( WHEN s-travel_status = 'X' THEN 'X' ELSE 'B' )
                                          last_changed_at       = now
                                          local_last_changed_at = now ) ).
    DATA(copied) = lines( bookings ).

    DATA(day) = demo_day( ).
    IF day IS NOT INITIAL.
      add_demo( EXPORTING day = day now = now CHANGING bookings = bookings ).
    ENDIF.
    DATA(demo_added) = lines( bookings ) - copied.
    DATA(traffic) = traffic_day( ).
    IF traffic IS NOT INITIAL.
      add_traffic( EXPORTING day = traffic now = now CHANGING bookings = bookings ).
    ENDIF.
    DATA(traffic_added) = lines( bookings ) - copied - demo_added.
    DATA(itinerary) = itinerary_day( traffic = traffic bookings = bookings ).
    IF itinerary IS NOT INITIAL.
      add_itinerary( EXPORTING day = itinerary now = now CHANGING bookings = bookings ).
    ENDIF.

    DELETE FROM zfr_booking.
    INSERT zfr_booking FROM TABLE @bookings.
    DELETE FROM zfr_flightcancel.
    out->write( |{ copied } bookings copied from /DMO/BOOKING into ZFR_BOOKING.| ).
    out->write( 'Flight cancellations cleared (ZFR_FLIGHTCANCEL).' ).
    IF day IS INITIAL.
      out->write( 'No demo scenario: UA 0043 and LH 0402 do not fly three days in a row within a year.' ).
    ELSE.
      out->write( |{ demo_added } demo bookings added on FRA-EWR.| ).
      out->write( |DEMO_FLIGHT LH 0402 { day DATE = ISO }| ).
    ENDIF.
    IF traffic IS INITIAL.
      out->write( 'No traffic scenario: LH 0400, DL 0107 and LH 0404 do not fly on one day within a year.' ).
    ELSE.
      out->write( |{ traffic_added } traffic bookings added on FRA-JFK.| ).
      out->write( |TRAFFIC_FLIGHT LH 0400 { traffic DATE = ISO }| ).
    ENDIF.
    IF itinerary IS INITIAL.
      out->write( 'No itinerary scenario: LH 0454 and its alternatives do not fly on one free day within a year.' ).
    ELSE.
      out->write( |{ lines( bookings ) - copied - demo_added - traffic_added } itinerary bookings added on FRA-SFO.| ).
      out->write( |ITINERARY_FLIGHT LH 0454 { itinerary DATE = ISO }| ).
    ENDIF.
  ENDMETHOD.

  METHOD demo_day.
    DATA last TYPE d.
    result = sy-datum + 14.
    DO 365 TIMES.
      last = result + 2.
      SELECT COUNT(*) FROM /dmo/flight
        WHERE ( ( carrier_id = 'UA' AND connection_id = '0043' ) OR ( carrier_id = 'LH' AND connection_id = '0402' ) )
          AND flight_date BETWEEN @result AND @last
        INTO @DATA(flights).
      IF flights = 6.
        RETURN.
      ENDIF.
      result = result + 1.
    ENDDO.
    CLEAR result.
  ENDMETHOD.

  METHOD add_demo.
    DATA travel_id TYPE /dmo/travel_id.
    DATA booking_id TYPE /dmo/booking_id.
    DATA on_date TYPE /dmo/flight_date.
    DATA(plan) = VALUE seat_plans( ( carrier_id = 'LH' connection_id = '0402' days_later = 0 free = -1 )
                                   ( carrier_id = 'UA' connection_id = '0043' days_later = 0 free = 2 )
                                   ( carrier_id = 'UA' connection_id = '0043' days_later = 1 free = 1 )
                                   ( carrier_id = 'LH' connection_id = '0402' days_later = 1 free = 3 )
                                   ( carrier_id = 'UA' connection_id = '0043' days_later = 2 free = 0 )
                                   ( carrier_id = 'LH' connection_id = '0402' days_later = 2 free = 0 ) ).

    LOOP AT plan INTO DATA(p).
      DATA(plan_index) = sy-tabix.
      on_date = day + p-days_later.
      SELECT SINGLE seats_max, price, currency_code FROM /dmo/flight
        WHERE carrier_id = @p-carrier_id AND connection_id = @p-connection_id AND flight_date = @on_date
        INTO @DATA(flight).
      DATA(booked) = REDUCE i( INIT n = 0 FOR b IN bookings
                               WHERE ( carrier_id = p-carrier_id AND connection_id = p-connection_id
                                       AND flight_date = on_date AND booking_status <> 'X' )
                               NEXT n = n + 1 ).
      DATA(to_add) = COND i( WHEN p-free < 0 THEN 9 ELSE flight-seats_max - booked - p-free ).
      DO to_add TIMES.
        IF p-free >= 0.       " an alternative: one filler travel per flight
          travel_id = 90000010 + plan_index.
          booking_id = sy-index.
        ELSEIF sy-index <= 4. " the flight to cancel: travels of 4, 3 and 2 bookings
          travel_id = 90000001.
          booking_id = sy-index.
        ELSEIF sy-index <= 7.
          travel_id = 90000002.
          booking_id = sy-index - 4.
        ELSE.
          travel_id = 90000003.
          booking_id = sy-index - 7.
        ENDIF.
        APPEND VALUE #( travel_id             = travel_id
                        booking_id            = booking_id
                        customer_id           = '000001'
                        carrier_id            = p-carrier_id
                        connection_id         = p-connection_id
                        flight_date           = on_date
                        flight_price          = flight-price
                        currency_code         = flight-currency_code
                        booking_status        = 'B'
                        last_changed_at       = now
                        local_last_changed_at = now ) TO bookings.
      ENDDO.
    ENDLOOP.
  ENDMETHOD.

  METHOD traffic_day.
    result = sy-datum + 14.
    DO 365 TIMES.
      SELECT COUNT(*) FROM /dmo/flight
        WHERE ( ( carrier_id = 'LH' AND connection_id = '0400' ) OR ( carrier_id = 'DL' AND connection_id = '0107' )
             OR ( carrier_id = 'LH' AND connection_id = '0404' ) )
          AND flight_date = @result
        INTO @DATA(flights).
      IF flights = 3.
        RETURN.
      ENDIF.
      result = result + 1.
    ENDDO.
    CLEAR result.
  ENDMETHOD.

  METHOD add_traffic.
    DATA travel_id TYPE /dmo/travel_id.
    DATA(plan) = VALUE seat_plans( ( carrier_id = 'LH' connection_id = '0400' free = -1 )
                                   ( carrier_id = 'DL' connection_id = '0107' free = 2 )
                                   ( carrier_id = 'LH' connection_id = '0404' free = 3 )
                                   ( carrier_id = 'DE' connection_id = '2016' free = 0 ) ).
    DATA(sizes) = VALUE travel_sizes( ( 2 ) ( 2 ) ( 1 ) ( 2 ) ( 2 ) ).

    LOOP AT plan INTO DATA(p).
      DATA(plan_index) = sy-tabix.
      SELECT SINGLE seats_max, price, currency_code FROM /dmo/flight
        WHERE carrier_id = @p-carrier_id AND connection_id = @p-connection_id AND flight_date = @day
        INTO @DATA(flight).
      IF sy-subrc <> 0.     " DE 2016 may not fly that day: nothing to fill
        CONTINUE.
      ENDIF.
      IF p-free < 0.        " the flight in the jam: travels 90000101-105 with 2, 2, 1, 2 and 2 bookings
        LOOP AT sizes INTO DATA(size).
          travel_id = 90000100 + sy-tabix.
          DO size TIMES.
            APPEND VALUE #( travel_id = travel_id booking_id = sy-index customer_id = '000001'
                            carrier_id = p-carrier_id connection_id = p-connection_id flight_date = day
                            flight_price = flight-price currency_code = flight-currency_code booking_status = 'B'
                            last_changed_at = now local_last_changed_at = now ) TO bookings.
          ENDDO.
        ENDLOOP.
      ELSE.                 " a later flight: one filler travel leaves `free` seats
        DATA(booked) = REDUCE i( INIT n = 0 FOR b IN bookings
                                 WHERE ( carrier_id = p-carrier_id AND connection_id = p-connection_id
                                         AND flight_date = day AND booking_status <> 'X' )
                                 NEXT n = n + 1 ).
        travel_id = 90000110 + plan_index.
        DO flight-seats_max - booked - p-free TIMES.
          APPEND VALUE #( travel_id = travel_id booking_id = sy-index customer_id = '000001'
                          carrier_id = p-carrier_id connection_id = p-connection_id flight_date = day
                          flight_price = flight-price currency_code = flight-currency_code booking_status = 'B'
                          last_changed_at = now local_last_changed_at = now ) TO bookings.
        ENDDO.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD itinerary_day.
    result = sy-datum + 14.
    DO 365 TIMES.
      IF result <> traffic.
        SELECT COUNT(*) FROM /dmo/flight
          WHERE ( ( carrier_id = 'LH' AND connection_id = '0454' ) OR ( carrier_id = 'DE' AND connection_id = '2096' )
               OR ( carrier_id = 'UA' AND connection_id = '0059' ) OR ( carrier_id = 'LH' AND connection_id = '0400' )
               OR ( carrier_id = 'DL' AND connection_id = '0107' ) OR ( carrier_id = 'B6' AND connection_id = '0415' )
               OR ( carrier_id = 'DL' AND connection_id = '0365' ) )
            AND flight_date = @result
          INTO @DATA(flights).
        " The cancellation then affects exactly the scenario's 9 bookings.
        DATA(copied) = REDUCE i( INIT n = 0 FOR b IN bookings
                                 WHERE ( carrier_id = 'LH' AND connection_id = '0454' AND flight_date = result
                                         AND booking_status <> 'X' )
                                 NEXT n = n + 1 ).
        IF flights = 7 AND copied = 0.
          RETURN.
        ENDIF.
      ENDIF.
      result = result + 1.
    ENDDO.
    CLEAR result.
  ENDMETHOD.

  METHOD add_itinerary.
    DATA travel_id TYPE /dmo/travel_id.
    " Seats left free that day. Direct: DE 2096 2, UA 0059 1, UA 0927 0. To JFK: LH 0400 3, DL 0107 2, the others 0 (SQ 0026
    " would otherwise reach SFO at 18:24 via DL 0679). On to SFO: B6 0415 1, DL 0365 5, every later flight 0, so the
    " next day's options make the top ten. LH 0400 and DL 0365 are each shared by two itineraries; 8 of 9 fit that day.
    DATA(plan) = VALUE seat_plans( ( carrier_id = 'LH' connection_id = '0454' free = -1 )
                                   ( carrier_id = 'DE' connection_id = '2096' free = 2 )
                                   ( carrier_id = 'UA' connection_id = '0059' free = 1 )
                                   ( carrier_id = 'UA' connection_id = '0927' free = 0 )
                                   ( carrier_id = 'SQ' connection_id = '0026' free = 0 )
                                   ( carrier_id = 'LH' connection_id = '0400' free = 3 )
                                   ( carrier_id = 'DE' connection_id = '2016' free = 0 )
                                   ( carrier_id = 'DL' connection_id = '0107' free = 2 )
                                   ( carrier_id = 'LH' connection_id = '0404' free = 0 )
                                   ( carrier_id = 'B6' connection_id = '0415' free = 1 )
                                   ( carrier_id = 'DL' connection_id = '0365' free = 5 )
                                   ( carrier_id = 'AS' connection_id = '0027' free = 0 )
                                   ( carrier_id = 'AA' connection_id = '0015' free = 0 )
                                   ( carrier_id = 'B6' connection_id = '0615' free = 0 )
                                   ( carrier_id = 'DL' connection_id = '0667' free = 0 )
                                   ( carrier_id = 'AS' connection_id = '0039' free = 0 )
                                   ( carrier_id = 'DL' connection_id = '1732' free = 0 )
                                   ( carrier_id = 'B6' connection_id = '0515' free = 0 )
                                   ( carrier_id = 'AA' connection_id = '0177' free = 0 ) ).
    DATA(sizes) = VALUE travel_sizes( ( 4 ) ( 3 ) ( 2 ) ).

    LOOP AT plan INTO DATA(p).
      DATA(plan_index) = sy-tabix.
      SELECT SINGLE seats_max, price, currency_code FROM /dmo/flight
        WHERE carrier_id = @p-carrier_id AND connection_id = @p-connection_id AND flight_date = @day
        INTO @DATA(flight).
      IF sy-subrc <> 0.     " a filled flight that does not fly that day: nothing to fill
        CONTINUE.
      ENDIF.
      IF p-free < 0.        " the flight to cancel: travels 90000201-203 with 4, 3 and 2 bookings
        LOOP AT sizes INTO DATA(size).
          travel_id = 90000200 + sy-tabix.
          DO size TIMES.
            APPEND VALUE #( travel_id = travel_id booking_id = sy-index customer_id = '000001'
                            carrier_id = p-carrier_id connection_id = p-connection_id flight_date = day
                            flight_price = flight-price currency_code = flight-currency_code booking_status = 'B'
                            last_changed_at = now local_last_changed_at = now ) TO bookings.
          ENDDO.
        ENDLOOP.
      ELSE.                 " one filler travel leaves `free` seats
        DATA(booked) = REDUCE i( INIT n = 0 FOR b IN bookings
                                 WHERE ( carrier_id = p-carrier_id AND connection_id = p-connection_id
                                         AND flight_date = day AND booking_status <> 'X' )
                                 NEXT n = n + 1 ).
        travel_id = 90000210 + plan_index.
        DO flight-seats_max - booked - p-free TIMES.
          APPEND VALUE #( travel_id = travel_id booking_id = sy-index customer_id = '000001'
                          carrier_id = p-carrier_id connection_id = p-connection_id flight_date = day
                          flight_price = flight-price currency_code = flight-currency_code booking_status = 'B'
                          last_changed_at = now local_last_changed_at = now ) TO bookings.
        ENDDO.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
