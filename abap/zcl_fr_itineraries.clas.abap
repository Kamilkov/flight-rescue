"! Itineraries of one to three flights from A4H's own HANA graph: the graph workspace over ZI_FR_GraphEdge and
"! ZI_FR_GraphVertex, the GraphScript search for the k shortest paths, and the query behind ZI_FR_Itinerary
"! (ZFR_REBOOK/Itineraries). The leg limit lives in the graph's layers, and a path costs 10 x its arrival + its
"! connections, so the k shortest paths are the k best itineraries.
CLASS zcl_fr_itineraries DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_amdp_marker_hdb.
    INTERFACES if_rap_query_provider.

    TYPES vertex_id TYPE c LENGTH 20.
    TYPES: BEGIN OF marked_edge,
             source_id TYPE vertex_id,
             target_id TYPE vertex_id,
             cost      TYPE int8,
             mask      TYPE int8,
           END OF marked_edge,
           marked_edges TYPE STANDARD TABLE OF marked_edge WITH EMPTY KEY.

    "! Itineraries per answer: the ten best.
    CONSTANTS k TYPE int4 VALUE 10.

    CLASS-METHODS graph FOR DDL OBJECT OPTIONS CDS SESSION CLIENT DEPENDENT.

    "! The k shortest paths from im_from (DEP:origin) to im_to (ARR:destination), as the edges they use: bit i of mask
    "! marks path i + 1. The first flight leaves from im_start to im_end, the others before im_end + 1 day.
    CLASS-METHODS best_paths
      AMDP OPTIONS READ-ONLY CDS SESSION CLIENT DEPENDENT
      IMPORTING VALUE(im_origin)      TYPE /dmo/airport_id
                VALUE(im_destination) TYPE /dmo/airport_id
                VALUE(im_from)        TYPE vertex_id
                VALUE(im_to)          TYPE vertex_id
                VALUE(im_start)       TYPE int8
                VALUE(im_end)         TYPE int8
                VALUE(im_k)           TYPE int4
      EXPORTING VALUE(ex_edges)       TYPE marked_edges
      RAISING   cx_amdp_execution_failed.
ENDCLASS.


