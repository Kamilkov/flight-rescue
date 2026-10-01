using fr from '../types';

/** For the booking system: ABAP's event handler reports a cancelled flight here (SM59 destination ZFR_CAP_EVENTS). */
@path: '/events'
@protocol: 'rest'
@requires: 'EventSource'
service EventsService {
  /** A flight was cancelled in ABAP. Opens a disruption and starts the rebooking agent for it; a repeat changes nothing. */
  action flightCancelled(carrierId : String(3), connectionId : String(4), flightDate : Date, reason : String(100)) returns fr.EventResult;
}
