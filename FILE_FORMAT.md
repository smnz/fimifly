# Fimi app route storage format

Findings from reverse-engineering the Fimi drone-control Android app
(`com.fimi.app.x8m`, tested at versionName `V1.1.43.20703`, used with a
Fimi Mini 3) to figure out where and how "AI Line" / waypoint routes are
stored.

## Where it lives

Routes are **not** exported, imported, or synced to the cloud anywhere in
the app. They live entirely in a local SQLite database, private to the
app, on the phone:

```
/data/user/0/com.fimi.app.x8m/databases/_sql.db
```

This is a [greenDAO](https://greenrobot.org/greendao/)-managed database.
It is only reachable via `adb shell run-as com.fimi.app.x8m` (requires the
app to be debuggable) or root — the app's external/sdcard storage
directory does not contain route data, only a map tile cache.

`example_routes.db` in this directory is a real pulled copy of that file,
containing one hand-drawn route ("North tracks", 11 waypoints) used to
verify the schema below.

## Relevant tables

Everything else in the database (`STUDENT`, `DYNAMIC_NFZ`,
`DATA_STATIC_INFO`, `GH2_DATA_STATIC_INFO`, `MEDIA_DOWNLOAD_INFO`) is
unrelated app bookkeeping (no-fly zones, downloaded media, etc.). Route
data is in two tables:

### `X8_AI_LINE_POINT_INFO` — one row per route

```sql
CREATE TABLE "X8_AI_LINE_POINT_INFO" (
  "_id"                 INTEGER PRIMARY KEY,
  "TIME"                INTEGER NOT NULL,  -- creation time, epoch millis
  "NAME"                TEXT,              -- user-visible route name
  "TYPE"                INTEGER NOT NULL,
  "SPEED"               INTEGER NOT NULL,  -- default flight speed
  "SAVE_FLAG"           INTEGER NOT NULL,  -- 0/1, whether saved vs. draft
  "DISTANCE"            REAL NOT NULL,     -- total path length, metres
  "IS_CURVE"            INTEGER NOT NULL,  -- 0/1, curved vs. straight-segment path
  "MAP_TYPE"            INTEGER NOT NULL,
  "RUN_BY_MAP_OR_VEDIO" INTEGER NOT NULL,
  "DISCONNECT_TYPE"     INTEGER NOT NULL,  -- behaviour on RC signal loss
  "EXCUTE_END"          INTEGER NOT NULL,  -- action at end of route
  "AUTO_RECORD"         INTEGER NOT NULL,  -- repurposed: _id of the route openfimi flies next (0 = none)
  "LOCALITY"            TEXT,
  "ESTIMATED_TIME"      TEXT               -- estimated flight time, seconds (as text)
);
```

Example row (route "North tracks"):

| _id | TIME | NAME | SPEED | DISTANCE | ESTIMATED_TIME |
|---|---|---|---|---|---|
| 1 | 1788945673455 | North tracks | 14 | 1253.66 | 240 |

`DISTANCE` was verified independently: computing the great-circle path
length across the 11 waypoints below gives 1253.31 m, matching the stored
1253.66 m closely enough (small difference likely from the app measuring
along its own curve-fit path rather than straight segments). Confirms the
field is metres, and that it's the *open* path length — start to end, not
a closed loop.

### `X8_AI_LINE_POINT_LATLNG_INFO` — one row per waypoint

Linked to its parent route via `LINE_ID = X8_AI_LINE_POINT_INFO._id`.

```sql
CREATE TABLE "X8_AI_LINE_POINT_LATLNG_INFO" (
  "_id"                    INTEGER PRIMARY KEY,
  "NUMBER"                 INTEGER NOT NULL,  -- 0-based order within the route
  "TOTALNUMBER"            INTEGER NOT NULL,  -- point count in the route (denormalised)
  "LONGITUDE"              REAL NOT NULL,
  "LATITUDE"               REAL NOT NULL,
  "ALTITUDE"               INTEGER NOT NULL,  -- metres above takeoff point
  "YAW"                    REAL NOT NULL,     -- drone heading at this point, degrees
  "GIMBAL_PITCH"           INTEGER NOT NULL,  -- degrees
  "SPEED"                  INTEGER NOT NULL,  -- speed to this point (app units, see below)
  "YAW_MODE"               INTEGER NOT NULL,
  "GIMBAL_MODE"            INTEGER NOT NULL,
  "TRAJECTORY_MODE"        INTEGER NOT NULL,  -- e.g. straight-line vs. curved segment
  "MISSION_FINISH_ACTION"  INTEGER NOT NULL,
  "R_CLOST_ACTION"         INTEGER NOT NULL,  -- action on RC signal lost (sic, "R/C lost")
  "LONGITUDE_POI"          REAL NOT NULL,     -- point-of-interest target, for orbit/look-at modes
  "LATITUDE_POI"           REAL NOT NULL,
  "ALTITUDE_POI"           INTEGER NOT NULL,
  "LINE_ID"                INTEGER NOT NULL,  -- FK -> X8_AI_LINE_POINT_INFO._id
  "POINT_ACTION_CMD"       INTEGER NOT NULL,  -- action triggered at this waypoint (photo/video/hover…)
  "RORATION"               INTEGER NOT NULL   -- (sic, "rotation")
);
```

Example rows (first 3 of 11, route "North tracks"):

| NUMBER | LONGITUDE | LATITUDE | ALTITUDE | YAW | SPEED | LINE_ID |
|---|---|---|---|---|---|---|
| 0 | 120.000000000000 | 10.0000000000000 | 60 | 0.0 | 140 | 1 |
| 1 | 119.999265409516 | 10.0019525609417 | 60 | 0.0 | 140 | 1 |
| 2 | 119.998768195010 | 10.0024956310668 | 60 | 0.0 | 140 | 1 |

Notes on this example:
- `SPEED` here is 140 while the parent route's `SPEED` is 14 — confirmed
  (routes configured in the app and pulled back, plus decompiling
  v1.1.43.20703): the route `SPEED` is an integer number of metres/second
  and each waypoint `SPEED` is decimetres/second, written as route
  `SPEED` × 10. The per-waypoint value is never read back — on load the app
  overwrites every waypoint with route `SPEED` × 10 — so sub-integer speeds
  are unreachable through the app. Max flight speed is 14 m/s.
  Flown with openfimi, which sends each waypoint's own value, the waypoint
  `SPEED` is the speed of the leg **arriving at** that waypoint
  (flight-verified 2026-10-04).
- Route `AUTO_RECORD` is repurposed as a link: the `_id` of the route to fly
  straight after this one (0 = none). The FIMI app writes 0 on creation and
  never reads it (its "Auto REC" control is a live toggle, not this column).
  The editor's flight screen follows these links; the survey planner links
  each grid part to the next. Editing a route in the FIMI app may reset it.
- `GIMBAL_MODE` is repurposed by openfimi (the app never reads it): 0 = leave
  the gimbal alone, 1 = at `GIMBAL_PITCH` before arrival, 2 = on arrival. See
  the openfimi README.
- `YAW`, `YAW_MODE`, `GIMBAL_MODE`, `TRAJECTORY_MODE`, `POINT_ACTION_CMD`,
  `MISSION_FINISH_ACTION`, and `R_CLOST_ACTION` are enums; this example
  route only exercises the default value (0). Their numeric-to-meaning
  mappings have since been extracted (app round-trips plus decompiling
  v1.1.43.20703) and are documented authoritatively in the editor — see the
  `ENUMS` table and field notes in `static/app.js`, which tier every value
  as confirmed, "sent to aircraft, untested" (reaches the encrypted flight
  controller — flight-test only), or "not implemented" (the app ignores the
  column or fixes the wire byte). In short: `YAW`/`YAW_MODE` are overwritten
  from the route on load; `GIMBAL_MODE`/`TRAJECTORY_MODE` are inert columns;
  `POINT_ACTION_CMD` 0/1/2/4/5/6 are confirmed (3 is dead); and the per-
  waypoint `MISSION_FINISH_ACTION`/`R_CLOST_ACTION` are overwritten by the
  route-level "at end" / "signal loss" settings.

## Practical takeaway

A route is fully described by one `X8_AI_LINE_POINT_INFO` row plus its
linked `X8_AI_LINE_POINT_LATLNG_INFO` rows. Reading a route out, or
writing a new one in, is just SQLite `SELECT`/`INSERT` against these two
tables — no binary formats, no cloud calls involved.
