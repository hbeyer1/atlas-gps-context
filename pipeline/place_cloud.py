"""Fuse one joint generation (joint.py: the lower dive, a ring and views down at the ground, all from a single World
Labs request) and the posed photo into one dot cloud for the place: the camera flies through it from ~70 m down to
the spot, and you can stand in it, look around and walk.

  python place_cloud.py <place> [--tag joint] [--stride 2] [--radius 90] [--inputs]
  -> world/journeys/october/clouds/lite/<place>-bubble.ply   (place-local metres; build_journey.py places it)
     work/gen/<place>-<tag>/cloud-check.jpg                   (the cloud from dive cameras, between ring views, 1 m aside,
                                                               and looking down at the ground behind the spot)
  --inputs: only what World Labs was given (the photo strips and the aerial frames, nothing generated), out to 250 m
     -> <place>-inputs.ply and inputs-check.jpg (the same check cameras, to compare). Each view gives way where a
     finer one (the photo, then the 520 m aerial, then the 600 m one) shows a surface, and the aerial's coarse dots
     shrink right around the spot so they don't fill the view from it.
  --surround R (with --inputs): also the land and sea around the crop, out to R metres (Big Sur: the coast is ~1 km
     south-west, 192 m below the spot), from the aerial layers the journey's terrain uses.
  --out F.ply, --max-depth M (atlas-studio): write the cloud there instead (no check sheet unless the views include a
     ring), and keep generated depth out to M metres (default 400; views from a few hundred metres up need more).

Each view is unprojected through its camera with the depth World Labs returned. Where views overlap, each small cell
of space keeps the pixels of the view that saw it closest (the finest dots); the photo's own pixels are preferred, so
what the photo shows stays the photo. Cells grow with distance from the spot (6 cm near it, about 1 m at 90 m).
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
from bubble import OUT, read_depth, render, unproject  # noqa: E402
from splats import write_splats  # noqa: E402
from build_place import ROOT, Terrain, camera, look_rotation, quat_matrix  # noqa: E402

PHOTO_PREFERENCE = 0.3   # a photo pixel wins over generated ones up to ~3x finer
SEA_DEEP = np.array([22, 70, 98], np.float32)   # offshore, where the aerial's water turns to pale glare bands


def surroundings(place, r0, r1, rng):
    """Land and sea around the crop, from the aerial layers (as the journey's terrain): rings of growing spacing from
    r0 out to r1. The sea lies flat at sea level, in the aerial's own colours near the shore, deepening to a plain sea
    blue by 2.5 km."""
    T = Terrain(place, region=True)
    pts, sizes = [], []
    for a, b, step in ((r0, 700.0, 3.0), (700.0, 1500.0, 6.0), (1500.0, r1, 12.0)):
        b = min(b, r1)
        if a >= b:
            continue
        g = np.arange(-b, b + step, step)
        X, Z = np.meshgrid(g, g)
        X = X + rng.uniform(-0.5, 0.5, X.shape) * step
        Z = Z + rng.uniform(-0.5, 0.5, Z.shape) * step
        m = (np.hypot(X, Z) >= a) & (np.hypot(X, Z) < b)
        pts.append(np.stack([X[m], np.zeros(m.sum()), Z[m]], 1)); sizes.append(np.full(m.sum(), step))
    P, S = np.concatenate(pts), np.concatenate(sizes)
    h, inside = T.height(P[:, 0], P[:, 2])
    col, cin = T.colour(P[:, 0], P[:, 2])
    col = col[:, ::-1].astype(np.float32)
    sea = T.sea(P[:, 0], P[:, 2])
    w = np.clip((np.hypot(P[:, 0], P[:, 2]) - 1800) / 700, 0, 1)[:, None]
    w = np.where(col.max(1, keepdims=True) < 8, 1.0, w)   # no aerial survey there at all
    deep = SEA_DEEP * rng.uniform(0.9, 1.1, (len(P), 1))
    col[sea] = col[sea] * (1 - w[sea]) + deep[sea] * w[sea]
    h[sea] = -T.ground0
    P[:, 1] = h
    keep = (inside & cin) | sea
    print(f"surroundings {r0:.0f}-{r1:.0f} m: {keep.sum():,} dots ({(keep & sea).sum():,} sea)")
    return P[keep], np.clip(col[keep], 0, 255).astype(np.uint8), S[keep]


def hides(P, size, finer):
    """Points standing between a finer view's camera and what it shows at that pixel, or lying on that surface (within
    about a dot's size behind it): their discs would cover it. Points further behind, or outside its frame, are left
    alone."""
    hide = np.zeros(len(P), bool)
    for cam, depth, conf in finer:
        K, R, C = cam["intrinsics"], quat_matrix(cam["extrinsics"]["quaternion"]), np.array(cam["extrinsics"]["position"])
        L = (P - C) @ R
        d = -L[:, 2]
        H, W = depth.shape
        with np.errstate(divide="ignore", invalid="ignore"):
            u = (K["fx"] * L[:, 0] / d + K["cx"]) * W / K["width"]
            v = (K["cy"] - K["fy"] * L[:, 1] / d) * H / K["height"]
        i = np.where((d > 0) & (u >= 0) & (u < W) & (v >= 0) & (v < H))[0]
        ui, vi = u[i].astype(int), v[i].astype(int)
        ok = np.isfinite(depth[vi, ui]) & (True if conf is None else conf[vi, ui] > 0)
        hide[i[ok & (d[i] < depth[vi, ui] * 1.05 + 1.5 * size[i])]] = True
    return hide


def main():
    args = sys.argv[1:]
    place = args[0]
    opt = lambda k, d: type(d)(args[args.index(k) + 1]) if k in args else d
    inputs, surround = "--inputs" in args, opt("--surround", 0.0)
    tag, stride, radius = opt("--tag", "joint"), opt("--stride", 2), opt("--radius", 250.0 if inputs else 90.0)
    max_depth = opt("--max-depth", 2000.0 if inputs else 400.0)   # the aerials look down from 500-600 m
    gen = ROOT / "work" / "gen" / f"{place}-{tag}"
    scene = ROOT / "work" / "scene" / place
    targets = json.loads((gen / "targets.json").read_text())
    ctx = json.loads((scene / "context.json").read_text())
    photo = next(f for f in ctx["frames"] if f["name"] == "photo")
    spot = np.array(photo["camera"]["extrinsics"]["position"])
    views = [dict(name=f["name"], cam=f["camera"], img=scene / "context" / f"{f['name']}.png", dep=scene / "context" / f"{f['name']}-depth.exr",
                  conf=scene / "context" / f"{f['name']}-confidence.png", photo=f["name"].startswith("photo"))
             for f in ctx["frames"] if inputs or f["name"].startswith("photo")]
    if inputs:   # the photo strips first, then the aerials from fine to coarse, each giving way to those before it
        views.sort(key=lambda v: (not v["photo"], v["cam"]["extrinsics"]["position"][1] / v["cam"]["intrinsics"]["fx"]))
    for i, t in enumerate([] if inputs else targets):
        views.append(dict(name=f"{i}:{t['kind']}", cam=t["camera"], img=gen / f"frame-{i:02d}.png", dep=gen / f"frame-{i:02d}-depth.exr",
                          conf=gen / f"frame-{i:02d}-confidence.png", photo=False))
    Ps, Cs, Ss, prio, vid, finer = [], [], [], [], [], []
    for k, v in enumerate(views):
        depth = read_depth(v["dep"])
        if depth is None:
            print("no depth for", v["name"], "- skipped"); continue
        conf = cv2.imread(str(v["conf"]), cv2.IMREAD_UNCHANGED) if Path(v["conf"]).exists() else None
        if conf is not None and conf.ndim == 3:
            conf = conf[..., 0]
        P, col, size, *_ = unproject(v["cam"], depth, cv2.imread(str(v["img"])), conf, stride, max_depth)
        near = np.hypot(P[:, 0] - spot[0], P[:, 2] - spot[2]) < radius
        if inputs:
            if not v["photo"]:
                hidden = hides(P, size, finer) & near
                print(f"{v['name']:14s} {hidden.sum():,} points on or in front of finer views' surfaces dropped")
                near &= ~hidden
                size = np.minimum(size, 0.1 * np.linalg.norm(P - spot, axis=1))   # at your feet: small dots, not a blanket
            finer.append((v["cam"], depth, conf))
        P, col, size = P[near], col[near], size[near]
        Ps.append(P); Cs.append(col); Ss.append(size)
        prio.append(size * (PHOTO_PREFERENCE if v["photo"] else 1.0)); vid.append(np.full(len(P), k, np.int32))
        print(f"{v['name']:14s} median depth {np.nanmedian(depth):6.1f} m  valid {np.isfinite(depth).mean():.0%}  {len(P):,} points within {radius:.0f} m")
    P, C, S, prio, vid = [np.concatenate(x) for x in (Ps, Cs, Ss, prio, vid)]
    # cells: 6 cm within 12 m of the spot, doubling every doubling of distance
    r = np.linalg.norm(P - spot, axis=1)
    shell = np.maximum(0, np.floor(np.log2(np.maximum(r, 1e-3) / 6.0))).astype(np.int64)
    cell = 0.06 * (2.0 ** shell)
    ijk = np.floor(P / cell[:, None]).astype(np.int64)
    key = ((shell * 1_000_003 + ijk[:, 0]) * 1_000_033 + ijk[:, 1]) * 1_000_037 + ijk[:, 2]
    uniq, inv = np.unique(key, return_inverse=True)
    order = np.lexsort((prio, inv))
    first = np.ones(len(order), bool); first[1:] = inv[order][1:] != inv[order][:-1]
    winner = np.empty(len(uniq), np.int32); winner[inv[order][first]] = vid[order][first]
    keep = vid == winner[inv]
    print(f"cells: {len(uniq):,}; kept {keep.sum():,} of {len(P):,} points")
    for k, v in enumerate(views):
        n = int((keep & (vid == k)).sum())
        if n:
            print(f"   {v['name']:14s} {n:>9,}")
    Pk, Ck, Sk = P[keep], C[keep], S[keep]
    if inputs and surround > radius:
        Ps, Cs, Ss = surroundings(place, radius, surround, np.random.default_rng(0))
        Pk, Ck, Sk = np.concatenate([Pk, Ps]), np.concatenate([Ck, Cs]), np.concatenate([Sk, Ss])
    ply = Path(opt("--out", str(OUT / f"{place}-{'inputs' if inputs else 'bubble'}.ply")))
    ply.parent.mkdir(parents=True, exist_ok=True)
    write_splats(ply, Pk.astype(np.float32), Ck, Sk.astype(np.float32))
    print(f"cloud: {len(Pk):,} dots -> {ply}")
    if not any(t["kind"] == "ring" for t in targets):   # the checks below look between a ring's views
        return
    # checks
    f = targets[0]["camera"]["intrinsics"]["fx"]
    cams = [(f"dive cam {t['dive_index']} ({t['camera']['extrinsics']['position'][1]:.0f} m)", t["camera"])
            for t in targets if t.get("dive_index") in (3, 5, 7)]
    head0 = next(t["yaw_deg"] for t in targets if t["kind"] == "ring")
    for dy, pitch, lab in ((15, -5, "between ring views"), (105, -5, "between ring views"), (195, -35, "looking down, behind"), (285, -50, "looking down, aside")):
        h = math.radians(head0 + dy); p = math.radians(pitch)
        fwd = np.array([math.sin(h) * math.cos(p), math.sin(p), -math.cos(h) * math.cos(p)])
        cams.append((f"yaw {head0 + dy:.0f}, pitch {pitch}: {lab}", camera(spot, look_rotation(fwd), 1280, 720, f)))
    side = np.array([math.cos(math.radians(head0 + 15)), 0, math.sin(math.radians(head0 + 15))])
    cams.append(("1 m right of the spot", dict(cams[3][1], extrinsics=dict(cams[3][1]["extrinsics"], position=(spot + side).tolist()))))
    tiles = []
    for label, cam in cams:
        im = render(Pk, Ck, Sk, cam)
        cv2.putText(im, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4)
        cv2.putText(im, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        tiles.append(im)
    while len(tiles) % 2:
        tiles.append(np.zeros_like(tiles[0]))
    check = gen / ("inputs-check.jpg" if inputs else "cloud-check.jpg")
    cv2.imwrite(str(check), np.vstack([np.hstack(tiles[r:r + 2]) for r in range(0, len(tiles), 2)]), [cv2.IMWRITE_JPEG_QUALITY, 88])
    print("check:", check)


if __name__ == "__main__":
    main()
