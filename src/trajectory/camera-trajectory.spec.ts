import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  appendDrawnTrajectory,
  buildTargetCameras,
  cameraAimDegrees,
  cameraDrawingView,
  cameraPathTarget,
  cameraQuaternionAtView,
  cameraQuaternionFromAim,
  cameraViewLookingAt,
  cameraViewsFromSegments,
  cameraViewsFromTrajectory,
  deleteTrajectoryPivot,
  frameTrajectorySpaceAboveFloor,
  insertTrajectoryPivot,
  MAX_PIVOTS_PER_PART,
  moveTrajectoryPoint,
  projectTrajectoryPoint,
  projectCameraPreviewPoints,
  sampleCameraPath,
  setTrajectoryPointQuaternion,
  trajectoryFloorBoundary,
  trajectoryPathFromSegments,
  trajectoryPivotsFromSegments,
  unprojectTrajectoryPoint,
  type CameraView,
  type TrajectoryDrawingView,
  type TrajectorySegment,
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
  it("keeps endpoint positions and manual endpoint angles", () => {
    const samples = sampleCameraPath([START, END], 9);

    expect(samples).toHaveLength(9);
    expect(samples[0]?.position).toEqual(START.position);
    expect(samples[0]?.fovRadians).toBe(START.fovRadians);
    expect(samples.at(-1)?.position).toEqual(END.position);
    expect(samples.at(-1)?.fovRadians).toBe(END.fovRadians);
    expect(
      Math.abs(
        new THREE.Quaternion(...samples[0]!.quaternion).dot(
          new THREE.Quaternion(...START.quaternion),
        ),
      ),
    ).toBeCloseTo(1);
    expect(
      Math.abs(
        new THREE.Quaternion(...samples.at(-1)!.quaternion).dot(
          new THREE.Quaternion(...END.quaternion),
        ),
      ),
    ).toBeCloseTo(1);
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

  it("smoothly reverses pitch at a manual angle without overshooting", () => {
    const views = [0, 30, 0].map((pitch, index): CameraView => ({
      ...START,
      id: `pitch-${index + 1}`,
      position: [index, 1, 0],
      quaternion: cameraQuaternionFromAim(0, pitch),
      angleKey: true,
    }));

    const pitches = sampleCameraPath(views, 49).map(
      (sample) => cameraAimDegrees(sample.quaternion).pitch,
    );
    const incomingStep = pitches[24]! - pitches[23]!;
    const outgoingStep = pitches[25]! - pitches[24]!;

    expect(pitches[24]).toBeCloseTo(30);
    expect(Math.max(...pitches)).toBeLessThanOrEqual(30 + 1e-8);
    expect(Math.abs(outgoingStep - incomingStep)).toBeLessThan(0.3);
  });

  it("takes the short yaw path through the wraparound boundary", () => {
    const views = [170, -170, 170].map((yaw, index): CameraView => ({
      ...START,
      id: `yaw-${index + 1}`,
      position: [index, 1, 0],
      quaternion: cameraQuaternionFromAim(yaw, 0),
      angleKey: true,
    }));

    const samples = sampleCameraPath(views, 49);
    const largestStep = Math.max(
      ...samples.slice(1).map((sample, index) =>
        THREE.MathUtils.radToDeg(
          new THREE.Quaternion(...samples[index]!.quaternion).angleTo(
            new THREE.Quaternion(...sample.quaternion),
          ),
        ),
      ),
    );

    expect(largestStep).toBeLessThan(2);
    expect(cameraAimDegrees(samples[24]!.quaternion).yaw).toBeCloseTo(-170);
  });

  it("eases into and out of interior manual angle keys", () => {
    const views = [0, 1, 2, 3, 4].map((x, index): CameraView => ({
      ...START,
      id: `interior-angle-${index + 1}`,
      position: [x, 1, 0],
      quaternion:
        index === 3 ? cameraQuaternionFromAim(0, 30) : START.quaternion,
      angleKey: index === 1 || index === 3,
    }));

    const pitches = sampleCameraPath(views, 49).map(
      (sample) => cameraAimDegrees(sample.quaternion).pitch,
    );

    expect(pitches[11]).toBeCloseTo(0);
    expect(pitches[12]).toBeCloseTo(0);
    expect(pitches[13]! - pitches[12]!).toBeLessThan(0.2);
    expect(pitches[36]).toBeCloseTo(30);
    expect(pitches[36]! - pitches[35]!).toBeLessThan(0.2);
    expect(pitches[37]).toBeCloseTo(30);
  });

  it("does not let path curvature change a manual camera angle", () => {
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

    for (const sample of samples) {
      expect(
        Math.abs(
          new THREE.Quaternion(...sample.quaternion).dot(
            new THREE.Quaternion(...START.quaternion),
          ),
        ),
      ).toBeCloseTo(1);
    }
  });

  it("does not spin between equivalent quaternion signs", () => {
    const equivalentEnd = {
      ...END,
      quaternion: START.quaternion.map((value) => -value) as [
        number,
        number,
        number,
        number,
      ],
    };
    const samples = sampleCameraPath([START, equivalentEnd], 51);

    for (const sample of samples) {
      expect(
        Math.abs(
          new THREE.Quaternion(...sample.quaternion).dot(
            new THREE.Quaternion(...START.quaternion),
          ),
        ),
      ).toBeCloseTo(1);
    }
  });

  it("gives equal time to short and long control-point intervals", () => {
    const middleQuaternion = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .toArray();
    const views: CameraView[] = [
      { ...START, position: [0, 1, 0], angleKey: true },
      {
        ...START,
        id: "middle",
        position: [1, 1, 0],
        quaternion: middleQuaternion,
        angleKey: true,
      },
      { ...END, position: [101, 1, 0], angleKey: true },
    ];

    const samples = sampleCameraPath(views, 5);

    expect(
      new THREE.Quaternion(...samples[2]!.quaternion).angleTo(
        new THREE.Quaternion(...middleQuaternion),
      ),
    ).toBeCloseTo(0);
  });

  it("moves smoothly through uneven approximate camera positions", () => {
    const views: CameraView[] = [0, 1, 11].map((x, index) => ({
      ...START,
      id: `position-${index + 1}`,
      position: [x, 1, 0],
    }));

    const samples = sampleCameraPath(views, 49);
    const incomingVelocity = new THREE.Vector3(...samples[24]!.position).sub(
      new THREE.Vector3(...samples[23]!.position),
    );
    const outgoingVelocity = new THREE.Vector3(...samples[25]!.position).sub(
      new THREE.Vector3(...samples[24]!.position),
    );

    expect(
      new THREE.Vector3(...samples[24]!.position).distanceTo(
        new THREE.Vector3(...views[1]!.position),
      ),
    ).toBeLessThan(0.1);
    expect(outgoingVelocity.sub(incomingVelocity).length()).toBeLessThan(0.1);
  });

  it("spreads indivisible leftover frames across control intervals", () => {
    const views = [0, 1, 2, 3].map((x, index): CameraView => ({
      ...START,
      id: `point-${index + 1}`,
      position: [x, 1, 0],
    }));

    const samples = sampleCameraPath(views, 8);

    expect(samples[2]?.position).toEqual(views[1]?.position);
    expect(samples[5]?.position).toEqual(views[2]?.position);
    expect(samples[7]?.position).toEqual(views[3]?.position);
  });
});

