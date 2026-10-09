"""Orthophotos with OpenDroneMap, from the photos attached to a chain of routes.

A survey grid is saved as several routes linked by their Next route
(AUTO_RECORD); the photos of each are attached in the editor (photos/<id>/).
A build stages every photo of the chain into odm/<project>/images/ with the
lens EXIF the Fimi leaves blank, then runs odm/run.sh (Docker, GPU if there
is one), the same as doing it by hand with odm/stage.py and odm/run.sh.
Finally the orthophoto is reprojected to web Mercator as a PNG the map can
lay over the satellite imagery.

ODM writes its outputs as root, so a project folder is never reused or
deleted from here: every build gets a new one, next to the earlier ones.
"""
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ODM_DIR = os.path.join(HERE, "odm")
IMAGE_EXTS = (".jpg", ".jpeg")
META = "fimifly.json"             # in each project folder built from here
PREVIEW_MAX_PX = 4096
# ODM's stages, in order, with their share of the time on the last full run
# (48 photos, GPU): progress is reported by stage.
STAGES = [("dataset", 0), ("split", 0), ("merge", 0), ("opensfm", 74), ("openmvs", 46),
          ("odm_filterpoints", 4), ("odm_meshing", 93), ("mvs_texturing", 91),
          ("odm_georeferencing", 5), ("odm_dem", 4), ("odm_orthophoto", 35),
          ("odm_report", 9), ("odm_postprocess", 0)]
STAGE_RE = re.compile(r"Running (\w+) stage")
RUNNING = ("staging", "running", "preview")


def capture_time(path):
    try:
        ex = Image.open(path).getexif().get_ifd(0x8769)
        return str(ex.get(36867) or "")
    except Exception:  # noqa: BLE001 - unreadable EXIF sorts first
        return ""


def stage_photos(dest, sources, fix_exif=True):
    """Copy ``sources`` into ``dest`` in capture order (renaming clashes), and
    give the copies the Fimi's lens data: 4.71 mm, 27 mm equivalent (79 degree
    diagonal on a 4:3 frame), which OpenSfM's camera model starts from."""
    if os.path.isdir(dest) and os.listdir(dest):
        raise ValueError("%s already has images" % dest)
    os.makedirs(dest, exist_ok=True)
    names = set()
    for src in sorted(sources, key=capture_time):
        name = os.path.basename(src)
        if name in names:                       # same file name from two routes: keep both
            stem, ext = os.path.splitext(name)
            k = 2
            while "%s_%d%s" % (stem, k, ext) in names:
                k += 1
            name = "%s_%d%s" % (stem, k, ext)
        names.add(name)
        shutil.copy2(src, os.path.join(dest, name))
    if fix_exif:
        subprocess.run(["exiftool", "-overwrite_original", "-q", "-FocalLength=4.71",
                        "-FocalLengthIn35mmFormat=27", "-DigitalZoomRatio=1", dest], check=True)
    return len(names)


def route_photos(photo_root, rid):
    d = os.path.join(photo_root, str(rid))
    if not os.path.isdir(d):
        return []
    return sorted(os.path.join(d, n) for n in os.listdir(d) if n.lower().endswith(IMAGE_EXTS))


def chain_of(db_path, rid):
    """The route ids of ``rid``'s chain, first to last: back along the routes
    whose Next route leads to it, then forward along the links."""
    db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    try:
        rows = db.execute("SELECT _id, NAME, AUTO_RECORD FROM X8_AI_LINE_POINT_INFO").fetchall()
    finally:
        db.close()
    names = {r[0]: r[1] or "" for r in rows}
    nxt = {r[0]: r[2] for r in rows if r[2] and r[2] in names and r[2] != r[0]}
    prev = {}
    for a, b in nxt.items():
        prev.setdefault(b, []).append(a)
    if rid not in names:
        raise KeyError("no route #%d" % rid)
    head, seen = rid, {rid}
    while len(prev.get(head, [])) == 1 and prev[head][0] not in seen:
        head = prev[head][0]
        seen.add(head)
    ids, seen = [head], {head}
    while nxt.get(ids[-1]) and nxt[ids[-1]] not in seen:
        ids.append(nxt[ids[-1]])
        seen.add(ids[-1])
    return [(i, names[i]) for i in ids]


