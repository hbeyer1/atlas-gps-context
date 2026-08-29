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
export type TrajectoryProjection = "top" | "front" | "side";
export type TrajectorySpace = {
  center: TrajectoryPoint;
  right: TrajectoryPoint;
  forward: TrajectoryPoint;
  horizontalRadius: number;
  maximumHeight: number;
};

export const TRAJECTORY_FLOOR_Y = 0;
export const TRAJECTORY_FLOOR_SCREEN_Y = 0.86;

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

export function cameraMapAxes(reference: CameraView): {
  right: [number, number, number];
  forward: [number, number, number];
} {
  const quaternion = new THREE.Quaternion(...reference.quaternion);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  forward.y = 0;
  if (forward.lengthSq() < 1e-5) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  right.y = 0;
  right.normalize();
  return { right: right.toArray(), forward: forward.toArray() };
}

export function projectTrajectoryPoint(
  point: TrajectoryPoint,
  projection: TrajectoryProjection,
  space: TrajectorySpace,
): DrawPoint {
  const offset = new THREE.Vector3(...point).sub(new THREE.Vector3(...space.center));
  const rightOffset = offset.dot(new THREE.Vector3(...space.right));
  const forwardOffset = offset.dot(new THREE.Vector3(...space.forward));
  if (projection === "top") {
    return [
      0.5 + rightOffset / (space.horizontalRadius * 2),
      0.5 - forwardOffset / (space.horizontalRadius * 2),
    ];
  }

  const horizontalOffset = projection === "front" ? rightOffset : forwardOffset;
  return [
    0.5 + horizontalOffset / (space.horizontalRadius * 2),
    TRAJECTORY_FLOOR_SCREEN_Y -
      ((point[1] - TRAJECTORY_FLOOR_Y) / space.maximumHeight) *
        TRAJECTORY_FLOOR_SCREEN_Y,
  ];
}

export function unprojectTrajectoryPoint(
  point: DrawPoint,
  projection: TrajectoryProjection,
  space: TrajectorySpace,
  anchor: TrajectoryPoint,
): TrajectoryPoint {
  const right = new THREE.Vector3(...space.right);
  const forward = new THREE.Vector3(...space.forward);
  const anchorOffset = new THREE.Vector3(...anchor).sub(new THREE.Vector3(...space.center));
  let rightOffset = anchorOffset.dot(right);
  let forwardOffset = anchorOffset.dot(forward);
  let height = Math.max(TRAJECTORY_FLOOR_Y, anchor[1]);

  if (projection === "top") {
    rightOffset = (point[0] - 0.5) * space.horizontalRadius * 2;
    forwardOffset = (0.5 - point[1]) * space.horizontalRadius * 2;
  } else {
    const horizontalOffset = (point[0] - 0.5) * space.horizontalRadius * 2;
    height = Math.max(
      TRAJECTORY_FLOOR_Y,
      TRAJECTORY_FLOOR_Y +
        ((TRAJECTORY_FLOOR_SCREEN_Y - point[1]) /
          TRAJECTORY_FLOOR_SCREEN_Y) *
          space.maximumHeight,
    );
    if (projection === "front") rightOffset = horizontalOffset;
    else forwardOffset = horizontalOffset;
  }

  return new THREE.Vector3(space.center[0], height, space.center[2])
    .addScaledVector(right, rightOffset)
    .addScaledVector(forward, forwardOffset)
    .toArray();
}

export function appendDrawnTrajectory(
  existing: readonly TrajectoryPoint[],
  stroke: readonly DrawPoint[],
  projection: TrajectoryProjection,
  space: TrajectorySpace,
  referencePosition: TrajectoryPoint,
): TrajectoryPoint[] {
  if (stroke.length < 2) return [...existing];
  const anchor = existing.at(-1) ?? referencePosition;
  const newPoints = stroke
    .slice(existing.length > 0 ? 1 : 0)
    .map((point) => unprojectTrajectoryPoint(point, projection, space, anchor));
  const path = [...existing];
  for (const point of newPoints) {
    const previous = path.at(-1);
    if (
      !previous ||
      new THREE.Vector3(...point).distanceTo(new THREE.Vector3(...previous)) > 1e-5
    ) {
      path.push(point);
    }
  }
  return path;
}

export function cameraViewsFromTrajectory(
  path: readonly TrajectoryPoint[],
  reference: CameraView,
  groundTarget: [number, number, number],
): CameraView[] {
  if (path.length < 2) return [];

  const target = cameraPathTarget(reference, groundTarget);

  return path.map((point, index) => {
    const position: TrajectoryPoint = [
      point[0],
      Math.max(TRAJECTORY_FLOOR_Y, point[1]),
      point[2],
    ];
    return cameraViewLookingAt(
      `drawn-frame-${index + 1}`,
      position,
      target,
      reference.fovRadians,
    );
  });
}

/** Sample a smooth path that preserves each captured camera's orientation. */
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
  const quaternions = views.map((view) => new THREE.Quaternion(...view.quaternion).normalize());
  const segmentCount = views.length - 1;

  return Array.from({ length: frameCount }, (_, index) => {
    if (index === 0 || frameCount === 1) {
      const start = views[0]!;
      return {
        position: floorSafePosition(start.position),
        quaternion: [...start.quaternion],
        fovRadians: start.fovRadians,
      };
    }
    if (index === frameCount - 1) {
      const end = views.at(-1)!;
      return {
        position: floorSafePosition(end.position),
        quaternion: [...end.quaternion],
        fovRadians: end.fovRadians,
      };
    }

    const progress = index / (frameCount - 1);
    const curveProgress = hasMovement ? curve.getUtoTmapping(progress, 0) : progress;
    const position = curve.getPoint(curveProgress);
    position.y = Math.max(TRAJECTORY_FLOOR_Y, position.y);
    const viewProgress = curveProgress * segmentCount;
    const segment = Math.min(Math.floor(viewProgress), segmentCount - 1);
    const amount = THREE.MathUtils.clamp(viewProgress - segment, 0, 1);
    const quaternion = new THREE.Quaternion().slerpQuaternions(
      quaternions[segment]!,
      quaternions[segment + 1]!,
      amount,
    );
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

function floorSafePosition(
  position: readonly [number, number, number],
): TrajectoryPoint {
  return [
    position[0],
    Math.max(TRAJECTORY_FLOOR_Y, position[1]),
    position[2],
  ];
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
