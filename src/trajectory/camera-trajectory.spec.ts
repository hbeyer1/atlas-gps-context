import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  appendDrawnTrajectory,
  buildTargetCameras,
  cameraMapAxes,
  cameraPathTarget,
  cameraViewLookingAt,
  cameraViewsFromTrajectory,
  projectTrajectoryPoint,
  sampleCameraPath,
  unprojectTrajectoryPoint,
  type CameraView,
  type TrajectorySpace,
} from "./camera-trajectory";

const START: CameraView = {
  id: "start",
  position: [0, 1, 4],
  quaternion: [0, 0, 0, 1],
  fovRadians: Math.PI / 3,
};

const END: CameraView = {
  id: "end",
  position: [4, 2, 0],
  quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  fovRadians: Math.PI / 2,
};

describe("sampleCameraPath", () => {
  it("keeps the captured endpoint poses", () => {
    const samples = sampleCameraPath([START, END], 9);

    expect(samples).toHaveLength(9);
    expect(samples[0]).toEqual({
      position: START.position,
      quaternion: START.quaternion,
      fovRadians: START.fovRadians,
    });
    expect(samples.at(-1)).toEqual({
      position: END.position,
      quaternion: END.quaternion,
      fovRadians: END.fovRadians,
    });
  });

  it("returns no path until two views have been captured", () => {
    expect(sampleCameraPath([START], 16)).toEqual([]);
  });

  it("smoothly rotates between views captured at the same position", () => {
    const turnInPlace: CameraView = {
      ...END,
      position: START.position,
    };

    const samples = sampleCameraPath([START, turnInPlace], 5);

    expect(samples.map((sample) => sample.position)).toEqual(
      Array.from({ length: 5 }, () => START.position),
    );
    expect(samples[1]?.quaternion[1]).toBeCloseTo(Math.sin(Math.PI / 16));
    expect(samples[2]?.quaternion[1]).toBeCloseTo(Math.sin(Math.PI / 8));
    expect(samples[3]?.quaternion[1]).toBeCloseTo(Math.sin((3 * Math.PI) / 16));
  });
});

describe("buildTargetCameras", () => {
  it("uses 720p output intrinsics and Three.js camera coordinates", () => {
    const cameras = buildTargetCameras([START, END], 2, 1280, 720);

    expect(cameras[0]?.intrinsics).toMatchObject({ width: 1280, height: 720 });
    expect(cameras[0]?.extrinsics.coordinateSystem).toBe("rub");
    expect(cameras[1]?.extrinsics.position).toEqual(END.position);
  });
});

describe("click-to-place camera points", () => {
  it("aims a placed camera at the subject", () => {
    const view = cameraViewLookingAt(
      "point-2",
      [4, 1, 0],
      [0, 1, 0],
      Math.PI / 3,
    );
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...view.quaternion),
    );

    expect(forward.x).toBeCloseTo(-1);
    expect(forward.y).toBeCloseTo(0);
    expect(forward.z).toBeCloseTo(0);
  });

  it("keeps the initial camera pitch when choosing the shared subject target", () => {
    const pitchedStart: CameraView = {
      ...START,
      quaternion: new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(Math.PI / 4, 0, 0))
        .toArray(),
    };

    expect(cameraPathTarget(pitchedStart, [0, 0, 0])[1]).toBeCloseTo(5);
  });
});

const SPACE: TrajectorySpace = {
  center: [0, 0, 0],
  right: [1, 0, 0],
  forward: [0, 0, -1],
  horizontalRadius: 10,
  maximumHeight: 10,
};

