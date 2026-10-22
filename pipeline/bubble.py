"""Fuse a ring of generated views (ring.py) and the posed photo into one dot cloud around the photo spot: a bubble
you can stand in and look around.

  python bubble.py <place> [--tag ring] [--stride 2] [--max-depth 120] [--margin 6]
  -> world/journeys/october/clouds/lite/<place>-bubble.ply   (place-local metres; build_journey.py places it)
     work/gen/<place>-<tag>/bubble-check.jpg                  (the cloud rendered from between the views, and 1 m aside)
     work/gen/<place>-<tag>/bubble-overlap.jpg                (same, keeping every view's pixels: disagreement shows as ghosting)

Each view is unprojected through the camera it was asked for, with the depth World Labs returned (planar depth, like
its posed photos). Where views overlap, each direction (seen from the spot) keeps the pixels of the view whose centre
is nearest, plus `margin` degrees of its neighbours' so the seams blend (the photo wins inside its own frame); the
overlap render keeps everything and shows how well the views actually agree.
"""
import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
from splats import write_splats  # noqa: E402
from build_place import ROOT, quat_matrix  # noqa: E402

OUT = ROOT.parent / "world" / "journeys" / "october" / "clouds" / "lite"


def read_depth(path):
    d = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if d is None:
        return None
    d = d if d.ndim == 2 else d[..., 0]
    return d.astype(np.float32)


def unproject(cam, depth, img, conf, stride, max_depth):
    """World points, colours, sizes and ray headings for one view."""
    K = cam["intrinsics"]
    R = quat_matrix(cam["extrinsics"]["quaternion"])
    C = np.array(cam["extrinsics"]["position"])
    H, W = depth.shape
    ys, xs = np.mgrid[0:H:stride, 0:W:stride]
    d = depth[ys, xs]
    ok = np.isfinite(d) & (d > 0.05) & (d < max_depth)
    if conf is not None:
        ok &= conf[ys, xs] > 0
    sx, sy = K["width"] / W, K["height"] / H   # depth may come back smaller than the picture
    x = (xs + 0.5) * sx - K["cx"]; y = (ys + 0.5) * sy - K["cy"]
    local = np.stack([x / K["fx"] * d, -y / K["fy"] * d, -d], -1)
    P = local @ R.T + C
    dirs = local @ R.T
    head = np.degrees(np.arctan2(dirs[..., 0], -dirs[..., 2])) % 360
    pitch = np.degrees(np.arcsin(np.clip(dirs[..., 1] / np.linalg.norm(dirs, axis=-1), -1, 1)))
    col = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)[ys, xs][..., ::-1]
    size = 0.65 * d * stride * sx / K["fx"]   # the ground size of one kept pixel; drawn ~1.7x, so the dots just touch (standing inside, overdraw costs frames)
    return P[ok], col[ok], size[ok], head[ok], pitch[ok], (x[ok] / K["fx"], y[ok] / K["fy"])


def render(P, C_rgb, S, cam, W=640, H=360):
    """A quick splat render of the cloud from a camera (nearest-first, discs)."""
    K = cam["intrinsics"]; f = K["fx"] * W / K["width"]
    R = quat_matrix(cam["extrinsics"]["quaternion"]); C = np.array(cam["extrinsics"]["position"])
    local = (P - C) @ R
    z = -local[:, 2]
    m = z > 0.05
    u = local[m, 0] / z[m] * f + W / 2; v = -local[m, 1] / z[m] * f + H / 2
    r = np.clip(S[m] / z[m] * f * 0.9, 1, 12)
    inside = (u > -12) & (u < W + 12) & (v > -12) & (v < H + 12)
    order = np.argsort(-z[m][inside])
    img = np.zeros((H, W, 3), np.uint8)
    uu, vv, rr, cc = u[inside][order], v[inside][order], r[inside][order], C_rgb[m][inside][order]
    for i in range(len(uu)):
        cv2.circle(img, (int(uu[i]), int(vv[i])), int(rr[i]), tuple(int(c) for c in cc[i][::-1]), -1)
    return img


