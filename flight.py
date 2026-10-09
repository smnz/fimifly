"""Fly a saved route with openfimi: one connection to the aircraft, shared by the
web UI's flight screen.

The session owns the openfimi Drone, a launch thread running Drone.fly_route
(the hands-off "auto launch" waits for GPS, a home point and the aircraft set
down level and still before taking off), an event log for the UI, and an
ffmpeg process that turns the H.265 FPV stream into JPEG frames for a plain
<img> MJPEG stream (browsers cannot be relied on to decode H.265).
"""

import math
import os
import sqlite3
import subprocess
import sys
import threading
import time
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
OPENFIMI_SRC = os.environ.get("OPENFIMI_SRC", os.path.join(HERE, "..", "openfimi", "src"))

try:
    from openfimi import Drone  # noqa: F401
except ImportError:
    # Not installed: use the sibling checkout. Drop whatever stood in for it
    # (this repo's own openfimi/ notes folder imports as an empty namespace).
    sys.modules.pop("openfimi", None)
    sys.path.insert(0, os.path.abspath(OPENFIMI_SRC))

from openfimi import Drone, commands, transport           # noqa: E402
from openfimi.drone import PreflightError                 # noqa: E402
from openfimi.mission import (                             # noqa: E402
    FinishAction, Heading, LostAction, Mission, Waypoint, mission_from_fimi_db)
from openfimi.transport.capture import RecordingTransport  # noqa: E402

DEFAULT_URL = os.environ.get("OPENFIMI_URL", "")
RECORDINGS = os.environ.get("FIMI_RECORDINGS", os.path.join(HERE, "recordings"))
AUTO_WAIT_S = 3600.0          # how long auto launch waits for power-on, GPS and settling
ROUTE_TASK_MODE = 1           # NavigationState.task_mode while a route is flying
RTH_TASK_MODE = 3             # ... while returning home, whoever asked for it
RETURNING = ("rth", "returning", "landing")  # emergency RTH, Return home, Land: progress messages can't override
MIN_FINISH_PCT = 25           # skip the next route if it would end below this battery
MAX_TEMP_C = 50.0             # skip the next route at this battery temperature (the
                              # take-off refusal was seen at 46 C with the overheat alarm)
DRAIN_FALLBACK = 0.07         # %/s, when this flight is too short to measure (flights: ~0.06)
RTH_SPEED_MS = 5.0            # return-home cruise, measured 3.6-5 m/s
GIMBAL_MIN, GIMBAL_MAX = -90.0, 0.0   # live gimbal control; upward pitch not offered for now
NO_WAYPOINT = 0xFFFF          # NavigationState.waypoint for a moment as a route starts


def has_parameter_sets(pkt):
    """True if the access unit carries a VPS (H.265) or SPS (H.264): a point
    a decoder can start from. The aircraft sends one every 30 frames."""
    data, i = pkt.data, 0
    while True:
        i = data.find(b"\x00\x00\x01", i)
        if i < 0 or i + 3 >= len(data):
            return False
        b = data[i + 3]
        if (b & 0x1F) == 7 if pkt.codec_name == "h264" else ((b >> 1) & 0x3F) == 32:
            return True
        i += 3


def tcp_url(url):
    """A bare host or host:port means the openfimi bridge over TCP."""
    url = url.strip()
    if url and "://" not in url and url not in ("usb", "aoa", "gadget", "udp"):
        return "tcp://" + url
    return url


