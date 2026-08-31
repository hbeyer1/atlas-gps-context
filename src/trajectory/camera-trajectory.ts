import type { PinholeCamera } from "./common";
import { createIntrinsicsFromFov } from "./common";
import * as THREE from "three";

export type CameraView = {
  id: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fovRadians: number;
  angleKey?: boolean;
};

export type SampledCameraView = Omit<CameraView, "angleKey" | "id">;
export type DrawPoint = [number, number];
export type TrajectoryPoint = [number, number, number];
export type TrajectoryQuaternion = [number, number, number, number];
export type TrajectoryDrawingView = {
  right: TrajectoryPoint;
  up: TrajectoryPoint;
  forward: TrajectoryPoint;
};
export type TrajectorySegment = {
  id: string;
  points: TrajectoryPoint[];
  quaternions?: (TrajectoryQuaternion | null)[] | null;
};
export type TrajectoryPivot = {
  segmentId: string;
  pointIndex: number;
  pivotNumber: number;
  position: TrajectoryPoint;
  hasCameraAngle: boolean;
};
export type TrajectorySpace = {
  center: TrajectoryPoint;
  radius: number;
};

export const TRAJECTORY_FLOOR_Y = 0;
export const MAX_PIVOTS_PER_PART = 12;
const MAX_POINTS_PER_DRAWN_PART = 5;
const DRAW_POINT_SPACING = 0.18;

export function trajectoryPathFromSegments(
  segments: readonly TrajectorySegment[],
): TrajectoryPoint[] {
  return trajectoryPathEntries(segments).map((entry) => entry.point);
}

export function trajectoryPivotsFromSegments(
  segments: readonly TrajectorySegment[],
): TrajectoryPivot[] {
  return trajectoryPathEntries(segments).map((entry, index) => ({
    segmentId: segments[entry.segmentIndex]!.id,
    pointIndex: entry.pointIndex,
    pivotNumber: index + 1,
    position: entry.point,
    hasCameraAngle: Boolean(entry.quaternion),
  }));
}

type TrajectoryPathEntry = {
  point: TrajectoryPoint;
  quaternion: TrajectoryQuaternion | null;
  segmentIndex: number;
  pointIndex: number;
};

function trajectoryPathEntries(
  segments: readonly TrajectorySegment[],
): TrajectoryPathEntry[] {
  const entries: TrajectoryPathEntry[] = [];
  segments.forEach((segment, segmentIndex) => {
    segment.points.forEach((point, pointIndex) => {
      const quaternion = segment.quaternions?.[pointIndex] ?? null;
      const previous = entries.at(-1);
      if (previous && sameTrajectoryPoint(point, previous.point)) {
        if (!previous.quaternion && quaternion)
          previous.quaternion = quaternion;
        return;
      }
      entries.push({ point, quaternion, segmentIndex, pointIndex });
    });
  });
  return entries;
}

export function moveTrajectoryPoint(
  segments: readonly TrajectorySegment[],
  segmentId: string,
  pointIndex: number,
  position: TrajectoryPoint,
): TrajectorySegment[] {
  const segmentIndex = segments.findIndex(
    (segment) => segment.id === segmentId,
  );
  const segment = segments[segmentIndex]!;
  const previousPosition = segment.points[pointIndex]!;

  return segments.map((current, currentIndex) => {
    const points = [...current.points];
    let changed = false;
    if (currentIndex === segmentIndex) {
      points[pointIndex] = position;
      changed = true;
    }
    if (
      currentIndex === segmentIndex - 1 &&
      pointIndex === 0 &&
      sameTrajectoryPoint(points.at(-1)!, previousPosition)
    ) {
      points[points.length - 1] = position;
      changed = true;
    }
    if (
      currentIndex === segmentIndex + 1 &&
      pointIndex === segment.points.length - 1 &&
      sameTrajectoryPoint(points[0]!, previousPosition)
    ) {
      points[0] = position;
      changed = true;
    }
    return changed ? { ...current, points } : current;
  });
}

