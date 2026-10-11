import {
  BaseEdge,
  getSmoothStepPath,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";
import type { GraphEdge, GraphNode } from "./types";

const laneFor = (id: string) => Math.abs([...id].reduce(
  (hash, char) => (hash * 31 + char.charCodeAt(0)) | 0,
  0,
) % 3);

/** Rounded orthogonal edges, with feedback connections routed outside both node bodies. */
export function AdaptiveEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  style,
  interactionWidth,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps<GraphEdge>) {
  const sourceNode = useInternalNode<GraphNode>(source);
  const targetNode = useInternalNode<GraphNode>(target);
  const backward = sourceX >= targetX;
  let centerY: number | undefined;
  let offset = 32;

  if (backward) {
    const sourceTop = sourceNode?.internals.positionAbsolute.y ?? sourceY;
    const targetTop = targetNode?.internals.positionAbsolute.y ?? targetY;
    const sourceBottom = sourceTop + (sourceNode?.measured.height ?? 0);
    const targetBottom = targetTop + (targetNode?.measured.height ?? 0);
    const clearance = 48 + laneFor(id) * 16;
    centerY = sourceY < targetY
      ? Math.min(sourceTop, targetTop) - clearance
      : Math.max(sourceBottom, targetBottom) + clearance;
    offset = Math.min(128, 64 + (sourceX - targetX) * 0.08);
  }

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    centerY,
    offset,
    borderRadius: 14,
  });

  return <BaseEdge
    id={id}
    path={edgePath}
    labelX={labelX}
    labelY={labelY}
    label={label}
    labelStyle={labelStyle}
    labelShowBg={labelShowBg}
    labelBgStyle={labelBgStyle}
    labelBgPadding={labelBgPadding}
    labelBgBorderRadius={labelBgBorderRadius}
    markerStart={markerStart}
    markerEnd={markerEnd}
    style={style}
    interactionWidth={interactionWidth}
    className={backward ? "adaptive-edge backward" : "adaptive-edge"}
  />;
}
