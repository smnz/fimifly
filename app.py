#!/usr/bin/env python3
"""Web editor for the Fimi (com.fimi.app.x8m) route database.

Serves a browser UI for browsing, editing and creating waypoint routes stored
in the app's SQLite database (see FILE_FORMAT.md for the schema).
"""

import argparse
import math
import os
import re
import sqlite3
import subprocess
import sys
import time
from urllib.parse import quote
from xml.sax.saxutils import escape

from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("FIMI_DB", os.path.join(HERE, "fimi.db"))
PHOTO_ROOT = os.environ.get("FIMI_PHOTOS", os.path.join(HERE, "photos"))   # one sub-folder per route id

app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="")

# ---------------------------------------------------------------- schema maps

# column -> (python type, default for new rows)
ROUTE_COLUMNS = {
    "TIME": (int, None),                 # filled with now() when absent
    "NAME": (str, "New route"),
    "TYPE": (int, 0),
    "SPEED": (int, 10),
    "SAVE_FLAG": (int, 0),
    "DISTANCE": (float, 0.0),            # recomputed on every write
    "IS_CURVE": (int, 0),
    "MAP_TYPE": (int, 0),            # map PROVIDER, not basemap style — the app writes 0
    "RUN_BY_MAP_OR_VEDIO": (int, 0),
    "DISCONNECT_TYPE": (int, 1),     # 1 = continue mission, confirmed from route "test"
    "EXCUTE_END": (int, 4),
    "AUTO_RECORD": (int, 0),
    "LOCALITY": (str, ""),
    "ESTIMATED_TIME": (str, "0"),
}

POINT_COLUMNS = {
    "NUMBER": (int, 0),                  # rewritten from list order
    "TOTALNUMBER": (int, 0),             # rewritten from list length
    "LONGITUDE": (float, 0.0),
    "LATITUDE": (float, 0.0),
    "ALTITUDE": (int, 60),
    "YAW": (float, 0.0),
    "GIMBAL_PITCH": (int, 0),
    "SPEED": (int, 140),
    "YAW_MODE": (int, 0),
    "GIMBAL_MODE": (int, 0),
    "TRAJECTORY_MODE": (int, 0),
    "MISSION_FINISH_ACTION": (int, 0),
    "R_CLOST_ACTION": (int, 0),
    "LONGITUDE_POI": (float, 0.0),
    "LATITUDE_POI": (float, 0.0),
    "ALTITUDE_POI": (int, 0),
    "LINE_ID": (int, 0),                 # set from the parent route
    "POINT_ACTION_CMD": (int, 0),
    "RORATION": (int, 0),
}

# ------------------------------------------------------------------- helpers


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def coerce(spec, value):
    """Coerce an incoming JSON value to the column's storage type."""
    typ, default = spec
    if value is None or value == "":
        return default if default is not None else typ()
    try:
        if typ is int:
            return int(round(float(value)))
        if typ is float:
            return float(value)
        return str(value)
    except (TypeError, ValueError):
        return default if default is not None else typ()


def haversine(lat1, lon1, lat2, lon2):
    r = 6372800.0  # metres — the radius the Fimi app itself uses (reproduces its
                   # stored DISTANCE to the millimetre across three sample routes)
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def path_length(points):
    """Open-path great-circle length in metres across consecutive waypoints."""
    total = 0.0
    for a, b in zip(points, points[1:]):
        total += haversine(a["LATITUDE"], a["LONGITUDE"], b["LATITUDE"], b["LONGITUDE"])
    return total


def route_summary(row, count, distance):
    d = {k: row[k] for k in ROUTE_COLUMNS}
    d["_id"] = row["_id"]
    d["point_count"] = count
    return d


def load_points(conn, rid):
    rows = conn.execute(
        "SELECT * FROM X8_AI_LINE_POINT_LATLNG_INFO WHERE LINE_ID = ? ORDER BY NUMBER, _id",
        (rid,),
    ).fetchall()
    out = []
    for r in rows:
        p = {k: r[k] for k in POINT_COLUMNS}
        p["_id"] = r["_id"]
        out.append(p)
    return out


