"! The body CAP's EventsService expects. Kept apart from the handler, so ABAP Unit checks it without HTTP.
CLASS lcl_payload DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS json IMPORTING cancellation  TYPE zfr_flightcancel
                       RETURNING VALUE(result) TYPE string.
ENDCLASS.


CLASS lcl_payload IMPLEMENTATION.

  METHOD json.
    TYPES: BEGIN OF body,
             carrier_id    TYPE string,
             connection_id TYPE string,
             flight_date   TYPE string,
             reason        TYPE string,
           END OF body.
    result = /ui2/cl_json=>serialize( data        = VALUE body( carrier_id    = cancellation-carrier_id
                                                                connection_id = cancellation-connection_id
                                                                flight_date   = |{ cancellation-flight_date DATE = ISO }|
                                                                reason        = condense( cancellation-reason ) )
                                      pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
  ENDMETHOD.

ENDCLASS.


CLASS lhe_cancellation DEFINITION INHERITING FROM cl_abap_behavior_event_handler.
  PRIVATE SECTION.
    METHODS on_cancelled FOR ENTITY EVENT cancellations FOR Cancellation~FlightCancelled.

    "! POSTs one body to the app. Returns why it failed, or nothing when the app accepted it.
    METHODS post IMPORTING body         TYPE string
                 RETURNING VALUE(error) TYPE string.
ENDCLASS.


CLASS lhe_cancellation IMPLEMENTATION.

  METHOD on_cancelled.
    LOOP AT cancellations INTO DATA(key).
      SELECT SINGLE * FROM zfr_flightcancel
        WHERE carrier_id = @key-CarrierId AND connection_id = @key-ConnectionId AND flight_date = @key-FlightDate
        INTO @DATA(cancellation).
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      DATA(error) = post( lcl_payload=>json( cancellation ) ).
      " An event handler cannot call the BO's operations IN LOCAL MODE; the delivery status is its own bookkeeping.
      UPDATE zfr_flightcancel SET notify_status  = @( COND #( WHEN error IS INITIAL THEN 'S' ELSE 'F' ) ),
                                  notify_message = @( CONV zfr_flightcancel-notify_message( error ) )
        WHERE carrier_id = @key-CarrierId AND connection_id = @key-ConnectionId AND flight_date = @key-FlightDate.
    ENDLOOP.
  ENDMETHOD.

  METHOD post.
    DATA client TYPE REF TO if_http_client.
    cl_http_client=>create_by_destination( EXPORTING  destination = 'ZFR_CAP_EVENTS'
                                           IMPORTING  client      = client
                                           EXCEPTIONS OTHERS      = 1 ).
    IF sy-subrc <> 0.
      error = |No HTTP client for destination ZFR_CAP_EVENTS (rc { sy-subrc }).|.
      RETURN.
    ENDIF.

    client->request->set_method( if_http_request=>co_request_method_post ).
    cl_http_utility=>set_request_uri( request = client->request uri = '/events/flightCancelled' ).
    client->request->set_content_type( 'application/json' ).
    client->request->set_cdata( body ).

    client->send( EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc = 0.
      client->receive( EXCEPTIONS OTHERS = 1 ).
    ENDIF.
    IF sy-subrc <> 0.
      client->get_last_error( IMPORTING message = DATA(message) ).
      error = |HTTP call failed: { message }|.
    ELSE.
      client->response->get_status( IMPORTING code = DATA(code) reason = DATA(reason) ).
      IF code < 200 OR code >= 300.
        error = |App answered { code } { reason }: { client->response->get_cdata( ) }|.
      ENDIF.
    ENDIF.
    client->close( EXCEPTIONS OTHERS = 0 ).
  ENDMETHOD.

ENDCLASS.
