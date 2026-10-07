@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Flight rescue: routing graph vertices'
@Metadata.ignorePropagatedAnnotations: true
// Every flight once per leg number it can have in an itinerary (1:, 2:, 3:), and per airport a DEP: source and an ARR:
// sink. A path from DEP: to ARR: is an itinerary of one to three flights.
define view entity ZI_FR_GraphVertex
  as select from ZI_FR_GraphFlight
{
  key cast( concat( '1:', FlightKey ) as abap.char( 20 ) ) as VertexId
}
union all
  select from ZI_FR_GraphFlight
{
  key cast( concat( '2:', FlightKey ) as abap.char( 20 ) ) as VertexId
}
union all
  select from ZI_FR_GraphFlight
{
  key cast( concat( '3:', FlightKey ) as abap.char( 20 ) ) as VertexId
}
union all
  select from /dmo/airport
{
  key cast( concat( 'DEP:', airport_id ) as abap.char( 20 ) ) as VertexId
}
union all
  select from /dmo/airport
{
  key cast( concat( 'ARR:', airport_id ) as abap.char( 20 ) ) as VertexId
}
