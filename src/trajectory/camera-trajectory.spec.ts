import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  appendDrawnTrajectory,
  buildTargetCameras,
  cameraDrawingView,
  cameraPathTarget,
  cameraViewLookingAt,
  cameraViewsFromTrajectory,
  moveTrajectoryPoint,
  projectTrajectoryPoint,
  sampleCameraPath,
  trajectoryFloorBoundary,
  trajectoryPathFromSegments,
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
  it("keeps endpoint positions and faces forward along a moving path", () => {
    const samples = sampleCameraPath([START, END], 9);
    const pathForward = new THREE.Vector3(...END.position)
      .sub(new THREE.Vector3(...START.position))
      .normalize();

    expect(samples).toHaveLength(9);
    expect(samples[0]?.position).toEqual(START.position);
    expect(samples[0]?.fovRadians).toBe(START.fovRadians);
    expect(samples.at(-1)?.position).toEqual(END.position);
    expect(samples.at(-1)?.fovRadians).toBe(END.fovRadians);
    for (const sample of [samples[0]!, samples.at(-1)!]) {
      const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        new THREE.Quaternion(...sample.quaternion),
      );
      expect(cameraForward.dot(pathForward)).toBeCloseTo(1);
    }
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

  it("faces every sampled camera along a curved spline", () => {
    const views = cameraViewsFromTrajectory(
      [
        [0, 1, 0],
        [0.2, 1.5, -3],
        [7, 2, -2],
        [8, 4, 5],
      ],
      START,
    );
    const samples = sampleCameraPath(views, 51);

    for (let index = 0; index < samples.length; index += 1) {
      const previous = new THREE.Vector3(
        ...samples[Math.max(0, index - 1)]!.position,
      );
      const next = new THREE.Vector3(
        ...samples[Math.min(samples.length - 1, index + 1)]!.position,
      );
      const pathForward = next.sub(previous).normalize();
      const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        new THREE.Quaternion(...samples[index]!.quaternion),
      );
      expect(cameraForward.dot(pathForward)).toBeGreaterThan(0.995);
    }
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
  radius: 10,
};
const FRONT_VIEW = cameraDrawingView([0, 0, 0, 1]);
const TURNED_VIEW = cameraDrawingView(
  new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(-Math.PI / 6, Math.PI / 4, 0))
    .toArray(),
);

