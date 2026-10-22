"""Build the World Labs context for one memory place, and plan its aerial approach.

  python build_place.py <place>        (reads places.json, work/pose/<place>/, work/relight/<place>/, source/aerial/<place>/)
  -> work/scene/<place>/
       context/<name>.png|-depth.exr|-confidence.png   posed RGBD context frames, all the same size
       context.json        cameras (RUB, xyzw, metres), in the place's local frame
       targets.json        approach + swivel target cameras (1280x720)
       check-registration.jpg   the photo next to the same view rendered from the aerial + terrain
       check-path.jpg           top-down map of the path, and a few target views rendered from the aerial

Local frame: metres, x east, y up, z south, origin on the ground at the photo's GPS point.
Aerial frames are perspective renders of the (relit) orthophoto draped over USGS 3DEP terrain, so their
colour and depth agree. The photo keeps the posing model's depth up to NEAR metres; beyond that its depth
comes from tracing each pixel's ray against the terrain (monocular depth squashes far distances).
"""
import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = Path(os.environ.get("PLACE_ROOT") or Path(__file__).resolve().parents[1])   # PLACE_ROOT: another folder laid out like this one (atlas-studio projects)
NEAR = 18.0


# ---------------------------------------------------------------- terrain and orthophoto
class Terrain:
    """Height above the photo spot's ground (metres) and orthophoto colour at local (x, z)."""

    def __init__(self, place, relit=True, region=False):
        a = ROOT / "source" / "aerial" / place
        self.meta = json.loads((a / "meta.json").read_text())
        self.layers = []   # close first: it wins where it covers
        for scale in ("close", "wide") + (("region",) if region else ()):   # the 14 km region only feeds the map
            s = self.meta["scales"][scale]
            dem = np.array(Image.open(a / f"dem-{scale}.tif"), dtype=np.float32)
            nodata = ~np.isfinite(dem) | (dem < -500) | (dem > 5000)
            dem[nodata] = 0.0
            rp = ROOT / "work" / "relight" / place / f"naip-{scale}-relit.png"
            img = cv2.imread(str(rp if relit and rp.exists() else a / f"naip-{scale}.jpg"))
            sea = cv2.resize((nodata | (dem == 0)).astype(np.float32), img.shape[1::-1], interpolation=cv2.INTER_NEAREST)
            low = cv2.resize((np.abs(dem) < 2).astype(np.uint8), img.shape[1::-1], interpolation=cv2.INTER_NEAREST) > 0
            b, g, r = [img[..., k].astype(np.int16) for k in range(3)]
            sea = np.maximum(sea, ((img.max(-1) < 8)                        # or no aerial survey (offshore)
                                   | (low & (b > r + 12) & (b > g))).astype(np.float32))   # or water-coloured at sea level
            self.layers.append(dict(extent=s["ground_metres"], dem=dem, img=img, sea=sea))
        # the relit tiles came out in different tones: match each wider one to the one inside it where they overlap
        # (mean and spread per channel in Lab), so views that use both have no seam
        if relit:
            for c, w in zip(self.layers, self.layers[1:]):
                h, wd = w["img"].shape[:2]
                fr = c["extent"] / w["extent"] / 2
                ov = w["img"][int(h * (0.5 - fr)):int(h * (0.5 + fr)), int(wd * (0.5 - fr)):int(wd * (0.5 + fr))]
                ok = c["sea"] < 0.5 if w is self.layers[-1] and region else np.ones(c["sea"].shape, bool)   # the region: land only (its empty sea corner would skew the tone)
                ok_w = cv2.resize(ok.astype(np.uint8), ov.shape[1::-1], interpolation=cv2.INTER_NEAREST) > 0
                a = cv2.cvtColor(c["img"], cv2.COLOR_BGR2LAB).astype(np.float32)[ok]
                b = cv2.cvtColor(ov, cv2.COLOR_BGR2LAB).astype(np.float32)[ok_w]
                lab = cv2.cvtColor(w["img"], cv2.COLOR_BGR2LAB).astype(np.float32)
                lab = (lab - b.mean(0)) / (b.std(0) + 1e-3) * a.std(0) + a.mean(0)
                w["img"] = cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
        d0 = self.layers[0]["dem"]
        self.ground0 = float(d0[d0.shape[0] // 2 - 1:d0.shape[0] // 2 + 1, d0.shape[1] // 2 - 1:d0.shape[1] // 2 + 1].mean())

    @staticmethod
    def _sample(arr, x, z, extent):
        h, w = arr.shape[:2]
        shape = np.shape(x)
        u = ((np.ravel(x) / extent + 0.5) * w - 0.5).astype(np.float32)
        v = ((np.ravel(z) / extent + 0.5) * h - 0.5).astype(np.float32)
        n, cols = u.size, 1024
        rows = -(-n // cols)
        pad = rows * cols - n
        U = np.pad(u, (0, pad)).reshape(rows, cols); V = np.pad(v, (0, pad)).reshape(rows, cols)
        parts = [cv2.remap(arr, U[r:r + 16000], V[r:r + 16000], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE) for r in range(0, rows, 16000)]
        out = np.concatenate(parts, 0).reshape((rows * cols,) + arr.shape[2:])[:n].reshape(shape + arr.shape[2:])
        return out, (np.abs(np.asarray(x)) < extent / 2) & (np.abs(np.asarray(z)) < extent / 2)

    def height(self, x, z):
        out = np.zeros_like(x, dtype=np.float32)
        done = np.zeros_like(x, dtype=bool)
        for L in self.layers:
            h, inside = self._sample(L["dem"], x, z, L["extent"])
            m = inside & ~done
            out[m] = h[m] - self.ground0
            done |= inside
        return out, done

    def colour(self, x, z, only=None):
        out = np.zeros(x.shape + (3,), np.uint8)
        done = np.zeros_like(x, dtype=bool)
        for L in (self.layers if only is None else [self.layers[only]]):
            c, inside = self._sample(L["img"], x, z, L["extent"])
            m = inside & ~done
            out[m] = c[m]
            done |= inside
        return out, done

    def sea(self, x, z, only=-1):
        """True offshore (no elevation, or no aerial survey)."""
        s, _ = self._sample(self.layers[only]["sea"], x, z, self.layers[only]["extent"])
        return s > 0.5


# ---------------------------------------------------------------- cameras
def look_rotation(forward, up=(0.0, 1.0, 0.0)):
    """Camera-to-world rotation (columns right, up, back) for a RUB camera looking along `forward`."""
    f = np.asarray(forward, float); f /= np.linalg.norm(f)
    r = np.cross(f, up)
    if np.linalg.norm(r) < 1e-6:
        r = np.array([1.0, 0, 0])
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return np.stack([r, u, -f], 1)


def quat_xyzw(R):
    m = R
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q); return (q / np.linalg.norm(q)).tolist()


def quat_matrix(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def camera(C, R, W, H, f):
    return {"extrinsics": {"position": [float(v) for v in C], "quaternion": quat_xyzw(R), "coordinateSystem": "rub"},
            "intrinsics": {"fx": float(f), "fy": float(f), "cx": W / 2, "cy": H / 2, "width": W, "height": H}}


def rays(cam):
    K = cam["intrinsics"]
    R = quat_matrix(cam["extrinsics"]["quaternion"])
    ys, xs = np.mgrid[0:K["height"], 0:K["width"]].astype(np.float32)
    local = np.stack([(xs + 0.5 - K["cx"]) / K["fx"], -(ys + 0.5 - K["cy"]) / K["fy"], -np.ones_like(xs)], -1)
    return local @ R.T, R   # unnormalised: the -Z component is 1, so t along it is planar depth


def trace(T, cam, max_planar=2500.0, colour_layer=None):
    """Planar depth and colour where each pixel's ray meets the terrain (NaN where it does not)."""
    d, R = rays(cam)
    C = np.array(cam["extrinsics"]["position"], np.float32)
    H, W = d.shape[:2]
    depth = np.full((H, W), np.nan, np.float32)
    hit = np.zeros((H, W), bool)
    t_prev = np.zeros((H, W), np.float32)
    t = np.full((H, W), 0.5, np.float32)
    while True:
        p = C + d * t[..., None]
        h, inside = T.height(p[..., 0], p[..., 2])
        below = (p[..., 1] <= h) & inside & ~hit
        if below.any():   # refine the crossing by bisection
            lo, hi = t_prev[below], t[below]
            dd = d[below]
            for _ in range(12):
                mid = (lo + hi) / 2
                q = C + dd * mid[:, None]
                hh, _ = T.height(q[:, 0], q[:, 2])
                under = q[:, 1] <= hh
                hi = np.where(under, mid, hi); lo = np.where(under, lo, mid)
            depth[below] = hi
            hit |= below
        t_prev = t.copy()
        active = ~hit & (t <= max_planar)
        if not active.any():
            break
        t = np.where(active, t * 1.04 + 0.25, t)
    p = C + d * np.nan_to_num(depth, nan=0.0)[..., None]
    col, _ = T.colour(p[..., 0], p[..., 2], only=colour_layer)
    col[~hit] = 0
    return depth, col, hit


def topdown(T, extent_ew, extent_ns, H_alt, W, Hpx, colour_layer=None, centre=(0.0, 0.0)):
    """A straight-down camera over the spot (or over `centre`, metres east and south of it) whose ground footprint is
    extent_ew x extent_ns metres."""
    f = (W / 2) * H_alt / (extent_ew / 2)
    R = np.stack([[1, 0, 0], [0, 0, -1], [0, 1, 0]], 1).astype(float)   # right = east, up = north, back = up
    cam = camera([float(centre[0]), H_alt, float(centre[1])], R, W, Hpx, f)
    depth, col, hit = trace(T, cam, max_planar=H_alt * 3, colour_layer=colour_layer)
    return cam, col, depth, hit


# ---------------------------------------------------------------- the photo in the local frame
def photo_pose(place_cfg, posed, T):
    """Rotation from the photo's ground normal (in its own camera frame) and the known heading; height from the
    ground fit; depth scale from place_cfg."""
    pose_dir = ROOT / "work" / "pose" / place_cfg["name"]
    fr = posed["frames"][place_cfg.get("photo_index", 0)]
    K = fr["camera"]["intrinsics"]
    dep = cv2.imread(str(pose_dir / fr["depth"]), cv2.IMREAD_UNCHANGED)
    dep = dep if dep.ndim == 2 else dep[..., 0]
    H, W = dep.shape
    ys, xs = np.mgrid[0:H, 0:W]
    X = (xs + 0.5 - K["cx"]) / K["fx"] * dep; Y = -(ys + 0.5 - K["cy"]) / K["fy"] * dep; Z = -dep
    x0, x1, y0 = place_cfg["ground_region"]
    m = np.isfinite(dep) & (dep > 0) & (ys > y0 * H) & ((xs < x0 * W) | (xs > x1 * W))   # ground beside the subject
    P = np.stack([X[m], Y[m], Z[m]], 1)
    rng = np.random.default_rng(0)
    best = None
    for _ in range(400):
        s = P[rng.choice(len(P), 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0])
        if np.linalg.norm(n) < 1e-9:
            continue
        n /= np.linalg.norm(n)
        inl = np.abs((P - s[0]) @ n) < 0.05
        if best is None or inl.sum() > best[0]:
            best = (inl.sum(), n, s[0])
    n, p0 = best[1], best[2]
    n = n if n[1] > 0 else -n
    height_units = abs(float(p0 @ n))
    # rotation: camera-frame (up_c, fwd_h, right) -> world (up, heading, right)
    up_c = n
    f_c = np.array([0, 0, -1.0]); f_h = f_c - (f_c @ up_c) * up_c; f_h /= np.linalg.norm(f_h)
    r_c = np.cross(f_h, up_c)
    b = math.radians(place_cfg["heading_deg"])
    up_w = np.array([0, 1.0, 0]); f_w = np.array([math.sin(b), 0, -math.cos(b)]); r_w = np.cross(f_w, up_w)
    R = np.stack([up_w, f_w, r_w], 1) @ np.stack([up_c, f_h, r_c], 1).T
    s = place_cfg["camera_height_m"] / height_units if "camera_height_m" in place_cfg else place_cfg["metres_per_unit"]
    C = np.array([0.0, height_units * s, 0.0])
    cam = {"extrinsics": {"position": C.tolist(), "quaternion": quat_xyzw(R), "coordinateSystem": "rub"}, "intrinsics": K}
    info = dict(ground_normal_cam=n.round(4).tolist(), camera_height_units=round(height_units, 3), camera_height_m=round(height_units * s, 3),
                pitch_deg=round(math.degrees(math.asin((R @ np.array([0, 0, -1.0]))[1])), 2),
                roll_deg=round(math.degrees(math.asin((R @ np.array([1.0, 0, 0]))[1])), 2), metres_per_unit=round(s, 4))
    return cam, dep * s, info, R, s


def place_photos(place_cfg, posed, T):
    """All the photos of a place in the local frame. The main one is placed from its ground plane, heading and
    scale; the others (posed jointly with it) follow by the same similarity transform."""
    main = place_cfg.get("photo_index", 0)
    pose_dir = ROOT / "work" / "pose" / place_cfg["name"]
    cam_main, _, info, R_main, s = photo_pose(place_cfg, posed, T)
    fm = posed["frames"][main]["camera"]["extrinsics"]
    R_align = R_main @ quat_matrix(fm["quaternion"]).T
    C_main = np.array(cam_main["extrinsics"]["position"])
    out = []
    for i, fr in enumerate(posed["frames"]):
        e = fr["camera"]["extrinsics"]
        R = R_align @ quat_matrix(e["quaternion"])
        C = C_main + s * R_align @ (np.array(e["position"]) - np.array(fm["position"]))
        dep = cv2.imread(str(pose_dir / fr["depth"]), cv2.IMREAD_UNCHANGED)
        dep = dep if dep.ndim == 2 else dep[..., 0]
        out.append(dict(name="photo" if i == main else f"photo-{Path(fr['photo']).stem}", main=i == main,
                        cam={"extrinsics": {"position": C.tolist(), "quaternion": quat_xyzw(R), "coordinateSystem": "rub"},
                             "intrinsics": fr["camera"]["intrinsics"]},
                        depth_m=dep * s, img=cv2.imread(str(pose_dir / fr["image"])),
                        conf=cv2.imread(str(pose_dir / fr["confidence"]), cv2.IMREAD_UNCHANGED)))
    return out, info


def subject_point(sw, photos):
    """The swivel's subject in the local frame: a pixel (fractions) of one photo at its depth."""
    ph = photos[sw.get("subject_photo", 0)]
    if "subject_local" in sw:
        R = quat_matrix(ph["cam"]["extrinsics"]["quaternion"])
        return np.array(ph["cam"]["extrinsics"]["position"]) + R @ np.array(sw["subject_local"])
    K = ph["cam"]["intrinsics"]; d = ph["depth_m"]
    u, v = sw["subject_px"][0] * K["width"], sw["subject_px"][1] * K["height"]
    for half in (12, 24, 48, 96):   # widen until the box holds some depth (hair and edges can be empty)
        box = d[max(0, int(v) - half):int(v) + half, max(0, int(u) - half):int(u) + half]
        box = box[np.isfinite(box) & (box > 0)]
        if box.size > 20:
            break
    z = float(np.median(box))
    R = quat_matrix(ph["cam"]["extrinsics"]["quaternion"])
    local = np.array([(u - K["cx"]) / K["fx"] * z, -(v - K["cy"]) / K["fy"] * z, -z])
    return np.array(ph["cam"]["extrinsics"]["position"]) + R @ local


GEN_W, GEN_H = 1280, 720


def to_generated_grid(cam, layers):
    """Crop a band (or columns) centred on the principal point to 16:9 and scale it to 1280x720, keeping the
    camera centre and orientation; intrinsics follow the pixels."""
    K = dict(cam["intrinsics"])
    H, W = layers[0].shape[:2]
    if W / H < GEN_W / GEN_H:          # portrait or narrower: keep full width, a band of rows
        bh = W * GEN_H / GEN_W
        r0 = int(round(K["cy"] - bh / 2)); r0 = min(max(r0, 0), H - int(round(bh)))
        box = (0, r0, W, int(round(bh)))
    else:
        bw = H * GEN_W / GEN_H
        c0 = int(round(K["cx"] - bw / 2)); c0 = min(max(c0, 0), W - int(round(bw)))
        box = (c0, 0, int(round(bw)), H)
    x0, y0, w, h = box
    sx, sy = GEN_W / w, GEN_H / h
    out = []
    for i, L in enumerate(layers):
        crop = L[y0:y0 + h, x0:x0 + w]
        out.append(cv2.resize(crop, (GEN_W, GEN_H), interpolation=cv2.INTER_CUBIC if i == 0 else cv2.INTER_NEAREST))
    K2 = {"fx": K["fx"] * sx, "fy": K["fy"] * sy, "cx": (K["cx"] - x0) * sx, "cy": (K["cy"] - y0) * sy, "width": GEN_W, "height": GEN_H}
    return {"extrinsics": cam["extrinsics"], "intrinsics": K2}, out


def reframe(cam, layers, pitch_down_deg, f=None):
    """The same photo seen from the same point by a camera tilted down by pitch_down_deg (a pure rotation, so no
    parallax and no holes), on the generated 1280x720 grid with a centred principal point. Beyond the photo's
    edges: black, no depth, confidence 0."""
    K = cam["intrinsics"]
    f = f or K["fx"] * GEN_W / K["width"]
    img, depth, conf = layers
    H, W = img.shape[:2]
    th = math.radians(-pitch_down_deg)
    Rx = np.array([[1, 0, 0], [0, math.cos(th), -math.sin(th)], [0, math.sin(th), math.cos(th)]])   # new-camera vectors -> old camera
    ys, xs = np.mgrid[0:GEN_H, 0:GEN_W].astype(np.float32)
    ray_new = np.stack([(xs + 0.5 - GEN_W / 2) / f, -(ys + 0.5 - GEN_H / 2) / f, -np.ones_like(xs)], -1)
    ray_old = ray_new @ Rx.T
    zo = -ray_old[..., 2]
    X = (ray_old[..., 0] / zo * K["fx"] + K["cx"] - 0.5).astype(np.float32)
    Y = (-ray_old[..., 1] / zo * K["fy"] + K["cy"] - 0.5).astype(np.float32)
    inside = (zo > 0) & (X >= 0) & (X <= W - 1) & (Y >= 0) & (Y <= H - 1)
    img2 = cv2.remap(img, X, Y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    d_old = cv2.remap(np.nan_to_num(depth, nan=0.0).astype(np.float32), X, Y, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    depth2 = np.where(inside & (d_old > 0), d_old / zo, np.nan).astype(np.float32)   # planar depth along the new axis
    conf2 = np.where(inside, cv2.remap(conf.astype(np.uint8), X, Y, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0), 0).astype(np.uint8)
    R2 = quat_matrix(cam["extrinsics"]["quaternion"]) @ Rx
    cam2 = {"extrinsics": {"position": cam["extrinsics"]["position"], "quaternion": quat_xyzw(R2), "coordinateSystem": "rub"},
            "intrinsics": {"fx": float(f), "fy": float(f), "cx": GEN_W / 2, "cy": GEN_H / 2, "width": GEN_W, "height": GEN_H}}
    return cam2, (img2, depth2, conf2)


# ---------------------------------------------------------------- the approach
def approach(place_cfg, photo_cam, T, photos=None):
    """Targets from high above, down to the photo's viewpoint, then a slight swivel toward the subject."""
    W, Hpx = 1280, 720
    f = (W / 2) / math.tan(math.radians(place_cfg.get("target_hfov", 75)) / 2)
    P_end = np.array(photo_cam["extrinsics"]["position"])
    R_end = quat_matrix(photo_cam["extrinsics"]["quaternion"])
    fwd_end = -R_end[:, 2]
    head = np.array([fwd_end[0], 0, fwd_end[2]]); head /= np.linalg.norm(head)
    a = place_cfg["approach"]
    n = a["frames"]
    targets = []
    p_end = math.degrees(math.asin(fwd_end[1]))
    right_w = np.cross(head, [0, 1, 0])
    for i in range(n):
        # a dive: the same altitude ratio every frame, looking almost straight down at first and tilting up
        # toward the photo's own view as it comes down; the spot stays in view (camera kept behind it along
        # the heading so the view's centre falls near the spot)
        s = i / (n - 1)
        alt = math.exp(math.log(a["start_alt_m"] + P_end[1]) * (1 - s) + math.log(P_end[1]) * s)
        pitch = a.get("start_pitch_deg", -70.0) + (p_end - a.get("start_pitch_deg", -70.0)) * s ** a.get("pitch_curve", 1.4)
        dist = (alt - P_end[1]) / math.tan(math.radians(max(-pitch, a.get("min_glide_deg", 15.0))))
        side = a.get("start_side_m", 0.0) * (1 - s) ** 2
        C = P_end - head * dist + right_w * side
        C[1] = alt
        if 0 < i < n - 1:   # never below the ground under the camera (canyons, slopes)
            g = float(T.height(np.array([C[0]]), np.array([C[2]]))[0][0])
            C[1] = max(C[1], g + 1.8)
        p = math.radians(pitch)
        fwd = head * math.cos(p) + np.array([0, 1.0, 0]) * math.sin(p)
        R = look_rotation(fwd)
        if i == n - 1:
            C, R = P_end, R_end
        targets.append(dict(kind="approach", camera=camera(C, R, W, Hpx, f)))
    sw = place_cfg.get("swivel")
    if sw and sw.get("mode") == "orbit_to":
        # a real orbit around the subject, from the main photo's viewpoint to another photo's (both real views)
        S = subject_point(sw, photos)
        to = photos[sw["to_photo"]]["cam"]
        C1 = np.array(to["extrinsics"]["position"]); R1 = quat_matrix(to["extrinsics"]["quaternion"])
        v0, v1 = P_end - S, C1 - S
        a0, a1 = math.atan2(v0[0], v0[2]), math.atan2(v1[0], v1[2])
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        if sw.get("direction") == "long":
            da = da - math.copysign(2 * math.pi, da)
        r0, r1 = math.hypot(v0[0], v0[2]), math.hypot(v1[0], v1[2])
        n = sw["frames"]
        lift, bulge = sw.get("lift_m", 0.0), sw.get("bulge", 0.0)
        for k in range(1, n + 1):
            t = k / n
            arc = math.sin(math.pi * t)   # 0 at both photos, 1 halfway: a crane move over chairs and bushes
            a = a0 + da * t
            r = (r0 + (r1 - r0) * t) * (1 + bulge * arc)
            C = S + np.array([math.sin(a) * r, 0.0, math.cos(a) * r])
            C[1] = P_end[1] + (C1[1] - P_end[1]) * t + lift * arc
            if k == n:
                targets.append(dict(kind="orbit", camera=camera(C1, R1, W, Hpx, f)))
                break
            look = S - C
            if not lift:
                look[1] *= 0.6
            targets.append(dict(kind="orbit", camera=camera(C, look_rotation(look), W, Hpx, f)))
    elif sw:
        S = subject_point(sw, photos) if photos else P_end + R_end @ np.array(sw["subject_local"])
        for k in range(1, sw["frames"] + 1):
            ang = math.radians(sw["degrees"] * k / sw["frames"])
            v = P_end - S
            v[1] = 0
            r = np.linalg.norm(v) * (1 - sw.get("closer", 0.2) * k / sw["frames"])
            v = v / np.linalg.norm(v)
            rot = np.array([[math.cos(ang), 0, math.sin(ang)], [0, 1, 0], [-math.sin(ang), 0, math.cos(ang)]])
            C = S + rot @ v * r
            C[1] = P_end[1]
            look = S - C
            look[1] = (S[1] - C[1]) * 0.5
            fwd = look / np.linalg.norm(look) * 0.6 + (rot @ fwd_end) * 0.4
            targets.append(dict(kind="swivel", camera=camera(C, look_rotation(fwd), W, Hpx, f)))
    return targets


# ---------------------------------------------------------------- io
def write_frame(out, name, img, depth, conf):
    out.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out / f"{name}.png"), img)
    cv2.imwrite(str(out / f"{name}-depth.exr"), depth.astype(np.float32), [cv2.IMWRITE_EXR_TYPE, cv2.IMWRITE_EXR_TYPE_HALF])
    cv2.imwrite(str(out / f"{name}-confidence.png"), conf.astype(np.uint8))


def main():
    name = sys.argv[1]
    cfg = json.loads((ROOT / "places.json").read_text())[name]
    cfg["name"] = name
    T = Terrain(name)
    posed = json.loads((ROOT / "work" / "pose" / name / "posed.json").read_text())
    out = ROOT / "work" / "scene" / name
    ctx = out / "context"
    frames = []

    # the photos
    photos, info = place_photos(cfg, posed, T)
    for ph in photos:
        td, tcol, thit = trace(T, ph["cam"])
        near = np.isfinite(ph["depth_m"]) & (ph["depth_m"] < NEAR)
        depth = np.where(near, ph["depth_m"], np.where(thit, td, np.nan)).astype(np.float32)
        conf = np.where(near, ph["conf"], np.where(thit, 200, 0)).astype(np.uint8)
        # context frames must be at the generated size (1280x720) with a centred principal point to be used fully:
        # a portrait photo gives up its top and bottom (a band centred on its principal point, scaled up)
        ctx_cam, (img_c, depth_c, conf_c) = to_generated_grid(ph["cam"], (ph["img"], depth, conf))
        write_frame(ctx, ph["name"], img_c, depth_c, conf_c)
        frames.append(dict(name=ph["name"], camera=ctx_cam))
        # a portrait photo's bottom (the ground, people, cars) would be lost: a second strip, tilted down so that its
        # lower edge is the photo's lower edge (or the tilts listed in "strips_down_deg", chosen in atlas-studio)
        K = ph["cam"]["intrinsics"]
        pitch_down = math.degrees(math.atan((K["height"] - K["cy"]) / K["fy"]) - math.atan(GEN_H / 2 / ctx_cam["intrinsics"]["fy"]))
        for k, pitch_down in enumerate(cfg.get("strips_down_deg", [pitch_down] if pitch_down > 3 else [])):
            # narrower than the photo where needed, so the tilted view stays inside it: World Labs paints black
            # borders as dark objects (a phantom fence, a black frame at the spot), whatever their confidence says
            f_low = ctx_cam["intrinsics"]["fx"]
            while True:
                low_cam, (li, ld, lc) = reframe(ph["cam"], (ph["img"], depth, conf), pitch_down, f=f_low)
                if li[[0, -1], :].max(-1).min() > 0 and li[:, [0, -1]].max(-1).min() > 0:
                    break
                f_low *= 1.02
            strip = ph["name"] + "-low" + (str(k + 1) if k else "")
            write_frame(ctx, strip, li, ld, lc)
            frames.append(dict(name=strip, camera=low_cam))
            print(f"{ph['name']}: a strip tilted down {pitch_down:.1f} deg")
        if ph["main"]:
            pcam, pimg, tcol = ph["cam"], ph["img"], tcol

    # the aerial views, straight down, at the generated size
    for label, (ew, alt, *centre) in cfg["aerial_views"].items():   # [width, altitude] or [.., east, south] of its centre
        ns = ew * GEN_H / GEN_W
        layer = 0 if "close" in label else (1 if "wide" in label else None)   # "mid" uses both (close where it covers)
        acam, acol, adep, ahit = topdown(T, ew, ns, alt, GEN_W, GEN_H, colour_layer=layer, centre=centre or (0.0, 0.0))
        write_frame(ctx, label, acol, np.where(ahit, adep, np.nan), np.where(ahit, 230, 0))
        frames.append(dict(name=label, camera=acam))

    targets = approach(cfg, pcam, T, photos)
    (out / "context.json").write_text(json.dumps(dict(place=name, frames=frames, photo_pose=info), indent=1))
    (out / "targets.json").write_text(json.dumps(targets, indent=1))

    # checks: registration (photo | the same view from the aerial + terrain), and the planned path
    reg = np.hstack([pimg, tcol])
    cv2.imwrite(str(out / "check-registration.jpg"), cv2.resize(reg, None, fx=0.6, fy=0.6), [cv2.IMWRITE_JPEG_QUALITY, 85])
    previews = []
    for t in targets[:: max(1, len(targets) // 6)][:6]:
        d, c, h = trace(T, t["camera"], max_planar=4000)
        c = c.copy(); c[~h] = (60, 40, 30)
        previews.append(cv2.resize(c, (427, 240)))
    grid = np.vstack([np.hstack(previews[i:i + 3]) for i in range(0, 6, 3)]) if len(previews) == 6 else np.hstack(previews)
    mp = cv2.resize(T.layers[1]["img"], (720, 720))
    ext = T.layers[1]["extent"]
    for t in targets:
        C = t["camera"]["extrinsics"]["position"]
        u, v = int((C[0] / ext + 0.5) * 720), int((C[2] / ext + 0.5) * 720)
        cv2.circle(mp, (u, v), 4, (0, 255, 255) if t["kind"] == "approach" else (255, 0, 255), -1)
        R = quat_matrix(t["camera"]["extrinsics"]["quaternion"]); fw = -R[:, 2]
        cv2.line(mp, (u, v), (int(u + 25 * fw[0]), int(v + 25 * fw[2])), (0, 200, 255), 1)
    cv2.putText(mp, "path (top = north)", (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    gh = grid.shape[0]
    mp = cv2.resize(mp, (gh, gh))
    cv2.imwrite(str(out / "check-path.jpg"), np.hstack([mp, grid]), [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(json.dumps(dict(photo_pose=info, context=[f["name"] for f in frames], targets=len(targets),
                          altitudes=[round(t["camera"]["extrinsics"]["position"][1], 1) for t in targets]), indent=1))


if __name__ == "__main__":
    main()
