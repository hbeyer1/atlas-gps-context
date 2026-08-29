import { describe, expect, it } from "vitest";
import { buildTargetCameras, sampleCameraPath, type CameraView } from "./camera-trajectory";

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
