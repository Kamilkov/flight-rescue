CLASS ltc_itinerary DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    "! A leg that exists, flies and has 3 seats; departure and arrival in minutes from the start of 2026-10-22.
    CLASS-METHODS leg IMPORTING carrier       TYPE /dmo/carrier_id
                                connection    TYPE /dmo/connection_id
                                from          TYPE /dmo/airport_from_id
                                to            TYPE /dmo/airport_to_id
                                dep           TYPE i
                                arr           TYPE i
                      RETURNING VALUE(result) TYPE lcl_itinerary=>leg.
    METHODS good_chain FOR TESTING.
    METHODS broken_chain FOR TESTING.
    METHODS airport_twice FOR TESTING.
    METHODS layover_bounds FOR TESTING.
    METHODS overnight_arrival FOR TESTING.
    METHODS missing_cancelled_full_order FOR TESTING.
ENDCLASS.


CLASS ltc_itinerary IMPLEMENTATION.

  METHOD leg.
    result = VALUE #( carrier_id = carrier connection_id = connection flight_date = '20261022' found = abap_true
                      airport_from = from airport_to = to dep_sec = dep * 60 arr_sec = arr * 60 seats_free = 3 ).
  ENDMETHOD.

  METHOD good_chain.
    " LH 0400 FRA 10:55-JFK 13:35, then B6 0415 JFK 15:45-SFO 19:13: 2 h 10 min to connect.
    cl_abap_unit_assert=>assert_initial( lcl_itinerary=>problem( origin = 'FRA' destination = 'SFO' legs = VALUE #(
      ( leg( carrier = 'LH' connection = '0400' from = 'FRA' to = 'JFK' dep = 655 arr = 815 ) )
      ( leg( carrier = 'B6' connection = '0415' from = 'JFK' to = 'SFO' dep = 945 arr = 1153 ) ) ) ) ).
  ENDMETHOD.

  METHOD broken_chain.
    DATA(lh0400) = leg( carrier = 'LH' connection = '0400' from = 'FRA' to = 'JFK' dep = 655 arr = 815 ).
    cl_abap_unit_assert=>assert_equals( exp = `CHAIN: leg 1 does not leave from FRA.` act = lcl_itinerary=>problem(
      origin = 'FRA' destination = 'SFO' legs = VALUE #( ( leg( carrier = 'B6' connection = '0415' from = 'JFK' to = 'SFO' dep = 945 arr = 1153 ) ) ) ) ).
    cl_abap_unit_assert=>assert_equals( exp = `CHAIN: leg 2 does not leave from JFK.` act = lcl_itinerary=>problem(
      origin = 'FRA' destination = 'SFO' legs = VALUE #( ( lh0400 ) ( leg( carrier = 'DE' connection = '2096' from = 'FRA' to = 'SFO' dep = 945 arr = 1130 ) ) ) ) ).
    cl_abap_unit_assert=>assert_equals( exp = `CHAIN: leg 2 does not land at SFO.` act = lcl_itinerary=>problem(
      origin = 'FRA' destination = 'SFO' legs = VALUE #( ( lh0400 ) ( leg( carrier = 'LH' connection = '0401' from = 'JFK' to = 'FRA' dep = 940 arr = 1765 ) ) ) ) ).
  ENDMETHOD.

  METHOD airport_twice.
    cl_abap_unit_assert=>assert_equals( exp = `CHAIN: the itinerary visits FRA twice.` act = lcl_itinerary=>problem(
      origin = 'FRA' destination = 'SFO' legs = VALUE #(
        ( leg( carrier = 'LH' connection = '0400' from = 'FRA' to = 'JFK' dep = 655 arr = 815 ) )
        ( leg( carrier = 'LH' connection = '0401' from = 'JFK' to = 'FRA' dep = 940 arr = 1045 ) )
        ( leg( carrier = 'LH' connection = '0454' from = 'FRA' to = 'SFO' dep = 1140 arr = 1275 ) ) ) ) ).
  ENDMETHOD.

  METHOD layover_bounds.
    " LH 0400 lands at 13:35 (815). 89 min and 12 h 01 min are refused; 90 min and 12 h are fine.
    DATA(lh0400) = leg( carrier = 'LH' connection = '0400' from = 'FRA' to = 'JFK' dep = 655 arr = 815 ).
    DATA(refused) = `LAYOVER: leg 2 is not 90 min to 12 h after leg 1.`.
    cl_abap_unit_assert=>assert_equals( exp = refused act = lcl_itinerary=>problem( origin = 'FRA' destination = 'SFO'
      legs = VALUE #( ( lh0400 ) ( leg( carrier = 'B6' connection = '0415' from = 'JFK' to = 'SFO' dep = 904 arr = 1100 ) ) ) ) ).
    cl_abap_unit_assert=>assert_equals( exp = refused act = lcl_itinerary=>problem( origin = 'FRA' destination = 'SFO'
      legs = VALUE #( ( lh0400 ) ( leg( carrier = 'B6' connection = '0415' from = 'JFK' to = 'SFO' dep = 1536 arr = 1700 ) ) ) ) ).
    cl_abap_unit_assert=>assert_initial( lcl_itinerary=>problem( origin = 'FRA' destination = 'SFO'
      legs = VALUE #( ( lh0400 ) ( leg( carrier = 'B6' connection = '0415' from = 'JFK' to = 'SFO' dep = 905 arr = 1100 ) ) ) ) ).
    cl_abap_unit_assert=>assert_initial( lcl_itinerary=>problem( origin = 'FRA' destination = 'SFO'
      legs = VALUE #( ( lh0400 ) ( leg( carrier = 'B6' connection = '0415' from = 'JFK' to = 'SFO' dep = 1535 arr = 1700 ) ) ) ) ).
  ENDMETHOD.

  METHOD overnight_arrival.
    " LH 0401 leaves JFK at 15:40 and lands in FRA at 05:25 the next day (ZI_FR_FlightTime adds the day), LH 0454 leaves
    " FRA at 10:25 that day: 5 h later, not 19 h earlier.
    cl_abap_unit_assert=>assert_initial( lcl_itinerary=>problem( origin = 'JFK' destination = 'SFO' legs = VALUE #(
      ( leg( carrier = 'LH' connection = '0401' from = 'JFK' to = 'FRA' dep = 940 arr = 1765 ) )
      ( leg( carrier = 'LH' connection = '0454' from = 'FRA' to = 'SFO' dep = 2065 arr = 2200 ) ) ) ) ).
  ENDMETHOD.

  METHOD missing_cancelled_full_order.
    DATA(lh0400) = leg( carrier = 'LH' connection = '0400' from = 'FRA' to = 'JFK' dep = 655 arr = 815 ).
    DATA(b6) = leg( carrier = 'B6' connection = '0415' from = 'JFK' to = 'SFO' dep = 945 arr = 1153 ).
    DATA(gone) = b6.
    gone-found = abap_false.
    cl_abap_unit_assert=>assert_equals( exp = `NO_FLIGHT: B6 0415 2026-10-22 does not exist.`
      act = lcl_itinerary=>problem( origin = 'FRA' destination = 'SFO' legs = VALUE #( ( lh0400 ) ( gone ) ) ) ).
    " A cancelled leg comes before a full one, whatever their order.
    DATA(full) = lh0400.
    full-seats_free = 0.
    DATA(cancelled) = b6.
    cancelled-cancelled = abap_true.
    cl_abap_unit_assert=>assert_equals( exp = `NOT_FLYING: B6 0415 2026-10-22 is cancelled.`
      act = lcl_itinerary=>problem( origin = 'FRA' destination = 'SFO' legs = VALUE #( ( full ) ( cancelled ) ) ) ).
    cl_abap_unit_assert=>assert_equals( exp = `FULL: LH 0400 2026-10-22 has no free seat.`
      act = lcl_itinerary=>problem( origin = 'FRA' destination = 'SFO' legs = VALUE #( ( full ) ( b6 ) ) ) ).
  ENDMETHOD.

ENDCLASS.