describe("3D drawn camera paths", () => {
  it("moves a shared part endpoint without splitting the path", () => {
    const parts = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
        ],
      },
    ] satisfies { id: string; points: [number, number, number][] }[];

    const moved = moveTrajectoryPoint(parts, "one", 1, [1, 3, -2]);

    expect(moved[0]?.points.at(-1)).toEqual([1, 3, -2]);
    expect(moved[1]?.points[0]).toEqual([1, 3, -2]);
    expect(trajectoryPathFromSegments(moved)).toEqual([
      [0, 1, 0],
      [1, 3, -2],
      [2, 1, 0],
    ]);
    expect(parts[0]?.points.at(-1)).toEqual([1, 1, 0]);
  });

  it("does not move an unrelated part across a deleted-path gap", () => {
    const parts = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "three",
        points: [
          [2, 1, 0],
          [3, 1, 0],
        ],
      },
    ] satisfies { id: string; points: [number, number, number][] }[];

    const moved = moveTrajectoryPoint(parts, "one", 1, [1, 3, -2]);

    expect(moved[0]?.points.at(-1)).toEqual([1, 3, -2]);
    expect(moved[1]?.points[0]).toEqual([2, 1, 0]);
  });

  it("keeps downstream anchors when an earlier path part is deleted", () => {
    const parts = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
        ],
      },
      {
        id: "three",
        points: [
          [2, 1, 0],
          [3, 1, 0],
        ],
      },
    ] satisfies { id: string; points: [number, number, number][] }[];

    expect(trajectoryPathFromSegments(parts.slice(1))).toEqual([
      [1, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ]);
    expect(
      trajectoryPathFromSegments(parts.filter((part) => part.id !== "two")),
    ).toEqual([
      [0, 1, 0],
      [1, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ]);
  });

  it("projects a point using the main camera angle", () => {
    const point: [number, number, number] = [5, 4, -2];

    expect(projectTrajectoryPoint(point, FRONT_VIEW, SPACE)).toEqual([
      0.75, 0.3,
    ]);
    expect(projectTrajectoryPoint(point, TURNED_VIEW, SPACE)).not.toEqual([
      0.75, 0.3,
    ]);
  });

  it("round-trips a point through an arbitrary drawing angle", () => {
    const point: [number, number, number] = [5, 4, -2];
    const roundTrip = unprojectTrajectoryPoint(
      projectTrajectoryPoint(point, TURNED_VIEW, SPACE),
      TURNED_VIEW,
      SPACE,
      point,
    );

    expect(roundTrip[0]).toBeCloseTo(point[0]);
    expect(roundTrip[1]).toBeCloseTo(point[1]);
    expect(roundTrip[2]).toBeCloseTo(point[2]);
  });

  it("preserves depth when a stroke continues from a rotated main view", () => {
    const existing: [number, number, number][] = [[4, 2, -6]];
    const continued = appendDrawnTrajectory(
      existing,
      [projectTrajectoryPoint(existing[0]!, TURNED_VIEW, SPACE), [0.8, 0.2]],
      TURNED_VIEW,
      SPACE,
      START.position,
    );
    const forward = new THREE.Vector3(...TURNED_VIEW.forward);

    expect(new THREE.Vector3(...continued.at(-1)!).dot(forward)).toBeCloseTo(
      new THREE.Vector3(...existing[0]!).dot(forward),
    );
  });

  it("lets the first drawn point differ from the reference camera", () => {
    const path = appendDrawnTrajectory(
      [],
      [
        [0, 0],
        [1, 1],
      ],
      FRONT_VIEW,
      SPACE,
      START.position,
    );

    expect(path[0]).toEqual([-10, 10, 4]);
    expect(path[0]).not.toEqual(START.position);
  });

  it("keeps earlier points when the main camera rotates between strokes", () => {
    const firstPath = appendDrawnTrajectory(
      [],
      [
        [0.5, 0.5],
        [0.6, 0.4],
      ],
      FRONT_VIEW,
      SPACE,
      START.position,
    );
    const finalPath = appendDrawnTrajectory(
      firstPath,
      [
        projectTrajectoryPoint(firstPath.at(-1)!, TURNED_VIEW, SPACE),
        [0.7, 0.3],
      ],
      TURNED_VIEW,
      SPACE,
      START.position,
    );

    expect(finalPath.slice(0, firstPath.length)).toEqual(firstPath);
  });

  it("clamps vertical drawing and spline output to the floor", () => {
    expect(
      unprojectTrajectoryPoint([0.5, 1], FRONT_VIEW, SPACE, START.position)[1],
    ).toBe(0);
    expect(trajectoryFloorBoundary(FRONT_VIEW, SPACE, START.position)).toEqual([
      [0, 0.5],
      [1, 0.5],
    ]);
    const turnedBoundary = trajectoryFloorBoundary(
      TURNED_VIEW,
      SPACE,
      START.position,
    )!;
    for (const point of turnedBoundary) {
      expect(
        unprojectTrajectoryPoint(point, TURNED_VIEW, SPACE, START.position)[1],
      ).toBeCloseTo(0);
    }
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
    const path: [number, number, number][] = [
      [-10, 2, -10],
      [0, 5, 0],
      [10, 3, 10],
    ];
    const views = cameraViewsFromTrajectory(path, START);

    expect(views).toHaveLength(3);
    expect(views[0]?.position).toEqual([-10, 2, -10]);
    expect(views.at(-1)?.position).toEqual([10, 3, 10]);
    const firstForward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(...views[0]!.quaternion),
    );
    const routeForward = new THREE.Vector3(...path[1]!)
      .sub(new THREE.Vector3(...path[0]!))
      .normalize();
    expect(firstForward.dot(routeForward)).toBeCloseTo(1);
  });

  it("derives the drawing plane from the main camera quaternion", () => {
    expect(cameraDrawingView(START.quaternion)).toEqual({
      right: [1, 0, 0],
      up: [0, 1, 0],
      forward: [0, 0, -1],
    });
  });

  it("ignores a trajectory with only one point", () => {
    expect(cameraViewsFromTrajectory([[0, 1, 0]], START)).toEqual([]);
  });
});
