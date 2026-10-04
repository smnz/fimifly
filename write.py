#!/usr/bin/env python3
"""Push a local SQLite file onto the phone as the Fimi app's route database.

Usage:
    ./write.py [input_file]

Replaces the app's live database with input_file (default: kimi.db).
Stops the app first, stages the file through /data/local/tmp (the app's
own data directory isn't writable by the plain adb shell user), copies
it into place as the app's uid, clears stale journal/WAL files, then
relaunches the app. Requires the app to be installed as a debuggable
build (see DATABASE_ACCESS.md).
"""
import argparse
import os
import subprocess
import sys

PACKAGE = "com.fimi.app.x8m"
STAGING_PATH = "/data/local/tmp/_sql.db"
SQLITE_MAGIC = b"SQLite format 3\x00"


def run(cmd):
    print("$ " + " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        sys.exit(
            f"Command failed ({result.returncode}): {' '.join(cmd)}\n"
            + result.stderr.decode(errors="replace")
        )
    return result.stdout.decode(errors="replace").strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "input",
        nargs="?",
        default="kimi.db",
        help="local database file to write to the phone (default: kimi.db)",
    )
    parser.add_argument("--package", default=PACKAGE, help="app package name")
    parser.add_argument(
        "--db-path",
        default=None,
        help="database path on device (default: derived from --package)",
    )
    parser.add_argument(
        "--no-launch", action="store_true", help="don't relaunch the app afterwards"
    )
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        sys.exit(f"Input file not found: {args.input}")

    with open(args.input, "rb") as f:
        header = f.read(len(SQLITE_MAGIC))
    if header != SQLITE_MAGIC:
        sys.exit(f"{args.input} doesn't look like a SQLite database (bad header)")

    db_path = args.db_path or f"/data/user/0/{args.package}/databases/_sql.db"

    print(f"Stopping {args.package} ...")
    run(["adb", "shell", "am", "force-stop", args.package])

    print(f"Pushing {args.input} to device staging path ...")
    out = run(["adb", "push", args.input, STAGING_PATH])
    if out:
        print(out)

    print("Copying staged file into app data directory ...")
    run(["adb", "shell", "run-as", args.package, "cp", STAGING_PATH, db_path])

    print("Clearing stale journal/WAL files ...")
    run(
        [
            "adb", "shell", "run-as", args.package, "rm", "-f",
            f"{db_path}-journal", f"{db_path}-wal", f"{db_path}-shm",
        ]
    )

    print("Removing staging file ...")
    run(["adb", "shell", "rm", STAGING_PATH])

    if not args.no_launch:
        print(f"Relaunching {args.package} ...")
        run(
            [
                "adb", "shell", "monkey", "-p", args.package,
                "-c", "android.intent.category.LAUNCHER", "1",
            ]
        )

    print(f"Done. {args.input} is now the live database for {args.package}.")


if __name__ == "__main__":
    main()
