import { decodePointCloud } from "./pointcloud";
import type { Camera } from "./types";

// A project's scene as World Labs gets it: posed RGBD context frames (the photo's strips, the aerial renders over the
// terrain) in the place's local frame (metres, x east, y up, z south, origin on the ground at the GPS point).
export type Frame = {
  name: string;
  camera: Camera;
  image: string;
  depth: string;
  confidence: string;
};
export type Cloud = {
  name: string;
  positions: Float32Array;
  colors: Float32Array;
  pointSize: number;
};
export type Scene = {
  frames: Frame[];
  clouds: Cloud[];
  reference: Camera;
  focus: [number, number, number];
};

export const fileUrl = (project: string, path: string) =>
  `/files/${project}/${path}`;

export function contextFrames(
  project: string,
  context: { frames: { name: string; camera: Camera }[] },
): Frame[] {
  const dir = `work/scene/${project}/context`;
  return context.frames.map(({ name, camera }) => ({
    name,
    camera,
    image: fileUrl(project, `${dir}/${name}.png`),
    depth: fileUrl(project, `${dir}/${name}-depth.exr`),
    confidence: fileUrl(project, `${dir}/${name}-confidence.png`),
  }));
}

// Each frame becomes its own cloud: the photo's dots are centimetres apart, the aerials' about a metre, so each gets
// its own dot size.
export async function loadClouds(frames: Frame[], signal: AbortSignal) {
  return Promise.all(
    frames.map(async (frame) => {
      const [image, depth] = await Promise.all([
        fetch(frame.image, { signal }),
        fetch(frame.depth, { signal }),
      ]);
      if (!image.ok || !depth.ok)
        throw new Error(`Could not load ${frame.name}`);
      const cloud = await decodePointCloud(
        image,
        depth,
        frame.camera,
        signal,
        240000,
      );
      return {
        name: frame.name,
        positions: cloud.positions,
        colors: cloud.colors,
        pointSize: cloud.pointSize,
        focus: cloud.focus,
      };
    }),
  );
}

export async function loadScene(
  project: string,
  context: { frames: { name: string; camera: Camera }[] },
  signal: AbortSignal,
): Promise<Scene> {
  const frames = contextFrames(project, context);
  const clouds = await loadClouds(frames, signal);
  const photo = frames.findIndex((frame) => frame.name === "photo");
  if (photo < 0) throw new Error("The scene has no photo frame.");
  return {
    frames,
    clouds,
    reference: frames[photo]!.camera,
    focus: clouds[photo]!.focus,
  };
}
