#!/usr/bin/env python3
"""Stage survey photos for OpenDroneMap.

Collects the photos attached to editor routes (photos/<route id>/), or the
JPEGs of a directory, into odm/<project>/images/, and gives each copy the
lens data the Fimi omits from its EXIF (focal length NaN, 35 mm equivalent 0)
so OpenSfM can seed its camera model: 4.71 mm, and a 35 mm equivalent of
27 mm, which is what the 79 degree diagonal field of view works out to on a
4:3 frame. Bundle adjustment refines it from there.

    ./odm/stage.py <project> --routes 10 11 12
    ./odm/stage.py <project> --dir /media/$USER/SDCARD/DCIM/100DRONE --newest 60
"""
import argparse, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from ortho import IMAGE_EXTS, capture_time, stage_photos  # noqa: E402


def route_ids_by_pattern(pattern):
    conn = sqlite3.connect(os.path.join(ROOT, "fimi.db"))
    ids = [r[0] for r in conn.execute("SELECT _id FROM X8_AI_LINE_POINT_INFO WHERE NAME LIKE ? ORDER BY _id", (pattern,))]
    conn.close()
    return ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--routes", nargs="*", type=int, default=[], help="editor route ids whose attached photos to use")
    ap.add_argument("--like", help="SQL LIKE pattern on route names, e.g. '%%grid 13Sep%%'")
    ap.add_argument("--dir", help="a directory of JPEGs instead of, or as well as, routes")
    ap.add_argument("--newest", type=int, help="with --dir: only the newest N photos by capture time")
    ap.add_argument("--no-exif-fix", action="store_true", help="leave the lens EXIF as the camera wrote it")
    a = ap.parse_args()

    ids = list(a.routes) + (route_ids_by_pattern(a.like) if a.like else [])
    sources = []
    for rid in ids:
        d = os.path.join(ROOT, "photos", str(rid))
        if not os.path.isdir(d):
            sys.exit("route %d has no attached photos (%s)" % (rid, d))
        sources += [os.path.join(d, n) for n in os.listdir(d) if n.lower().endswith(IMAGE_EXTS)]
    if a.dir:
        files = [os.path.join(a.dir, n) for n in os.listdir(a.dir) if n.lower().endswith(IMAGE_EXTS)]
        files.sort(key=capture_time)
        if a.newest:
            files = files[-a.newest:]
        sources += files
    if not sources:
        sys.exit("no photos found")

    dest = os.path.join(HERE, a.project, "images")
    try:
        n = stage_photos(dest, sources, fix_exif=not a.no_exif_fix)
    except ValueError as e:
        sys.exit("%s; remove it or pick another project name" % e)
    print("staged %d photos in %s" % (n, dest))
    print("next: ./odm/run.sh %s" % a.project)


if __name__ == "__main__":
    main()
