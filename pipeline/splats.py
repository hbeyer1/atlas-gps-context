"""Dots as a 3D Gaussian splat .ply (one isotropic splat per dot), which splat viewers such as Spark read."""
import numpy as np

SH_C0 = 0.28209479177387814


def write_splats(path, pts, cols_rgb, sizes):
    n = len(pts)
    f_dc = ((cols_rgb.astype(np.float32) / 255.0) - 0.5) / SH_C0
    log_s = np.log(np.maximum(sizes * 0.6, 1e-5)).astype(np.float32)
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    a = np.zeros((n, len(names)), np.float32)
    a[:, 0:3] = pts
    a[:, 6:9] = f_dc
    a[:, 9] = 4.0
    a[:, 10:13] = log_s[:, None]
    a[:, 13] = 1.0
    head = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n" + "".join(f"property float {k}\n" for k in names) + "end_header\n"
    path.write_bytes(head.encode() + a.tobytes())
