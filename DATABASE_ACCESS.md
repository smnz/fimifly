# Reading and writing the Fimi route database

Procedure for getting the route database (`_sql.db`, see `FILE_FORMAT.md`)
off the phone, editing it, and putting it back.

## Prerequisites

- Phone connected via `adb` (USB or wireless debugging enabled).
- The app installed with `android:debuggable="true"` in its manifest.
  A normal Play Store install does not have this set, and without it the
  adb shell user cannot reach the app's private data directory at all.
  Getting a debuggable build onto the phone means decompiling the APK
  with apktool, adding that manifest attribute, rebuilding, signing with
  a local key, and installing it (this replaces the original app
  install, since the signature changes).

Once installed, confirm access works:

```
adb shell run-as com.fimi.app.x8m ls /data/user/0/com.fimi.app.x8m/databases/
```

If that lists `_sql.db`, everything below works.

## Reading the database

One command, streamed through `run-as` to a local file:

```
adb shell "run-as com.fimi.app.x8m cat /data/user/0/com.fimi.app.x8m/databases/_sql.db" > local_copy.db
```

`local_copy.db` is then a normal SQLite file — open it with `sqlite3`,
DB Browser for SQLite, or anything else that reads SQLite.

## Writing the database

The app's data directory isn't writable by the plain adb shell user, so
a new database file has to be staged somewhere shell-writable first, then
moved into place as the app's own user.

1. Edit a local copy of the database with normal SQL
   (`INSERT`/`UPDATE`/`DELETE` against `X8_AI_LINE_POINT_INFO` and
   `X8_AI_LINE_POINT_LATLNG_INFO`, see `FILE_FORMAT.md` for the schema).

2. Stop the app so it isn't holding the current database open:

   ```
   adb shell am force-stop com.fimi.app.x8m
   ```

3. Push the edited file to a shell-writable staging path:

   ```
   adb push local_copy.db /data/local/tmp/_sql.db
   ```

4. Copy it into the app's database directory, running as the app's own
   uid so the permissions come out right:

   ```
   adb shell run-as com.fimi.app.x8m cp /data/local/tmp/_sql.db /data/user/0/com.fimi.app.x8m/databases/_sql.db
   ```

5. Remove any journal/WAL files left over from the previous database, so
   SQLite doesn't try to replay old transaction logs against the new
   file:

   ```
   adb shell run-as com.fimi.app.x8m rm -f \
     /data/user/0/com.fimi.app.x8m/databases/_sql.db-journal \
     /data/user/0/com.fimi.app.x8m/databases/_sql.db-wal \
     /data/user/0/com.fimi.app.x8m/databases/_sql.db-shm
   ```

6. Clean up the staging copy:

   ```
   adb shell rm /data/local/tmp/_sql.db
   ```

7. Launch (or relaunch) the app. It opens the new database on startup and
   the change shows up in the route list immediately.

## Things to keep consistent when writing

- `X8_AI_LINE_POINT_INFO._id` is referenced as `LINE_ID` in
  `X8_AI_LINE_POINT_LATLNG_INFO` — when adding a new route, insert the
  route row first, then insert its waypoint rows with `LINE_ID` set to
  match.
- `NUMBER` on each waypoint row is its 0-based order within the route,
  and `TOTALNUMBER` is the route's total waypoint count, repeated on
  every row — both need to stay correct across all of a route's rows.
- `DISTANCE` on the route row is the path length in metres; the app
  doesn't appear to strictly require it to be exact, but keeping it
  consistent with the actual waypoints avoids a mismatch against what's
  shown in the app's UI.

This round-trip (pull → edit with SQL → push back) was verified working:
a route name changed in a local copy of the database showed up correctly
in the app after pushing the file back and relaunching.