def clean_points(raw, line_id):
    """Normalise an incoming waypoint list: types, ordering, counts, FK."""
    points = []
    for item in raw or []:
        p = {k: coerce(spec, item.get(k)) for k, spec in POINT_COLUMNS.items()}
        points.append(p)
    total = len(points)
    for i, p in enumerate(points):
        p["NUMBER"] = i
        p["TOTALNUMBER"] = total
        p["LINE_ID"] = line_id
    return points


def write_points(conn, rid, points):
    conn.execute("DELETE FROM X8_AI_LINE_POINT_LATLNG_INFO WHERE LINE_ID = ?", (rid,))
    cols = list(POINT_COLUMNS)
    sql = "INSERT INTO X8_AI_LINE_POINT_LATLNG_INFO ({}) VALUES ({})".format(
        ",".join('"%s"' % c for c in cols), ",".join("?" for _ in cols)
    )
    conn.executemany(sql, [[p[c] for c in cols] for p in points])


# ---------------------------------------------------------------------- API


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/db")
def api_db():
    return jsonify({"path": DB_PATH, "name": os.path.basename(DB_PATH)})


@app.get("/api/routes")
def api_routes():
    conn = connect()
    try:
        routes = []
        for row in conn.execute("SELECT * FROM X8_AI_LINE_POINT_INFO ORDER BY _id").fetchall():
            pts = load_points(conn, row["_id"])
            d = route_summary(row, len(pts), row["DISTANCE"])
            if pts:
                d["first"] = {"lat": pts[0]["LATITUDE"], "lng": pts[0]["LONGITUDE"]}
            routes.append(d)
        return jsonify(routes)
    finally:
        conn.close()


@app.get("/api/routes/<int:rid>")
def api_route(rid):
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM X8_AI_LINE_POINT_INFO WHERE _id = ?", (rid,)).fetchone()
        if row is None:
            abort(404)
        pts = load_points(conn, rid)
        d = route_summary(row, len(pts), row["DISTANCE"])
        d["points"] = pts
        return jsonify(d)
    finally:
        conn.close()


@app.post("/api/routes")
def api_create():
    body = request.get_json(force=True) or {}
    route = {k: coerce(spec, body.get(k)) for k, spec in ROUTE_COLUMNS.items()}
    if not body.get("TIME"):
        route["TIME"] = int(time.time() * 1000)
    conn = connect()
    try:
        cols = list(ROUTE_COLUMNS)
        cur = conn.execute(
            "INSERT INTO X8_AI_LINE_POINT_INFO ({}) VALUES ({})".format(
                ",".join('"%s"' % c for c in cols), ",".join("?" for _ in cols)
            ),
            [route[c] for c in cols],
        )
        rid = cur.lastrowid
        points = clean_points(body.get("points"), rid)
        route["DISTANCE"] = path_length(points)
        conn.execute("UPDATE X8_AI_LINE_POINT_INFO SET DISTANCE = ? WHERE _id = ?", (route["DISTANCE"], rid))
        write_points(conn, rid, points)
        conn.commit()
        return jsonify({"_id": rid, "DISTANCE": route["DISTANCE"], "point_count": len(points)}), 201
    finally:
        conn.close()


@app.put("/api/routes/<int:rid>")
def api_update(rid):
    body = request.get_json(force=True) or {}
    conn = connect()
    try:
        existing = conn.execute("SELECT * FROM X8_AI_LINE_POINT_INFO WHERE _id = ?", (rid,)).fetchone()
        if existing is None:
            abort(404)
        route = {}
        for k, spec in ROUTE_COLUMNS.items():
            route[k] = coerce(spec, body[k]) if k in body else existing[k]
        points = clean_points(body.get("points"), rid) if "points" in body else load_points(conn, rid)
        route["DISTANCE"] = path_length(points)
        cols = list(ROUTE_COLUMNS)
        conn.execute(
            "UPDATE X8_AI_LINE_POINT_INFO SET {} WHERE _id = ?".format(
                ",".join('"%s" = ?' % c for c in cols)
            ),
            [route[c] for c in cols] + [rid],
        )
        if "points" in body:
            write_points(conn, rid, points)
        conn.commit()
        return jsonify({"_id": rid, "DISTANCE": route["DISTANCE"], "point_count": len(points)})
    finally:
        conn.close()