export function deleteTrajectoryPivot(
  segments: readonly TrajectorySegment[],
  segmentId: string,
  pointIndex: number,
): TrajectorySegment[] | null {
  if (trajectoryPathEntries(segments).length <= 2) return null;

  const segmentIndex = segments.findIndex(
    (segment) => segment.id === segmentId,
  );
  const segment = segments[segmentIndex];
  const position = segment?.points[pointIndex];
  if (!segment || !position) return null;

  const storedPoints = segments.flatMap((current, currentIndex) =>
    current.points.map((point, currentPointIndex) => ({
      point,
      segmentIndex: currentIndex,
      pointIndex: currentPointIndex,
    })),
  );
  const selectedIndex = storedPoints.findIndex(
    (entry) =>
      entry.segmentIndex === segmentIndex && entry.pointIndex === pointIndex,
  );
  let firstDuplicate = selectedIndex;
  let lastDuplicate = selectedIndex;
  while (
    firstDuplicate > 0 &&
    sameTrajectoryPoint(storedPoints[firstDuplicate - 1]!.point, position)
  ) {
    firstDuplicate -= 1;
  }
  while (
    lastDuplicate < storedPoints.length - 1 &&
    sameTrajectoryPoint(storedPoints[lastDuplicate + 1]!.point, position)
  ) {
    lastDuplicate += 1;
  }

  const removedIndexes = new Map<number, Set<number>>();
  storedPoints.slice(firstDuplicate, lastDuplicate + 1).forEach((entry) => {
    const indexes = removedIndexes.get(entry.segmentIndex) ?? new Set();
    indexes.add(entry.pointIndex);
    removedIndexes.set(entry.segmentIndex, indexes);
  });

  return segments.flatMap((current, currentIndex) => {
    const indexes = removedIndexes.get(currentIndex);
    if (!indexes) return [current];
    const points = current.points.filter((_, index) => !indexes.has(index));
    if (points.length === 0) return [];
    const quaternions = current.quaternions
      ? current.quaternions.filter((_, index) => !indexes.has(index))
      : current.quaternions;
    return [{ ...current, points, quaternions }];
  });
}

export function setTrajectoryPointQuaternion(
  segments: readonly TrajectorySegment[],
  segmentId: string,
  pointIndex: number,
  quaternion: TrajectoryQuaternion,
): TrajectorySegment[] {
  const segmentIndex = segments.findIndex(
    (segment) => segment.id === segmentId,
  );
  const segment = segments[segmentIndex]!;
  const position = segment.points[pointIndex]!;
  const normalized = new THREE.Quaternion(...quaternion).normalize().toArray();

  return segments.map((current, currentIndex) => {
    let quaternionIndex: number | null = null;
    if (currentIndex === segmentIndex) quaternionIndex = pointIndex;
    if (
      currentIndex === segmentIndex - 1 &&
      pointIndex === 0 &&
      sameTrajectoryPoint(current.points.at(-1)!, position)
    ) {
      quaternionIndex = current.points.length - 1;
    }
    if (
      currentIndex === segmentIndex + 1 &&
      pointIndex === segment.points.length - 1 &&
      sameTrajectoryPoint(current.points[0]!, position)
    ) {
      quaternionIndex = 0;
    }
    if (quaternionIndex === null) return current;

    const quaternions = current.points.map(
      (_, index) => current.quaternions?.[index] ?? null,
    );
    quaternions[quaternionIndex] = normalized;
    return { ...current, quaternions };
  });
}

export function insertTrajectoryPivot(
  segments: readonly TrajectorySegment[],
  position: TrajectoryPoint,
  curveProgress: number,
): {
  segments: TrajectorySegment[];
  segmentId: string;
  pointIndex: number;
  pivotNumber: number;
} | null {
  const entries = trajectoryPathEntries(segments);
  const path = entries.map((entry) => entry.point);
  if (path.length < 2) return null;
  const clampedCurveProgress = THREE.MathUtils.clamp(curveProgress, 0, 1);
  const spanIndex = Math.min(
    Math.floor(clampedCurveProgress * (path.length - 1)),
    path.length - 2,
  );
  const owner = entries[spanIndex + 1];
  if (!owner) return null;
  const segment = segments[owner.segmentIndex]!;
  if (segment.points.length >= MAX_PIVOTS_PER_PART) return null;
  const nextPosition: TrajectoryPoint = [
    position[0],
    Math.max(TRAJECTORY_FLOOR_Y, position[1]),
    position[2],
  ];
  const pointIndex = owner.pointIndex;
  if (
    sameTrajectoryPoint(nextPosition, path[spanIndex]!) ||
    sameTrajectoryPoint(nextPosition, path[spanIndex + 1]!)
  ) {
    return null;
  }
  const nextSegments = segments.map((current, index) => {
    if (index !== owner.segmentIndex) return current;
    const quaternions = current.quaternions
      ? [
          ...current.quaternions.slice(0, pointIndex),
          null,
          ...current.quaternions.slice(pointIndex),
        ]
      : current.quaternions;
    return {
      ...current,
      points: [
        ...current.points.slice(0, pointIndex),
        nextPosition,
        ...current.points.slice(pointIndex),
      ],
      quaternions,
    };
  });
  return {
    segments: nextSegments,
    segmentId: segment.id,
    pointIndex,
    pivotNumber: spanIndex + 2,
  };
}

