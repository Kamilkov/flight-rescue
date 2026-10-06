using fr from '../types';

/** For the passenger's phone (post #3 demo): their offer after a traffic jam, and accepting it. The `passenger` user
 *  stands for the booking marked `phone` in PassengerContext; a real airline app would know its signed-in traveller. */
@path: '/odata/v4/passenger'
@requires: 'Passenger'
service PassengerService {
  /** The latest offer for this passenger's booking, with what happened to it. Changes nothing. */
  function myOffer() returns fr.Offer;
  /** Accept the offer: the booking system moves the booking to the offered flight. */
  action acceptOffer() returns fr.Offer;
}