@app.delete("/api/routes/<int:rid>")
def api_delete(rid):
    conn = connect()
    try:
        cur = conn.execute("DELETE FROM X8_AI_LINE_POINT_INFO WHERE _id = ?", (rid,))
        if cur.rowcount == 0:
            abort(404)
        conn.execute("DELETE FROM X8_AI_LINE_POINT_LATLNG_INFO WHERE LINE_ID = ?", (rid,))
        conn.commit()
        clear_photos(rid)
        return jsonify({"deleted": rid})
    finally:
        conn.close()


@app.post("/api/push")
def api_push():
    """Run write.py to replace the app's live database on the phone.

    Requires a JSON content type: that forces a CORS preflight, which keeps a
    stray page in another tab from triggering a device write by posting a form.
    """
    if not request.is_json:
        abort(415)
    script = os.path.join(HERE, "write.py")
    if not os.path.exists(script):
        return jsonify({"ok": False, "output": "write.py not found next to app.py"}), 404
    try:
        proc = subprocess.run(
            [sys.executable, script, DB_PATH],   # explicit path: don't rely on write.py's default
            cwd=HERE, capture_output=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "output": "write.py timed out after 180s — is the phone still connected?"}), 504
    out = (proc.stdout + proc.stderr).decode(errors="replace").strip()
    return jsonify({"ok": proc.returncode == 0, "returncode": proc.returncode, "output": out})


# ---------------------------------------------------------- flight (openfimi)
# One aircraft connection for the whole server, made through openfimi (see
# flight.py). Loaded on first use so the editor still runs without openfimi.
# Like /api/push, every POST needs a JSON body, so a form posted from another
# tab cannot connect or launch.

_flight = None


def flight():
    global _flight
    if _flight is None:
        import flight as flight_mod
        _flight = flight_mod.FlightSession(DB_PATH)
    return _flight


def flight_call(fn):
    if not request.is_json:
        abort(415)
    action = request.path.rsplit("/", 1)[-1]
    try:
        fn(request.get_json(silent=True) or {})
    except ValueError as e:
        return flight_error(action, str(e), 409)
    except ImportError as e:
        return jsonify({"ok": False, "error": "openfimi not available: %s" % e}), 500
    except Exception as e:  # noqa: BLE001 - e.g. no reply from the aircraft
        return flight_error(action, "%s: %s" % (type(e).__name__, e), 500)
    return jsonify({"ok": True})


def flight_error(action, error, status):
    """Refusals and failures go to the flight log too (and so into a recording's .log)."""
    if _flight is not None and action != "sticks":   # sticks repeat 7 times a second
        _flight.say("%s failed: %s" % (action, error))
    return jsonify({"ok": False, "error": error}), status


@app.get("/api/flight")
def api_flight_status():
    try:
        f = flight()
    except ImportError as e:
        return jsonify({"error": "openfimi not available: %s" % e}), 500
    return jsonify(f.status(int(request.args.get("since", 0))))


@app.get("/api/flight/trail")
def api_flight_trail():
    return jsonify(flight().trail_points())


@app.post("/api/flight/connect")
def api_flight_connect():
    return flight_call(lambda d: flight().connect((d.get("url") or "").strip()))


@app.post("/api/flight/disconnect")
def api_flight_disconnect():
    return flight_call(lambda d: flight().disconnect())


@app.post("/api/flight/config")
def api_flight_config():
    return flight_call(lambda d: flight().configure(
        route_id=d.get("route_id"), auto=d.get("auto"), min_sats=d.get("min_sats"),
        next_id=d.get("next_id", False), min_finish=d.get("min_finish")))


@app.post("/api/flight/launch")
def api_flight_launch():
    return flight_call(lambda d: flight().launch())


@app.post("/api/flight/rth")
def api_flight_rth():
    return flight_call(lambda d: flight().emergency_rth())


@app.post("/api/flight/land")
def api_flight_land():
    return flight_call(lambda d: flight().land())


@app.post("/api/flight/home")
def api_flight_home():
    return flight_call(lambda d: flight().emergency_rth(emergency=False))


@app.post("/api/flight/takeoff")
def api_flight_takeoff():
    return flight_call(lambda d: flight().takeoff())


@app.post("/api/flight/manual")
def api_flight_manual():
    return flight_call(lambda d: flight().set_manual(bool(d.get("on")), step=d.get("step")))


