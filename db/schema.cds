namespace fr;

using { cuid, managed } from '@sap/cds/common';

// What this app owns. Bookings and flights stay in the ABAP system (ZFR_REBOOK); a plan only
// records which booking should move where, and after approval what ABAP answered for each one.

/** A disruption: a flight cancelled in ABAP (EventsService), or a traffic jam on the way to the airport (the replay). */
entity Disruptions : cuid, managed {
  kind         : String(12) enum { Cancellation; TrafficJam } default 'Cancellation';
  // Cancellation: the cancelled flight. Only its bookings move.
  carrierId    : String(3);
  connectionId : String(4);
  flightDate   : Date;
  airportFrom  : String(3);
  airportTo    : String(3);
  reason       : String(200);
  // TrafficJam: when the rule fired on the demo clock (FRA local time, like /DMO/ departure times), the jammed
  // approach (a spike origin: wiesbaden, badhomburg, offenbach, darmstadt), its road and the delay.
  jamDate      : Date;
  jamTime      : Time;
  approach     : String(20);
  road         : String(10);
  delayMinutes : Integer;
  status       : String(10) enum { Open; Closed } default 'Open';
  agentTask    : String(100); // the A2A task the server started for this disruption, owned by the dispatcher
  agentStatus  : String(20) enum { Working; AwaitingApproval; Done; Failed };
  agentMessage : String(500); // why the agent stopped, when it failed
  plans        : Association to many Plans on plans.disruption = $self;
}

/** Simulated for the demo: how a scenario booking's passenger gets to the airport. Only the server reads it; no
 *  service the agent can reach exposes it. `phone`: the booking the `passenger` user stands for. */
entity PassengerContext {
  key travelId  : String(8);
  key bookingId : String(4);
      arrival   : String(10) enum { Car; Train; CheckedIn };
      approach  : String(20); // drivers: the approach they come by
      phone     : Boolean default false;
}

entity Plans : cuid, managed {
  disruption : Association to Disruptions;
  // Offered: a traffic jam's offers were sent; each passenger then answers alone (PlanItems).
  status     : String(20) enum { Pending; Superseded; Applying; Applied; PartiallyApplied; Failed; Offered } default 'Pending';
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
  // Offered: waiting for the passenger; Accepting: their answer is being applied in ABAP.
  status           : String(10) enum { Planned; Offered; Accepting; Rebooked; Failed } default 'Planned';
  message          : String(500);
}