def main():
    args = sys.argv[1:]
    place = args[0]
    opt = lambda k, d: type(d)(args[args.index(k) + 1]) if k in args else d
    tag, stride, max_depth, margin = opt("--tag", "ring"), opt("--stride", 2), opt("--max-depth", 120.0), opt("--margin", 6.0)
    gen = ROOT / "work" / "gen" / f"{place}-{tag}"
    scene = ROOT / "work" / "scene" / place
    targets = json.loads((gen / "targets.json").read_text())
    ctx = json.loads((scene / "context.json").read_text())
    photo = next(f for f in ctx["frames"] if f["name"] == "photo")
    strips = [f for f in ctx["frames"] if f["name"].startswith("photo")]   # the photo's strips (a portrait photo has two)
    views = [dict(name=f["name"], cam=f["camera"], img=scene / "context" / f"{f['name']}.png", dep=scene / "context" / f"{f['name']}-depth.exr",
                  conf=scene / "context" / f"{f['name']}-confidence.png") for f in strips]
    for i, t in enumerate(targets):
        views.append(dict(name=f"ring {t['yaw_deg']:.0f}", yaw=t["yaw_deg"], cam=t["camera"], img=gen / f"frame-{i:02d}.png",
                          dep=gen / f"frame-{i:02d}-depth.exr", conf=gen / f"frame-{i:02d}-confidence.png"))
    yaws = np.array([v["yaw"] for v in views if "yaw" in v])
    spot = np.array(photo["camera"]["extrinsics"]["position"])
    frusta = [(quat_matrix(f["camera"]["extrinsics"]["quaternion"]), f["camera"]["intrinsics"]["width"] / 2 / f["camera"]["intrinsics"]["fx"],
               f["camera"]["intrinsics"]["height"] / 2 / f["camera"]["intrinsics"]["fy"]) for f in strips]
    keep_all, keep_sel = [], []
    for v in views:
        depth = read_depth(v["dep"])
        if depth is None:
            print("no depth for", v["name"], "- skipped"); continue
        conf = cv2.imread(str(v["conf"]), cv2.IMREAD_UNCHANGED) if Path(v["conf"]).exists() else None
        if conf is not None and conf.ndim == 3:
            conf = conf[..., 0]
        img = cv2.imread(str(v["img"]))
        P, col, size, _, _, _ = unproject(v["cam"], depth, img, conf, stride, max_depth)
        keep_all.append((P, col, size))
        if "yaw" in v:
            # directions as seen from the spot (the view's own camera sits on the small circle, which would leave gaps)
            D = P - spot
            head = np.degrees(np.arctan2(D[:, 0], -D[:, 2])) % 360
            dh = (head - v["yaw"] + 180) % 360 - 180
            sel = np.abs(dh) <= 180 / len(yaws) + margin
            # the photo claims what it sees: a ring pixel inside one of its strips (with a small margin) goes
            for Rp, tanx, tany in frusta:
                dirs = D @ Rp
                inphoto = (dirs[:, 2] < 0) & (np.abs(dirs[:, 0] / -dirs[:, 2]) < tanx * 0.97) & (np.abs(dirs[:, 1] / -dirs[:, 2]) < tany * 0.97)
                sel &= ~inphoto
        else:
            sel = np.ones(len(P), bool)
        keep_sel.append((P[sel], col[sel], size[sel]))
        print(f"{v['name']:10s} depth {depth.shape[1]}x{depth.shape[0]}  median {np.nanmedian(depth):6.1f} m  "
              f"valid {np.isfinite(depth).mean():.0%}  kept {sel.sum():,} of {len(P):,}")
    Pa, Ca, Sa = [np.concatenate(x) for x in zip(*keep_all)]
    Ps, Cs, Ss = [np.concatenate(x) for x in zip(*keep_sel)]
    OUT.mkdir(parents=True, exist_ok=True)
    write_splats(OUT / f"{place}-bubble.ply", Ps.astype(np.float32), Cs, Ss.astype(np.float32))
    print(f"bubble: {len(Ps):,} dots (all views: {len(Pa):,}) -> {OUT / f'{place}-bubble.ply'}")
    # check renders: between the views (seams), and 1 m to the side (parallax)
    cams = []
    for k in range(0, len(targets), max(1, len(targets) // 4)):
        t = targets[k]
        yaw = t["yaw_deg"] + 180 / len(targets)
        h = math.radians(yaw)
        from build_place import camera, look_rotation
        fwd = np.array([math.sin(h) * math.cos(math.radians(-5)), math.sin(math.radians(-5)), -math.cos(h) * math.cos(math.radians(-5))])
        side = np.array([math.cos(h), 0, math.sin(h)])
        cams.append((f"yaw {yaw:.0f} (between)", camera(spot, look_rotation(fwd), 1280, 720, t["camera"]["intrinsics"]["fx"])))
        cams.append((f"yaw {yaw:.0f}, 1 m right", camera(spot + side, look_rotation(fwd), 1280, 720, t["camera"]["intrinsics"]["fx"])))
    for name, cloud in (("bubble-check.jpg", (Ps, Cs, Ss)), ("bubble-overlap.jpg", (Pa, Ca, Sa))):
        tiles = []
        for label, cam in cams:
            im = render(*cloud, cam)
            cv2.putText(im, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            tiles.append(im)
        while len(tiles) % 2:
            tiles.append(np.zeros_like(tiles[0]))
        cv2.imwrite(str(gen / name), np.vstack([np.hstack(tiles[r:r + 2]) for r in range(0, len(tiles), 2)]), [cv2.IMWRITE_JPEG_QUALITY, 88])
    print("check images:", gen / "bubble-check.jpg", gen / "bubble-overlap.jpg")


if __name__ == "__main__":
    main()