@app.post("/api/flight/sticks")
def api_flight_sticks():
    return flight_call(lambda d: flight().sticks(d.get("roll"), d.get("pitch"), d.get("throttle"), d.get("yaw")))


@app.post("/api/flight/gimbal")
def api_flight_gimbal():
    return flight_call(lambda d: flight().gimbal(pitch=d.get("pitch"), delta=d.get("delta")))


@app.post("/api/flight/streamrec")
def api_flight_streamrec():
    return flight_call(lambda d: flight().stream_record(bool(d.get("on"))))


@app.post("/api/flight/goto")
def api_flight_goto():
    return flight_call(lambda d: flight().goto(lat=d.get("lat"), lon=d.get("lon"), alt=d.get("alt"),
                                               speed=d.get("speed"), heading=d.get("heading"),
                                               gimbal=d.get("gimbal")))


@app.post("/api/flight/hover")
def api_flight_hover():
    return flight_call(lambda d: flight().hover())


@app.post("/api/flight/photo")
def api_flight_photo():
    return flight_call(lambda d: flight().photo())


@app.post("/api/flight/record")
def api_flight_record():
    return flight_call(lambda d: flight().record(bool(d.get("on"))))


@app.get("/api/flight/video.mjpg")
def api_flight_video():
    """The FPV view as MJPEG, for an <img>; ends when the connection does."""
    f = flight()
    relay = f.video
    if relay is None:
        abort(404)

    def gen():
        for jpg in relay.frames():
            yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                   + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")

    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame",
                    headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------- route photos
# After a survey flight the user drops the flight's photos onto the editor.
# Copies are kept in PHOTO_ROOT/<route id>/ (a browser never reveals where a
# dropped file came from), matched in capture order to the waypoints whose
# action takes photos, shown as thumbnails, and exported as a KML of ground
# overlays written into that same folder for Google Earth. Footprints use the
# same camera model as the survey planner: 79 deg diagonal field of view, 4:3
# stills, digital zoom cropping the frame, nadir camera facing north, flat
# ground at the take-off altitude.

IMAGE_EXTS = {".jpg", ".jpeg", ".png"}
PHOTOS_PER_ACTION = {4: 1, 5: 1, 6: 3}      # single photo, photo after 5 s hover, burst of 3
CAMERA_DIAG_FOV_DEG = 79.0
CAMERA_ASPECT = (4, 3)
M_PER_DEG = 2 * math.pi * 6372800 / 360     # same radius as haversine()


