#!/usr/bin/env python3
"""Pull the Fimi app's route database off the phone.

Usage:
    ./read.py [output_file]

Overwrites output_file (default: app-snapshot.db) with a copy of the
app's live SQLite database, pulled via `adb shell run-as`. Requires the
app to be installed as a debuggable build (see DATABASE_ACCESS.md).
"""
import argparse
import subprocess
import sys

PACKAGE = "com.fimi.app.x8m"
SQLITE_MAGIC = b"SQLite format 3\x00"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "output",
        nargs="?",
        default="app-snapshot.db",
        help="local file to write (default: app-snapshot.db, overwritten)",
    )
    parser.add_argument("--package", default=PACKAGE, help="app package name")
    parser.add_argument(
        "--db-path",
        default=None,
        help="database path on device (default: derived from --package)",
    )
    args = parser.parse_args()

    db_path = args.db_path or f"/data/user/0/{args.package}/databases/_sql.db"

    print(f"Reading {db_path} from {args.package} ...")
    result = subprocess.run(
        ["adb", "shell", "run-as", args.package, "cat", db_path],
        capture_output=True,
    )

    if result.returncode != 0:
        sys.exit("adb command failed:\n" + result.stderr.decode(errors="replace"))

    data = result.stdout
    if not data.startswith(SQLITE_MAGIC):
        sys.exit(
            "Output doesn't look like a SQLite database (wrong package name, "
            "wrong path, or the app isn't a debuggable build):\n"
            + data[:200].decode(errors="replace")
        )

    with open(args.output, "wb") as f:
        f.write(data)

    print(f"Wrote {len(data)} bytes to {args.output}")


if __name__ == "__main__":
    main()
