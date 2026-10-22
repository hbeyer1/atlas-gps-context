"""Public-domain map data around one point: USGS NAIP aerial imagery and USGS 3DEP elevation, north-up in Web
Mercator, at two scales (a 600 m 'close' square and a 4 km 'wide' square).

  python3 fetch_aerial.py <out-dir> --place <name> <lat> <lon> [--fine]
      -> <out-dir>/<name>/{naip,dem}-{close,wide}.{jpg,tif} + meta.json
      --fine: at the servers' full detail (FINE_SCALES) instead of the lighter SCALES
"""
import json, math, subprocess, sys
from pathlib import Path

SCALES = {"wide": (4000, 2048, 512), "close": (600, 1024, 512)}   # ground metres, imagery px, elevation px
# about what the aerial context frames need (0.35-1.25 m per pixel): imagery 0.6 m close and 1 m wide (the NAIP server
# returns at most 4000 px), elevation 1 m and 2 m
FINE_SCALES = {"wide": (4000, 4000, 2000), "close": (600, 1024, 600)}
NAIP = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
DEM = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
R = 6378137.0


def mercator(lat, lon):
    return math.radians(lon) * R, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R


def drop_nodata_fringe(path):
    """The elevation server resamples its no-data value (open sea) into the pixels near it, which come back as spikes
    thousands of metres high or deep, up to ~7 px out where coarser seafloor-edge data meets it: mark everything within
    8 px of no data as no data too (a few metres of cliff edge become sea level)."""
    import numpy as np
    from PIL import Image
    dem = np.array(Image.open(path), dtype=np.float32)
    nodata = ~np.isfinite(dem) | (np.abs(dem) > 1e30)
    r = 8
    padded, grown = np.pad(nodata, r), np.zeros_like(nodata)
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            grown |= padded[dy:dy + dem.shape[0], dx:dx + dem.shape[1]]
    dem[grown] = np.float32(-3.4028235e38)
    Image.fromarray(dem).save(path)


def get(url, out):
    if out.exists() and out.stat().st_size > 1000:
        return
    subprocess.run(["curl", "-s", "-f", "-m", "300", "--retry", "4", "--retry-delay", "5", "--retry-all-errors",
                    "-o", str(out), url], check=True)


def main():
    root = Path(sys.argv[1])
    i = sys.argv.index("--place")
    name, lat, lon = sys.argv[i + 1], float(sys.argv[i + 2]), float(sys.argv[i + 3])
    fine = "--fine" in sys.argv
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    x, y = mercator(lat, lon)
    meta = dict(lat=lat, lon=lon, mercator=[x, y], source="USGS NAIP + USGS 3DEP (public domain)", scales={})
    for scale, (metres, px, dem_px) in (FINE_SCALES if fine else SCALES).items():
        half = metres / 2 / math.cos(math.radians(lat))   # mercator units for that many ground metres
        bbox = f"{x - half},{y - half},{x + half},{y + half}"
        quality = "&compressionQuality=92" if fine else ""
        get(f"{NAIP}?bbox={bbox}&bboxSR=3857&imageSR=3857&size={px},{px}&format=jpg{quality}&f=image", d / f"naip-{scale}.jpg")
        get(f"{DEM}?bbox={bbox}&bboxSR=3857&imageSR=3857&size={dem_px},{dem_px}&format=tiff&pixelType=F32"
            f"&interpolation=RSP_BilinearInterpolation&f=image", d / f"dem-{scale}.tif")
        if fine:
            drop_nodata_fringe(d / f"dem-{scale}.tif")
        meta["scales"][scale] = dict(ground_metres=metres, naip_px=px, dem_px=dem_px, bbox_3857=bbox,
                                     metres_per_naip_px=metres / px, metres_per_dem_px=metres / dem_px)
        print(name, scale, "ok")
    (d / "meta.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
