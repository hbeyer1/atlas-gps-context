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

const DRAWN_CONTROL_POINTS = 6;

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

export function cameraViewsFromDrawnPath(
  stroke: readonly DrawPoint[],
  reference: CameraView,
  groundTarget: [number, number, number],
  radius: number,
): CameraView[] {
  const points = sampleDrawnPath(stroke, DRAWN_CONTROL_POINTS);
  if (points.length < 2) return [];

  const target = cameraPathTarget(reference, groundTarget);
  const { right, forward } = cameraMapAxes(reference);
  const rightVector = new THREE.Vector3(...right);
  const forwardVector = new THREE.Vector3(...forward);

  return points.map(([x, y], index) => {
    const position = new THREE.Vector3(groundTarget[0], reference.position[1], groundTarget[2])
      .addScaledVector(rightVector, (x - 0.5) * radius * 2)
      .addScaledVector(forwardVector, (0.5 - y) * radius * 2);
    return cameraViewLookingAt(
      `drawn-frame-${index + 1}`,
      position.toArray(),
      target,
      reference.fovRadians,
    );
  });
}

function sampleDrawnPath(stroke: readonly DrawPoint[], count: number): DrawPoint[] {
  if (stroke.length < 2) return [];

  const distances = [0];
  for (let index = 1; index < stroke.length; index++) {
    const previous = stroke[index - 1]!;
    const current = stroke[index]!;
    distances.push(distances[index - 1]! + Math.hypot(current[0] - previous[0], current[1] - previous[1]));
  }
  const total = distances.at(-1)!;
  if (total < 0.02) return [];

  return Array.from({ length: count }, (_, sampleIndex) => {
    const wanted = (sampleIndex / (count - 1)) * total;
    let segment = 1;
    while (segment < distances.length - 1 && distances[segment]! < wanted) segment++;
    const startDistance = distances[segment - 1]!;
    const segmentDistance = distances[segment]! - startDistance;
    const amount = segmentDistance > 0 ? (wanted - startDistance) / segmentDistance : 0;
    const start = stroke[segment - 1]!;
    const end = stroke[segment]!;
    return [THREE.MathUtils.lerp(start[0], end[0], amount), THREE.MathUtils.lerp(start[1], end[1], amount)];
  });
}

/** Sample a smooth path that preserves each captured camera's orientation. */
export function sampleCameraPath(
  views: readonly CameraView[],
  frameCount: number,
): SampledCameraView[] {
  if (views.length < 2 || frameCount < 1) return [];

  const curve = new THREE.CatmullRomCurve3(
    views.map((view) => new THREE.Vector3(...view.position)),
    false,
    "centripetal",
  );
  const quaternions = views.map((view) => new THREE.Quaternion(...view.quaternion).normalize());
  const segmentCount = views.length - 1;

  return Array.from({ length: frameCount }, (_, index) => {
    if (index === 0 || frameCount === 1) {
      const start = views[0]!;
      return {
        position: [...start.position],
        quaternion: [...start.quaternion],
        fovRadians: start.fovRadians,
      };
    }
    if (index === frameCount - 1) {
      const end = views.at(-1)!;
      return {
        position: [...end.position],
        quaternion: [...end.quaternion],
        fovRadians: end.fovRadians,
      };
    }

    const progress = index / (frameCount - 1);
    const position = curve.getPoint(progress);
    const viewProgress = progress * segmentCount;
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