describe("buildTargetCameras", () => {
  it("uses 720p output intrinsics and Three.js camera coordinates", () => {
    const cameras = buildTargetCameras([START, END], 2, 1280, 720);

    expect(cameras[0]?.intrinsics).toMatchObject({ width: 1280, height: 720 });
    expect(cameras[0]?.extrinsics.coordinateSystem).toBe("rub");
    expect(cameras[1]?.extrinsics.position).toEqual(END.position);
  });

  it("uses the manually chosen angles in generated cameras", () => {
    const cameras = buildTargetCameras([START, END], 9, 1280, 720);

    expect(cameras[0]?.extrinsics.quaternion).toEqual(START.quaternion);
    expect(
      Math.abs(
        new THREE.Quaternion(...cameras.at(-1)!.extrinsics.quaternion).dot(
          new THREE.Quaternion(...END.quaternion),
        ),
      ),
    ).toBeCloseTo(1);
  });

  it("uses one field of view for every frame in a trajectory", () => {
    const pathViews = cameraViewsFromTrajectory(
      [
        [0, 1, 4],
        [2, 2, 1],
        [4, 2, 0],
      ],
      { ...START, fovRadians: THREE.MathUtils.degToRad(95) },
    );
    const cameras = buildTargetCameras(pathViews, 17, 1280, 720);

    expect(new Set(cameras.map((camera) => camera.intrinsics.fy)).size).toBe(1);
  });

  it("uses the model portrait raster without changing vertical field of view", () => {
    const landscape = buildTargetCameras([START, END], 2, 1280, 720);
    const portrait = buildTargetCameras([START, END], 2, 400, 720);

    expect(portrait[0]?.intrinsics).toMatchObject({ width: 400, height: 720 });
    expect(portrait[0]?.intrinsics.fy).toBeCloseTo(landscape[0]!.intrinsics.fy);
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

describe("camera direction preview", () => {
  it("projects points through the selected camera", () => {
    const projected = projectCameraPreviewPoints(
      [
        [0, 0, -2],
        [0, 0, 2],
        [1, 1, -2],
      ],
      { ...START, position: [0, 0, 0] },
    );

    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual({
      x: 0.5,
      y: 0.5,
      depth: 2,
      pointIndex: 0,
    });
    expect(projected[1]?.pointIndex).toBe(2);
    expect(projected[1]!.x).toBeGreaterThan(0.5);
    expect(projected[1]!.y).toBeLessThan(0.5);
  });

  it("shows the world direction chosen by yaw", () => {
    const projected = projectCameraPreviewPoints([[2, 0, 0]], {
      ...START,
      position: [0, 0, 0],
      quaternion: cameraQuaternionFromAim(90, 0),
    });

    expect(projected[0]?.x).toBeCloseTo(0.5);
    expect(projected[0]?.y).toBeCloseTo(0.5);
  });

  it("uses the selected aspect when clipping the approximate view", () => {
    const view = { ...START, position: [0, 0, 0] as [number, number, number] };

    expect(projectCameraPreviewPoints([[1, 0, -2]], view, 16 / 9)).toHaveLength(
      1,
    );
    expect(projectCameraPreviewPoints([[1, 0, -2]], view, 400 / 720)).toEqual(
      [],
    );
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
  it("deletes an interior camera position and its facing key", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left: [number, number, number, number] = [
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
    ];
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [2, 1, 0],
        ],
        quaternions: [forward, left, forward],
      },
    ];

    const deleted = deleteTrajectoryPivot(parts, "one", 1);

    expect(deleted).toEqual([
      {
        id: "one",
        points: [
          [0, 1, 0],
          [2, 1, 0],
        ],
        quaternions: [forward, forward],
      },
    ]);
    expect(parts[0]?.points).toHaveLength(3);
  });

  it("deletes every consecutive stored copy of one camera point", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [1, 1, 0],
        ],
      },
      {
        id: "two",
        points: [
          [1, 1, 0],
          [2, 1, 0],
          [3, 1, 0],
        ],
      },
    ];

    const deleted = deleteTrajectoryPivot(parts, "one", 1)!;

    expect(deleted[0]?.points).toEqual([[0, 1, 0]]);
    expect(deleted[1]?.points).toEqual([
      [2, 1, 0],
      [3, 1, 0],
    ]);
    expect(trajectoryPathFromSegments(deleted)).toEqual([
      [0, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ]);
  });

  it("keeps the minimum two camera points", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
        ],
      },
    ];

    expect(deleteTrajectoryPivot(parts, "one", 0)).toBeNull();
  });

  it("inserts a draggable pivot into the nearest path span", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left: [number, number, number, number] = [
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
    ];
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [10, 1, 0],
        ],
        quaternions: [forward, left],
      },
      {
        id: "two",
        points: [
          [10, 1, 0],
          [20, 1, 0],
        ],
      },
    ];

    const inserted = insertTrajectoryPivot(parts, [7, 3, 1], 0.35);

    expect(inserted).toMatchObject({
      segmentId: "one",
      pointIndex: 1,
      pivotNumber: 2,
    });
    expect(inserted?.segments[0]?.points).toEqual([
      [0, 1, 0],
      [7, 3, 1],
      [10, 1, 0],
    ]);
    expect(inserted?.segments[1]).toBe(parts[1]);
    expect(inserted?.segments[0]?.quaternions).toEqual([forward, null, left]);
    expect(parts[0]?.points).toHaveLength(2);
  });

  it("uses control-point timing when inserting on unequal path spans", () => {
    const parts: TrajectorySegment[] = [
      {
        id: "one",
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [101, 1, 0],
        ],
      },
    ];

    const inserted = insertTrajectoryPivot(parts, [0.8, 2, 0], 0.45);

    expect(inserted).toMatchObject({
      segmentId: "one",
      pointIndex: 1,
      pivotNumber: 2,
    });
    expect(inserted?.segments[0]?.points[1]).toEqual([0.8, 2, 0]);
  });

  it("does not add more than the manual pivot limit", () => {
    const points = Array.from(
      { length: MAX_PIVOTS_PER_PART },
      (_, index): [number, number, number] => [index, 1, 0],
    );

    expect(
      insertTrajectoryPivot([{ id: "one", points }], [4.5, 2, 0], 0.5),
    ).toBeNull();
  });

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

  it("numbers shared pivots once for the viewer and camera picker", () => {
    const pivots = trajectoryPivotsFromSegments([
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
        quaternions: [[0, 0, 0, 1], null],
      },
    ]);

    expect(pivots.map((pivot) => pivot.pivotNumber)).toEqual([1, 2, 3]);
    expect(pivots[1]).toMatchObject({
      segmentId: "one",
      pointIndex: 1,
      position: [1, 1, 0],
      hasCameraAngle: true,
    });
  });

  it("sets the same manual angle on both copies of a shared pivot", () => {
    const parts: TrajectorySegment[] = [
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
    ];
    const angle = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-0.2, 0.8, 0))
      .toArray();

    const updated = setTrajectoryPointQuaternion(parts, "one", 1, angle);

    expect(
      Math.abs(
        new THREE.Quaternion(...updated[0]!.quaternions![1]!).dot(
          new THREE.Quaternion(...angle),
        ),
      ),
    ).toBeCloseTo(1);
    expect(updated[1]?.quaternions?.[0]).toEqual(updated[0]?.quaternions?.[1]);
    expect(updated[0]?.quaternions?.[0]).toBeNull();
    expect(parts[0]?.quaternions).toBeUndefined();
  });

  it("interpolates only the manual angle keys across path pivots", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .toArray();
    const views = cameraViewsFromSegments(
      [
        {
          id: "one",
          points: [
            [0, 1, 0],
            [1, 1, 0],
            [2, 1, 0],
          ],
          quaternions: [forward, null, left],
        },
      ],
      START,
    );

    const samples = sampleCameraPath(views, 3);
    const middle = new THREE.Quaternion(...samples[1]!.quaternion);
    expect(middle.angleTo(new THREE.Quaternion(...forward))).toBeCloseTo(
      Math.PI / 4,
    );
    expect(samples[0]?.quaternion).toEqual(forward);
    expect(samples[2]?.quaternion).toEqual(left);
  });

  it("starts an unset pivot camera at its interpolated angle", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .toArray();
    const views = cameraViewsFromSegments(
      [
        {
          id: "one",
          points: [
            [0, 1, 0],
            [1, 1, 0],
            [2, 1, 0],
          ],
          quaternions: [forward, null, left],
        },
      ],
      START,
    );

    expect(
      new THREE.Quaternion(...cameraQuaternionAtView(views, 1)).angleTo(
        new THREE.Quaternion(...forward),
      ),
    ).toBeCloseTo(Math.PI / 4);
  });

  it("uses positive yaw to look right without adding roll", () => {
    const quaternion = cameraQuaternionFromAim(45, 0);
    const rotated = new THREE.Quaternion(...quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rotated);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rotated);

    expect(forward.x).toBeCloseTo(Math.SQRT1_2);
    expect(right.y).toBeCloseTo(0);
    const aim = cameraAimDegrees(quaternion);
    expect(aim.yaw).toBeCloseTo(45);
    expect(aim.pitch).toBeCloseTo(0);
  });

  it("clamps pitch before the camera flips", () => {
    const quaternion = cameraQuaternionFromAim(0, 10_000);
    const rotated = new THREE.Quaternion(...quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rotated);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rotated);

    expect(forward.y).toBeGreaterThan(0.999);
    expect(forward.z).toBeLessThan(0);
    expect(right.y).toBeCloseTo(0);
    expect(cameraAimDegrees(quaternion).pitch).toBeCloseTo(89);
  });

  it("holds one manual angle across the full path", () => {
    const angle = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-0.3, 1.1, 0))
      .toArray();
    const views = cameraViewsFromSegments(
      [
        {
          id: "one",
          points: [
            [0, 1, 0],
            [2, 4, -3],
            [5, 2, 1],
          ],
          quaternions: [null, angle, null],
        },
      ],
      START,
    );

    for (const view of sampleCameraPath(views, 17)) {
      expect(
        Math.abs(
          new THREE.Quaternion(...view.quaternion).dot(
            new THREE.Quaternion(...angle),
          ),
        ),
      ).toBeCloseTo(1);
    }
  });

  it("does not turn an unset pivot into an angle key", () => {
    const forward: [number, number, number, number] = [0, 0, 0, 1];
    const left = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .toArray();
    const direct = cameraViewsFromSegments(
      [
        {
          id: "direct",
          points: [
            [0, 1, 0],
            [10, 1, 0],
          ],
          quaternions: [forward, left],
        },
      ],
      START,
    );
    const withUnsetPivot = cameraViewsFromSegments(
      [
        {
          id: "with-pivot",
          points: [
            [0, 1, 0],
            [0.1, 1, 0],
            [10, 1, 0],
          ],
          quaternions: [forward, null, left],
        },
      ],
      START,
    );
    const directSamples = sampleCameraPath(direct, 21);
    const pivotSamples = sampleCameraPath(withUnsetPivot, 21);

    directSamples.forEach((sample, index) => {
      expect(
        new THREE.Quaternion(...sample.quaternion).angleTo(
          new THREE.Quaternion(...pivotSamples[index]!.quaternion),
        ),
      ).toBeCloseTo(0);
    });
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

  it("frames the floor near the bottom without changing world scale", () => {
    const frontSpace = frameTrajectorySpaceAboveFloor(
      SPACE,
      FRONT_VIEW,
      START.position,
    );
    const frontBoundary = trajectoryFloorBoundary(
      FRONT_VIEW,
      frontSpace,
      START.position,
    )!;
    const turnedSpace = frameTrajectorySpaceAboveFloor(
      SPACE,
      TURNED_VIEW,
      START.position,
    );
    const turnedBoundary = trajectoryFloorBoundary(
      TURNED_VIEW,
      turnedSpace,
      START.position,
    )!;

    expect(frontSpace.radius).toBe(SPACE.radius);
    expect(Math.max(frontBoundary[0][1], frontBoundary[1][1])).toBeCloseTo(
      0.94,
    );
    expect(Math.max(turnedBoundary[0][1], turnedBoundary[1][1])).toBeCloseTo(
      0.94,
    );
  });

  it("recenters a far path endpoint before framing the floor", () => {
    const anchor: [number, number, number] = [20, 0, 0];
    const framedSpace = frameTrajectorySpaceAboveFloor(
      SPACE,
      FRONT_VIEW,
      anchor,
    );
    const projectedAnchor = projectTrajectoryPoint(
      anchor,
      FRONT_VIEW,
      framedSpace,
    );

    expect(projectedAnchor[0]).toBeCloseTo(0.5);
    expect(projectedAnchor[1]).toBeCloseTo(0.94);
  });

  it("keeps a high path endpoint visible when the floor cannot fit", () => {
    const anchor: [number, number, number] = [0, 19, 0];
    const framedSpace = frameTrajectorySpaceAboveFloor(
      SPACE,
      FRONT_VIEW,
      anchor,
    );
    const projectedAnchor = projectTrajectoryPoint(
      anchor,
      FRONT_VIEW,
      framedSpace,
    );
    const floorBoundary = trajectoryFloorBoundary(
      FRONT_VIEW,
      framedSpace,
      anchor,
    )!;

    expect(framedSpace.radius).toBe(SPACE.radius);
    expect(projectedAnchor[1]).toBeCloseTo(0.06);
    expect(Math.max(floorBoundary[0][1], floorBoundary[1][1])).toBeGreaterThan(
      0.94,
    );
  });

  it("leaves the drawing space unchanged when the floor is nearly edge-on", () => {
    const nearOverheadView: TrajectoryDrawingView = {
      right: [1, 0, 0],
      up: [0, 0.05, -Math.sqrt(1 - 0.05 ** 2)],
      forward: [0, Math.sqrt(1 - 0.05 ** 2), 0.05],
    };

    expect(
      frameTrajectorySpaceAboveFloor(SPACE, nearOverheadView, START.position),
    ).toBe(SPACE);
    expect(
      trajectoryFloorBoundary(nearOverheadView, SPACE, START.position),
    ).toBeNull();
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

  it("reduces a dense drawn stroke to a few spline controls", () => {
    const stroke = Array.from({ length: 101 }, (_, index) => {
      const progress = index / 100;
      return [progress, 0.5 - Math.sin(progress * Math.PI) * 0.2] as [
        number,
        number,
      ];
    });

    const path = appendDrawnTrajectory(
      [],
      stroke,
      FRONT_VIEW,
      SPACE,
      START.position,
    );

    expect(path).toHaveLength(5);
    expect(path[0]).toEqual([-10, 0, 4]);
    expect(path.at(-1)).toEqual([10, 0, 4]);
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

  it("keeps the reference angle until manual pivot angles are set", () => {
    const path: [number, number, number][] = [
      [-10, 2, -10],
      [0, 5, 0],
      [10, 3, 10],
    ];
    const views = cameraViewsFromTrajectory(path, START);

    expect(views).toHaveLength(3);
    expect(views[0]?.position).toEqual([-10, 2, -10]);
    expect(views.at(-1)?.position).toEqual([10, 3, 10]);
    for (const view of views) {
      expect(view.quaternion).toEqual(START.quaternion);
    }
  });

  it("derives the drawing plane from the main camera quaternion", () => {
    const drawingView = cameraDrawingView(START.quaternion);

    expect(drawingView).toEqual({
      right: [1, 0, 0],
      up: [0, 1, 0],
      forward: [0, 0, -1],
    });
  });

  it("ignores a trajectory with only one point", () => {
    expect(cameraViewsFromTrajectory([[0, 1, 0]], START)).toEqual([]);
  });
});