function sameTrajectoryPoint(
  first: TrajectoryPoint,
  second: TrajectoryPoint,
): boolean {
  return (
    new THREE.Vector3(...first).distanceTo(new THREE.Vector3(...second)) <= 1e-5
  );
}

export function cameraViewLookingAt(
  id: string,
  position: [number, number, number],
  target: [number, number, number],
  fovRadians: number,
): CameraView {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(...position);
  camera.lookAt(new THREE.Vector3(...target));
  return {
    id,
    position,
    quaternion: camera.quaternion.toArray(),
    fovRadians,
  };
}

export function cameraPathTarget(
  start: CameraView,
  groundTarget: [number, number, number],
): [number, number, number] {
  const position = new THREE.Vector3(...start.position);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion(...start.quaternion),
  );
  const horizontalForward = Math.hypot(forward.x, forward.z);
  const horizontalDistance = Math.hypot(
    groundTarget[0] - start.position[0],
    groundTarget[2] - start.position[2],
  );
  const targetY =
    horizontalForward > 1e-5
      ? position.y + (forward.y * horizontalDistance) / horizontalForward
      : position.y;
  return [groundTarget[0], targetY, groundTarget[2]];
}

export function cameraDrawingView(
  quaternion: readonly [number, number, number, number],
): TrajectoryDrawingView {
  const rotation = new THREE.Quaternion(...quaternion).normalize();
  return {
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).toArray(),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).toArray(),
    forward: new THREE.Vector3(0, 0, -1).applyQuaternion(rotation).toArray(),
  };
}

export function frameTrajectorySpaceAboveFloor(
  space: TrajectorySpace,
  view: TrajectoryDrawingView,
  anchor: TrajectoryPoint,
): TrajectorySpace {
  const [anchorX, anchorY] = projectTrajectoryPoint(anchor, view, space);
  const anchoredSpace =
    anchorX >= 0 && anchorX <= 1 && anchorY >= 0 && anchorY <= 1
      ? space
      : { ...space, center: [...anchor] as TrajectoryPoint };
  const boundary = trajectoryFloorBoundary(view, anchoredSpace, anchor);
  if (!boundary) return anchoredSpace;

  const floorFacesDown = view.up[1] >= 0;
  const currentEdge = floorFacesDown
    ? Math.max(boundary[0][1], boundary[1][1])
    : Math.min(boundary[0][1], boundary[1][1]);
  const targetEdge = floorFacesDown ? 0.94 : 0.06;
  const [, anchoredAnchorY] = projectTrajectoryPoint(
    anchor,
    view,
    anchoredSpace,
  );
  const screenShift = THREE.MathUtils.clamp(
    targetEdge - currentEdge,
    0.06 - anchoredAnchorY,
    0.94 - anchoredAnchorY,
  );
  const shift = screenShift * anchoredSpace.radius * 2;
  const center = new THREE.Vector3(...anchoredSpace.center).addScaledVector(
    new THREE.Vector3(...view.up),
    shift,
  );
  return { center: center.toArray(), radius: anchoredSpace.radius };
}

export function projectTrajectoryPoint(
  point: TrajectoryPoint,
  view: TrajectoryDrawingView,
  space: TrajectorySpace,
): DrawPoint {
  const offset = new THREE.Vector3(...point).sub(
    new THREE.Vector3(...space.center),
  );
  return [
    0.5 + offset.dot(new THREE.Vector3(...view.right)) / (space.radius * 2),
    0.5 - offset.dot(new THREE.Vector3(...view.up)) / (space.radius * 2),
  ];
}

