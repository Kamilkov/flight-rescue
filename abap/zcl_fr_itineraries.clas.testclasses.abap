CLASS ltc_paths DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS two_paths_share_an_edge FOR TESTING.
    METHODS three_legs_without_the_prefix FOR TESTING.
    METHODS no_path FOR TESTING.
    METHODS seconds_since_2000 FOR TESTING.
    METHODS one_equality_per_element FOR TESTING.
ENDCLASS.


CLASS ltc_paths IMPLEMENTATION.

  METHOD two_paths_share_an_edge.
    " Path 1: LH 0400 then B6 0415; path 2: LH 0400 then DL 0365. Both take the edge DEP:FRA -> 1:LH 0400.
    DATA(paths) = lcl_paths=>rebuild( start = 'DEP:FRA' edges = VALUE #(
      ( source_id = 'DEP:FRA'            target_id = '1:LH 0400 20261022' mask = 3 )
      ( source_id = '1:LH 0400 20261022' target_id = '2:B6 0415 20261022' mask = 1 )
      ( source_id = '1:LH 0400 20261022' target_id = '2:DL 0365 20261022' mask = 2 )
      ( source_id = '2:B6 0415 20261022' target_id = 'ARR:SFO'            mask = 1 )
      ( source_id = '2:DL 0365 20261022' target_id = 'ARR:SFO'            mask = 2 ) ) ).
    cl_abap_unit_assert=>assert_equals( act = paths exp = VALUE lcl_paths=>paths(
      ( VALUE #( ( carrier_id = 'LH' connection_id = '0400' flight_date = '20261022' )
                 ( carrier_id = 'B6' connection_id = '0415' flight_date = '20261022' ) ) )
      ( VALUE #( ( carrier_id = 'LH' connection_id = '0400' flight_date = '20261022' )
                 ( carrier_id = 'DL' connection_id = '0365' flight_date = '20261022' ) ) ) ) ).
  ENDMETHOD.

  METHOD three_legs_without_the_prefix.
    " The spike's FRA-HAV: UA 0043, AA 2933, AA 0017 the next morning; the edges come in any order.
    DATA(paths) = lcl_paths=>rebuild( start = 'DEP:FRA' edges = VALUE #(
      ( source_id = '2:AA 2933 20261022' target_id = '3:AA 0017 20261023' mask = 1 )
      ( source_id = 'DEP:FRA'            target_id = '1:UA 0043 20261022' mask = 1 )
      ( source_id = '3:AA 0017 20261023' target_id = 'ARR:HAV'            mask = 1 )
      ( source_id = '1:UA 0043 20261022' target_id = '2:AA 2933 20261022' mask = 1 ) ) ).
    cl_abap_unit_assert=>assert_equals( act = paths exp = VALUE lcl_paths=>paths(
      ( VALUE #( ( carrier_id = 'UA' connection_id = '0043' flight_date = '20261022' )
                 ( carrier_id = 'AA' connection_id = '2933' flight_date = '20261022' )
                 ( carrier_id = 'AA' connection_id = '0017' flight_date = '20261023' ) ) ) ) ).
  ENDMETHOD.

  METHOD no_path.
    cl_abap_unit_assert=>assert_initial( lcl_paths=>rebuild( start = 'DEP:FRA' edges = VALUE #( ) ) ).
  ENDMETHOD.

  METHOD seconds_since_2000.
    " ZI_FR_FlightTime counts DepSec and ArrSec from 2000-01-01 00:00: 9791 days to 2026-10-22.
    cl_abap_unit_assert=>assert_equals( act = lcl_paths=>seconds( '20261022' ) exp = CONV int8( 845942400 ) ).
  ENDMETHOD.

  METHOD one_equality_per_element.
    DATA(ranges) = VALUE if_rap_query_filter=>tt_name_range_pairs(
      ( name = `ORIGIN`      range = VALUE #( ( sign = 'I' option = 'EQ' low = `FRA` ) ) )
      ( name = `DESTINATION` range = VALUE #( ( sign = 'I' option = 'EQ' low = `SFO` ) ( sign = 'I' option = 'EQ' low = `JFK` ) ) ) ).
    cl_abap_unit_assert=>assert_equals( act = lcl_query=>equal( ranges = ranges name = `ORIGIN` ) exp = `FRA` ).
    cl_abap_unit_assert=>assert_initial( lcl_query=>equal( ranges = ranges name = `DESTINATION` ) ).
    cl_abap_unit_assert=>assert_initial( lcl_query=>equal( ranges = ranges name = `FROMDATE` ) ).
  ENDMETHOD.

ENDCLASS.