def photo_time(path):
    """Capture time as (epoch seconds, source): EXIF DateTimeOriginal, else file mtime."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            exif = im.getexif()
            ifd = exif.get_ifd(0x8769)
            raw = ifd.get(36867) or ifd.get(36868) or exif.get(306)
            if raw:
                return time.mktime(time.strptime(str(raw)[:19], "%Y:%m:%d %H:%M:%S")), "exif"
    except Exception:
        pass
    return os.path.getmtime(path), "mtime"


def list_photos(directory):
    """Image files in a directory, oldest first."""
    files = []
    for name in os.listdir(directory):
        path = os.path.join(directory, name)
        if os.path.splitext(name)[1].lower() in IMAGE_EXTS and os.path.isfile(path):
            t, src = photo_time(path)
            files.append({"name": name, "time": t, "source": src})
    files.sort(key=lambda f: (f["time"], f["name"]))
    return files


def photo_waypoints(points):
    """(index, point, photos taken) for every waypoint whose action takes photos."""
    return [(i, p, PHOTOS_PER_ACTION[p["POINT_ACTION_CMD"]])
            for i, p in enumerate(points) if p["POINT_ACTION_CMD"] in PHOTOS_PER_ACTION]


def footprint(altitude, zoom):
    """Ground footprint (east-west, north-south) in metres of a nadir photo facing north."""
    tan_d = math.tan(math.radians(CAMERA_DIAG_FOV_DEG / 2))
    a, b = CAMERA_ASPECT
    d = math.hypot(a, b)
    z = min(max(float(zoom or 1), 1.0), 6.0)
    return 2 * altitude * tan_d * a / d / z, 2 * altitude * tan_d * b / d / z


def safe_filename(name):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", name).strip() or "route"


def build_kml(name, points, files, transparency, zoom):
    """KML text with one GroundOverlay per photo waypoint, plus the flight path."""
    alpha = max(0, min(255, round(255 * (1 - float(transparency) / 100.0))))
    color = "%02xffffff" % alpha                      # KML colour is aabbggrr
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2">',
           "<Document>", "<name>%s</name>" % escape(name), "<Folder><name>Photos</name>"]
    assignment, k = [], 0
    for i, p, n in photo_waypoints(points):
        group = files[k:k + n]
        k += n
        assignment.append({"waypoint": i + 1, "files": [g["name"] for g in group]})
        if p["GIMBAL_PITCH"] > -8500:                 # planned as an oblique: no north-up nadir footprint to draw
            continue
        f = group[0]                                  # a burst shows its first frame
        ew, ns = footprint(float(p["ALTITUDE"]), zoom)
        lat, lng = p["LATITUDE"], p["LONGITUDE"]
        m_lng = M_PER_DEG * math.cos(math.radians(lat))
        out.append(
            "<GroundOverlay><name>%s</name><color>%s</color><drawOrder>%d</drawOrder>"
            "<Icon><href>%s</href></Icon>"
            "<LatLonBox><north>%.7f</north><south>%.7f</south><east>%.7f</east><west>%.7f</west>"
            "<rotation>0</rotation></LatLonBox></GroundOverlay>"
            % (escape("#%d %s" % (i + 1, f["name"])), color, i + 1, escape(quote(f["name"])),
               lat + ns / 2 / M_PER_DEG, lat - ns / 2 / M_PER_DEG,
               lng + ew / 2 / m_lng, lng - ew / 2 / m_lng))
    out.append("</Folder>")
    coords = " ".join("%.7f,%.7f,%d" % (p["LONGITUDE"], p["LATITUDE"], p["ALTITUDE"]) for p in points)
    out.append("<Placemark><name>Flight path</name><Style><LineStyle><color>ffffa739</color><width>2</width>"
               "</LineStyle></Style><LineString><altitudeMode>relativeToGround</altitudeMode>"
               "<coordinates>%s</coordinates></LineString></Placemark>" % coords)
    out += ["</Document>", "</kml>", ""]
    return "\n".join(out), assignment


def photo_dir(rid):
    return os.path.join(PHOTO_ROOT, str(rid))


def assign_photos(points, files):
    """Attach a 1-based waypoint number to each file, in capture order."""
    k = 0
    for i, _, n in photo_waypoints(points):
        for f in files[k:k + n]:
            f["waypoint"] = i + 1
        k += n
    return files


def photo_state(rid, pts):
    wps = photo_waypoints(pts)
    files = list_photos(photo_dir(rid)) if os.path.isdir(photo_dir(rid)) else []
    expected = sum(n for _, _, n in wps)
    if len(files) == expected:
        assign_photos(pts, files)
    return {"dir": photo_dir(rid), "expected": expected, "waypoints": len(wps),
            "count": len(files), "complete": bool(files) and len(files) == expected, "photos": files}


def route_and_points(rid):
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM X8_AI_LINE_POINT_INFO WHERE _id = ?", (rid,)).fetchone()
        if row is None:
            abort(404)
        return row, load_points(conn, rid)
    finally:
        conn.close()


def clear_photos(rid):
    d = photo_dir(rid)
    if os.path.isdir(d):
        for root, dirs, names in os.walk(d, topdown=False):
            for n in names:
                os.remove(os.path.join(root, n))
            for n in dirs:
                os.rmdir(os.path.join(root, n))
        os.rmdir(d)


@app.get("/api/routes/<int:rid>/photos")
def api_photos_get(rid):
    _, pts = route_and_points(rid)
    return jsonify(photo_state(rid, pts))


@app.post("/api/routes/<int:rid>/photos")
def api_photos_put(rid):
    """Replace the route's photo set with the uploaded files, if the count fits."""
    _, pts = route_and_points(rid)
    wps = photo_waypoints(pts)
    expected = sum(n for _, _, n in wps)
    uploads = [f for f in request.files.getlist("files")
               if f.filename and os.path.splitext(f.filename)[1].lower() in IMAGE_EXTS]
    if not wps:
        return jsonify({"error": "no waypoint in this route takes a photo"}), 409
    if len(uploads) != expected:
        return jsonify({"error": "this route took %d photo%s on %d waypoint%s; %d image%s dropped"
                        % (expected, "" if expected == 1 else "s", len(wps), "" if len(wps) == 1 else "s",
                           len(uploads), "" if len(uploads) == 1 else "s")}), 409
    clear_photos(rid)
    d = photo_dir(rid)
    os.makedirs(d)
    seen = set()
    for f in uploads:
        name = safe_filename(os.path.basename(f.filename))
        if name in seen:
            return jsonify({"error": "two files are both called %s" % name}), 409
        seen.add(name)
        f.save(os.path.join(d, name))
    return jsonify(photo_state(rid, pts))


