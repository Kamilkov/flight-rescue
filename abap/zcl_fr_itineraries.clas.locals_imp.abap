"! The query's refusal, with its text as the message (00 001, in up to four parts of 50 characters).
CLASS lcx_refused DEFINITION INHERITING FROM cx_rap_query_provider FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS raise IMPORTING text TYPE string RAISING lcx_refused.
ENDCLASS.


CLASS lcx_refused IMPLEMENTATION.

  METHOD raise.
    DATA(t) = |{ text WIDTH = 200 }|.
    RAISE EXCEPTION TYPE lcx_refused MESSAGE e001(00) WITH t(50) t+50(50) t+100(50) t+150(50).
  ENDMETHOD.

ENDCLASS.


"! The query's filter as the provider needs it.
CLASS lcl_query DEFINITION FINAL.
  PUBLIC SECTION.
    "! The value of element `name` when the filter compares it by exactly one equality; else initial.
    CLASS-METHODS equal IMPORTING ranges        TYPE if_rap_query_filter=>tt_name_range_pairs
                                  name          TYPE string
                        RETURNING VALUE(result) TYPE string.
ENDCLASS.


CLASS lcl_query IMPLEMENTATION.

  METHOD equal.
    DATA(range) = VALUE if_rap_query_filter=>tt_range_option( ranges[ name = name ]-range OPTIONAL ).
    IF lines( range ) = 1 AND range[ 1 ]-sign = 'I' AND range[ 1 ]-option = 'EQ'.
      result = range[ 1 ]-low.
    ENDIF.
  ENDMETHOD.

ENDCLASS.


"! The paths of ZCL_FR_ITINERARIES=>BEST_PATHS, rebuilt from the edges it marked: path i follows the edges with bit
"! i - 1 of mask from DEP:<origin>. A flight vertex is the flight key behind its leg number (1:, 2: or 3:).
CLASS lcl_paths DEFINITION FINAL.
  PUBLIC SECTION.
    TYPES: BEGIN OF flight,
             carrier_id    TYPE /dmo/carrier_id,
             connection_id TYPE /dmo/connection_id,
             flight_date   TYPE /dmo/flight_date,
           END OF flight,
           flights TYPE STANDARD TABLE OF flight WITH EMPTY KEY,
           paths   TYPE STANDARD TABLE OF flights WITH EMPTY KEY.
    CLASS-METHODS rebuild IMPORTING edges         TYPE zcl_fr_itineraries=>marked_edges
                                    start         TYPE zcl_fr_itineraries=>vertex_id
                          RETURNING VALUE(result) TYPE paths.
    "! Seconds from 2000-01-01 00:00 to the start of `day`, as ZI_FR_FlightTime counts them.
    CLASS-METHODS seconds IMPORTING day TYPE d RETURNING VALUE(result) TYPE int8.
ENDCLASS.


CLASS lcl_paths IMPLEMENTATION.

  METHOD rebuild.
    DATA next TYPE zcl_fr_itineraries=>marked_edge.
    DATA carrier TYPE /dmo/carrier_id.
    DATA connection TYPE /dmo/connection_id.
    DATA date TYPE c LENGTH 8.
    DATA bit TYPE int8 VALUE 1.
    DO zcl_fr_itineraries=>k TIMES.
      DATA(path) = VALUE flights( ).
      DATA(vertex) = start.
      DO 4 TIMES. " DEP: to ARR: is at most four edges: in, two connections, out
        CLEAR next.
        LOOP AT edges INTO DATA(edge) WHERE source_id = vertex.
          IF ( edge-mask DIV bit ) MOD 2 = 1.
            next = edge.
            EXIT.
          ENDIF.
        ENDLOOP.
        IF next IS INITIAL OR next-target_id CP 'ARR:*'.
          EXIT.
        ENDIF.
        " 1:LH 0400 20261022 -> LH, 0400, 20261022
        SPLIT next-target_id+2 AT space INTO carrier connection date.
        APPEND VALUE #( carrier_id = carrier connection_id = connection flight_date = date ) TO path.
        vertex = next-target_id.
      ENDDO.
      IF path IS INITIAL.
        RETURN. " no path i, so none after it either
      ENDIF.
      APPEND path TO result.
      bit = bit * 2.
    ENDDO.
  ENDMETHOD.

  METHOD seconds.
    result = CONV int8( day - CONV d( '20000101' ) ) * 86400.
  ENDMETHOD.

ENDCLASS.