export function unprojectTrajectoryPoint(
  point: DrawPoint,
  view: TrajectoryDrawingView,
  space: TrajectorySpace,
  anchor: TrajectoryPoint,
): TrajectoryPoint {
  const right = new THREE.Vector3(...view.right);
  const up = new THREE.Vector3(...view.up);
  const forward = new THREE.Vector3(...view.forward);
  const anchorOffset = new THREE.Vector3(...anchor).sub(
    new THREE.Vector3(...space.center),
  );
  const position = new THREE.Vector3(...space.center)
    .addScaledVector(right, (point[0] - 0.5) * space.radius * 2)
    .addScaledVector(up, (0.5 - point[1]) * space.radius * 2)
    .addScaledVector(forward, anchorOffset.dot(forward));
  position.y = Math.max(TRAJECTORY_FLOOR_Y, position.y);
  return position.toArray();
}

export function trajectoryFloorBoundary(
  view: TrajectoryDrawingView,
  space: TrajectorySpace,
  anchor: TrajectoryPoint,
): [DrawPoint, DrawPoint] | null {
  if (Math.abs(view.up[1]) < 0.1) return null;

  const center = new THREE.Vector3(...space.center);
  const forward = new THREE.Vector3(...view.forward);
  const depth = new THREE.Vector3(...anchor).sub(center).dot(forward);
  const boundaryPoint = (x: number): DrawPoint => {
    const rightOffset = (x - 0.5) * space.radius * 2;
    const upOffset =
      -(
        space.center[1] +
        view.right[1] * rightOffset +
        view.forward[1] * depth
      ) / view.up[1];
    return [x, 0.5 - upOffset / (space.radius * 2)];
  };
  return [boundaryPoint(0), boundaryPoint(1)];
}

export function appendDrawnTrajectory(
  existing: readonly TrajectoryPoint[],
  stroke: readonly DrawPoint[],
  view: TrajectoryDrawingView,
  space: TrajectorySpace,
  referencePosition: TrajectoryPoint,
): TrajectoryPoint[] {
  if (stroke.length < 2) return [...existing];
  const anchor = existing.at(-1) ?? referencePosition;
  const newPoints = resampleDrawStroke(stroke)
    .slice(existing.length > 0 ? 1 : 0)
    .map((point) => unprojectTrajectoryPoint(point, view, space, anchor));
  const path = [...existing];
  for (const point of newPoints) {
    const previous = path.at(-1);
    if (!previous || !sameTrajectoryPoint(point, previous)) {
      path.push(point);
    }
  }
  return path;
}

function resampleDrawStroke(stroke: readonly DrawPoint[]): DrawPoint[] {
  const distances = [0];
  for (let index = 1; index < stroke.length; index++) {
    const previous = stroke[index - 1]!;
    const current = stroke[index]!;
    distances.push(
      distances[index - 1]! +
        Math.hypot(current[0] - previous[0], current[1] - previous[1]),
    );
  }

  const totalDistance = distances.at(-1)!;
  const pointCount = Math.min(
    MAX_POINTS_PER_DRAWN_PART,
    Math.max(2, Math.ceil(totalDistance / DRAW_POINT_SPACING) + 1),
  );
  if (stroke.length <= pointCount || totalDistance < 1e-6) return [...stroke];

  let segmentIndex = 1;
  return Array.from({ length: pointCount }, (_, index) => {
    const targetDistance = (totalDistance * index) / (pointCount - 1);
    while (
      segmentIndex < distances.length - 1 &&
      distances[segmentIndex]! < targetDistance
    ) {
      segmentIndex += 1;
    }
    const startDistance = distances[segmentIndex - 1]!;
    const endDistance = distances[segmentIndex]!;
    const amount =
      endDistance === startDistance
        ? 0
        : (targetDistance - startDistance) / (endDistance - startDistance);
    const start = stroke[segmentIndex - 1]!;
    const end = stroke[segmentIndex]!;
    return [
      THREE.MathUtils.lerp(start[0], end[0], amount),
      THREE.MathUtils.lerp(start[1], end[1], amount),
    ];
  });
}

export function cameraViewsFromTrajectory(
  path: readonly TrajectoryPoint[],
  reference: CameraView,
): CameraView[] {
  if (path.length < 2) return [];

  return path.map((point, index) => {
    const position: TrajectoryPoint = [
      point[0],
      Math.max(TRAJECTORY_FLOOR_Y, point[1]),
      point[2],
    ];
    return {
      id: `drawn-frame-${index + 1}`,
      position,
      quaternion: reference.quaternion,
      fovRadians: reference.fovRadians,
    };
  });
}

