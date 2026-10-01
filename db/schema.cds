namespace fr;

using { cuid, managed } from '@sap/cds/common';

// What this app owns. Bookings and flights stay in the ABAP system (ZFR_REBOOK); a plan only
// records which booking should move where, and after approval what ABAP answered for each one.

/** A flight a dispatcher declared cancelled in this app. ABAP is not told; only its bookings move. */
entity Disruptions : cuid, managed {
  carrierId    : String(3)  @mandatory;
  connectionId : String(4)  @mandatory;
  flightDate   : Date       @mandatory;
  airportFrom  : String(3);
  airportTo    : String(3);
  reason       : String(200);
  status       : String(10) enum { Open; Closed } default 'Open';
  plans        : Association to many Plans on plans.disruption = $self;
}

entity Plans : cuid, managed {
  disruption : Association to Disruptions;
  status     : String(20) enum { Pending; Superseded; Applying; Applied; PartiallyApplied; Failed } default 'Pending';
  rationale  : String(1000);
  agentTask  : String(100); // the A2A task that proposed it; only that task can request its approval
  appliedBy  : String(255);
  appliedAt  : Timestamp;
  items      : Composition of many PlanItems on items.plan = $self;
}

entity PlanItems : cuid {
  plan             : Association to Plans;
  travelId         : String(8);
  bookingId        : String(4);
  fromCarrierId    : String(3);
  fromConnectionId : String(4);
  fromFlightDate   : Date;
  toCarrierId      : String(3);
  toConnectionId   : String(4);
  toFlightDate     : Date;
  status           : String(10) enum { Planned; Rebooked; Failed } default 'Planned';
  message          : String(500);
}
