namespace fr;

type Assignment {
  travelId     : String(8);
  bookingId    : String(4);
  carrierId    : String(3);
  connectionId : String(4);
  flightDate   : Date;
}

type BookingRef {
  travelId  : String(8);
  bookingId : String(4);
}

type Impact {
  disruption       : {
    ID           : UUID;
    flight       : String;
    carrierId    : String(3);
    connectionId : String(4);
    flightDate   : Date;
    airportFrom  : String(3);
    airportTo    : String(3);
    reason       : String;
  };
  affectedBookings : many BookingRef;
  alternatives     : many {
    carrierId      : String(3);
    connectionId   : String(4);
    flightDate     : Date;
    departureTime  : Time;
    arrivalTime    : Time;
    daysLater      : Integer;
    seatsFree      : Integer;
    seatsHeld      : Integer;
    seatsAvailable : Integer;
  };
  seatsAvailable   : Integer;
  note             : String;
}

type ProposalResult {
  plan       : UUID;
  disruption : UUID;
  assigned   : Integer;
  unassigned : many BookingRef;
  status     : String;
  message    : String;
}

type ApplyResult {
  plan     : UUID;
  status   : String;
  rebooked : Integer;
  failed   : many {
    travelId  : String(8);
    bookingId : String(4);
    message   : String;
  };
  message  : String;
}

/** One flight of a disruption's route and window, for the cockpit's fill map. */
type FlightLoad {
  carrierId     : String(3);
  connectionId  : String(4);
  flightDate    : Date;
  departureTime : Time;
  arrivalTime   : Time;
  seatsMax      : Integer;
  seatsBooked   : Integer;
  seatsFree     : Integer;
  cancelled     : Boolean; // the disrupted flight
  highlighted   : Integer; // cancelled flight: active bookings still on it; others: bookings this disruption's plans moved here
}

/** Which booking system the app talks to, and the flight the demo scenario is built around. */
type DemoInfo {
  backend      : String(4); // abap or mock
  carrierId    : String(3);
  connectionId : String(4);
  flightDate   : Date;
}

/** What the app answers ABAP for a cancelled flight. `duplicate`: the flight already had an open disruption. */
type EventResult {
  disruption : UUID;
  duplicate  : Boolean;
}
