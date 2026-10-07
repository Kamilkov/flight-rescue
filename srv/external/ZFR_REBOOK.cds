/**
 * Contract of the custom RAP service ZFR_REBOOK in the ABAP trial (sources in abap/).
 * Names and types follow what the OData V4 binding exposes for those CDS views. After publishing the
 * binding, `cds import` of its $metadata should give the same shape; keep this file in step with it.
 * Without ABAP_URL, `cds watch` and the tests mock this service from here (ZFR_REBOOK.js, data/).
 */
@cds.external: true
service ZFR_REBOOK {

  entity Bookings {
    key TravelId           : String(8) not null;
    key BookingId          : String(4) not null;
        CustomerId         : String(6) not null;
        CarrierId          : String(3) not null;
        ConnectionId       : String(4) not null;
        FlightDate         : Date;
        FlightPrice        : Decimal(16) not null; // Edm.Decimal, Precision 16, Scale variable
        CurrencyCode       : String(3) not null;
        BookingStatus      : String(1) not null;
        LastChangedAt      : Timestamp;
        LocalLastChangedAt : Timestamp;
        SAP__Messages      : many SAP__Message;
  } actions {
    /** Moves the booking to another flight on the same route. Refuses if it is no longer on the expected flight. */
    action rebook(ExpectedCarrierId : String(3) not null, ExpectedConnectionId : String(4) not null, ExpectedFlightDate : Date,
                  CarrierId : String(3) not null, ConnectionId : String(4) not null, FlightDate : Date) returns Bookings;
    /** Moves the booking onto an itinerary: to Leg1*, with new bookings in its travel (price 0) for Leg2* and Leg3*.
     *  All or nothing. Leg3* is empty for two legs (ABAP's initial values: no carrier, connection 0000, no date), so
     *  Leg2* and Leg3* are not `not null` here. Refuses if the booking is no longer on the expected flight. */
    action rebookItinerary(ExpectedCarrierId : String(3) not null, ExpectedConnectionId : String(4) not null, ExpectedFlightDate : Date,
                           Leg1CarrierId : String(3) not null, Leg1ConnectionId : String(4) not null, Leg1FlightDate : Date,
                           Leg2CarrierId : String(3), Leg2ConnectionId : String(4), Leg2FlightDate : Date,
                           Leg3CarrierId : String(3), Leg3ConnectionId : String(4), Leg3FlightDate : Date) returns Bookings;
  }

  @readonly
  entity Flights {
    key CarrierId     : String(3) not null;
    key ConnectionId  : String(4) not null;
    key FlightDate    : Date not null;
        AirportFrom   : String(3) not null;
        AirportTo     : String(3) not null;
        DepartureTime : Time not null;
        ArrivalTime   : Time not null;
        Price         : Decimal(16) not null; // Edm.Decimal, Precision 16, Scale variable
        CurrencyCode  : String(3) not null;
        PlaneType     : String(10) not null;
        SeatsMax      : Integer not null;
        SeatsBooked   : Integer not null;
        SeatsFree     : Integer not null;
        IsCancelled   : Boolean; // a ZFR_FLIGHTCANCEL row exists for the flight
  }

  /** The ten best itineraries of one to three flights from Origin to Destination, the first flight leaving on FromDate up
   *  to two days later: one row per leg, ItineraryNo 1 arriving first (ZI_FR_Itinerary; HANA Graph in ZCL_FR_ITINERARIES).
   *  Origin, Destination and FromDate must be filtered by equality. */
  @readonly
  entity Itineraries {
    key ItineraryNo   : Integer not null;
    key LegNo         : Integer not null;
        Origin        : String(3) not null;
        Destination   : String(3) not null;
        FromDate      : Date;
        Legs          : Integer not null;
        ArrivesOn     : Date;          // at the destination, local
        ArrivesAt     : Time not null;
        CarrierId     : String(3) not null;
        ConnectionId  : String(4) not null;
        FlightDate    : Date;
        AirportFrom   : String(3) not null;
        AirportTo     : String(3) not null;
        DepartureTime : Time not null;
        ArrivalTime   : Time not null;
        SeatsFree     : Integer not null;
  }

  /** A flight cancellation (ZR_FR_FlightCancel). Creating one cancels the flight; ABAP then reports it to this app. */
  entity FlightCancellations {
    key CarrierId     : String(3) not null;
    key ConnectionId  : String(4) not null;
    key FlightDate    : Date not null;
        Reason        : String(100);
        CreatedBy     : String(12);
        CreatedAt     : Timestamp;
        NotifyStatus  : String(1);   // empty: not reported yet, S: reported, F: the call to this app failed
        NotifyMessage : String(200); // why it failed
        SAP__Messages : many SAP__Message;
  }

  /** RAP adds bound messages to every entity with behavior. */
  type SAP__Message {
    code              : String not null;
    message           : String not null;
    target            : String;
    additionalTargets : many String;
    transition        : Boolean not null;
    numericSeverity   : Integer not null;
    longtextUrl       : String;
  }
}
