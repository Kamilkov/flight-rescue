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