describe("3D drawn camera paths", () => {
  it("projects the same endpoint into the top, front, and side views", () => {
    const point: [number, number, number] = [5, 4, -2];

    expect(projectTrajectoryPoint(point, "top", SPACE)).toEqual([0.75, 0.4]);
    expect(projectTrajectoryPoint(point, "front", SPACE)).toEqual([
      0.75,
      0.516,
    ]);
    expect(projectTrajectoryPoint(point, "side", SPACE)).toEqual([
      0.6,
      0.516,
    ]);
  });

  it("round-trips a point through every fixed drawing view", () => {
    const point: [number, number, number] = [5, 4, -2];

    for (const projection of ["top", "front", "side"] as const) {
      const roundTrip = unprojectTrajectoryPoint(
        projectTrajectoryPoint(point, projection, SPACE),
        projection,
        SPACE,
        point,
      );
      expect(roundTrip[0]).toBeCloseTo(point[0]);
      expect(roundTrip[1]).toBeCloseTo(point[1]);
      expect(roundTrip[2]).toBeCloseTo(point[2]);
    }
  });

  it("preserves the hidden coordinate when a stroke continues in another view", () => {
    const existing: [number, number, number][] = [[4, 2, -6]];
    const continued = appendDrawnTrajectory(
      existing,
      [
        projectTrajectoryPoint(existing[0]!, "front", SPACE),
        [0.8, 0.2],
      ],
      "front",
      SPACE,
      START.position,
    );

    expect(continued.at(-1)?.[0]).toBeCloseTo(6);
    expect(continued.at(-1)?.[1]).toBeCloseTo(7.6744186);
    expect(continued.at(-1)?.[2]).toBeCloseTo(-6);
  });

  it("lets the first drawn point differ from the reference camera", () => {
    const path = appendDrawnTrajectory(
      [],
      [
        [0, 0],
        [1, 1],
      ],
      "top",
      SPACE,
      START.position,
    );

    expect(path[0]).toEqual([-10, 1, -10]);
    expect(path[0]).not.toEqual(START.position);
  });

  it("keeps raised height when drawing top, front, then top again", () => {
    const topPath = appendDrawnTrajectory(
      [],
      [
        [0.5, 0.5],
        [0.6, 0.4],
      ],
      "top",
      SPACE,
      START.position,
    );
    const raisedPath = appendDrawnTrajectory(
      topPath,
      [
        projectTrajectoryPoint(topPath.at(-1)!, "front", SPACE),
        [0.7, 0.3],
      ],
      "front",
      SPACE,
      START.position,
    );
    const finalPath = appendDrawnTrajectory(
      raisedPath,
      [
        projectTrajectoryPoint(raisedPath.at(-1)!, "top", SPACE),
        [0.8, 0.2],
      ],
      "top",
      SPACE,
      START.position,
    );

    expect(finalPath.slice(0, topPath.length)).toEqual(topPath);
    expect(finalPath.at(-1)?.[1]).toBeCloseTo(raisedPath.at(-1)![1]);
  });

  it("clamps vertical drawing and spline output to the floor", () => {
    expect(unprojectTrajectoryPoint([0.5, 1], "front", SPACE, START.position)[1]).toBe(0);
    const samples = sampleCameraPath(
      [
        { ...START, position: [0, 1, 0] },
        { ...START, position: [1, 0, 0] },
        { ...START, position: [2, 0, 0] },
        { ...END, position: [3, 1, 0] },
      ],
      101,
    );
    expect(samples.every((sample) => sample.position[1] >= 0)).toBe(true);
  });

  it("turns a multi-view trajectory into spline control cameras", () => {
    const views = cameraViewsFromTrajectory(
      [
        [-10, 2, -10],
        [0, 5, 0],
        [10, 3, 10],
      ],
      START,
      [0, 0, 0],
    );

    expect(views).toHaveLength(3);
    expect(views[0]?.position).toEqual([-10, 2, -10]);
    expect(views.at(-1)?.position).toEqual([10, 3, 10]);
  });

  it("orients the 2D map to the reference camera", () => {
    expect(cameraMapAxes(START)).toEqual({
      right: [1, 0, 0],
      forward: [0, 0, -1],
    });
  });

  it("ignores a trajectory with only one point", () => {
    expect(cameraViewsFromTrajectory([[0, 1, 0]], START, [0, 0, 0])).toEqual([]);
  });
});