def project_name(route_names):
    """From the grid's route names ("1/3 grid 4Oct 14:21"): "grid-4oct-1421",
    with -2, -3... when that folder exists."""
    base = re.sub(r"^\s*\d+/\d+\s*", "", route_names[0] if route_names else "") or "ortho"
    base = re.sub(r"[^a-z0-9]+", "-", base.lower().replace(":", "")).strip("-")[:40] or "ortho"
    name, k = base, 2
    while os.path.exists(os.path.join(ODM_DIR, name)):
        name, k = "%s-%d" % (base, k), k + 1
    return name


def make_preview(project_dir):
    """odm_orthophoto.tif -> preview.png in web Mercator (what the map draws
    in, so an image overlay lines up exactly) + its lat/lon bounds."""
    import numpy as np
    import rasterio
    from rasterio.warp import Resampling, calculate_default_transform, reproject, transform_bounds

    src_path = os.path.join(project_dir, "odm_orthophoto", "odm_orthophoto.tif")
    with rasterio.open(src_path) as src:
        dst_crs = "EPSG:3857"
        tr, w, h = calculate_default_transform(src.crs, dst_crs, src.width, src.height, *src.bounds)
        k = max(1.0, max(w, h) / PREVIEW_MAX_PX)
        w, h = int(w / k), int(h / k)
        tr = tr * tr.scale(k, k)
        bands = min(src.count, 4)
        out = []
        for b in range(1, bands + 1):
            a = np.zeros((h, w), dtype=src.dtypes[b - 1])
            reproject(rasterio.band(src, b), a, src_transform=src.transform, src_crs=src.crs,
                      dst_transform=tr, dst_crs=dst_crs, resampling=Resampling.average)
            out.append(a)
        west, north = tr * (0, 0)
        east, south = tr * (w, h)
        w84 = transform_bounds(dst_crs, "EPSG:4326", west, south, east, north)
    arr = np.dstack(out)
    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    Image.fromarray(arr, "RGBA" if bands == 4 else "RGB").save(os.path.join(project_dir, "preview.png"))
    bounds = [[w84[1], w84[0]], [w84[3], w84[2]]]      # [[south, west], [north, east]]
    with open(os.path.join(project_dir, "preview.json"), "w") as f:
        json.dump({"bounds": bounds}, f)
    return bounds


