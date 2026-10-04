# fimifly

A web app for planning and flying routes on a **FIMI X8 Mini** drone. It edits
the FIMI app's route database over a map, plans photo survey grids, and flies
routes and manual flights directly through the remote controller with
[openfimi](https://github.com/smnz/openfimi): live video, telemetry, and
per-waypoint gimbal control, which the FIMI app can't do.

## What it does

**Route editor**
- Browse, edit and create routes on satellite imagery; drag waypoints, set
  altitude, speed, actions (photo, hover, record), points of interest and
  gimbal pitch.
- Every field shows what it really does on the aircraft: confirmed, overwritten
  by the FIMI app, or used only when flown with openfimi (◆).
- **Survey grids**: drag a rectangle and get a north-up photo grid (footprint
  from the camera's field of view, overlap, altitude and zoom), split into
  linked routes of up to 20 waypoints, with optional oblique and high passes.
- Photos from a survey can be dropped onto the route and exported to Google
  Earth as ground overlays (KML), or staged for OpenDroneMap (`odm/`).

**Flying with openfimi** (Fly / Manual flight)
- Connect through the openfimi phone bridge or a USB gadget; launch by hand or
  **hands-off** (waits for GPS, a home point and the drone set down still).
- Live FPV video, map position and trail, telemetry with alarm colours for
  battery, temperature and the remote, and the route's progress.
- Per-waypoint **gimbal pitch** applied during the route; per-waypoint speeds.
- **Route chaining**: linked routes fly back to back, skipped if the battery
  would finish below a floor or the aircraft is too hot.
- **Manual flight**: take off, land, return home, keyboard nudges (WASD, arrows
  to climb and turn, PgUp/PgDn for the gimbal), and **Go to** a point picked on
  the map at a set altitude, speed and facing.
- Emergency return home, photo / video, and recording of the video stream
  together with a full openfimi link capture, a log and telemetry subtitles.

## Running it

Needs Python 3.10+, Flask, and for flying [openfimi](https://github.com/smnz/openfimi)
and `ffmpeg` (video). Pillow is optional (photo thumbnails and EXIF times).

```
pip install flask pillow
pip install git+https://github.com/smnz/openfimi
./run                      # or: python3 app.py [--db fimi.db] [--port 5000]
```

Then open http://127.0.0.1:5000/. Without a database, `fimi.db` is created
empty from `schema.sql`.

To edit the routes already on your phone instead, pull the FIMI app's database
with `read.py` and push it back with `write.py` ("Send to phone"). That needs
the FIMI app installed as a debuggable build; see `DATABASE_ACCESS.md`. Flying
with openfimi doesn't need any of that: it reads routes from the local database.

`FILE_FORMAT.md` documents the database and what each column does.

## Safety

This flies a real aircraft. Keep the remote in hand and line of sight: its
sticks and switches are always the way to take over, and there is no emergency
motor stop. Hands-off launch takes off by itself, so keep clear once the drone
is set down. Fly within your local regulations.

Not affiliated with or endorsed by FIMI or Xiaomi.