CLASS zcl_fr_itineraries IMPLEMENTATION.

  METHOD graph BY DATABASE GRAPH WORKSPACE FOR HDB
    LANGUAGE SQL
    USING zi_fr_graphedge zi_fr_graphvertex.

    edge table zi_fr_graphedge
      source column sourceid
      target column targetid
      key    column edgeid
    vertex table zi_fr_graphvertex
      key    column vertexid
  ENDMETHOD.

  METHOD best_paths BY DATABASE PROCEDURE FOR HDB
    LANGUAGE GRAPH OPTIONS READ-ONLY
    USING zcl_fr_itineraries=>graph.

    -- No apostrophes in these comments: ABAP reads them as the start of a literal.
    Graph g = Graph ("ZCL_FR_ITINERARIES=>GRAPH");
    BigInt t0 = :im_start;
    BigInt t1 = :im_end;
    BigInt t2 = :im_end + BigInt(86400);
    -- First flights inside the window, onward ones up to a day later. No connection onto a flight that leaves the
    -- destination or lands at the origin, so no itinerary visits an airport twice.
    Multiset<Edge> es = e IN Edges (:g)
      WHERE :e.depsec <= :t2
        AND ( :e.edgekind != N'D' OR ( :e.depsec >= :t0 AND :e.depsec <= :t1 ) )
        AND ( :e.edgekind != N'C' OR ( :e.legfrom != :im_destination AND :e.legto != :im_origin ) );
    Graph g2 = SubGraph (:g, :es);
    ALTER g2 ADD TEMPORARY EDGE ATTRIBUTE (BigInt mask = 0L);
    -- A subgraph holds only the vertices of its edges, and Vertex () raises on an unknown key.
    Multiset<Vertex> sources = v IN Vertices (:g2) WHERE :v.vertexid == :im_from;
    Multiset<Vertex> sinks = v IN Vertices (:g2) WHERE :v.vertexid == :im_to;
    IF ( COUNT(:sources) > 0L AND COUNT(:sinks) > 0L ) {
      Vertex v_from = Vertex (:g2, :im_from);
      Vertex v_to = Vertex (:g2, :im_to);
      Integer k = :im_k;
      Sequence<WeightedPath<BigInt>> ps = K_Shortest_Paths (:g2, :v_from, :v_to, :k,
        (Edge e) => BigInt { RETURN :e.cost; } );
      -- Paths share edges: bit i of mask marks path i + 1. Set it through Edge (), as writes via Edges (:p) are lost.
      BigInt bit = 1L;
      FOREACH p IN :ps {
        FOREACH e IN Edges (:p) {
          Edge ge = Edge (:g2, :e.edgeid);
          ge.mask = :ge.mask + :bit;
        }
        bit = :bit * 2L;
      }
    }
    Multiset<Edge> used = e IN Edges (:g2) WHERE :e.mask > 0L;
    ex_edges = SELECT :e.sourceid, :e.targetid, :e.cost, :e.mask FOREACH e IN :used;
  ENDMETHOD.

  METHOD if_rap_query_provider~select.
    DATA rows TYPE STANDARD TABLE OF zi_fr_itinerary WITH EMPTY KEY.
    DATA paged LIKE rows.

    " The filter names the trip: Origin, Destination and FromDate, each by one equality.
    TRY.
        DATA(ranges) = io_request->get_filter( )->get_as_ranges( ).
      CATCH cx_rap_query_filter_no_range.
        CLEAR ranges.
    ENDTRY.
    DATA(origin)      = CONV /dmo/airport_id( lcl_query=>equal( ranges = ranges name = `ORIGIN` ) ).
    DATA(destination) = CONV /dmo/airport_id( lcl_query=>equal( ranges = ranges name = `DESTINATION` ) ).
    DATA(from_date)   = CONV d( replace( val = lcl_query=>equal( ranges = ranges name = `FROMDATE` ) sub = `-` with = `` occ = 0 ) ).
    IF origin IS INITIAL OR destination IS INITIAL OR from_date IS INITIAL.
      lcx_refused=>raise( `FILTER: Origin, Destination and FromDate needed.` ).
    ENDIF.
    " Rows come ranked by itinerary and leg, with every element: reading the paging, order and elements accepts them.
    DATA(offset) = io_request->get_paging( )->get_offset( ).
    DATA(size)   = io_request->get_paging( )->get_page_size( ).
    io_request->get_sort_elements( ).
    io_request->get_requested_elements( ).

    " An unknown airport gives no rows, and the graph is not asked: Vertex () raises on an unknown key.
    SELECT COUNT(*) FROM /dmo/airport WHERE airport_id = @origin OR airport_id = @destination INTO @DATA(known).
    IF known = 2.
      DATA(start) = lcl_paths=>seconds( from_date ).
      TRY.
          best_paths( EXPORTING im_origin = origin im_destination = destination
                                im_from = |DEP:{ origin }| im_to = |ARR:{ destination }|
                                im_start = start im_end = start + 3 * 86400 - 1 im_k = k
                      IMPORTING ex_edges = DATA(edges) ).
        CATCH cx_amdp_execution_failed INTO DATA(failed).
          lcx_refused=>raise( |GRAPH: { failed->sql_message }| ).
      ENDTRY.
      DATA(paths) = lcl_paths=>rebuild( edges = edges start = |DEP:{ origin }| ).
      DATA(legs) = VALUE lcl_paths=>flights( FOR p IN paths FOR l IN p ( l ) ).
      IF legs IS NOT INITIAL.
        SELECT FROM zi_fr_flighttime
          FIELDS CarrierId, ConnectionId, FlightDate, AirportFrom, AirportTo, DepartureTime, ArrivalTime, ArrivalDate, SeatsFree
          FOR ALL ENTRIES IN @legs
          WHERE CarrierId = @legs-carrier_id AND ConnectionId = @legs-connection_id AND FlightDate = @legs-flight_date
          INTO TABLE @DATA(flights).
      ENDIF.
      LOOP AT paths INTO DATA(path).
        DATA(itinerary_no) = sy-tabix.
        DATA(last_leg) = path[ lines( path ) ].
        DATA(arrival) = flights[ CarrierId = last_leg-carrier_id ConnectionId = last_leg-connection_id FlightDate = last_leg-flight_date ].
        LOOP AT path INTO DATA(leg).
          DATA(flight) = flights[ CarrierId = leg-carrier_id ConnectionId = leg-connection_id FlightDate = leg-flight_date ].
          APPEND VALUE #( itineraryno = itinerary_no legno = sy-tabix origin = origin destination = destination fromdate = from_date
                          legs = lines( path ) arriveson = arrival-ArrivalDate arrivesat = arrival-ArrivalTime
                          carrierid = flight-CarrierId connectionid = flight-ConnectionId flightdate = flight-FlightDate
                          airportfrom = flight-AirportFrom airportto = flight-AirportTo departuretime = flight-DepartureTime
                          arrivaltime = flight-ArrivalTime seatsfree = flight-SeatsFree ) TO rows.
        ENDLOOP.
      ENDLOOP.
    ENDIF.

    IF io_request->is_total_numb_of_rec_requested( ).
      io_response->set_total_number_of_records( lines( rows ) ).
    ENDIF.
    IF io_request->is_data_requested( ).
      LOOP AT rows INTO DATA(row) FROM offset + 1.
        IF size <> if_rap_query_paging=>page_size_unlimited AND lines( paged ) >= size.
          EXIT.
        ENDIF.
        APPEND row TO paged.
      ENDLOOP.
      io_response->set_data( paged ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
