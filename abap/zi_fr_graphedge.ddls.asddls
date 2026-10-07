@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Flight rescue: routing graph edges'
@Metadata.ignorePropagatedAnnotations: true
// D: DEP:<from> -> 1:<flight>, cost 10 x its arrival. C: a leg-n flight -> a leg-n+1 flight at the same airport,
// leaving 90 min to 12 h after the first lands, cost 10 x the arrival difference + 1. A: any leg -> ARR:<to>, cost 0.
// A path from DEP: to ARR: costs 10 x its arrival + its connections: the arrival decides, connections break ties.
// LegFrom and LegTo are the airports of the flight the edge leads to (blank for A): the search drops connections onto a
// flight that leaves the destination or lands at the origin. DepSec is when that flight leaves (for A, the flight left).
define view entity ZI_FR_GraphEdge
  as select from ZI_FR_GraphFlight as f
{
  key cast( concat_with_space( concat( 'DEP:', f.AirportFrom ), concat( '1:', f.FlightKey ), 1 ) as abap.char( 45 ) ) as EdgeId,
      cast( concat( 'DEP:', f.AirportFrom ) as abap.char( 20 ) )                                                as SourceId,
      cast( concat( '1:', f.FlightKey ) as abap.char( 20 ) )                                                    as TargetId,
      cast( 'D' as abap.char( 1 ) )                                                                             as EdgeKind,
      cast( 10 * f.ArrSec as abap.int8 )                                                                        as Cost,
      f.DepSec                                                                                                  as DepSec,
      cast( f.AirportFrom as abap.char( 3 ) )                                                                   as LegFrom,
      cast( f.AirportTo as abap.char( 3 ) )                                                                     as LegTo
}
union all
  select from ZI_FR_GraphFlight as p
    inner join ZI_FR_GraphFlight as n on  n.AirportFrom = p.AirportTo
                                      and (    n.FlightDate = p.ArrivalDate
                                            or n.FlightDate = p.ArrivalDateNext )
{
  key cast( concat_with_space( concat( '1:', p.FlightKey ), concat( '2:', n.FlightKey ), 1 ) as abap.char( 45 ) ) as EdgeId,
      cast( concat( '1:', p.FlightKey ) as abap.char( 20 ) )                                                    as SourceId,
      cast( concat( '2:', n.FlightKey ) as abap.char( 20 ) )                                                    as TargetId,
      cast( 'C' as abap.char( 1 ) )                                                                             as EdgeKind,
      cast( 10 * case when n.ArrSec > p.ArrSec then n.ArrSec - p.ArrSec else cast( 0 as abap.int8 ) end + 1 as abap.int8 ) as Cost,
      n.DepSec                                                                                                  as DepSec,
      cast( n.AirportFrom as abap.char( 3 ) )                                                                   as LegFrom,
      cast( n.AirportTo as abap.char( 3 ) )                                                                     as LegTo
}
where n.DepSec >= p.ArrSec + 5400
  and n.DepSec <= p.ArrSec + 43200
union all
  select from ZI_FR_GraphFlight as p
    inner join ZI_FR_GraphFlight as n on  n.AirportFrom = p.AirportTo
                                      and (    n.FlightDate = p.ArrivalDate
                                            or n.FlightDate = p.ArrivalDateNext )
{
  key cast( concat_with_space( concat( '2:', p.FlightKey ), concat( '3:', n.FlightKey ), 1 ) as abap.char( 45 ) ) as EdgeId,
      cast( concat( '2:', p.FlightKey ) as abap.char( 20 ) )                                                    as SourceId,
      cast( concat( '3:', n.FlightKey ) as abap.char( 20 ) )                                                    as TargetId,
      cast( 'C' as abap.char( 1 ) )                                                                             as EdgeKind,
      cast( 10 * case when n.ArrSec > p.ArrSec then n.ArrSec - p.ArrSec else cast( 0 as abap.int8 ) end + 1 as abap.int8 ) as Cost,
      n.DepSec                                                                                                  as DepSec,
      cast( n.AirportFrom as abap.char( 3 ) )                                                                   as LegFrom,
      cast( n.AirportTo as abap.char( 3 ) )                                                                     as LegTo
}
where n.DepSec >= p.ArrSec + 5400
  and n.DepSec <= p.ArrSec + 43200
union all
  select from ZI_FR_GraphFlight as f
{
  key cast( concat_with_space( concat( '1:', f.FlightKey ), concat( 'ARR:', f.AirportTo ), 1 ) as abap.char( 45 ) ) as EdgeId,
      cast( concat( '1:', f.FlightKey ) as abap.char( 20 ) )                                                    as SourceId,
      cast( concat( 'ARR:', f.AirportTo ) as abap.char( 20 ) )                                                  as TargetId,
      cast( 'A' as abap.char( 1 ) )                                                                             as EdgeKind,
      cast( 0 as abap.int8 )                                                                                    as Cost,
      f.DepSec                                                                                                  as DepSec,
      cast( ' ' as abap.char( 3 ) )                                                                             as LegFrom,
      cast( ' ' as abap.char( 3 ) )                                                                             as LegTo
}
union all
  select from ZI_FR_GraphFlight as f
{
  key cast( concat_with_space( concat( '2:', f.FlightKey ), concat( 'ARR:', f.AirportTo ), 1 ) as abap.char( 45 ) ) as EdgeId,
      cast( concat( '2:', f.FlightKey ) as abap.char( 20 ) )                                                    as SourceId,
      cast( concat( 'ARR:', f.AirportTo ) as abap.char( 20 ) )                                                  as TargetId,
      cast( 'A' as abap.char( 1 ) )                                                                             as EdgeKind,
      cast( 0 as abap.int8 )                                                                                    as Cost,
      f.DepSec                                                                                                  as DepSec,
      cast( ' ' as abap.char( 3 ) )                                                                             as LegFrom,
      cast( ' ' as abap.char( 3 ) )                                                                             as LegTo
}
union all
  select from ZI_FR_GraphFlight as f
{
  key cast( concat_with_space( concat( '3:', f.FlightKey ), concat( 'ARR:', f.AirportTo ), 1 ) as abap.char( 45 ) ) as EdgeId,
      cast( concat( '3:', f.FlightKey ) as abap.char( 20 ) )                                                    as SourceId,
      cast( concat( 'ARR:', f.AirportTo ) as abap.char( 20 ) )                                                  as TargetId,
      cast( 'A' as abap.char( 1 ) )                                                                             as EdgeKind,
      cast( 0 as abap.int8 )                                                                                    as Cost,
      f.DepSec                                                                                                  as DepSec,
      cast( ' ' as abap.char( 3 ) )                                                                             as LegFrom,
      cast( ' ' as abap.char( 3 ) )                                                                             as LegTo
}
