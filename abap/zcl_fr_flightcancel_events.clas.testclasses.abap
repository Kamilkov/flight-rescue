CLASS ltc_payload DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS camel_case_and_iso_date FOR TESTING.
    METHODS quotes_and_umlauts_stay_valid FOR TESTING.
ENDCLASS.


CLASS ltc_payload IMPLEMENTATION.

  METHOD camel_case_and_iso_date.
    cl_abap_unit_assert=>assert_equals(
      act = lcl_payload=>json( VALUE #( carrier_id = 'LH' connection_id = '0402' flight_date = '20261014' reason = 'Aircraft technical issue' ) )
      exp = `{"carrierId":"LH","connectionId":"0402","flightDate":"2026-10-14","reason":"Aircraft technical issue"}` ).
  ENDMETHOD.

  METHOD quotes_and_umlauts_stay_valid.
    cl_abap_unit_assert=>assert_equals(
      act = lcl_payload=>json( VALUE #( carrier_id = 'UA' connection_id = '0043' flight_date = '20261015' reason = 'Bird "strike" in Köln' ) )
      exp = `{"carrierId":"UA","connectionId":"0043","flightDate":"2026-10-15","reason":"Bird \"strike\" in Köln"}` ).
  ENDMETHOD.

ENDCLASS.