export function cameraViewsFromSegments(
  segments: readonly TrajectorySegment[],
  reference: CameraView,
): CameraView[] {
  const entries = trajectoryPathEntries(segments);
  return cameraViewsFromTrajectory(
    entries.map((entry) => entry.point),
    reference,
  ).map((view, index) => ({
    ...view,
    quaternion: entries[index]!.quaternion ?? reference.quaternion,
    angleKey: Boolean(entries[index]!.quaternion),
  }));
}

export function cameraQuaternionAtView(
  views: readonly CameraView[],
  viewIndex: number,
): TrajectoryQuaternion {
  if (views.length === 0) return [0, 0, 0, 1];
  if (views.length === 1) return views[0]!.quaternion;

  const { quaternions, progresses } = cameraOrientationKeys(views);
  const index = THREE.MathUtils.clamp(viewIndex, 0, views.length - 1);
  return quaternionAtProgress(
    quaternions,
    progresses,
    index / (views.length - 1),
  ).toArray();
}

export function cameraAimDegrees(quaternion: TrajectoryQuaternion): {
  yaw: number;
  pitch: number;
} {
  const euler = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion(...quaternion).normalize(),
    "YXZ",
  );
  return {
    yaw:
      THREE.MathUtils.euclideanModulo(
        -THREE.MathUtils.radToDeg(euler.y) + 180,
        360,
      ) - 180,
    pitch: THREE.MathUtils.radToDeg(euler.x),
  };
}

export function cameraQuaternionFromAim(
  yaw: number,
  pitch: number,
): TrajectoryQuaternion {
  return new THREE.Quaternion()
    .setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pitch, -89, 89)),
        THREE.MathUtils.degToRad(-yaw),
        0,
        "YXZ",
      ),
    )
    .normalize()
    .toArray();
}

export function projectCameraPreviewPoints(
  points: readonly TrajectoryPoint[],
  view: CameraView,
  aspectRatio = 16 / 9,
): { x: number; y: number; depth: number; pointIndex: number }[] {
  const cameraPosition = new THREE.Vector3(...view.position);
  const worldToCamera = new THREE.Quaternion(...view.quaternion)
    .normalize()
    .invert();
  const halfHeightAtUnitDepth = Math.tan(view.fovRadians / 2);
  const local = new THREE.Vector3();
  const projected: {
    x: number;
    y: number;
    depth: number;
    pointIndex: number;
  }[] = [];

  for (const [pointIndex, point] of points.entries()) {
    local
      .set(...point)
      .sub(cameraPosition)
      .applyQuaternion(worldToCamera);
    const depth = -local.z;
    if (depth <= 0.01) continue;
    const x = 0.5 + local.x / (2 * depth * halfHeightAtUnitDepth * aspectRatio);
    const y = 0.5 - local.y / (2 * depth * halfHeightAtUnitDepth);
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    projected.push({ x, y, depth, pointIndex });
  }
  return projected;
}

/** Sample a smooth path using the manually chosen camera angles. */
export function sampleCameraPath(
  views: readonly CameraView[],
  frameCount: number,
): SampledCameraView[] {
  if (views.length < 2 || frameCount < 1) return [];

  const curve = new THREE.CatmullRomCurve3(
    views.map((view) => new THREE.Vector3(...floorSafePosition(view.position))),
    false,
    "centripetal",
  );
  const { quaternions, progresses } = cameraOrientationKeys(views);
  const segmentCount = views.length - 1;
  const constantFovRadians = views.every(
    (view) => view.fovRadians === views[0]!.fovRadians,
  )
    ? views[0]!.fovRadians
    : null;
  let previousQuaternion = quaternions[0]!.clone();

  return Array.from({ length: frameCount }, (_, index) => {
    const curveProgress = cameraPathProgressAtFrame(
      index,
      frameCount,
      views.length,
    );
    const position =
      index === 0
        ? new THREE.Vector3(...floorSafePosition(views[0]!.position))
        : index === frameCount - 1
          ? new THREE.Vector3(...floorSafePosition(views.at(-1)!.position))
          : floorSafeCurvePoint(curve, curveProgress);
    const viewProgress = curveProgress * segmentCount;
    const segment = Math.min(Math.floor(viewProgress), segmentCount - 1);
    const amount = THREE.MathUtils.clamp(viewProgress - segment, 0, 1);
    const quaternion = quaternionAtProgress(
      quaternions,
      progresses,
      curveProgress,
    );
    if (previousQuaternion.dot(quaternion) < 0) {
      quaternion.set(
        -quaternion.x,
        -quaternion.y,
        -quaternion.z,
        -quaternion.w,
      );
    }
    previousQuaternion = quaternion;
    const fovRadians =
      constantFovRadians ??
      THREE.MathUtils.lerp(
        views[segment]!.fovRadians,
        views[segment + 1]!.fovRadians,
        amount,
      );

    return {
      position: position.toArray(),
      quaternion: quaternion.toArray(),
      fovRadians,
    };
  });
}