@app.delete("/api/routes/<int:rid>/photos")
def api_photos_delete(rid):
    clear_photos(rid)
    return jsonify({"cleared": rid})


@app.get("/api/routes/<int:rid>/photos/<path:name>")
def api_photo_file(rid, name):
    d = photo_dir(rid)
    name = os.path.basename(name)
    path = os.path.join(d, name)
    if not os.path.isfile(path):
        abort(404)
    if request.args.get("thumb"):
        tdir = os.path.join(d, ".thumbs")
        tpath = os.path.join(tdir, name + ".jpg")
        if not os.path.isfile(tpath) or os.path.getmtime(tpath) < os.path.getmtime(path):
            from PIL import Image, ImageOps
            os.makedirs(tdir, exist_ok=True)
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((240, 180))
                im.save(tpath, "JPEG", quality=80)
        return send_file(tpath, mimetype="image/jpeg", max_age=3600)
    return send_from_directory(d, name)


@app.post("/api/routes/<int:rid>/kml")
def api_kml(rid):
    """Write <route name>.kml into the route's photo folder, one overlay per photo."""
    body = request.get_json(force=True) or {}
    row, pts = route_and_points(rid)
    st = photo_state(rid, pts)
    if not st["complete"]:
        return jsonify({"error": "drop the flight's %d photo%s on the waypoint list first"
                        % (st["expected"], "" if st["expected"] == 1 else "s")}), 409
    kml, assignment = build_kml(row["NAME"] or "route", pts, st["photos"],
                                body.get("transparency", 30), body.get("zoom", 1))
    path = os.path.join(photo_dir(rid), safe_filename(row["NAME"] or "route") + ".kml")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(kml)
    return jsonify({"path": path, "photos": st["expected"], "waypoints": st["waypoints"],
                    "time_source": sorted({f["source"] for f in st["photos"]}), "assignment": assignment})




@app.post("/api/routes/<int:rid>/duplicate")
def api_duplicate(rid):
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM X8_AI_LINE_POINT_INFO WHERE _id = ?", (rid,)).fetchone()
        if row is None:
            abort(404)
        route = {k: row[k] for k in ROUTE_COLUMNS}
        route["NAME"] = (row["NAME"] or "Route") + " copy"
        route["TIME"] = int(time.time() * 1000)
        cols = list(ROUTE_COLUMNS)
        cur = conn.execute(
            "INSERT INTO X8_AI_LINE_POINT_INFO ({}) VALUES ({})".format(
                ",".join('"%s"' % c for c in cols), ",".join("?" for _ in cols)
            ),
            [route[c] for c in cols],
        )
        new_id = cur.lastrowid
        write_points(conn, new_id, clean_points(load_points(conn, rid), new_id))
        conn.commit()
        return jsonify({"_id": new_id}), 201
    finally:
        conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Fimi route database web editor")
    ap.add_argument("--db", default=DB_PATH, help="path to the route database (default: fimi.db)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5000)
    args = ap.parse_args()
    DB_PATH = os.path.abspath(args.db)
    if not os.path.exists(DB_PATH):
        # A fresh checkout has no database: start an empty one in the app's own
        # schema (read.py pulls the phone's real one instead).
        with open(os.path.join(HERE, "schema.sql")) as f, sqlite3.connect(DB_PATH) as db:
            db.executescript(f.read())
        print("Created an empty route database: %s" % DB_PATH)
    print("Editing %s" % DB_PATH)
    print("Open http://%s:%d/" % (args.host, args.port))
    app.run(host=args.host, port=args.port, debug=False, threaded=True)
