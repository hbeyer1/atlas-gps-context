import type { PinholeCamera } from "./common";
import { createIntrinsicsFromFov } from "./common";
import * as THREE from "three";

export type CameraView = {
  id: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fovRadians: number;
};

export type SampledCameraView = Omit<CameraView, "id">;
export type DrawPoint = [number, number];
export type TrajectoryPoint = [number, number, number];
export type TrajectoryDrawingView = {
  right: TrajectoryPoint;
  up: TrajectoryPoint;
  forward: TrajectoryPoint;
};
export type TrajectorySegment = {
  id: string;
  points: TrajectoryPoint[];
};
export type TrajectorySpace = {
  center: TrajectoryPoint;
  radius: number;
};

export const TRAJECTORY_FLOOR_Y = 0;
const MAX_POINTS_PER_DRAWN_PART = 5;
const DRAW_POINT_SPACING = 0.18;

export function trajectoryPathFromSegments(
  segments: readonly TrajectorySegment[],
): TrajectoryPoint[] {
  const path: TrajectoryPoint[] = [];
  for (const segment of segments) {
    for (const point of segment.points) {
      const previous = path.at(-1);
      if (!previous || !sameTrajectoryPoint(point, previous)) {
        path.push(point);
      }
    }
  }
  return path;
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
  if (Math.abs(view.up[1]) < 1e-4) return null;

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
    const previous = new THREE.Vector3(...path[Math.max(0, index - 1)]!);
    const next = new THREE.Vector3(
      ...path[Math.min(path.length - 1, index + 1)]!,
    );
    const direction = next.sub(previous);
    if (direction.lengthSq() < 1e-8) {
      direction
        .set(0, 0, -1)
        .applyQuaternion(new THREE.Quaternion(...reference.quaternion));
    }
    const target = new THREE.Vector3(...position).add(direction);
    return cameraViewLookingAt(
      `drawn-frame-${index + 1}`,
      position,
      target.toArray(),
      reference.fovRadians,
    );
  });
}

/** Sample a smooth path with each moving camera facing along the spline. */
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
  const hasMovement = curve.getLength() > 1e-5;
  const quaternions = views.map((view) =>
    new THREE.Quaternion(...view.quaternion).normalize(),
  );
  const segmentCount = views.length - 1;
  let previousQuaternion = quaternions[0]!.clone();

  return Array.from({ length: frameCount }, (_, index) => {
    const progress = frameCount === 1 ? 0 : index / (frameCount - 1);
    const curveProgress = hasMovement
      ? curve.getUtoTmapping(progress, 0)
      : progress;
    const position =
      index === 0
        ? new THREE.Vector3(...floorSafePosition(views[0]!.position))
        : index === frameCount - 1
          ? new THREE.Vector3(...floorSafePosition(views.at(-1)!.position))
          : floorSafeCurvePoint(curve, curveProgress);
    const viewProgress = curveProgress * segmentCount;
    const segment = Math.min(Math.floor(viewProgress), segmentCount - 1);
    const amount = THREE.MathUtils.clamp(viewProgress - segment, 0, 1);
    const quaternion = hasMovement
      ? quaternionFacingDirection(
          floorSafeCurveDirection(curve, curveProgress),
          previousQuaternion,
        )
      : new THREE.Quaternion().slerpQuaternions(
          quaternions[segment]!,
          quaternions[segment + 1]!,
          amount,
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
    const fovRadians = THREE.MathUtils.lerp(
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

function floorSafeCurvePoint(
  curve: THREE.CatmullRomCurve3,
  progress: number,
): THREE.Vector3 {
  const point = curve.getPoint(progress);
  point.y = Math.max(TRAJECTORY_FLOOR_Y, point.y);
  return point;
}

function floorSafeCurveDirection(
  curve: THREE.CatmullRomCurve3,
  progress: number,
): THREE.Vector3 {
  const delta = 1e-3;
  const before = floorSafeCurvePoint(curve, Math.max(0, progress - delta));
  const after = floorSafeCurvePoint(curve, Math.min(1, progress + delta));
  const direction = after.sub(before);
  return direction.lengthSq() > 1e-10
    ? direction.normalize()
    : curve.getTangent(progress).normalize();
}

function quaternionFacingDirection(
  direction: THREE.Vector3,
  previous: THREE.Quaternion,
): THREE.Quaternion {
  if (direction.lengthSq() < 1e-10) return previous.clone();
  const forward = direction.clone().normalize();
  const previousUp = new THREE.Vector3(0, 1, 0).applyQuaternion(previous);
  const up = previousUp.addScaledVector(forward, -previousUp.dot(forward));
  if (up.lengthSq() < 1e-8) {
    const previousRight = new THREE.Vector3(1, 0, 0).applyQuaternion(previous);
    up.crossVectors(previousRight, forward);
  }
  if (up.lengthSq() < 1e-8) {
    up.set(
      0,
      Math.abs(forward.y) < 0.99 ? 1 : 0,
      Math.abs(forward.y) < 0.99 ? 0 : 1,
    );
    up.addScaledVector(forward, -up.dot(forward));
  }
  up.normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  up.crossVectors(right, forward).normalize();
  const rotation = new THREE.Matrix4().makeBasis(
    right,
    up,
    forward.clone().negate(),
  );
  return new THREE.Quaternion().setFromRotationMatrix(rotation).normalize();
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
