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
    kind         : String(12);
    flight       : String;
    carrierId    : String(3);
    connectionId : String(4);
    flightDate   : Date;
    airportFrom  : String(3);
    airportTo    : String(3);
    reason       : String;
    jamDate      : Date;
    jamTime      : Time;
    road         : String(10);
    delayMinutes : Integer;
  };
  /** Each affected booking with its own flight: the cancelled flight, or for a jam the flight it may miss. */
  affectedBookings : many {
    travelId     : String(8);
    bookingId    : String(4);
    carrierId    : String(3);
    connectionId : String(4);
    flightDate   : Date;
  };
  /** forFlight: the affected flight ("LH 0400 2026-10-20") this alternative is for. */
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
    forFlight      : String;
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

/** What sending a traffic jam's offers did: the plan and its items are Offered; nothing changed in ABAP. */
type OfferResult {
  plan    : UUID;
  status  : String;
  offered : Integer;
  message : String;
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
  affected      : Boolean; // a traffic jam's flight, which its passengers at risk may miss
  held          : Integer; // offered seats not answered yet
  highlighted   : Integer; // cancelled flight: active bookings still on it; jam's flight: bookings at risk; others: bookings moved here
}

/** Which booking system the app talks to, the flight the cancellation demo is built around, and the traffic scenario's flight. */
type DemoInfo {
  backend       : String(4); // abap or mock
  carrierId     : String(3);
  connectionId  : String(4);
  flightDate    : Date;
  trafficFlight : {
    carrierId    : String(3);
    connectionId : String(4);
    flightDate   : Date;
  };
}

/** What the app answers ABAP for a cancelled flight. `duplicate`: the flight already had an open disruption. */
type EventResult {
  disruption : UUID;
  duplicate  : Boolean;
}

/** A flight cancelled in the booking system. notifyStatus: empty until ABAP reported it here, S reported, F failed. */
type Cancellation {
  carrierId     : String(3);
  connectionId  : String(4);
  flightDate    : Date;
  reason        : String(100);
  notifyStatus  : String(1);
  notifyMessage : String(200);
}

/** The traffic replay so far, on the demo clock (FRA local time, 'YYYY-MM-DDTHH:MM:SS'). note: "No jam detected" when
 *  the replay ended without the rule firing. */
type TrafficReplay {
  running    : Boolean;
  done       : Boolean;
  label      : String;
  clock      : String;
  steps      : Integer; // sample times in the whole replay
  rule       : {
    minDelayMin : Integer;
    runs        : Integer;
  };
  samples    : many {
    clock   : String;
    origin  : String;
    live    : Integer;
    typical : Integer;
  };
  reports    : many {
    clock       : String;
    road        : String;
    location    : String;
    direction   : String;
    delayMin    : Integer;
    trafficType : String;
  };
  fired      : {
    clock    : String;
    origin   : String;
    delayMin : Integer;
  };
  disruption : UUID;
  geo        : {
    lat      : Double;
    lon      : Double;
    geometry : LargeString; // GeoJSON LineString of the jam
  };
  note       : String;
}