class VideoRelay:
    """H.265 access units in, latest JPEG frame out (ffmpeg does the decoding).

    Packets are queued from the link's receive thread and written by a thread of
    our own, so a slow ffmpeg never stalls telemetry. ffmpeg is only started
    on a packet with parameter sets: joining the stream mid-way, it would
    otherwise probe undecodable frames, give up and exit. If it exits anyway
    it is restarted at the next such packet.
    """

    def __init__(self):
        self.proc = None
        self.frame = None                  # latest JPEG
        self.seq = 0
        self.cond = threading.Condition()
        self.queue = deque(maxlen=90)      # drops the oldest if ffmpeg lags
        self.wake = threading.Event()
        self.stopped = threading.Event()
        self.started_at = 0.0

    def feed(self, pkt):
        if not pkt.is_video or self.stopped.is_set():
            return
        if self.proc is None or self.proc.poll() is not None:
            if not has_parameter_sets(pkt) or time.monotonic() - self.started_at < 2.0:
                return                     # wait for a start point; don't respawn in a tight loop
            if self.proc is not None:
                self.proc.wait()           # reap the one that died
            self.queue.clear()
            self._start(pkt.codec_name)
        self.queue.append(pkt.data)
        self.wake.set()

    def _start(self, codec):
        self.started_at = time.monotonic()
        proc = self.proc = subprocess.Popen(
            # Small probe so the first frame comes quickly; "-fflags nobuffer"
            # stalls this raw stream entirely, so it is deliberately absent.
            ["ffmpeg", "-loglevel", "error", "-probesize", "32768", "-analyzeduration", "0",
             "-flags", "low_delay", "-f", codec, "-i", "-", "-vf", "fps=15", "-f", "image2pipe", "-c:v", "mjpeg",
             "-q:v", "6", "-"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        threading.Thread(target=self._write, args=(proc,), daemon=True).start()
        threading.Thread(target=self._read, args=(proc,), daemon=True).start()

    def _write(self, proc):
        while not self.stopped.is_set() and proc.poll() is None:
            self.wake.wait(0.5)
            self.wake.clear()
            while self.queue and proc is self.proc:
                try:
                    proc.stdin.write(self.queue.popleft())
                    proc.stdin.flush()
                except (BrokenPipeError, ValueError, OSError):
                    return

    def _read(self, proc):
        # mjpeg in image2pipe is back-to-back JPEGs; FFD9 cannot occur inside
        # the entropy-coded data (0xFF is stuffed), so it ends each frame.
        buf = b""
        while True:
            chunk = proc.stdout.read1(65536)
            if not chunk:
                return
            buf += chunk
            while True:
                start = buf.find(b"\xff\xd8")
                end = buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                if end < 0:
                    break
                with self.cond:
                    self.frame = buf[start:end + 2]
                    self.seq += 1
                    self.cond.notify_all()
                buf = buf[end + 2:]

    def frames(self):
        """Yield each new JPEG until the relay stops."""
        seen = -1
        while not self.stopped.is_set():
            with self.cond:
                self.cond.wait_for(lambda: self.seq != seen or self.stopped.is_set(), timeout=1.0)
                if self.seq == seen or self.frame is None:
                    continue
                seen, frame = self.seq, self.frame
            yield frame

    def stop(self):
        self.stopped.set()
        with self.cond:
            self.cond.notify_all()
        if self.proc is not None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            self.proc.kill()
            self.proc.wait()


def shortpath(path):
    """A path as the log shows it: relative to this project when inside it."""
    rel = os.path.relpath(path, HERE)
    return path if rel.startswith("..") else rel


class StreamRecorder:
    """Save the FPV stream as it arrives: no re-encoding, so it costs almost
    nothing and runs alongside the aircraft's own photos or video.

    ffmpeg copies the H.265 into Matroska (still playable if cut off), stamping
    each frame with its arrival time, since the raw stream carries no frame
    rate. Recording starts at the next keyframe, at most a second away.
    """

    def __init__(self, path):
        self.path = path
        self.base = os.path.splitext(path)[0]   # the .ofcap, .log and .srt share it
        self.pressed = time.time()
        self.events = []                   # (wall time, text) from the app's log
        self.samples = []                  # (wall time, telemetry dict), 1 Hz
        self.proc = None
        self.started = None                # wall time of the first frame written
        self.queue = deque(maxlen=300)
        self.wake = threading.Event()
        self.stopped = threading.Event()

    def feed(self, pkt):
        if not pkt.is_video or self.stopped.is_set():
            return
        if self.proc is None:
            if not has_parameter_sets(pkt):
                return
            self.proc = subprocess.Popen(
                ["ffmpeg", "-loglevel", "error", "-y", "-use_wallclock_as_timestamps", "1",
                 "-f", pkt.codec_name, "-i", "-", "-c", "copy", self.path],
                stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.started = time.time()
            threading.Thread(target=self._write, daemon=True).start()
        self.queue.append(pkt.data)
        self.wake.set()

    def _write(self):
        while True:
            self.wake.wait(0.5)
            self.wake.clear()
            while self.queue:
                try:
                    self.proc.stdin.write(self.queue.popleft())
                    self.proc.stdin.flush()
                except (BrokenPipeError, ValueError, OSError):
                    return
            if self.stopped.is_set():
                try:
                    self.proc.stdin.close()            # ffmpeg finishes the file
                except OSError:
                    pass
                self.proc.wait(timeout=10)
                return

    def stop(self):
        self.stopped.set()
        self.wake.set()


class _Either:
    """Set when either event is: the route monitor's cancel, so a Fly next
    now stops following a route without ending the flight's chain."""

    def __init__(self, a, b):
        self.a, self.b = a, b

    def is_set(self):
        return self.a.is_set() or self.b.is_set()


class FlightSession:
    """The single aircraft connection. Every public method is thread-safe."""

    def __init__(self, db_path):
        self.db_path = db_path
        self.lock = threading.RLock()
        self.drone = None
        self.url = DEFAULT_URL
        self.conn = "disconnected"         # disconnected | connecting | connected
        self.phase = "idle"                # idle | waiting | launching | flying | done | failed | cancelled
        #                                    | manual (took off by hand) | rth (emergency)
        #                                    | returning (Return home) | landing (Land, in place)
        self.route_id = None               # route being (or last) flown
        self.next_id = None                # route to chain when this one completes (None = stop)
        self.next_linked = False           # next_id came from a route's stored link, not the pilot
        self.skip = threading.Event()      # Fly next now: leave the current route for the next
        self.min_finish = MIN_FINISH_PCT
        self.takeoff_batt = None           # (monotonic time, battery %) at take-off, for the drain rate
        self.auto = False
        self.min_sats = 10
        self.cancel = None
        self.thread = None
        self.video = None
        self.events = deque(maxlen=500)
        self.event_seq = 0
        self.trail = deque(maxlen=5000)    # (lat, lon) breadcrumbs since connecting
        self.manual = False                # keyboard control enabled
        self.manual_ctl = None             # openfimi ManualFlight while keyboard control is on
        self.manual_step = 25.0            # metres each keyboard nudge aims ahead
        self.goto_target = None            # {lat, lon, alt, ...} of the last go-to, for the map
        self.recording = False             # as far as our own record commands go
        self.gimbal_target = None          # (pitch, monotonic time) of our last gimbal command
        self.rth_at = None                 # wall time of the last emergency RTH, from anyone
        self.streamrec = None              # StreamRecorder while saving the FPV stream
        self.tap = None                    # the connection's RecordingTransport

    # ---------------------------------------------------------------- events
    def say(self, text):
        with self.lock:
            self.event_seq += 1
            self.events.append({"seq": self.event_seq, "t": time.time(), "text": text})
            if self.streamrec is not None:
                self.streamrec.events.append((time.time(), text))
            if self.phase in RETURNING:
                pass                       # an emergency return home outranks progress messages
            elif text.startswith("taking off"):
                self.phase = "launching"
                b = self.drone.state.battery if self.drone else None
                self.takeoff_batt = (time.monotonic(), b.percent) if b else None
            elif text == "route started" and self.thread and self.thread.is_alive():
                self.phase = "flying"              # a planned route, not a go-to's one-point route

    # ------------------------------------------------------------ connection
    def active(self):
        """True from take-off until landed: nothing may change then."""
        with self.lock:
            if self.phase in ("launching", "flying") and self.thread and self.thread.is_alive():
                return True
            d = self.drone
        return bool(d and d.state.flying)

    def connect(self, url):
        url = tcp_url(url)
        with self.lock:
            if self.conn != "disconnected":
                raise ValueError("already " + self.conn)
            if not url:
                raise ValueError("no connection URL")
            self.url, self.conn = url, "connecting"
        self.say("connecting to " + url)
        threading.Thread(target=self._connect, args=(url,), daemon=True).start()

    def _connect(self, url):
        try:
            # Switchable openfimi capture: on while the stream is being recorded.
            tap = RecordingTransport(transport.from_url(url))
            d = Drone(tap)
            video = VideoRelay()
            d.on_video(video.feed)
            d.on_video(lambda pkt: self.streamrec and self.streamrec.feed(pkt))
            d.link.on_message(lambda msg, frame: self._track(d))
            d.link.on_notice(self._notice)
            d.connect()
        except Exception as e:  # noqa: BLE001 - any transport error ends the attempt
            with self.lock:
                self.conn = "disconnected"
            self.say("connection failed: %s" % e)
            return
        with self.lock:
            self.tap = tap
            self.drone, self.video, self.conn = d, video, "connected"
            self.trail.clear()
            if not (self.thread and self.thread.is_alive()):
                self.phase = "idle"        # a fresh connection: last attempt's outcome is in the log
            auto = self.auto and self.route_id is not None
        self.say("connected")
        threading.Thread(target=self._watch_link, args=(d,), daemon=True).start()
        if auto:
            try:
                self._launch(auto=True)
            except Exception as e:  # noqa: BLE001 - e.g. the route no longer loads
                self.say("auto launch not started: %s" % e)

    def _track(self, d):
        s = d.state.sport
        if s is not None and (s.lat or s.lon):
            t = self.trail
            if not t or abs(t[-1][0] - s.lat) > 2e-6 or abs(t[-1][1] - s.lon) > 2e-6:
                t.append((round(s.lat, 7), round(s.lon, 7)))

    def _watch_link(self, d):
        d.link.closed.wait()
        with self.lock:
            if self.drone is not d:
                return                     # a deliberate disconnect already tidied up
        self.say("link lost")
        self._teardown(d)

    def disconnect(self):
        if self.active():
            raise ValueError("not during a flight")
        with self.lock:
            d = self.drone
            if d is None:
                return
        self.say("disconnecting")
        self._teardown(d)

    def _teardown(self, d):
        with self.lock:
            if self.cancel:
                self.cancel.set()
            self.manual = self.recording = False
            rec, self.streamrec = self.streamrec, None
            ctl, self.manual_ctl = self.manual_ctl, None
        if ctl is not None:
            ctl.stop(halt=False)           # link is going; nothing more to send
        if rec:
            self._finish_rec(rec)
        with self.lock:
            video, self.video = self.video, None
            self.drone, self.conn = None, "disconnected"
        if video:
            video.stop()
        try:
            d.close()
        except Exception:  # noqa: BLE001
            pass
        self.say("disconnected")

    # ---------------------------------------------------------------- launch
    def configure(self, route_id=None, auto=None, min_sats=None, next_id=False, min_finish=None):
        """Select the route, and switch auto launch on or off.

        Switching auto on while connected starts the hands-off launch at once;
        switching it off before take-off cancels a pending one. The next route
        (``next_id``, None for none) and the battery floor may change at any
        time, flight included: they are read when the current route ends.
        """
        with self.lock:
            if next_id is not False:
                self.next_id = int(next_id) if next_id else None
                self.next_linked = False
            if min_finish is not None:
                self.min_finish = max(0, min(90, int(min_finish)))
        if route_id is None and auto is None and min_sats is None:
            return
        if self.active():
            raise ValueError("not during a flight")
        with self.lock:
            if self.thread and self.thread.is_alive() and route_id is not None and route_id != self.route_id:
                raise ValueError("a launch is pending for another route")
            if route_id is not None:
                self.route_id = route_id
            if min_sats is not None:
                self.min_sats = max(4, int(min_sats))
            start = auto is True and not self.auto and self.conn == "connected"
            stop = auto is False and self.auto
            if auto is not None:
                self.auto = bool(auto)
            pending = self.thread is not None and self.thread.is_alive()
        if stop and pending and self.cancel:
            self.cancel.set()
        if start and not pending:
            self._launch(auto=True)

    def launch(self):
        """Manual launch: check now and take off at once, or say why not."""
        with self.lock:
            if self.auto:
                raise ValueError("auto launch is on")
            if self.conn != "connected":
                raise ValueError("not connected")
        self._launch(auto=False)

    def _launch(self, auto):
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError("a launch is already running")
            if self.route_id is None:
                raise ValueError("no route selected")
            mission = mission_from_fimi_db(self.db_path, int(self.route_id))
            self.cancel = threading.Event()
            self.phase = "waiting" if auto else "launching"
            args = (self.drone, mission, auto, self.cancel, self.min_sats)
            self.thread = threading.Thread(target=self._fly, args=args, daemon=True)
            self.thread.start()

    def _fly(self, d, mission, auto, cancel, min_sats):
        self.say(("auto launch armed: " if auto else "launching: ")
                 + "%d waypoints, at least %d satellites" % (len(mission.waypoints), min_sats))
        self._run(cancel, lambda: self._chain(d, d.fly_route(
            mission, wait_ready=AUTO_WAIT_S if auto else 0.0, min_satellites=min_sats,
            on_event=self.say, cancel=_Either(cancel, self.skip),
            stop_at_end=self._chaining), cancel))

    def _run(self, cancel, body):
        """The launch thread's outcome: the phase and the log's last word."""
        try:
            res = body()
            with self.lock:
                rth = self.phase in RETURNING
                if not rth:
                    self.phase = "done"
            self.say("route monitoring ended (returning home)" if rth
                     else "finished" + (" (landed)" if res.get("landed") else ""))
        except PreflightError as e:
            with self.lock:
                if self.phase not in RETURNING:
                    self.phase = "cancelled" if str(e) == "cancelled" else "failed"
            self.say("launch " + ("cancelled" if str(e) == "cancelled" else "refused: %s" % e))
        except Exception as e:  # noqa: BLE001 - report whatever ended the flight
            with self.lock:
                if self.phase not in RETURNING:
                    self.phase = "failed"
            self.say("flight error: %s" % e)
        finally:
            # One arming, one launch attempt: never take off again by itself
            # (after a reconnect, say) without the pilot switching it back on.
            with self.lock:
                was, self.auto = self.auto, False
                self.skip.clear()
            if was:
                self.say("auto launch off")

    def _chaining(self):
        """Asked as each route ends: is there a next route to go on to?"""
        with self.lock:
            return self.next_id is not None and not self.cancel.is_set()

    def _check_next(self, d, nxt):
        """(info, mission, battery now, battery the route needs) for route
        ``nxt``, or ValueError saying why it can't be flown from here now."""
        try:
            info = route_info(self.db_path, nxt)
            mission = mission_from_fimi_db(self.db_path, nxt)
        except Exception as e:  # noqa: BLE001 - deleted or empty route
            raise ValueError("route #%d could not be loaded: %s" % (nxt, e)) from e
        hot = too_hot(d)
        if hot:
            raise ValueError("%s skipped: %s" % (info["name"], hot))
        with self.lock:
            floor = self.min_finish
        left, need, why = battery_forecast(d, info, self.takeoff_batt)
        if left is not None and left - need < floor:
            raise ValueError("%s skipped: battery %d%% now, would finish near %d%% (floor %d%%; %s)"
                             % (info["name"], left, left - need, floor, why))
        return info, mission, left, need

    def _chain(self, d, res, cancel):
        """Fly the next routes one after another, each as soon as the one
        before has flown its last waypoint (cancelling its return home), or
        at once when the pilot asked for it (Fly next now).

        Stops when a route was cut short, a launch is cancelled, a stored link
        loops, the aircraft is too hot (overheat alarm, or the battery at
        MAX_TEMP_C), or the battery would end below the floor; then the finish action
        of the route just flown (normally a return home) is left to happen, and
        a route that ends in a hover is sent home.
        """
        seen = {self.route_id}
        while True:
            with self.lock:
                nxt, linked = self.next_id, self.next_linked
                asked = self.skip.is_set()
                self.skip.clear()
            if nxt is None or cancel.is_set():
                return res
            if not res.get("completed") and not asked:
                self.say("next route not started: this one did not complete")
                return res
            if linked and nxt in seen:
                self.say("next route not started: route #%d is already in this chain" % nxt)
                return self._send_home(d, res)
            try:
                info, mission, left, need = self._check_next(d, nxt)
            except ValueError as e:
                self.say("next route %s" % e)
                return self._send_home(d, res)
            nav = d.state.navigation
            if nav and nav.task_mode == RTH_TASK_MODE:
                r = d.send(commands.cancel_return_home(), timeout=3)
                self.say("cancelled the route's return home" if r is None or r.ok
                         else "cancel return home refused (code %s)" % r.code)
            else:
                # still in a route (one left for Fly next now, or a hover
                # finish, which stays in route mode at the last point) or a
                # go-to's fly-to: end it first, as a mid-flight restart does
                self._hover_quietly(d)
            with self.lock:
                self.route_id, self.next_id, self.next_linked = nxt, info["next_id"], True
                if self.phase not in RETURNING:
                    self.phase = "flying"
            seen.add(nxt)
            self.say("next route: %s (#%d, %d waypoints)%s" % (
                info["name"], nxt, len(mission.waypoints),
                "" if left is None else ", battery %d%%, expect about %d%% at the end" % (left, left - need)))
            res = d.fly_route(mission, takeoff=False, on_event=self.say,
                              cancel=_Either(cancel, self.skip), stop_at_end=self._chaining)

    def fly_next_now(self):
        """Fly the queued next route now: stop the current route where it is,
        or start from a hover. Refused, with the current route left flying,
        if the next route fails the same checks a chain makes."""
        d = self._drone()
        with self.lock:
            nxt, phase = self.next_id, self.phase
            running = self.thread is not None and self.thread.is_alive()
        if nxt is None:
            raise ValueError("no next route chosen")
        if not d.state.flying:
            raise ValueError("not in the air: use Launch")
        if phase in RETURNING:
            raise ValueError("returning home or landing")
        if running and phase != "flying":
            raise ValueError("wait until the route has started")
        info, _, _, _ = self._check_next(d, nxt)
        if running:
            self.say("flying %s now: stopping this route here" % info["name"])
            self.skip.set()            # the route's monitor lets go; the chain flies the next
            return
        self._stop_manual(halt=False)
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError("a route flight is under way")
            self.manual = False
            self.goto_target = None
            self.cancel = cancel = threading.Event()
            self.skip.set()
            self.thread = threading.Thread(
                target=self._run, args=(cancel, lambda: self._chain(d, {}, cancel)), daemon=True)
            self.thread.start()
        self.say("flying %s now, from here" % info["name"])

    def _send_home(self, d, res):
        """After a chain stops: a route that ended in a hover would just sit
        there, so send it home; a return home already under way carries on."""
        nav = d.state.navigation
        if d.state.flying and not (nav and nav.task_mode == RTH_TASK_MODE):
            r = d.return_home(timeout=3)
            self.say("returning home" if r is None or r.ok else "return home refused (code %s)" % r.code)
        return res

    # ------------------------------------------------------------- controls
    def _drone(self):
        with self.lock:
            if self.drone is None or self.conn != "connected":
                raise ValueError("not connected")
            return self.drone

    def emergency_rth(self, emergency=True):
        """Stop everything (launch, route, manual sticks) and return home.

        Allowed at any time while connected, flight or not. The commands run in
        the background; their outcome goes to the log. The manual-flight
        Return home button is the same thing without the alarm (``emergency=False``).
        """
        d = self._drone()
        with self.lock:
            if self.cancel:
                self.cancel.set()          # no route will start; a running one is no longer followed
            self.auto = False
            self.manual = False
            if emergency:
                self.rth_at = time.time()
            self.phase = "rth" if emergency else "returning"
            self.goto_target = None
        self._stop_manual()                # without a halt command that could interfere
        self.say("EMERGENCY RETURN HOME (from this app)" if emergency else "returning home to land")

        def run():
            ok = d.emergency_rth(on_event=self.say)
            if not ok:
                self.say("RETURN HOME NOT ACCEPTED: take over with the remote")
        threading.Thread(target=run, daemon=True).start()

    def land(self):
        """Land where it is (FC 3/21), after stopping keyboard sticks."""
        d = self._drone()
        with self.lock:
            if self.cancel:
                self.cancel.set()
            self.auto = self.manual = False
            self.phase = "landing"
            self.goto_target = None
        self._stop_manual()                # so no fly-to target fights the descent
        r = d.land(timeout=3)
        self.say("landing here" if r is None or r.ok else "land refused (code %s)" % r.code)

    def takeoff(self):
        """Manual flight: run the pre-flight checks and take off to a hover."""
        d = self._drone()
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError("a route launch is under way")
            min_sats = self.min_sats
        if d.state.flying:
            raise ValueError("already flying")
        problems = d.preflight(min_satellites=min_sats)
        if problems:
            self.say("take-off refused: " + "; ".join(problems))
            raise ValueError("; ".join(problems))
        r = d.takeoff(timeout=5)
        if r is not None and not r.ok:
            self.say("take-off refused by the aircraft (code %s)" % r.code)
            raise ValueError("aircraft refused take-off (code %s)" % r.code)
        with self.lock:
            self.phase = "manual"
        self.say("manual take-off")

    def _notice(self, notice):
        if notice.get("event") == "emergency_rth":
            stage = notice.get("stage", "")
            with self.lock:
                if self.cancel:
                    self.cancel.set()
                self.auto = self.manual = False
                if stage == "activated":
                    self.rth_at = time.time()
                    self.phase = "rth"
            self._stop_manual()
            text = {"activated": "EMERGENCY RETURN HOME pressed on the phone bridge",
                    "accepted": "phone bridge: return home accepted",
                    "no_reply": "phone bridge: return home got no reply",
                    "refused": "phone bridge: return home refused (code %s)" % notice.get("code")}
            self.say(text.get(stage, "phone bridge: emergency return home " + stage))
        else:
            self.say("bridge notice: %s" % notice)

    def _stop_manual(self, halt=False):
        """End keyboard control. halt=True also cancels a move in progress (hover);
        land / return home pass False so nothing is sent that could interfere."""
        with self.lock:
            ctl, self.manual_ctl = self.manual_ctl, None
        if ctl is not None:
            ctl.stop(halt=halt)

    def set_manual(self, on, step=None):
        """Keyboard control. Virtual sticks are ignored by the aircraft over the
        remote's link (flight-tested), so keys drive autopilot nudges instead
        (openfimi.manual.ManualFlight): each held key flies a one-point route
        ``step`` metres ahead (forward/back/left/right relative to the desired
        heading; up/down a fraction of that), with a POI along the desired
        heading, which the turn keys swing. Released keys stop and hover.
        Changing the step while on restarts it."""
        d = self._drone()
        from openfimi.manual import ManualFlight
        with self.lock:
            if step is not None:
                self.manual_step = max(2.0, min(50.0, float(step)))
            step = self.manual_step
            was = self.manual
            self.manual = bool(on)
        if on:
            self._stop_manual(halt=False)
            # At full input ManualFlight moves at max_speed_ms and aims
            # max(min_carrot_m, speed * lookahead_s) ahead: make that the step.
            ctl = ManualFlight(d, on_event=self.say, min_carrot_m=step,
                               lookahead_s=step / 5.0, max_speed_ms=5.0).start()
            with self.lock:
                self.manual_ctl = ctl
            self.say("keyboard control %s (nudges of %.0f m; turn keys swing the heading)"
                     % ("restarted" if was else "on", step))
        else:
            self._stop_manual(halt=True)   # hover where it is
            self.say("keyboard control off")

    # ---------------------------------------------------------------- go to
    def goto(self, lat=None, lon=None, alt=None, speed=5.0, heading=None, gimbal=None):
        """Fly to a point (or, without lat/lon, change altitude or heading here).

        Flown the way ManualFlight flies (flight-verified): end whatever task is
        running, upload a one-point route (heading Free, finish hover) with a
        POI 500 m along the wanted heading, start it. Unlike a fly-to, this can
        be replaced in mid-move by another go-to or a nudge. ``heading``:
        "travel" (or None) faces the target, "current" keeps today's heading,
        a number faces that compass bearing. ``gimbal``: pitch to set now.
        """
        d = self._drone()
        s = d.state
        if not s.flying or s.sport is None:
            raise ValueError("take off first")
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError("a route flight is under way")
        here = lat is None or lon is None
        pos = (s.sport.lat, s.sport.lon)
        lat, lon = pos if here else (float(lat), float(lon))
        alt = max(3.0, min(120.0, float(alt if alt is not None else s.sport.height_m)))
        speed = max(0.5, min(14.0, float(speed or 5.0)))
        dist = ground_m(pos, (lat, lon))
        if heading in (None, "", "travel"):
            bearing = bearing_deg(pos, (lat, lon)) if dist > 3 else s.sport.yaw_deg
        elif heading == "current":
            bearing = s.sport.yaw_deg
        else:
            bearing = float(heading)
        bearing %= 360
        self._stop_manual(halt=False)      # a held key would replace this move
        with self.lock:
            self.manual = False
            if self.phase not in RETURNING:
                self.phase = "manual"
        if gimbal is not None:
            self.gimbal(pitch=gimbal)
        b = math.radians(bearing)
        plat = lat + 500 * math.cos(b) / 111320.0
        plon = lon + 500 * math.sin(b) / (111320.0 * math.cos(math.radians(lat)))
        m = Mission([Waypoint(lat, lon, alt, poi=(plat, plon, alt), speed_ms=speed)], speed_ms=speed,
                    heading=Heading.FREE, finish=FinishAction.HOVER, rc_lost=LostAction.CONTINUE)
        self._hover_quietly(d)             # a running fly-to or route refuses an upload
        d.upload_mission(m, check=True)
        r = d.start_mission(timeout=3)
        if r is not None and not r.ok:
            raise ValueError("go-to start refused (code %s)" % r.code)
        with self.lock:
            self.goto_target = {"lat": lat, "lon": lon, "alt": alt, "here": here, "bearing": bearing}
        self.say("go to: %s, facing %.0f°" % (
            ("altitude %.0f m here" % alt) if here else ("%.0f m away at %.0f m, %.1f m/s" % (dist, alt, speed)),
            bearing))

    def _hover_quietly(self, d):
        """End a running route or fly-to so the next upload is accepted (a
        fly-to refuses uploads with code 41, even ~1.6 s after arriving)."""
        nav = d.state.navigation
        if nav and nav.task_mode == ROUTE_TASK_MODE:
            d.send(commands.mission_stop(), timeout=3)
        elif nav and nav.task_mode == 2:
            d.send(commands.fly_to_exit(), timeout=3)

    def hover(self):
        """Stop a go-to (or keyboard move) and hold position."""
        d = self._drone()
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError("a route flight is under way: use Return home or the remote")
            self.goto_target = None
        self._stop_manual(halt=True)
        self._hover_quietly(d)
        self.say("holding position")

    def sticks(self, roll=0.0, pitch=0.0, throttle=0.0, yaw=0.0):
        self._drone()
        with self.lock:
            ctl = self.manual_ctl if self.manual else None
        if ctl is None:
            raise ValueError("keyboard control is off")
        ctl.set(roll=roll, pitch=pitch, throttle=throttle, yaw=yaw)

    def gimbal(self, pitch=None, delta=None):
        """Tilt to ``pitch``, or by ``delta`` from where we last put it (or where it is)."""
        d = self._drone()
        if pitch is None:
            with self.lock:
                last = self.gimbal_target
            if last and time.monotonic() - last[1] < 3.0:
                base = last[0]
            elif d.state.gimbal:
                base = d.state.gimbal.pitch_deg
            else:
                base = 0.0
            pitch = base + float(delta or 0)
        pitch = max(GIMBAL_MIN, min(GIMBAL_MAX, float(pitch)))
        with self.lock:
            self.gimbal_target = (pitch, time.monotonic())
        d.link.send(commands.gimbal_pitch(pitch))     # no wait: keys repeat quickly

    def stream_record(self, on):
        """Start or stop saving the FPV stream to RECORDINGS (no re-encoding).

        Alongside the .mkv, with the same name: .ofcap, the complete openfimi
        capture of the link for the same span (every command, reply and
        telemetry frame; read it with ``openfimi decode``); .log, this app's
        log with times into the video; .srt, subtitles of the basic telemetry.
        """
        d = self._drone()
        with self.lock:
            rec = self.streamrec
            if on and rec is None:
                os.makedirs(RECORDINGS, exist_ok=True)
                path = os.path.join(RECORDINGS, time.strftime("fpv-%Y%m%d-%H%M%S.mkv"))
                new = self.streamrec = StreamRecorder(path)
                self.tap.start(open(new.base + ".ofcap", "wb"))
            elif not on:
                self.streamrec = None
        if on and rec is None:
            threading.Thread(target=self._sample, args=(d, new), daemon=True).start()
            self.say("stream recording: %s (starts at the next keyframe)" % shortpath(path))
        elif not on and rec is not None:
            self._finish_rec(rec)

    def _sample(self, d, rec):
        while not rec.stopped.wait(1.0):
            rec.samples.append((time.time(), telemetry(d)))

    def _finish_rec(self, rec):
        rec.stop()
        if self.tap is not None:
            self.tap.stop()
        if rec.proc is None:
            self.say("stream recording stopped before any video arrived; capture and log kept")
        else:
            self.say("stream recording saved: %s (%.0f s)" % (shortpath(rec.path), time.time() - rec.started))
        try:
            write_rec_log(rec)
            if rec.started:
                write_srt(rec)
        except OSError as e:
            self.say("could not write the recording's log: %s" % e)

    def photo(self):
        r = self._drone().take_photo(timeout=3)
        self.say("photo: " + ("taken" if r is None or r.ok else "refused (code %s)" % r.code))

    def record(self, on):
        d = self._drone()
        r = (d.start_recording if on else d.stop_recording)(timeout=3)
        ok = r is None or r.ok
        if ok:
            with self.lock:
                self.recording = bool(on)
        self.say(("recording started" if on else "recording stopped") if ok
                 else "record command refused (code %s)" % r.code)

    # ---------------------------------------------------------------- status
    def status(self, since=0):
        with self.lock:
            d = self.drone
            out = {
                "conn": self.conn, "url": self.url, "phase": self.phase, "auto": self.auto,
                "route_id": self.route_id, "min_sats": self.min_sats,
                "next_id": self.next_id, "min_finish": self.min_finish,
                "pending": bool(self.thread and self.thread.is_alive()),
                "events": [e for e in self.events if e["seq"] > since],
                "video": bool(self.video and self.video.frame is not None),
                "manual": self.manual, "recording": self.recording, "rth_at": self.rth_at,
                "goto": self.goto_target, "manual_step": self.manual_step,
                "streamrec": self.streamrec and {"path": self.streamrec.path, "started": self.streamrec.started},
            }
        out["active"] = self.active()
        out["tele"] = telemetry(d) if d else None
        return out

    def trail_points(self):
        return list(self.trail)


def route_info(db_path, rid):
    """A route's name, link and the waypoint rows the battery forecast needs."""
    db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    try:
        head = db.execute("SELECT NAME, SPEED, AUTO_RECORD FROM X8_AI_LINE_POINT_INFO WHERE _id = ?",
                          (rid,)).fetchone()
        if head is None:
            raise KeyError("no route #%d" % rid)
        pts = db.execute("SELECT LATITUDE, LONGITUDE, ALTITUDE, SPEED, POINT_ACTION_CMD "
                         "FROM X8_AI_LINE_POINT_LATLNG_INFO WHERE LINE_ID = ? ORDER BY NUMBER", (rid,)).fetchall()
    finally:
        db.close()
    return {"name": head[0], "speed": head[1] or 5, "next_id": head[2] or None, "points": pts}


ACTION_DWELL = {1: 10, 2: 10, 4: 2, 5: 7, 6: 4}   # seconds a waypoint action holds the aircraft


def bearing_deg(a, b):
    """Compass bearing from a to b, degrees."""
    p1, p2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360


def ground_m(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[1] - a[1]) / 2) ** 2)
    return 2 * 6372800 * math.asin(math.sqrt(h))


def too_hot(d):
    """Why the aircraft is too hot to go on, or None."""
    s = d.state
    if s.errors and s.errors.sensor_overheat:
        return "the aircraft's sensor-overheat alarm is on"
    if s.battery and s.battery.temperature_c >= MAX_TEMP_C:
        return "battery at %.0f °C (limit %.0f °C)" % (s.battery.temperature_c, MAX_TEMP_C)
    return None


def battery_forecast(d, info, takeoff_batt):
    """(battery % now, % the route plus the flight home will use, how) or
    (None, 0, why) without battery telemetry.

    Time: from here to the first waypoint, every leg at the speed of the
    waypoint it arrives at (as openfimi flies it) plus 15 s a leg for
    acceleration, each action's dwell, then home at return-home speed and the
    descent. Drain: this flight's own %/s since take-off when it is long
    enough to tell, else a figure from earlier flights.
    """
    s = d.state
    if not (s.battery and s.sport):
        return None, 0, "no battery telemetry"
    pos, pts = (s.sport.lat, s.sport.lon), info["points"]
    secs, here = 0.0, pos
    for lat, lon, alt, spd, act in pts:
        v = max((spd or info["speed"] * 10) / 10, 0.5)
        secs += ground_m(here, (lat, lon)) / v + 15 + ACTION_DWELL.get(act, 0)
        here = (lat, lon)
    home = (s.home.lat, s.home.lon) if s.home and (s.home.lat or s.home.lon) else pos
    alt = max(p[2] for p in pts) if pts else s.sport.height_m
    secs += ground_m(here, home) / RTH_SPEED_MS + 15 + alt / 1.5
    rate, how = DRAIN_FALLBACK, "drain %.2f%%/s from earlier flights" % DRAIN_FALLBACK
    if takeoff_batt:
        t0, b0 = takeoff_batt
        flown = time.monotonic() - t0
        if flown > 60 and b0 - s.battery.percent >= 2:
            rate = (b0 - s.battery.percent) / flown
            how = "drain %.2f%%/s this flight" % rate
    return s.battery.percent, int(round(rate * secs)), "%s, about %d min to finish and get home" % (how, secs / 60)


def clock(secs):
    """Seconds as h:mm:ss.s (negative before the first video frame)."""
    sign, secs = ("-" if secs < 0 else ""), abs(secs)
    return "%s%d:%02d:%04.1f" % (sign, secs // 3600, secs % 3600 // 60, secs % 60)


def write_rec_log(rec):
    """The app's log for a recording, timed from the first video frame."""
    t0 = rec.started or rec.pressed
    name = os.path.basename(rec.base)
    with open(rec.base + ".log", "w") as f:
        f.write("# %s: times are into %s.mkv, which starts %s\n" % (
            name, name, time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(t0))))
        f.write("# full link capture: %s.ofcap (openfimi decode %s.ofcap)\n" % (name, name))
        for t, text in rec.events:
            f.write("%s  %s  %s\n" % (clock(t - t0), time.strftime("%H:%M:%S", time.localtime(t)), text))


def write_srt(rec):
    """One cue a second with the basics, plus events for 4 s after they happen."""
    def stamp(s):
        ms = int(round(max(s, 0) * 1000))
        return "%02d:%02d:%02d,%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)

    def line(t):
        bits = []
        if "height_m" in t:
            bits.append("%.0f m" % t["height_m"])
        if "speed_ms" in t:
            bits.append("%.0f km/h" % (t["speed_ms"] * 3.6))
        if "yaw" in t:
            bits.append("hdg %.0f°" % (t["yaw"] % 360))
        if "gimbal_pitch" in t:
            bits.append("gimbal %.0f°" % t["gimbal_pitch"])
        if t.get("route") and t.get("reached") is not None:
            bits.append("wp %d" % (t["reached"] + 1))
        if "battery_pct" in t:
            bits.append("bat %d%%" % t["battery_pct"])
        if "home_m" in t:
            bits.append("home %.0f m" % t["home_m"])
        return "  ·  ".join(bits)

    t0, n = rec.started, 0
    with open(rec.base + ".srt", "w") as f:
        for i, (t, tele) in enumerate(rec.samples):
            if t < t0:
                continue
            end = rec.samples[i + 1][0] if i + 1 < len(rec.samples) else t + 1.0
            text = [line(tele)] + [e for et, e in rec.events if t - 4.0 < et <= end]
            n += 1
            f.write("%d\n%s --> %s\n%s\n\n" % (n, stamp(t - t0), stamp(end - t0), "\n".join(x for x in text if x)))


def telemetry(d):
    """The flight screen's readout, from the latest decoded messages."""
    s = d.state
    t = {}
    if s.sport:
        p = s.sport
        t.update(lat=p.lat, lon=p.lon, height_m=round(p.height_m, 1), yaw=p.yaw_deg,
                 roll=p.roll_deg, pitch=p.pitch_deg, home_m=round(p.home_distance_m, 1),
                 speed_ms=round(p.ground_speed_ms, 2), vspeed_ms=round(p.vertical_speed_ms, 2),
                 age=round(s.age("sport"), 1))
    if s.heart:
        t.update(phase=s.heart.flight_phase, flying=s.heart.flying,
                 takeoff_block=s.heart.takeoff_block)
    if s.battery:
        b = s.battery
        t.update(battery_pct=b.percent, volts=round(b.voltage, 2), battery_temp=round(b.temperature_c, 1))
    if s.errors:
        t.update(overheat=s.errors.sensor_overheat, faults=s.errors.bits())
    if s.signal:
        t.update(sats=s.signal.satellites, rc_signal=s.signal.rc_signal)
    if s.rc_heart:
        t.update(rc_battery_pct=s.rc_heart.percent)
    if s.rc_sticks:
        t.update(rc_rth_pressed=s.rc_sticks.rth_pressed)
    if s.home and (s.home.lat or s.home.lon):
        t.update(home_lat=s.home.lat, home_lon=s.home.lon)
    if s.gimbal:
        t.update(gimbal_pitch=round(s.gimbal.pitch_deg, 1))
    if s.navigation:
        n = s.navigation
        t.update(task_mode=n.task_mode, ap_status=n.ap_status, route=n.task_mode == ROUTE_TASK_MODE,
                 rth=n.task_mode == RTH_TASK_MODE,
                 reached=None if n.waypoint == NO_WAYPOINT else n.waypoint)
    return t
