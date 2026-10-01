using fr from '../../db/schema';
using from '../types';

/** For dispatchers: declare and close disruptions, and follow plans and what ABAP answered. */
@path: '/odata/v4/control'
@requires: 'Dispatcher'
service ControlService {
  @readonly entity Disruptions as projection on fr.Disruptions;
  @readonly entity Plans       as projection on fr.Plans;
  @readonly entity PlanItems   as projection on fr.PlanItems;

  /** Declare a flight cancelled in this app. The flight must exist in ABAP; its bookings are not touched. */
  action declareDisruption(carrierId : String(3), connectionId : String(4), flightDate : Date, reason : String(200)) returns Disruptions;
  /** Close a disruption; its Pending plan is superseded and can no longer be approved. */
  action closeDisruption(disruption : UUID) returns Disruptions;

  /** Every flight of the disruption's route and window with its seats, read from the booking system. Changes nothing. */
  function flightBoard(disruption : UUID) returns many fr.FlightLoad;

  /** Whether the booking system is ABAP or the mock, and the demo scenario's flight. */
  function demoInfo() returns fr.DemoInfo;
  /** For re-recording: reseeds the ABAP demo data (not the mock's) and deletes all disruptions and plans. */
  action resetDemo() returns fr.DemoInfo;
}
