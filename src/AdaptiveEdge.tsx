import {
  BaseEdge,
  useInternalNode,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import type { GraphEdge, GraphNode } from "./types";
import { useGraphActions } from "./nodes/context";

type Point = { x: number; y: number };
type Axis = "x" | "y";

const CORNER_RADIUS = 14;
const MIN_BEND_LEG = CORNER_RADIUS * 2;

const laneFor = (id: string) => Math.abs([...id].reduce(
  (hash, char) => (hash * 31 + char.charCodeAt(0)) | 0,
  0,
) % 3);

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

function bend(before: Point, corner: Point, after: Point) {
  const radius = Math.min(distance(before, corner) / 2, distance(corner, after) / 2, CORNER_RADIUS);
  if ((before.x === corner.x && corner.x === after.x) || (before.y === corner.y && corner.y === after.y)) {
    return `L${corner.x} ${corner.y}`;
  }
  if (before.y === corner.y) {
    const entryX = corner.x + radius * (before.x < after.x ? -1 : 1);
    const exitY = corner.y + radius * (before.y < after.y ? 1 : -1);
    return `L${entryX} ${corner.y}Q${corner.x} ${corner.y} ${corner.x} ${exitY}`;
  }
  const entryY = corner.y + radius * (before.y < after.y ? -1 : 1);
  const exitX = corner.x + radius * (before.x < after.x ? 1 : -1);
  return `L${corner.x} ${entryY}Q${corner.x} ${corner.y} ${exitX} ${corner.y}`;
}

function roundedPath(rawPoints: Point[]) {
  const points = rawPoints.filter((point, index) => index === 0
    || point.x !== rawPoints[index - 1].x
    || point.y !== rawPoints[index - 1].y);
  if (points.length < 2) return "";
  let path = `M${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    path += bend(points[index - 1], points[index], points[index + 1]);
  }
  return `${path}L${points.at(-1)!.x} ${points.at(-1)!.y}`;
}

function moveSegment(points: Point[], index: number, position: Point) {
  const before = points[index];
  const after = points[index + 1];
  const horizontal = Math.abs(after.x - before.x) >= Math.abs(after.y - before.y);
  return points.map((point, pointIndex) => {
    if (pointIndex !== index && pointIndex !== index + 1) return { ...point };
    return horizontal ? { ...point, y: position.y } : { ...point, x: position.x };
  });
}

/** Rounded orthogonal edges with a perpendicular drag handle on every movable interior segment. */
export function AdaptiveEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
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
  data,
  selected,
}: EdgeProps<GraphEdge>) {
  const { screenToFlowPosition } = useReactFlow<GraphNode, GraphEdge>();
  const { updateEdgeRoute } = useGraphActions();
  const sourceNode = useInternalNode<GraphNode>(source);
  const targetNode = useInternalNode<GraphNode>(target);
  const backward = sourceX >= targetX;
  const route = data?.route;
  const legacyControl = data?.control;
  const sourceTop = sourceNode?.internals.positionAbsolute.y ?? sourceY;
  const targetTop = targetNode?.internals.positionAbsolute.y ?? targetY;
  const sourceBottom = sourceTop + (sourceNode?.measured.height ?? 0);
  const targetBottom = targetTop + (targetNode?.measured.height ?? 0);
  const loopAbove = sourceY < targetY;
  const offset = backward ? Math.min(128, 64 + (sourceX - targetX) * 0.08) : 32;
  const clearance = 48 + laneFor(id) * 16;
  const automaticLoopY = loopAbove
    ? Math.min(sourceTop, targetTop) - clearance
    : Math.max(sourceBottom, targetBottom) + clearance;
  const loopBoundary = loopAbove
    ? Math.min(sourceTop, targetTop) - MIN_BEND_LEG
    : Math.max(sourceBottom, targetBottom) + MIN_BEND_LEG;

  let points: Point[];

  if (route?.waypoints?.length) {
    const waypoints = route.waypoints.map((point) => ({ ...point }));
    // Node handles in this graph sit on the left/right sides; keep the terminal runs attached
    // when a connected node moves without disturbing the user's remaining route.
    waypoints[0].y = sourceY;
    waypoints[waypoints.length - 1].y = targetY;
    points = [{ x: sourceX, y: sourceY }, ...waypoints, { x: targetX, y: targetY }];
  } else if (backward || route?.mode === "dogleg") {
    const sourceLaneX = backward
      ? Math.max(sourceX + MIN_BEND_LEG, route?.sourceLaneX ?? sourceX + offset)
      : clamp(route?.sourceLaneX ?? sourceX + offset, sourceX + MIN_BEND_LEG, targetX - MIN_BEND_LEG * 2);
    const targetLaneX = backward
      ? Math.min(targetX - MIN_BEND_LEG, route?.targetLaneX ?? targetX - offset)
      : clamp(route?.targetLaneX ?? targetX - offset, sourceLaneX + MIN_BEND_LEG, targetX - MIN_BEND_LEG);
    const requestedCenterY = route?.centerY ?? legacyControl?.y ?? (backward ? automaticLoopY : (sourceY + targetY) / 2);
    const centerY = backward
      ? (loopAbove ? Math.min(requestedCenterY, loopBoundary) : Math.max(requestedCenterY, loopBoundary))
      : requestedCenterY;

    points = [
      { x: sourceX, y: sourceY },
      { x: sourceLaneX, y: sourceY },
      { x: sourceLaneX, y: centerY },
      { x: targetLaneX, y: centerY },
      { x: targetLaneX, y: targetY },
      { x: targetX, y: targetY },
    ];

  } else {
    const minimum = sourceX + offset + MIN_BEND_LEG;
    const maximum = targetX - offset - MIN_BEND_LEG;
    const centerX = minimum <= maximum
      ? clamp(route?.centerX ?? legacyControl?.x ?? (sourceX + targetX) / 2, minimum, maximum)
      : (sourceX + targetX) / 2;
    points = [
      { x: sourceX, y: sourceY },
      { x: centerX, y: sourceY },
      { x: centerX, y: targetY },
      { x: targetX, y: targetY },
    ];
  }

  const controls: Array<{
    key: string;
    x: number;
    y: number;
    axis: Axis;
    update: (position: Point) => void;
  }> = points.slice(0, -1).flatMap((before, index) => {
    const after = points[index + 1];
    if (index === 0 || index === points.length - 2 || distance(before, after) < 0.01) return [];
    const horizontal = Math.abs(after.x - before.x) >= Math.abs(after.y - before.y);
    return [{
      key: `segment-${index}`,
      x: (before.x + after.x) / 2,
      y: (before.y + after.y) / 2,
      axis: (horizontal ? "y" : "x") as Axis,
      update: (position: Point) => {
        const moved = moveSegment(points, index, position);
        updateEdgeRoute(id, { waypoints: moved.slice(1, -1) });
      },
    }];
  });

  const edgePath = roundedPath(points);
  const labelControl = controls[Math.floor(controls.length / 2)] ?? {
    x: (sourceX + targetX) / 2,
    y: (sourceY + targetY) / 2,
  };

  const startControlDrag = (
    event: React.PointerEvent<SVGCircleElement>,
    update: (position: Point) => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      update(screenToFlowPosition({ x: pointerEvent.clientX, y: pointerEvent.clientY }));
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return <>
    <BaseEdge
      id={id}
      path={edgePath}
      labelX={labelControl.x}
      labelY={labelControl.y}
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
    />
    {selected && controls.map((control) => <g key={control.key}>
      <circle className={`edge-control-hit axis-${control.axis} nodrag nopan`}
        cx={control.x} cy={control.y} r={14}
        onPointerDown={(event) => startControlDrag(event, control.update)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          updateEdgeRoute(id, undefined);
        }} />
      <circle className="edge-control" cx={control.x} cy={control.y} r={5} />
    </g>)}
  </>;
}
