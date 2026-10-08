using fr from '../../db/schema';
using from '../types';

/** For dispatchers: cancel flights in the booking system, close disruptions, follow plans and what ABAP answered. */
@path: '/odata/v4/control'
@requires: 'Dispatcher'
service ControlService {
  @readonly entity Disruptions as projection on fr.Disruptions;
  @readonly entity Plans       as projection on fr.Plans;
  @readonly entity PlanItems   as projection on fr.PlanItems;

  /** Cancel a flight in the booking system. ABAP then reports it to this app, which opens the disruption and starts the agent. */
  action cancelFlight(carrierId : String(3), connectionId : String(4), flightDate : Date, reason : String(100)) returns fr.Cancellation;
  /** The flight's cancellation in the booking system, with whether ABAP has reported it to this app yet. Changes nothing. */
  function cancellation(carrierId : String(3), connectionId : String(4), flightDate : Date) returns fr.Cancellation;
  /** Close a disruption; its Pending plan is superseded and can no longer be approved. */
  action closeDisruption(disruption : UUID) returns Disruptions;

  /** Every flight of the disruption's route and window with its seats, read from the booking system. Changes nothing. */
  function flightBoard(disruption : UUID) returns many fr.FlightLoad;

  /** Whether the booking system is ABAP or the mock, and the demo scenario's flight. */
  function demoInfo() returns fr.DemoInfo;
  /** For re-recording: reseeds the ABAP demo data (not the mock's) and deletes all disruptions and plans. */
  action resetDemo() returns fr.DemoInfo;

  /** Replay the traffic incident on the demo clock. When the rule fires, a TrafficJam disruption opens and the agent starts. */
  action replayTraffic() returns fr.TrafficReplay;
  /** The replay so far: the demo clock, the samples and reports played, and where the rule fired. Changes nothing. */
  function trafficReplay() returns fr.TrafficReplay;
  /** Pause the running replay (no more samples play) or resume it. Answers once a sample in flight has ended. */
  action pauseReplay(paused : Boolean) returns fr.TrafficReplay;
  /** Play exactly one sample of the paused replay, as the timer would: the firing sample opens the TrafficJam disruption and starts the agent. */
  action stepReplay() returns fr.TrafficReplay;
}
