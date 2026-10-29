import { BaseEdge, EdgeText } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';

/** Shared presentation only: returning edges carry no editing or execution actions. */
export function ReturnEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps) {
  const laneY = typeof data?.laneY === 'number' ? data.laneY : Math.min(sourceY, targetY) - 100;
  const path = `M ${sourceX} ${sourceY} H ${sourceX + 10} V ${laneY} H ${targetX - 10} V ${targetY} H ${targetX}`;
  return <><BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} /><EdgeText x={(sourceX + targetX) / 2} y={laneY} label={typeof data?.label === 'string' ? data.label : '返回'} /></>;
}