def read_meta(project_dir):
    try:
        with open(os.path.join(project_dir, META)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_meta(project_dir, meta):
    tmp = os.path.join(project_dir, META + ".tmp")
    with open(tmp, "w") as f:
        json.dump(meta, f, indent=1)
    os.replace(tmp, os.path.join(project_dir, META))


def outputs(project):
    """What a finished project has, for the editor."""
    d = os.path.join(ODM_DIR, project)
    out = {}
    for key, rel in (("orthophoto", "odm_orthophoto/odm_orthophoto.tif"),
                     ("kmz", "odm_orthophoto/odm_orthophoto.kmz"),
                     ("dsm", "odm_dem/dsm.tif"),
                     ("report", "odm_report/report.pdf")):
        if os.path.exists(os.path.join(d, rel)):
            out[key] = os.path.join(d, rel)
    try:
        with open(os.path.join(d, "preview.json")) as f:
            out["bounds"] = json.load(f)["bounds"]
        out["preview"] = "/api/ortho/%s/preview.png" % project
    except (OSError, ValueError, KeyError):
        pass
    return out


class OrthoBuilder:
    """One ODM build at a time (it takes the whole GPU)."""

    def __init__(self, db_path, photo_root):
        self.db_path = db_path
        self.photo_root = photo_root
        self.lock = threading.Lock()
        self.job = None                  # dict: project, routes, state, stage, ...
        self.proc = None

    def chain(self, rid):
        return [{"id": i, "name": n, "photos": len(route_photos(self.photo_root, i))}
                for i, n in chain_of(self.db_path, rid)]

    def latest(self, ids):
        """The newest finished or failed build of exactly these routes."""
        best = None
        if not os.path.isdir(ODM_DIR):
            return None
        for name in os.listdir(ODM_DIR):
            m = read_meta(os.path.join(ODM_DIR, name))
            if m and m.get("routes") == ids and (best is None or m.get("started", 0) > best.get("started", 0)):
                best = dict(m, project=name)
        return best

    def status(self, rid):
        chain = self.chain(rid)
        ids = [c["id"] for c in chain]
        with self.lock:
            job = dict(self.job) if self.job else None
        if job and job["routes"] != ids:
            other = job
            job = None
        else:
            other = None
        last = job or self.latest(ids)
        if last and not job and last.get("state") in RUNNING:
            last["state"] = "interrupted"          # the app stopped while it ran
        if last and last.get("state") == "done":
            last["outputs"] = outputs(last["project"])
        if last:
            last["dir"] = os.path.join(ODM_DIR, last["project"])
        return {"chain": chain, "photos": sum(c["photos"] for c in chain), "build": last,
                "busy": other and {"project": other["project"], "routes": other["routes"]}}

    def start(self, rid):
        chain = self.chain(rid)
        with self.lock:
            if self.job and self.job["state"] in RUNNING:
                raise ValueError("an orthophoto build (%s) is already running" % self.job["project"])
            empty = [c for c in chain if not c["photos"]]
            if empty:
                raise ValueError("no photos attached to %s" % ", ".join("#%d %s" % (c["id"], c["name"]) for c in empty))
            project = project_name([c["name"] for c in chain])
            self.job = {"project": project, "routes": [c["id"] for c in chain],
                        "photos": sum(c["photos"] for c in chain), "state": "staging",
                        "stage": None, "stage_i": 0, "stages": len(STAGES), "progress": 0.0,
                        "started": time.time(), "finished": None, "error": None, "cancel": False}
            os.makedirs(os.path.join(ODM_DIR, project))
            write_meta(os.path.join(ODM_DIR, project), self.job)
        threading.Thread(target=self._run, args=(project, chain), daemon=True).start()
        return project

    def cancel(self):
        with self.lock:
            job = self.job
            if not job or job["state"] not in RUNNING:
                raise ValueError("no build is running")
            job["cancel"] = True
        subprocess.run(["docker", "kill", "fimifly-odm-" + job["project"]],
                       capture_output=True, timeout=30)

    def _update(self, project, **kw):
        with self.lock:
            self.job.update(kw)
            write_meta(os.path.join(ODM_DIR, project), self.job)

    def _run(self, project, chain):
        d = os.path.join(ODM_DIR, project)
        try:
            sources = [p for c in chain for p in route_photos(self.photo_root, c["id"])]
            stage_photos(os.path.join(d, "images"), sources)
            if self.job["cancel"]:
                raise InterruptedError
            self._update(project, state="running")
            env = dict(os.environ, ODM_CONTAINER="fimifly-odm-" + project)
            total = sum(w for _, w in STAGES)
            done_w = {name: sum(w for _, w in STAGES[:i]) for i, (name, _) in enumerate(STAGES)}
            with open(os.path.join(d, "run.log"), "wb") as log:
                proc = subprocess.Popen([os.path.join(ODM_DIR, "run.sh"), project], env=env,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                for line in proc.stdout:
                    log.write(line)
                    m = STAGE_RE.search(line.decode("utf-8", "replace"))
                    if m and m.group(1) in done_w:
                        names = [s for s, _ in STAGES]
                        self._update(project, stage=m.group(1), stage_i=names.index(m.group(1)) + 1,
                                     progress=round(done_w[m.group(1)] / total, 3))
                rc = proc.wait()
            if self.job["cancel"]:
                raise InterruptedError
            if rc != 0:
                raise RuntimeError("ODM exited with code %d; see %s" % (rc, os.path.join(d, "run.log")))
            self._update(project, state="preview", stage="map preview", progress=1.0)
            make_preview(d)
            self._update(project, state="done", finished=time.time())
        except InterruptedError:
            self._update(project, state="cancelled", finished=time.time())
        except Exception as e:  # noqa: BLE001 - shown in the editor
            self._update(project, state="failed", error=str(e), finished=time.time())