export function cameraPathProgressAtFrame(
  frameIndex: number,
  frameCount: number,
  viewCount: number,
): number {
  if (frameCount <= 1 || viewCount <= 1) return 0;

  const lastFrame = frameCount - 1;
  const index = THREE.MathUtils.clamp(frameIndex, 0, lastFrame);
  const segmentCount = viewCount - 1;
  if (lastFrame < segmentCount) return index / lastFrame;

  let segment = 0;
  let segmentEnd = Math.round(lastFrame / segmentCount);
  while (segment < segmentCount - 1 && index > segmentEnd) {
    segment += 1;
    segmentEnd = Math.round(((segment + 1) * lastFrame) / segmentCount);
  }
  const segmentStart = Math.round((segment * lastFrame) / segmentCount);
  const amount = (index - segmentStart) / (segmentEnd - segmentStart);
  return (segment + amount) / segmentCount;
}

function cameraOrientationKeys(views: readonly CameraView[]): {
  quaternions: THREE.Quaternion[];
  progresses: number[];
} {
  const explicitKeyIndices = views.flatMap((view, index) =>
    view.angleKey ? [index] : [],
  );
  const keyIndices =
    explicitKeyIndices.length > 0
      ? explicitKeyIndices
      : views.map((_, index) => index);
  const quaternions = keyIndices.map((index) =>
    new THREE.Quaternion(...views[index]!.quaternion).normalize(),
  );
  for (let index = 1; index < quaternions.length; index += 1) {
    const previous = quaternions[index - 1]!;
    const current = quaternions[index]!;
    if (previous.dot(current) < 0) {
      current.set(-current.x, -current.y, -current.z, -current.w);
    }
  }
  return {
    quaternions,
    progresses: keyIndices.map((index) => index / (views.length - 1)),
  };
}

function quaternionAtProgress(
  quaternions: readonly THREE.Quaternion[],
  progresses: readonly number[],
  progress: number,
): THREE.Quaternion {
  if (quaternions.length === 1 || progress <= progresses[0]!) {
    return quaternions[0]!.clone();
  }
  const lastIndex = quaternions.length - 1;
  if (progress >= progresses[lastIndex]!) {
    return quaternions[lastIndex]!.clone();
  }

  const endIndex = progresses.findIndex((value) => value >= progress);
  const startProgress = progresses[endIndex - 1]!;
  const endProgress = progresses[endIndex]!;
  const amount =
    endProgress - startProgress > 1e-8
      ? (progress - startProgress) / (endProgress - startProgress)
      : 0;
  return new THREE.Quaternion().slerpQuaternions(
    quaternions[endIndex - 1]!,
    quaternions[endIndex]!,
    amount,
  );
}

function floorSafeCurvePoint(
  curve: THREE.CatmullRomCurve3,
  progress: number,
): THREE.Vector3 {
  const point = curve.getPoint(progress);
  point.y = Math.max(TRAJECTORY_FLOOR_Y, point.y);
  return point;
}

function floorSafePosition(
  position: readonly [number, number, number],
): TrajectoryPoint {
  return [position[0], Math.max(TRAJECTORY_FLOOR_Y, position[1]), position[2]];
}

export function buildTargetCameras(
  views: readonly CameraView[],
  frameCount: number,
  width: number,
  height: number,
): PinholeCamera[] {
  return sampleCameraPath(views, frameCount).map((view) => ({
    intrinsics: createIntrinsicsFromFov(
      THREE.MathUtils.radToDeg(view.fovRadians),
      width,
      height,
    ),
    extrinsics: {
      position: view.position,
      quaternion: view.quaternion,
      coordinateSystem: "rub",
    },
  }));
}
