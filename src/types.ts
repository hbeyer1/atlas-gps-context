export type Camera = {
  intrinsics: {
    width: number;
    height: number;
    fx: number;
    fy: number;
    cx: number;
    cy: number;
  };
  extrinsics: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    coordinateSystem: "rub" | "rdf";
  };
};
