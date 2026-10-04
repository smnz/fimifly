/* Fimi route editor — browse / edit / create waypoint routes over a map. */

// ---------------------------------------------------------------- enums
// Each option is tagged by how its MEANING was established. These are no longer
// guesses from the order the UI lists options in: every mapping below was either
// round-tripped through the app or traced through the decompiled app
// (v1.1.43.20703) to the wire encoder.
//   'ok'    confirmed — a route was set in the Fimi app, pulled back with
//           ./read.py and the stored integer read off, AND/OR the value was
//           traced through the decompiled app to the 58-byte waypoint frame.
//   'wire'  the app's UI never emits this value, but whatever integer is stored
//           is passed straight to the aircraft on the wire, so its effect is
//           real but untested here. Learnable only by flight test: the flight
//           controller that interprets it is an ENCRYPTED firmware image
//           (confirmed 2026-10-03, Mini3_FC — no key in the app), not readable
//           from code. Shown as "… — sent to aircraft, untested".
//   'noop'  the value exists in the schema but does NOTHING on the aircraft: the
//           app never reads the column, or hard-codes/overwrites the wire byte,
//           so writing it has no effect. Shown as "… — not implemented".
//   'openfimi'  ignored by the stock app, but acted on when the route is flown
//           with openfimi (../openfimi). Shown as "… — openfimi only".
//   null    no name known; shown as "Value N — unverified".
// Tick "Raw enum values" to set any integer regardless of tier (for flight tests).
//
// Why the numbers are trustworthy and not positional: the mapping is per-control,
// not "index == value". The rotate selector writes its raw tab index (0 Min /
// 1 CW / 2 CCW, traced at e1.java:914), but the mission-end selector maps its two
// positions to 0 (Hover) and 4 (RTH) — so each control was checked on its own.
// Anchored by two routes configured in the app and pulled back:
//   "test"   speed 10.0 m/s, heading free,  failsafe continue(1), finish RTH(4)
//   "Test 2" speed  8.0 m/s, heading route, failsafe exit(0),     finish hover(0)
// Wire facts below come from decompiling v1.1.43.20703: the waypoint upload is a
// 58-byte packet whose bytes 36-39 are gimbal mode, trajectory mode, mission
// finish action and signal-loss action, filled from ROUTE settings, never from
// the per-waypoint columns.
const ENUMS = {
  // TYPE (route) and YAW_MODE (waypoint) are one setting: the app copies route
  // TYPE into every waypoint's YAW_MODE on save. Value 1 is only reachable from
  // the app's "fly now" screen, not its route planner.
  TYPE:                  [[0, 'Free', 'ok'], [1, 'Waypoint', 'ok'], [2, 'Route', 'ok']],
  SAVE_FLAG:             [[0, 'Normal', 'ok'], [1, 'Favourite', 'ok']],
  IS_CURVE:              [[0, 'Straight segments', 'noop'], [1, 'Curved path', 'noop']],
  // The map PROVIDER a route was saved under, not the basemap style. The app's
  // history list runs WHERE MAP_TYPE = (active provider == AMap ? 1 : 0), so a
  // route whose value does not match the phone's current provider is invisible.
  MAP_TYPE:              [[0, 'Google Maps', 'ok'], [1, 'AMap / Gaode', 'ok']],
  // Which screen the route was confirmed from; the app writes 1 only on the
  // live-video "fly" path.
  RUN_BY_MAP_OR_VEDIO:   [[0, 'Map planner', 'ok'], [1, 'Live video screen', 'ok']],
  DISCONNECT_TYPE:       [[0, 'Exit', 'ok'], [1, 'Continue mission', 'ok'], [2, null, 'wire'], [3, null, 'wire']],
  EXCUTE_END:            [[0, 'Hover', 'ok'], [1, null, 'wire'], [2, null, 'wire'], [3, null, 'wire'], [4, 'Return to home', 'ok'], [5, null, 'wire']],
  YAW_MODE:              [[0, 'Free', 'ok'], [1, 'Waypoint', 'ok'], [2, 'Route', 'ok']],
  // Never written by the app (always 0) and never read. Their wire bytes exist
  // (36 and 37 of the upload) but the app fills them itself: byte 36 = 1 when
  // the heading mode is Waypoint, else 0; byte 37 = 0 always.
  // Repurposed by openfimi: the stock app never reads this column, so it holds
  // when openfimi's gimbal follower applies GIMBAL_PITCH during a route.
  GIMBAL_MODE:           [[0, 'None (gimbal untouched)', 'ok'], [1, 'Before arrival', 'openfimi'],
                          [2, 'On arrival', 'openfimi']],
  TRAJECTORY_MODE:       [[0, null, 'noop'], [1, null, 'noop']],
  POINT_ACTION_CMD:      [[0, 'None', 'ok'], [1, 'Hover 10 s', 'ok'], [2, 'Record 10 s', 'ok'],
                          [3, '4× slow-motion video', 'noop'], [4, 'Single photo', 'ok'],
                          [5, 'Photo after 5 s hover', 'ok'], [6, 'Burst of 3 photos', 'ok']],
  // Per-waypoint MISSION_FINISH_ACTION and R_CLOST_ACTION are not edited here:
  // the wire bytes they would fill (38 and 39 of every waypoint) are always
  // the ROUTE's "At end of route" and "On signal loss", in the FIMI app and in
  // openfimi alike, so the columns are never read.
  // Direction the aircraft swings to face a POI; the app only shows this control
  // when the waypoint has a POI bound to it.
  RORATION:              [[0, 'Min angle', 'ok'], [1, 'Clockwise', 'ok'], [2, 'Counter-clockwise', 'ok']],
};
const MARK = { ok: ' \u2713', wire: '', noop: '', openfimi: '' };
// Field markers (the caption suffix) and the class that colours them; the key
// under the route form explains them.
const OPENFIMI = ' \u25c6';   // ◆ ignored by the stock app, flown by openfimi
const MARK_CLASS = { ' \u2717': 'absent', ' \u2298': 'substituted', ' \u2605': 'unlocked', [OPENFIMI]: 'openfimi' };
const GUESS_HINT = '\u2713 = confirmed: set in the Fimi app and pulled back, and/or traced through the decompiled app to the wire encoder.  ' +
                   '"sent to aircraft, untested" = the app never picks this value, but the column is passed straight to the drone on the wire, so flight-test to learn its effect (the flight-controller firmware is encrypted and cannot be read from code).  ' +
                   '"openfimi only" = the stock app ignores it; a route flown with openfimi acts on it.  ' +
                   '"not implemented" = the value exists but does nothing on the aircraft (the app ignores this column or hard-codes/overwrites the wire byte).  ' +
                   '"Value N \u2014 unverified" = the app stores this integer but its meaning is unknown. ' +
                   'Tick "Raw enum values" to enter any integer (e.g. to flight-test an untested one).';

const ROUTE_DEFAULTS = {
  NAME: 'New route', TYPE: 0, SPEED: 10, SAVE_FLAG: 0, DISTANCE: 0, IS_CURVE: 0,
  MAP_TYPE: 0, RUN_BY_MAP_OR_VEDIO: 0, DISCONNECT_TYPE: 1, EXCUTE_END: 4,
  AUTO_RECORD: 0, LOCALITY: '', ESTIMATED_TIME: '0', TIME: 0,
};
const POINT_DEFAULTS = {
  LONGITUDE: 0, LATITUDE: 0, ALTITUDE: 60, YAW: 0, GIMBAL_PITCH: 0, SPEED: 140,
  YAW_MODE: 0, GIMBAL_MODE: 0, TRAJECTORY_MODE: 0, MISSION_FINISH_ACTION: 0,
  R_CLOST_ACTION: 0, LONGITUDE_POI: 0, LATITUDE_POI: 0, ALTITUDE_POI: 0,
  POINT_ACTION_CMD: 0, RORATION: 0,
};

const ROUTE_FIELDS = [
  { key: 'NAME', label: 'Name', type: 'text', wide: true },
  { key: 'SPEED', label: 'Speed', type: 'number', step: 0.1, min: 0, speed: 1, tip: 'FIMI app: sets every waypoint. openfimi: ignored, waypoint speeds apply.',
    note: 'Whole metres/second. The FIMI app writes this into every waypoint when it loads the route, overriding their own speeds. openfimi does the reverse: it flies each waypoint\'s own speed and uses this only for a waypoint whose speed is 0.' },
  { key: 'ESTIMATED_TIME', label: 'Estimated time (s)', type: 'number', step: 1, recalc: true },
  { key: 'RUN_BY_MAP_OR_VEDIO', label: 'Run by', type: 'enum', note: 'Which screen the route was confirmed from: 0 the map planner, 1 the live-video fly screen. Code-traced; the app only uses it to decide how to present the route on load.' },
  { key: 'IS_CURVE', label: 'Path shape', type: 'enum' , note: 'Dead in this app version: the curve flag it would mirror is read in a few places but never switched on anywhere, the "Waypoint (Curve)" label is unused, and the upload hard-codes the turn byte to 0.', mark: ' ⊘' },
  { key: 'EXCUTE_END', label: 'At end of route', type: 'enum', note: 'The app offers only Hover (0) and Return to home (4), but whatever integer is stored here is passed straight to the aircraft on every waypoint (wire byte 38), so values 1/2/3/5 reach the flight controller untested. The FIMI app and openfimi both send it this way; the per-waypoint column is never used. Their behaviour is firmware-side and the FC image is encrypted (no key in the app), so the only way to learn them is a flight test.' },
  { key: 'DISCONNECT_TYPE', label: 'On signal loss', type: 'enum', note: 'The app offers only Exit (0) and Continue mission (1), but the stored integer is passed straight to the aircraft (wire byte 39), so values 2/3 reach the flight controller untested. The FIMI app and openfimi both send it this way; the per-waypoint column is never used. Firmware-side and the FC image is encrypted, so flight-test to learn them.' },
  // AUTO_RECORD is repurposed as the route to fly next: the stock app writes 0
  // on creation and never reads the column (its "Auto REC" control is a live
  // toggle, not stored here), so the link survives a round trip to the phone.
  { key: 'AUTO_RECORD', label: 'Next route', type: 'route', mark: OPENFIMI, wide: true, note: "Flown with openfimi, this route is followed straight away by the one chosen here, as soon as this route's last waypoint is done (its own return home is cancelled), and that one by its own next route, and so on, unless the battery would end below the floor set on the flight screen. Stored in the AUTO_RECORD column, which the FIMI app ignores; editing the route in the FIMI app may reset it." },
  { key: 'MAP_TYPE', label: 'Map provider', type: 'enum' , note: "Which map provider the route was saved under. The app lists only routes matching the phone's CURRENT provider — 0 Google Maps, 1 AMap/Gaode — so a mismatch makes the route vanish from the route list entirely, with no error. Keep this at 0 unless the phone is set to AMap." },
  { key: 'SAVE_FLAG', label: 'Favourite', type: 'enum' , note: "Set to 1 to make the route appear in the app's Favourites tab, which queries SAVE_FLAG = 1 in addition to the map-provider match. 0 lists in History only." },
  { key: 'TYPE', label: 'Heading mode', type: 'enum' },
  { key: 'LOCALITY', label: 'Locality', type: 'text', wide: true },
];

const POINT_FIELDS = [
  { key: 'LATITUDE', label: 'Latitude', type: 'number', step: 0.000001 },
  { key: 'LONGITUDE', label: 'Longitude', type: 'number', step: 0.000001 },
  { key: 'ALTITUDE', label: 'Altitude (m)', type: 'number', step: 1 },
  { key: 'SPEED', label: 'Speed', type: 'number', step: 0.1, speed: 0.1, tip: 'Speed of the leg flown TO this waypoint, not away from it', note: 'Decimetres/second for the leg ARRIVING at this waypoint (flight-verified 2026-10-04 with openfimi: wp3->wp4 cruised at wp4\'s speed, not wp3\'s). The stock app never reads it back: on load it writes route SPEED x 10 into every waypoint, so in the FIMI app only the route speed counts. openfimi sends each waypoint\'s own value, so per-waypoint and sub-integer speeds work there. Acceleration is gentle (~0.5 m/s²): legs under ~45 m stay below ~4.5 m/s.', mark: OPENFIMI },
  { key: 'YAW', label: 'Yaw (deg)', type: 'number', step: 0.1 , note: 'Discarded on load: with heading Free the angle is forced to 0, with heading Route it is recomputed as the bearing to the next waypoint. The per-waypoint "Heading Direction" the app shows is this angle, but only on its fly-to-record screen, where it is the heading the aircraft had when the point was recorded and is flown in the Waypoint heading mode. A saved route never gets that mode, so this column never reaches the aircraft.', mark: ' ⊘' },
  { key: 'GIMBAL_PITCH', label: 'Gimbal pitch (°)', type: 'number', step: 1, min: -90, max: 0, centi: true, note: "Degrees, negative = down: -90 straight down, 0 level. Stored in hundredths of a degree (-9000), as the app's fly-to-record screen writes it. The stock app sends it to the aircraft, but the aircraft ignores it on routes (flight tests 2026-09-10, including an orbit with values from 0 to -90 and two different starting pitches), and a POI steers yaw only. openfimi applies it from the ground during the route, at the moment chosen by Gimbal mode (verified on hardware 2026-10-03); with Gimbal mode None nothing happens. Upward pitches are possible on the gimbal but not allowed here for now.", mark: OPENFIMI },
  { key: 'YAW_MODE', label: 'Heading mode', type: 'enum' , note: 'The wire protocol carries this per waypoint, but the app writes the ROUTE heading mode into every waypoint on upload; the app has no per-waypoint heading mode control (its per-waypoint "Heading Direction" is the recorded yaw angle, see Yaw). Route "Heading mode" is what actually applies.', mark: ' ⊘' },
  { key: 'GIMBAL_MODE', label: 'Gimbal mode', type: 'enum', mark: OPENFIMI, note: 'Used by openfimi, ignored by the stock app (which never reads this column). Tells openfimi\'s gimbal follower when to apply this waypoint\'s Gimbal pitch during a route flown with openfimi: 0 None = leave the gimbal alone (the default; it stays wherever the pilot or an earlier waypoint left it). 1 Before arrival = in position 15 s before reaching the waypoint, estimated from distance and leg speed; on legs shorter than 15 s it moves as soon as the aircraft leaves the previous waypoint. Best for photos. 2 On arrival = moves when the waypoint is reached; best for video. A photo action at that waypoint is always taken BEFORE the move (measured: photo ~1.1 s before the aircraft reports arrival), so use Before arrival for photo points. Needs the remote link for the whole route.' },
  { key: 'POINT_ACTION_CMD', label: 'Action at point', type: 'enum', note: 'An app-level index, not a wire value: on upload the app expands it into a two-slot action with parameters (hover seconds, photo count). Value 3 has no case and sends an empty action. If either time-lapse switch is on in the app, every waypoint action is zeroed at upload.' },
  { key: 'TRAJECTORY_MODE', label: 'Trajectory', type: 'enum' , note: 'Not implemented: the app never reads this column and hard-codes its wire byte (37 of the waypoint upload) to 0, so editing it here has no effect on the aircraft.', mark: ' ⊘' },
  { key: 'RORATION', label: 'POI rotation', type: 'enum' },
  { key: 'ALTITUDE_POI', label: 'POI altitude (m)', type: 'number', step: 1 , note: "Loaded and flown (sent in decimetres). The app's POI tool cannot set it: it fixes a new POI's altitude to the aircraft's altitude at that moment, at least 5 m, so the app's POIs are looked at level. Any value, including ground level, is reachable only here.", mark: ' ★' },
  { key: 'LATITUDE_POI', label: 'POI latitude', type: 'number', step: 0.000001 , note: 'Loaded and flown. The app can set this too, with its map POI tool and "Bind waypoint".' },
  { key: 'LONGITUDE_POI', label: 'POI longitude', type: 'number', step: 0.000001 , note: 'Loaded and flown. The app can set this too, with its map POI tool and "Bind waypoint".' },
];

// ---------------------------------------------------------------- state
const state = {
  routes: [],
  route: null,      // currently open route (with .points)
  sel: -1,          // selected waypoint index
  dirty: false,
  raw: false,
  unit: 'kmh',      // display unit for both speed fields
  survey: { active: false, drawing: false, start: null, last: null, bounds: null, plan: null },
  photos: null,     // /api/routes/<id>/photos result for the open route
  poiPick: -1,      // waypoint index waiting for a map click to set its POI, or -1
  poiClip: null,    // copied POI {LATITUDE_POI, LONGITUDE_POI, ALTITUDE_POI}, so several waypoints can share one
  flight: false,    // flight screen open: route is read-only, map shows the aircraft
  flightManual: false,   // ... in manual flight: no route at all
};

// Route SPEED is stored in m/s; waypoint SPEED in decimetres/second — confirmed
// by two samples where waypoint SPEED was exactly 10x the route's (14 -> 140,
// 10 -> 100, the latter from a route set to 10.0 m/s in the app).
function unitLabel() { return state.unit === 'kmh' ? 'km/h' : 'm/s'; }
function unitFactor(msPerUnit) { return msPerUnit * (state.unit === 'kmh' ? 3.6 : 1); }
function fromStoredSpeed(stored, msPerUnit) {
  return +((Number(stored) || 0) * unitFactor(msPerUnit)).toFixed(2);
}
function toStoredSpeed(shown, msPerUnit) {
  const v = Math.round((Number(shown) || 0) / unitFactor(msPerUnit));
  return Math.max(0, Math.min(v, Math.round(MAX_SPEED_MS / msPerUnit)));
}
// The drone slows to a stop at each waypoint and accelerates away again, so
// duration is not distance/speed. The app sums, per leg, a flat 15.0 s plus a
// climb/descent-aware travel time plus a dwell for the next point's action.
// Only the flat constant and the travel term are reproduced here; the action
// dwell is not, so routes using photo/hover actions will read low.
const LEG_OVERHEAD = 15.0;   // the app's own literal constant, one per leg
const MAX_SPEED_MS = 14;     // drone's maximum flight speed

function estimateTime(points, speedMs) {
  if (points.length < 2) return 0;
  const v = Math.max(Number(speedMs) || 0, 0.1);
  return pathLength(points) / v + LEG_OVERHEAD * (points.length - 1);
}

function speedText(stored, msPerUnit) {
  return fromStoredSpeed(stored, msPerUnit) + ' ' + unitLabel();
}

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ map
const MAX_ZOOM = 22;                    // how deep the map will zoom, imagery or not
const PROBE_MIN = 14, PROBE_MAX = 21;   // range searched for real imagery coverage

const map = L.map('map', { zoomControl: true, worldCopyJump: true, maxZoom: MAX_ZOOM })
  .setView([20, 0], 2);                 // the world until a route opens (openRoute fits it)

const sat = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: MAX_ZOOM, maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' });
const labels = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: MAX_ZOOM, maxNativeZoom: 19, opacity: 0.9 });
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  { maxZoom: MAX_ZOOM, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
const topo = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: MAX_ZOOM, maxNativeZoom: 19, attribution: 'Map data &copy; Esri' });

sat.addTo(map);
labels.addTo(map);
L.control.layers(
  { 'Satellite': sat, 'Streets': streets, 'Topographic': topo },
  { 'Place labels': labels },
  { position: 'topright' }
).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

// ------------------------------------------------------- imagery coverage
// Esri's imagery cache runs out at a different level in different places, and
// past the end it serves a grey "Map data not yet available" tile with HTTP
// 200 rather than a 404 — so Leaflet cannot tell that the tile is empty. The
// service's tilemap endpoint does report real coverage, so probe it for the
// current view and pin maxNativeZoom to the deepest level that actually has
// imagery. Leaflet then upscales that last real tile for anything deeper.
const TILEMAP = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tilemap/';
const coverCache = new Map();

function tileXY(lat, lng, z) {
  const n = 2 ** z, rad = Math.PI / 180;
  return {
    x: Math.floor((lng + 180) / 360 * n),
    y: Math.floor((1 - Math.log(Math.tan(lat * rad) + 1 / Math.cos(lat * rad)) / Math.PI) / 2 * n),
  };
}

function tileExists(lat, lng, z) {
  const { x, y } = tileXY(lat, lng, z);
  const key = z + '/' + y + '/' + x;
  if (!coverCache.has(key)) {
    coverCache.set(key, fetch(TILEMAP + z + '/' + y + '/' + x + '/1/1?f=json')
      .then((r) => r.json())
      .then((d) => Array.isArray(d.data) && d.data[0] === 1)
      .catch(() => true));   // network trouble: assume present, don't degrade the map
  }
  return coverCache.get(key);
}

let probing = null;
async function updateNativeZoom() {
  if (probing) return;
  const c = map.getCenter();
  probing = (async () => {
    let lo = PROBE_MIN, hi = PROBE_MAX, best = PROBE_MIN;
    while (lo <= hi) {                       // coverage is monotonic: binary search
      const mid = (lo + hi) >> 1;
      if (await tileExists(c.lat, c.lng, mid)) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (sat.options.maxNativeZoom !== best) {
      sat.options.maxNativeZoom = best;
      if (map.hasLayer(sat)) sat.redraw();
    }
  })();
  try { await probing; } finally { probing = null; }
  updateZoomInfo();
}

function updateZoomInfo() {
  const z = map.getZoom();
  const layer = map.hasLayer(sat) ? sat : (map.hasLayer(topo) ? topo : streets);
  const native = Math.min(layer.options.maxNativeZoom, z);
  const el = $('zoominfo');
  if (!el) return;
  el.textContent = z > native
    ? 'z' + z + ' · imagery z' + native + ' · ' + Math.pow(2, z - native) + '× digital'
    : 'z' + z;
}

let probeTimer = null;
map.on('moveend zoomend', () => {
  updateZoomInfo();
  clearTimeout(probeTimer);
  if (map.getZoom() >= PROBE_MIN) probeTimer = setTimeout(updateNativeZoom, 250);
});
map.on('baselayerchange', updateZoomInfo);

let markers = [];
let poiMarkers = [];
let line = null;

map.on('mousemove', (e) => {
  $('mapinfo').textContent = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6) + statsText();
});
map.on('click', (e) => {
  if (state.flight) { gotoMapClick(e); return; }
  if (state.survey.active) return;
  if (state.poiPick >= 0) { setPoi(state.poiPick, e.latlng.lat, e.latlng.lng); return; }
  if (!state.route || !$('addmode').checked) return;
  addWaypoint(e.latlng.lat, e.latlng.lng);
});

// ---------------------------------------------------------- POI picking
function startPoiPick(i) {
  state.poiPick = i;
  $('map').classList.add('poi-pick');
  setStatus('Click the map to set the POI for waypoint #' + (i + 1) + ' (Esc to cancel)', 'dirty');
}
function endPoiPick() {
  state.poiPick = -1;
  $('map').classList.remove('poi-pick');
}
function setPoi(i, lat, lng) {
  const p = state.route && state.route.points[i];
  endPoiPick();
  if (!p) return;
  p.LATITUDE_POI = lat; p.LONGITUDE_POI = lng;
  markDirty();
  renderWaypoints();
  drawMap();
}
function copyPoi(i) {
  const p = state.route.points[i];
  state.poiClip = { LATITUDE_POI: p.LATITUDE_POI, LONGITUDE_POI: p.LONGITUDE_POI, ALTITUDE_POI: p.ALTITUDE_POI };
  renderWaypoints();
  setStatus('POI of waypoint #' + (i + 1) + ' copied', state.dirty ? 'dirty' : 'ok');
}
function pastePoi(i) {
  if (!state.poiClip) return;
  Object.assign(state.route.points[i], state.poiClip);
  markDirty();
  renderWaypoints();
  drawMap();
}
function clearPoi(i) {
  const p = state.route.points[i];
  p.LATITUDE_POI = 0; p.LONGITUDE_POI = 0; p.ALTITUDE_POI = 0;
  markDirty();
  renderWaypoints();
  drawMap();
}

// ------------------------------------------------------------- helpers
function haversine(a, b) {
  const R = 6372800, rad = Math.PI / 180;   // matches the app's own distance figures
  const p1 = a.LATITUDE * rad, p2 = b.LATITUDE * rad;
  const dp = p2 - p1, dl = (b.LONGITUDE - a.LONGITUDE) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pathLength(points) {
  let t = 0;
  for (let i = 1; i < points.length; i++) t += haversine(points[i - 1], points[i]);
  return t;
}
function statsText() {
  if (!state.route || state.flightManual) return '';
  const n = state.route.points.length;
  return '  ·  ' + n + ' waypoint' + (n === 1 ? '' : 's') + '  ·  ' + pathLength(state.route.points).toFixed(1) + ' m';
}
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(method + ' ' + url + ' -> ' + r.status);
  return r.status === 204 ? null : r.json();
}
function setStatus(msg, cls) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + (cls || '');
}
function markDirty() {
  state.dirty = true;
  $('save').disabled = false;
  $('revert').disabled = !state.route || state.route._id == null;
  setStatus('Unsaved changes', 'dirty');
}

// ------------------------------------------------------- form building
function makeField(spec, obj, onChange) {
  const wrap = document.createElement('label');
  if (spec.wide) wrap.className = 'wide';
  const cap = document.createElement('span');
  cap.textContent = spec.label + (spec.mark || '');
  if (spec.note) {
    wrap.title = spec.note;
    // a note without a marker carries no class — classList.add('') throws
    const cls = MARK_CLASS[spec.mark];
    if (cls) cap.classList.add(cls);
  }
  wrap.appendChild(cap);

  const isEnum = spec.type === 'enum' && !state.raw;
  let input;

  if (spec.type === 'route' && !state.raw) {
    input = document.createElement('select');
    const cur = Number(obj[spec.key]) || 0;
    input.appendChild(new Option('None', 0, false, !cur));
    let found = !cur;
    for (const r of state.routes) {
      if (r._id === obj._id) continue;
      input.appendChild(new Option((r.NAME || '(unnamed)') + ' #' + r._id, r._id, false, r._id === cur));
      if (r._id === cur) found = true;
    }
    if (!found) input.appendChild(new Option('Missing route #' + cur, cur, false, true));
  } else if (isEnum) {
    input = document.createElement('select');
    const opts = ENUMS[spec.key] || [];
    const cur = Number(obj[spec.key]);
    let found = false;
    for (const [val, text, conf] of opts) {
      const o = document.createElement('option');
      o.value = val;
      if (conf === 'noop')      o.textContent = (text || 'Value ' + val) + ' (' + val + ') \u2014 not implemented';
      else if (conf === 'openfimi') o.textContent = text + ' (' + val + ') \u2014 openfimi only';
      else if (conf === 'wire') o.textContent = (text || 'Value ' + val) + ' (' + val + ') \u2014 sent to aircraft, untested';
      else if (text)            o.textContent = text + ' (' + val + ')' + (MARK[conf] || '');
      else                      o.textContent = 'Value ' + val + ' \u2014 unverified';
      if (val === cur) { o.selected = true; found = true; }
      input.appendChild(o);
    }
    if (!found) {
      const o = document.createElement('option');
      o.value = cur; o.textContent = 'Unknown (' + cur + ')'; o.selected = true;
      input.appendChild(o);
    }
    wrap.title = GUESS_HINT;
    cap.textContent = spec.label + (spec.mark || '') + ' ⓘ';
  } else {
    input = document.createElement('input');
    input.type = spec.type === 'text' ? 'text' : 'number';
    if (spec.step) input.step = spec.step;
    if (spec.min !== undefined) input.min = spec.min;
    input.value = spec.speed ? fromStoredSpeed(obj[spec.key], spec.speed)
                : spec.centi ? Number(obj[spec.key] || 0) / 100
                : (obj[spec.key] ?? '');
    if (spec.max !== undefined) input.max = spec.max;
    if (spec.speed) {
      cap.textContent = spec.label + ' (' + unitLabel() + ')' + (spec.mark || '');
      input.max = +(MAX_SPEED_MS * (state.unit === 'kmh' ? 3.6 : 1)).toFixed(2);
      input.min = 0;
    }
  }

  input.addEventListener('change', () => {
    const v = input.value;
    if (spec.speed) {
      obj[spec.key] = toStoredSpeed(v, spec.speed);
      input.value = fromStoredSpeed(obj[spec.key], spec.speed);  // reflect what is actually stored
    } else if (spec.centi) {
      // shown in degrees, stored in hundredths; clamped to the field's range
      const deg = Math.min(spec.max, Math.max(spec.min, Number(v) || 0));
      obj[spec.key] = Math.round(deg * 100);
      input.value = obj[spec.key] / 100;
    } else {
      obj[spec.key] = (spec.type === 'text') ? v : (v === '' ? 0 : Number(v));
    }
    onChange(spec.key);
  });

  if (spec.recalc) {
    const row = document.createElement('div');
    row.className = 'row-btns';
    row.appendChild(input);
    const b = document.createElement('button');
    b.className = 'mini'; b.textContent = '↻'; b.type = 'button';
    b.title = 'Approximate from path length, route speed and a stop at each waypoint';
    b.addEventListener('click', () => {
      state.route.ESTIMATED_TIME = String(Math.round(estimateTime(state.route.points, state.route.SPEED)));
      input.value = state.route.ESTIMATED_TIME;
      markDirty();
    });
    row.appendChild(b);
    wrap.appendChild(row);
  } else {
    wrap.appendChild(input);
  }
  if (spec.tip) {
    const tip = document.createElement('small');
    tip.className = 'fieldhint';
    tip.textContent = spec.tip;
    wrap.appendChild(tip);
  }
  return wrap;
}

// -------------------------------------------------------- route list
async function loadRoutes(selectId) {
  state.routes = await api('GET', '/api/routes');
  renderRouteList();
  if (selectId != null) await openRoute(selectId);
}

function renderRouteList() {
  const ul = $('routelist');
  const q = $('filter').value.trim().toLowerCase();
  ul.textContent = '';
  for (const r of state.routes) {
    if (q && !(r.NAME || '').toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    if (state.route && state.route._id === r._id) li.className = 'sel';
    const name = document.createElement('div');
    name.className = 'rname';
    name.textContent = r.NAME || '(unnamed)';
    const meta = document.createElement('div');
    meta.className = 'rmeta';
    meta.textContent = '#' + r._id + '  ·  ' + r.point_count + ' wp  ·  ' +
                       Math.round(r.DISTANCE) + ' m  ·  ' + speedText(r.SPEED, 1) +
                       (r.AUTO_RECORD ? '  ·  then #' + r.AUTO_RECORD : '');
    li.append(name, meta);
    li.addEventListener('click', () => openRoute(r._id));
    ul.appendChild(li);
  }
}

// ------------------------------------------------------- open / render
async function confirmDiscard() {
  if (!state.dirty) return true;
  return confirm('Discard unsaved changes to the current route?');
}

async function openRoute(id) {
  if (!(await confirmDiscard())) return;
  const r = await api('GET', '/api/routes/' + id);
  state.route = r;
  state.sel = r.points.length ? 0 : -1;
  state.dirty = false;
  await loadPhotos();
  photoMsg('');
  $('save').disabled = true;
  $('revert').disabled = true;
  setStatus('');
  renderAll();
  fitRoute();
}

function newRoute() {
  confirmDiscard().then((ok) => {
    if (!ok) return;
    state.route = Object.assign({ _id: null, points: [] }, ROUTE_DEFAULTS);
    state.sel = -1;
    state.photos = null;
    renderAll();
    markDirty();
    setStatus('New route — click the map to add waypoints', 'dirty');
  });
}

function renderAll() {
  const has = !!state.route;
  $('editor').hidden = !has;
  $('noroute').hidden = has;
  renderRouteList();
  if (!has) { drawMap(); return; }
  $('routeid').textContent = state.route._id == null ? 'unsaved' : '#' + state.route._id;
  renderRouteForm();
  renderWaypoints();
  drawMap();
}

function renderRouteForm() {
  const f = $('routeform');
  f.textContent = '';
  for (const spec of ROUTE_FIELDS) {
    f.appendChild(makeField(spec, state.route, () => { markDirty(); if (spec.key === 'NAME') renderRouteList(); }));
  }
  // computed / informational
  const dist = document.createElement('label');
  dist.innerHTML = '<span>Distance (m, computed)</span>';
  const di = document.createElement('input');
  di.readOnly = true;
  di.value = pathLength(state.route.points).toFixed(2);
  di.id = 'distfield';
  dist.appendChild(di);
  f.appendChild(dist);

  const created = document.createElement('label');
  created.innerHTML = '<span>Created</span>';
  const ci = document.createElement('input');
  ci.readOnly = true;
  ci.value = state.route.TIME ? new Date(Number(state.route.TIME)).toLocaleString() : 'on save';
  created.appendChild(ci);
  f.appendChild(created);
}

function renderWaypoints() {
  const ol = $('wplist');
  ol.textContent = '';
  const pts = state.route.points;
  $('wpcount').textContent = pts.length;
  renderPhotoBar();

  pts.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = (i === state.sel ? 'sel ' : '') +
                   (i === 0 ? 'first ' : '') + (i === pts.length - 1 ? 'last' : '');

    const row = document.createElement('div');
    row.className = 'wp-row';
    const num = document.createElement('span');
    num.className = 'wp-num';
    num.textContent = i + 1;
    const sum = document.createElement('span');
    sum.className = 'wp-sum';
    sum.textContent = p.LATITUDE.toFixed(6) + ', ' + p.LONGITUDE.toFixed(6) +
                      '   ' + p.ALTITUDE + ' m   ' + speedText(p.SPEED, 0.1);
    const shots = photosFor(i);
    let thumb = null;
    if (shots.length) {
      thumb = document.createElement('span');
      thumb.className = 'wp-thumb';
      const img = document.createElement('img');
      img.src = photoUrl(shots[0].name, true);
      img.alt = shots[0].name;
      img.loading = 'lazy';
      thumb.appendChild(img);
      if (shots.length > 1) { const m = document.createElement('span'); m.className = 'more'; m.textContent = '+' + (shots.length - 1); thumb.appendChild(m); }
      thumb.title = shots.map((f) => f.name).join(', ') + ' — click to view';
      thumb.addEventListener('click', (e) => { e.stopPropagation(); showPhoto(i, shots[0]); });
    }
    const ctl = document.createElement('span');
    ctl.className = 'wp-ctl';
    ctl.append(
      btn('↑', 'Move up', (e) => { e.stopPropagation(); move(i, -1); }),
      btn('↓', 'Move down', (e) => { e.stopPropagation(); move(i, 1); }),
      btn('⧉', 'Duplicate', (e) => { e.stopPropagation(); duplicate(i); }),
      btn('✕', 'Delete', (e) => { e.stopPropagation(); removePoint(i); })
    );
    row.append(num, sum);
    if (thumb) row.appendChild(thumb);
    row.appendChild(ctl);
    row.addEventListener('click', () => select(i));
    li.appendChild(row);

    if (i === state.sel) {
      const patternBeforeEdit = northPattern(pts);
      const det = document.createElement('div');
      det.className = 'wp-detail form';
      for (const spec of POINT_FIELDS) {
        det.appendChild(makeField(spec, p, (key) => {
          markDirty();
          if (key === 'LATITUDE' || key === 'LONGITUDE') { if (patternBeforeEdit) applyNorthPattern(state.route.points); drawMap(); fitIfOffscreen(p); }
          else if (key.endsWith('_POI')) drawMap();
          sum.textContent = p.LATITUDE.toFixed(6) + ', ' + p.LONGITUDE.toFixed(6) +
                            '   ' + p.ALTITUDE + ' m   ' + speedText(p.SPEED, 0.1);
          $('distfield').value = pathLength(state.route.points).toFixed(2);
        }));
      }
      const poiRow = document.createElement('div');
      poiRow.className = 'poi-row wide';
      const hasPoi = !!(p.LATITUDE_POI || p.LONGITUDE_POI);
      const clip = state.poiClip;
      poiRow.append(
        btn(hasPoi ? 'Move POI on map' : 'Pick POI on map', 'Then click the map where the aircraft should look', (e) => { e.stopPropagation(); startPoiPick(i); }),
        btn('Copy POI', 'Remember this waypoint\'s POI so other waypoints can be given the same one', (e) => { e.stopPropagation(); copyPoi(i); }),
        btn('Paste POI', clip ? 'Give this waypoint the copied POI: ' + clip.LATITUDE_POI.toFixed(6) + ', ' + clip.LONGITUDE_POI.toFixed(6) + ', ' + clip.ALTITUDE_POI + ' m' : 'Copy a POI from another waypoint first', (e) => { e.stopPropagation(); pastePoi(i); }),
        btn('Clear POI', 'Remove the point of interest from this waypoint', (e) => { e.stopPropagation(); clearPoi(i); })
      );
      poiRow.children[1].disabled = !hasPoi;
      poiRow.children[2].disabled = !clip;
      poiRow.children[3].disabled = !hasPoi;
      det.appendChild(poiRow);
      li.appendChild(det);
    }
    ol.appendChild(li);
  });

  const add = document.createElement('button');
  add.className = 'mini addwp';
  add.textContent = '+ Add waypoint at map centre';
  add.addEventListener('click', () => {
    const c = map.getCenter();
    addWaypoint(c.lat, c.lng);
  });
  ol.appendChild(add);
}

function btn(text, title, fn) {
  const b = document.createElement('button');
  b.textContent = text; b.title = title;
  b.addEventListener('click', fn);
  return b;
}

// ------------------------------------------------------ waypoint edits
// Survey routes store each waypoint's POI 500 m due north of the waypoint
// BEFORE it (the first one north of itself), because the aircraft applies a
// waypoint's POI to the photo taken at the point before. Editing a route
// with that pattern rebuilds it, so deleting, moving or dragging points is
// safe; routes with real targets are left alone.
function northPattern(pts) {
  return pts.length > 1 && pts.every((p, i) => {
    const ref = pts[i - 1] || p;
    return Math.abs(p.LONGITUDE_POI - ref.LONGITUDE) < 1e-6 && Math.abs((p.LATITUDE_POI - ref.LATITUDE) * M_PER_DEG - POI_NORTH) < 2;
  });
}
function applyNorthPattern(pts) { pts.forEach((p, i) => Object.assign(p, northPoi(pts[i - 1] || p))); }
function aimAllNorth() {
  const pts = state.route.points;
  if (!pts.length) return;
  if (!northPattern(pts) && pts.some((p) => p.LATITUDE_POI || p.LONGITUDE_POI) &&
      !confirm('This route\'s POIs are not the survey pattern. Replace every POI with one 500 m north of the waypoint before it?')) return;
  applyNorthPattern(pts);
  markDirty();
  renderWaypoints();
  drawMap();
}
// Wraps an edit: applies it, then rebuilds the pattern if the route had it.
function editingPattern(fn) {
  const had = state.route && northPattern(state.route.points);
  fn();
  if (had) applyNorthPattern(state.route.points);
}

function select(i) {
  if (state.poiPick >= 0) endPoiPick();
  state.sel = i;
  renderWaypoints();
  drawMap();
  const li = $('wplist').children[i];
  if (li) li.scrollIntoView({ block: 'nearest' });
}

function addWaypoint(lat, lng) {
  const pts = state.route.points;
  const prev = pts.length ? pts[pts.length - 1] : null;
  const p = Object.assign({}, POINT_DEFAULTS, prev ? {
    ALTITUDE: prev.ALTITUDE, SPEED: prev.SPEED, GIMBAL_PITCH: prev.GIMBAL_PITCH,
    YAW: prev.YAW, YAW_MODE: prev.YAW_MODE, GIMBAL_MODE: prev.GIMBAL_MODE,
    TRAJECTORY_MODE: prev.TRAJECTORY_MODE, R_CLOST_ACTION: prev.R_CLOST_ACTION,
    MISSION_FINISH_ACTION: prev.MISSION_FINISH_ACTION, POINT_ACTION_CMD: prev.POINT_ACTION_CMD,
  } : {}, { LATITUDE: lat, LONGITUDE: lng });
  editingPattern(() => pts.push(p));
  state.sel = pts.length - 1;
  markDirty();
  renderWaypoints();
  drawMap();
}

function removePoint(i) {
  editingPattern(() => state.route.points.splice(i, 1));
  if (state.sel >= state.route.points.length) state.sel = state.route.points.length - 1;
  markDirty();
  renderWaypoints();
  drawMap();
}

function duplicate(i) {
  const copy = Object.assign({}, state.route.points[i]);
  delete copy._id;
  editingPattern(() => state.route.points.splice(i + 1, 0, copy));
  state.sel = i + 1;
  markDirty();
  renderWaypoints();
  drawMap();
}

function move(i, d) {
  const pts = state.route.points;
  const j = i + d;
  if (j < 0 || j >= pts.length) return;
  editingPattern(() => { [pts[i], pts[j]] = [pts[j], pts[i]]; });
  state.sel = j;
  markDirty();
  renderWaypoints();
  drawMap();
}

// -------------------------------------------------------------- drawing
function drawMap() {
  markers.forEach((m) => map.removeLayer(m));
  poiMarkers.forEach((m) => map.removeLayer(m));
  markers = []; poiMarkers = [];
  if (line) { map.removeLayer(line); line = null; }
  if (!state.route || state.survey.active || state.flightManual) return;   // survey and manual flight: no route drawn

  const pts = state.route.points;
  if (pts.length > 1) {
    line = L.polyline(pts.map((p) => [p.LATITUDE, p.LONGITUDE]),
      { color: '#39a7ff', weight: 3, opacity: 0.9 }).addTo(map);
  }

  pts.forEach((p, i) => {
    const cls = 'wp-marker' + (i === 0 ? ' start' : '') + (i === pts.length - 1 && pts.length > 1 ? ' end' : '') +
                (state.flight ? flightWpClass(i) : (i === state.sel ? ' sel' : ''));
    const m = L.marker([p.LATITUDE, p.LONGITUDE], {
      draggable: !state.flight,
      icon: L.divIcon({ className: '', html: '<div class="' + cls + '">' + (i + 1) + '</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(map);
    m.bindTooltip('#' + (i + 1) + ' · ' + p.ALTITUDE + ' m', { direction: 'top', offset: [0, -12] });
    let link = null;                       // dashed line to this waypoint's POI, if it has one
    let patternBeforeDrag = false;
    m.on('click', (e) => { L.DomEvent.stop(e); if (!state.flight) select(i); });
    m.on('dragstart', () => { patternBeforeDrag = northPattern(pts); });
    m.on('drag', (e) => {
      const ll = e.target.getLatLng();
      p.LATITUDE = ll.lat; p.LONGITUDE = ll.lng;
      if (line) line.setLatLngs(pts.map((q) => [q.LATITUDE, q.LONGITUDE]));
      if (link) link.setLatLngs([[p.LATITUDE, p.LONGITUDE], [p.LATITUDE_POI, p.LONGITUDE_POI]]);
    });
    m.on('dragend', () => {
      if (patternBeforeDrag) applyNorthPattern(pts);
      markDirty();
      renderWaypoints();
      drawMap();
      $('distfield').value = pathLength(pts).toFixed(2);
    });
    markers.push(m);

    if (p.LATITUDE_POI || p.LONGITUDE_POI) {
      const selected = i === state.sel;
      const pm = L.marker([p.LATITUDE_POI, p.LONGITUDE_POI], {
        draggable: !state.flight, zIndexOffset: selected ? 1000 : 0,
        icon: L.divIcon({ className: '', html: '<div class="poi-marker' + (selected ? ' sel' : '') + '"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      }).addTo(map);
      pm.bindTooltip('POI for #' + (i + 1), { direction: 'top', permanent: selected });
      pm.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        p.LATITUDE_POI = ll.lat; p.LONGITUDE_POI = ll.lng;
        markDirty(); renderWaypoints(); drawMap();
      });
      poiMarkers.push(pm);
      link = L.polyline([[p.LATITUDE, p.LONGITUDE], [p.LATITUDE_POI, p.LONGITUDE_POI]],
        selected ? { color: '#ffcc55', weight: 3, dashArray: '6 4', opacity: 1 }
                 : { color: '#ffcc55', weight: 1, dashArray: '4 4', opacity: 0.6 }).addTo(map);
      poiMarkers.push(link);
    }
  });
}

function fitRoute() {
  const pts = state.route && state.route.points;
  if (pts && pts.length) {
    map.fitBounds(L.latLngBounds(pts.map((p) => [p.LATITUDE, p.LONGITUDE])), { padding: [40, 40], maxZoom: 18 });
  }
}
function fitIfOffscreen(p) {
  if (!map.getBounds().contains([p.LATITUDE, p.LONGITUDE])) map.panTo([p.LATITUDE, p.LONGITUDE]);
}

// ----------------------------------------------------------- save/delete
async function save() {
  if (!state.route) return;
  const body = Object.assign({}, state.route);
  setStatus('Saving…');
  try {
    let res;
    if (state.route._id == null) {
      res = await api('POST', '/api/routes', body);
      state.route._id = res._id;
    } else {
      res = await api('PUT', '/api/routes/' + state.route._id, body);
    }
    state.route.DISTANCE = res.DISTANCE;
    state.dirty = false;
    $('save').disabled = true;
    $('revert').disabled = false;
    setStatus('Saved', 'ok');
    state.routes = await api('GET', '/api/routes');
    renderRouteList();
    $('routeid').textContent = '#' + state.route._id;
  } catch (e) {
    setStatus('Save failed: ' + e.message, 'err');
  }
}

async function deleteRoute() {
  if (!state.route || state.route._id == null) {
    state.route = null; state.dirty = false; renderAll(); return;
  }
  if (!confirm('Delete route "' + (state.route.NAME || '') + '" and all its waypoints?')) return;
  await api('DELETE', '/api/routes/' + state.route._id);
  state.route = null; state.sel = -1; state.dirty = false;
  $('save').disabled = true; $('revert').disabled = true;
  setStatus('Route deleted', 'ok');
  await loadRoutes();
  renderAll();
}

async function sendToPhone() {
  if (state.dirty) {
    if (!confirm('This route has unsaved changes.\n\nSave them first, then send to the phone?')) return;
    await save();
    if (state.dirty) return;                     // save failed; status already says so
  }
  if (!confirm('Replace the route database on the phone with this one?\n\n' +
               'The Fimi app will be force-stopped, its database overwritten, ' +
               'and the app relaunched. Routes on the phone that are not in this ' +
               'database will be gone.')) return;

  const panel = $('pushpanel'), log = $('pushlog'), b = $('push');
  panel.hidden = false; panel.className = '';
  $('pushtitle').textContent = 'Sending to phone…';
  log.textContent = 'Running write.py — stopping the app, pushing the database, relaunching…';
  b.disabled = true;
  setStatus('Sending to phone…');
  try {
    const r = await api('POST', '/api/push', {});
    panel.className = r.ok ? 'ok' : 'err';
    $('pushtitle').textContent = r.ok ? 'Sent to phone' : 'Send failed';
    log.textContent = r.output || '(no output)';
    setStatus(r.ok ? 'Sent to phone' : 'Send failed', r.ok ? 'ok' : 'err');
  } catch (e) {
    panel.className = 'err';
    $('pushtitle').textContent = 'Send failed';
    log.textContent = e.message;
    setStatus('Send failed', 'err');
  } finally {
    b.disabled = false;
  }
}

function applyToAll() {
  if (state.sel < 0) { alert('Select a waypoint first.'); return; }
  const src = state.route.points[state.sel];
  for (const p of state.route.points) {
    p.ALTITUDE = src.ALTITUDE;
    p.SPEED = src.SPEED;
    p.GIMBAL_PITCH = src.GIMBAL_PITCH;
    p.GIMBAL_MODE = src.GIMBAL_MODE;
    p.YAW_MODE = src.YAW_MODE;
  }
  markDirty();
  renderWaypoints();
  drawMap();
}


// ---------------------------------------------------------- route photos
// The flight's photos are dropped on the waypoint panel, copied to a folder
// per route on the server, matched in capture order to the waypoints whose
// action takes a photo, shown as thumbnails, and exported as a Google Earth
// KML of north-up ground overlays into that folder. Per-action photo counts
// mirror PHOTOS_PER_ACTION in app.py.
const PHOTOS_PER_ACTION = { 4: 1, 5: 1, 6: 3 };

function expectedPhotos(points) {
  let photos = 0, wps = 0;
  for (const p of points) {
    const n = PHOTOS_PER_ACTION[p.POINT_ACTION_CMD];
    if (n) { photos += n; wps += 1; }
  }
  return { photos, wps };
}

function photosFor(i) {        // files assigned to waypoint index i, in capture order
  const ph = state.photos;
  return ph && ph.complete ? ph.photos.filter((f) => f.waypoint === i + 1) : [];
}

async function loadPhotos() {
  state.photos = null;
  if (state.route && state.route._id != null) {
    try { state.photos = await api('GET', '/api/routes/' + state.route._id + '/photos'); } catch (e) { /* none yet */ }
  }
}

function photoMsg(text, cls) {
  const el = $('photomsg');
  el.textContent = text || '';
  el.className = 'hint ' + (cls || '');
}

function renderPhotoBar() {
  const hint = $('photohint'), ctl = $('photoctl');
  const { photos, wps } = expectedPhotos(state.route.points);
  const ph = state.photos;
  hint.textContent = '';
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  if (!photos) {
    hint.textContent = 'No waypoint in this route takes a photo.';
    hint.className = 'hint'; ctl.hidden = true; return;
  }
  if (ph && ph.complete) {
    hint.textContent = plural(ph.count, 'photo') + ' on ' + plural(ph.waypoints, 'waypoint') + ', matched by capture time. Drop a new set to replace them. ';
    hint.className = 'hint ok'; ctl.hidden = false;
  } else {
    const pick = document.createElement('a');
    pick.textContent = 'choose them';
    pick.addEventListener('click', () => $('photofile').click());
    hint.append('Drag the flight\'s ' + plural(photos, 'photo') + ' onto this panel, or ');
    hint.appendChild(pick);
    hint.append('. They are matched to the ' + plural(wps, 'photo waypoint') + ' in capture order.');
    if (ph && ph.count) hint.append(' (' + ph.count + ' stored, which no longer fits this route.)');
    hint.className = 'hint'; ctl.hidden = true;
  }
}

async function uploadPhotos(fileList) {
  const files = [...fileList].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png)$/i.test(f.name));
  if (!files.length) { photoMsg('No image files in that drop.', 'warn'); return; }
  if (state.route._id == null || state.dirty) {
    if (!confirm('The route must be saved before photos can be attached. Save it now?')) return;
    await save();
    if (state.dirty || state.route._id == null) return;
  }
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  photoMsg('Uploading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…');
  try {
    const r = await fetch('/api/routes/' + state.route._id + '/photos', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) { photoMsg(d.error || ('upload failed: ' + r.status), 'warn'); return; }
    state.photos = d;
    photoMsg('');
    renderWaypoints();
    setStatus('Photos attached', 'ok');
  } catch (e) {
    photoMsg('Upload failed: ' + e.message, 'warn');
  }
}

async function clearPhotos() {
  if (!state.route || state.route._id == null) return;
  if (!confirm('Remove the photos attached to this route?')) return;
  await api('DELETE', '/api/routes/' + state.route._id + '/photos');
  await loadPhotos();
  photoMsg('');
  renderWaypoints();
}

async function exportKml() {
  const body = { transparency: Number($('kml-alpha').value) || 0, zoom: Number($('kml-zoom').value) || 1 };
  $('kmlexport').disabled = true;
  try {
    const r = await fetch('/api/routes/' + state.route._id + '/kml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { photoMsg(d.error || ('export failed: ' + r.status), 'warn'); return; }
    photoMsg('Wrote ' + d.path + ' (' + d.photos + ' overlays, ordered by ' + d.time_source.join(' and ') + '). Open it in Google Earth; the photos sit next to it.', 'ok');
    setStatus('KML written', 'ok');
  } catch (e) {
    photoMsg('Export failed: ' + e.message, 'warn');
  } finally {
    $('kmlexport').disabled = false;
  }
}

function photoUrl(name, thumb) {
  return '/api/routes/' + state.route._id + '/photos/' + encodeURIComponent(name) + (thumb ? '?thumb=1' : '');
}

function showPhoto(i, f) {
  $('lightboximg').src = photoUrl(f.name, false);
  $('lightboxcap').textContent = '#' + (i + 1) + ' · ' + f.name + ' · ' + new Date(f.time * 1000).toLocaleString();
  $('lightbox').hidden = false;
}

// ---------------------------------------------------------- survey grid
// Plans a lawnmower route over a dragged rectangle so that nadir photos taken
// at every waypoint overlap by the requested fraction. Camera: Fimi Mini 3,
// 1/2-inch sensor, 4.71 mm lens (24 mm equivalent), f/1.6, 79 deg diagonal
// field of view, digital zoom to 6x. The 79 deg figure is treated as the
// diagonal of a 4:3 still; digital zoom crops the frame, so the footprint
// shrinks linearly with it. Ground is assumed flat at the take-off altitude.
//
// The aircraft faces due north throughout, so the long side of the footprint
// always lies east-west: E-W spacing comes from the frame width and N-S
// spacing from the frame height, whichever way the lines run. Heading is left
// at Free and every photo waypoint carries a POI 500 m due north, which the
// aircraft turns to face at each point (flight-tested 2026-09-10; a POI steers
// yaw only and never touches the gimbal). Lines run east-west by default so
// every leg is flown sideways: the body rolls instead of pitching, which is
// the one pattern in which the hand-set -90 gimbal stayed put in flight.
const CAMERA = { diagFovDeg: 79, aspect: [4, 3], maxZoom: 6 };
const M_PER_DEG = 2 * Math.PI * 6372800 / 360;   // same radius as haversine() above
const PART_SIZE = 20;                            // the app's per-route limit; longer grids are cut into parts
const MIN_SPACING = 10;                          // the app refuses a waypoint within 10 m of any other
const NADIR_PITCH = -9000;                       // gimbal straight down, in stored hundredths of a degree
const POI_NORTH = 500;                          // metres due north, on the waypoint's own meridian
const DEFAULT_SPEED_MS = 5;                     // gentle: tilt from acceleration and braking is what disturbs the gimbal

// A POI on the waypoint's own meridian is due north at any distance; 500 m
// keeps it well clear of position error and of the app's small waypoint-only
// coordinate nudge, without dragging the phone's map fit halfway to the pole.
function northPoi(q) {
  return { LATITUDE_POI: q.LATITUDE + POI_NORTH / M_PER_DEG, LONGITUDE_POI: q.LONGITUDE, ALTITUDE_POI: 0 };
}

// Measured on three flights (11-12 Sep, image registration against the known
// legs): the photo taken at waypoint k faces the POI stored on waypoint k+1.
// So each waypoint carries a POI 500 m due north of the waypoint BEFORE it,
// and every route ends with a photo-less tail point carrying the POI for the
// last photo. The first point's own POI is only in force on the way in.
function northPois(points) {
  return points.map((q, i) => Object.assign({}, q, northPoi(points[i - 1] || q)));
}

// Tail point: just past a route's last photo, half a spacing ahead along the
// row and half a row toward the rows still to fly (the middle of the next
// cell), or outside the grid along the row if the grid is too tight.
function tailPoint(plan, last) {
  const pts = plan.points, per = plan.perLine;
  const idx = pts.findIndex((q) => q.LATITUDE === last.LATITUDE && q.LONGITUDE === last.LONGITUDE);
  const row = Math.floor(Math.max(idx, 0) / per), r0 = pts[row * per], r1 = pts[row * per + 1] || r0;
  let ax = (r1.LONGITUDE - r0.LONGITUDE) * plan.mLng, ay = (r1.LATITUDE - r0.LATITUDE) * plan.mLat;
  if (!ax && !ay) { ax = 1; ay = 0; }
  const al = Math.hypot(ax, ay); ax /= al; ay /= al;
  const nxt = pts[(row + 1) * per] || pts[(row - 1) * per] || r0;
  let cx = -ay, cy = ax;
  const dx = (nxt.LONGITUDE - r0.LONGITUDE) * plan.mLng, dy = (nxt.LATITUDE - r0.LATITUDE) * plan.mLat;
  if (dx * cx + dy * cy < 0) { cx = -cx; cy = -cy; }
  const sAlong = plan.rowsAlongEW ? plan.stepEW : plan.stepNS, sAcross = plan.rowsAlongEW ? plan.stepNS : plan.stepEW;
  const clear = (q) => pts.every((g) => haversine(q, g) >= MIN_SPACING + 0.5);
  const at = (ex, ny) => ({ LATITUDE: last.LATITUDE + ny / plan.mLat, LONGITUDE: last.LONGITUDE + ex / plan.mLng, kind: 'tail' });
  let q = at(ax * sAlong / 2 + cx * sAcross / 2, ay * sAlong / 2 + cy * sAcross / 2);
  if (!clear(q)) {
    const span = (plan.rowsAlongEW ? plan.extEW : plan.extNS) + 2 * LEAD_OUT;
    let ahead = 0;
    do { ahead += 5; q = at(ax * ahead, ay * ahead); } while (!clear(q) && ahead < span);
  }
  return Object.assign(q, northPoi(last));
}

// The first photo has no previous waypoint to aim it, so every set of routes
// starts with a lead-in: one extra waypoint just outside the grid, before
// point 1 along the north-south axis (the same kind of hop the rows use),
// with its POI due north of point 1. No photo.
const LEAD_OUT = 15;                            // metres outside the grid
function gridLeadIn(plan, first) {
  const south = first.LATITUDE <= plan.centre.lat;                 // point 1 on the south edge: lead in from the south
  const q = { LATITUDE: first.LATITUDE + (south ? -LEAD_OUT : LEAD_OUT) / plan.mLat, LONGITUDE: first.LONGITUDE, kind: 'leadin' };
  return Object.assign(q, northPoi(first));
}

// Lead-in for a route that starts in the middle of the grid: behind its first
// point along the row and half a row toward the rows already flown, i.e. the
// middle of a grid cell, where it is clear of every photo point. If the grid
// is too tight for that, it goes just outside the grid on the same row, and
// the aircraft crabs along the row to the first point.
function midGridLeadIn(plan, first) {
  const pts = plan.points, per = plan.perLine;
  const idx = pts.findIndex((q) => q.LATITUDE === first.LATITUDE && q.LONGITUDE === first.LONGITUDE);
  const row = Math.floor(Math.max(idx, 0) / per), r0 = pts[row * per], r1 = pts[row * per + 1] || r0;
  let ax = (r1.LONGITUDE - r0.LONGITUDE) * plan.mLng, ay = (r1.LATITUDE - r0.LATITUDE) * plan.mLat;    // row travel direction
  if (!ax && !ay) { ax = 1; ay = 0; }
  const al = Math.hypot(ax, ay); ax /= al; ay /= al;
  // across the rows, pointing away from the previous row: the perpendicular
  // to the row direction, signed by where the neighbouring row lies (rows
  // start at alternate ends, so their first points must not be compared directly)
  const prev = pts[(row - 1) * per] || pts[(row + 1) * per] || r0;
  let cx = -ay, cy = ax;
  const dx = (r0.LONGITUDE - prev.LONGITUDE) * plan.mLng, dy = (r0.LATITUDE - prev.LATITUDE) * plan.mLat;
  if (dx * cx + dy * cy < 0) { cx = -cx; cy = -cy; }
  if (row === 0 && pts[per]) { cx = -cx; cy = -cy; }                                                   // no previous row: lean toward the next one instead
  const sAlong = plan.rowsAlongEW ? plan.stepEW : plan.stepNS, sAcross = plan.rowsAlongEW ? plan.stepNS : plan.stepEW;
  const clear = (q) => pts.every((g) => haversine(q, g) >= MIN_SPACING + 0.5);
  const at = (dx, dy) => ({ LATITUDE: first.LATITUDE + dy / plan.mLat, LONGITUDE: first.LONGITUDE + dx / plan.mLng, kind: 'leadin' });
  let q = at(-ax * sAlong / 2 - cx * sAcross / 2, -ay * sAlong / 2 - cy * sAcross / 2);               // cell centre, behind and on the flown side
  if (!clear(q)) {                                                                                      // fall back: outside the grid, same row
    const span = (plan.rowsAlongEW ? plan.extEW : plan.extNS) + 2 * LEAD_OUT;
    let back = 0;
    do { back += 5; q = at(-ax * back, -ay * back); } while (!clear(q) && back < span);
  }
  return Object.assign(q, northPoi(first));
}

// Split photo points into routes. Heading 'poi': every photo point carries a
// POI due north of the point before it and each route ends with a tail point
// carrying the POI for its last photo. Heading 'leadin': only lead-ins carry a
// POI and Free mode holds the heading in between. Lead-ins as chosen: 'all'
// gives every route its own, 'first' one outside the grid ahead of the whole
// set, 'none' relies on the pilot facing north for the first photo.
function surveyRoutes(plan, points, heading, mode) {
  const parts = [];
  if (heading === 'poi') {
    for (let i = 0; i < points.length;) {
      const withLead = mode === 'all' || (mode === 'first' && i === 0);
      const per = PART_SIZE - 1 - (withLead ? 1 : 0);
      const chunk = northPois(points.slice(i, i + per));
      i += per;
      const lead = withLead ? [parts.length === 0 ? gridLeadIn(plan, chunk[0]) : midGridLeadIn(plan, chunk[0])] : [];
      parts.push([...lead, ...chunk, tailPoint(plan, chunk[chunk.length - 1])]);
    }
    return parts;
  }
  const pts = points.map((q) => Object.assign({}, q));
  if (mode === 'none') return surveyParts(pts);
  if (mode === 'first') return surveyParts([gridLeadIn(plan, pts[0]), ...pts]);
  for (let i = 0; i < pts.length; i += PART_SIZE - 1) {
    const chunk = pts.slice(i, i + PART_SIZE - 1);
    parts.push([i === 0 ? gridLeadIn(plan, chunk[0]) : midGridLeadIn(plan, chunk[0]), ...chunk]);
  }
  return parts;
}

// Obliques follow the same rule: the photo at oblique k faces the POI of
// oblique k+1, so each oblique carries the target of the one before it and a
// tail point carries the last target; the first oblique's own POI is its own
// target, in force on the way in. A lead-in ahead of the ring is optional.
function obliqueRoute(plan, obliques) {
  if (!obliques.length) return [];
  const targets = obliques.map((q) => ({ LATITUDE_POI: q.LATITUDE_POI, LONGITUDE_POI: q.LONGITUDE_POI, ALTITUDE_POI: 0 }));
  obliques = obliques.map((q, i) => Object.assign({}, q, targets[i - 1] || targets[0]));
  const oN = obliques[obliques.length - 1];
  let tx = (oN.LONGITUDE - plan.centre.lng) * plan.mLng, ty = (oN.LATITUDE - plan.centre.lat) * plan.mLat;
  const tl = Math.hypot(tx, ty) || 1;
  const tail = Object.assign({ LATITUDE: oN.LATITUDE + LEAD_OUT * ty / tl / plan.mLat, LONGITUDE: oN.LONGITUDE + LEAD_OUT * tx / tl / plan.mLng, kind: 'tail' }, targets[targets.length - 1]);
  obliques = [...obliques, tail];
  const o1 = obliques[0];
  let dx = (o1.LONGITUDE - plan.centre.lng) * plan.mLng, dy = (o1.LATITUDE - plan.centre.lat) * plan.mLat;
  const len = Math.hypot(dx, dy) || 1;
  const lead = { LATITUDE: o1.LATITUDE + LEAD_OUT * dy / len / plan.mLat, LONGITUDE: o1.LONGITUDE + LEAD_OUT * dx / len / plan.mLng, kind: 'leadin',
                 LATITUDE_POI: o1.LATITUDE_POI, LONGITUDE_POI: o1.LONGITUDE_POI, ALTITUDE_POI: 0 };
  return [lead, ...obliques];
}

// Oblique pass: a ring of points just outside the area, each looking inward
// at a POI on the ground, placed so that the line of sight dips by the chosen
// pitch. openfimi sets that pitch on the way to every waypoint (Gimbal mode
// Before arrival); with the stock app the pilot sets it
// by hand before flying the pass, which a uniform pitch makes possible.
// The POI sits inside the area, one line-of-sight run inward from the point,
// or at the middle of the area if that is nearer.
const OBLIQUE_MARGIN = 10;                      // metres outside the boundary
function surveyObliques(plan, alt, count, pitchDeg) {
  if (!count) return [];
  const c = plan.centre, halfEW = plan.extEW / 2 + OBLIQUE_MARGIN, halfNS = plan.extNS / 2 + OBLIQUE_MARGIN;
  const run = alt / Math.tan(pitchDeg * Math.PI / 180);           // horizontal distance that gives the pitch
  const pts = [];
  for (let k = 0; k < count; k++) {
    const a = 2 * Math.PI * k / count;                              // bearing from the centre, from north
    const sx = Math.sin(a), cy = Math.cos(a);
    const t = 1 / Math.max(Math.abs(sx) / halfEW, Math.abs(cy) / halfNS);   // ray from the centre to the expanded boundary
    const dx = sx * t, dy = cy * t;                                 // metres east and north of the centre
    const dist = Math.hypot(dx, dy);
    const f = Math.max(0, 1 - run / dist);                          // POI fraction of the way back toward the centre
    const q = { LATITUDE: c.lat + dy / plan.mLat, LONGITUDE: c.lng + dx / plan.mLng, kind: 'oblique',
                LATITUDE_POI: c.lat + dy * f / plan.mLat, LONGITUDE_POI: c.lng + dx * f / plan.mLng, ALTITUDE_POI: 0,
                pitch: -Math.round(pitchDeg * 100) };
    pts.push(q);
  }
  return pts;
}

// Cut the photo points into routes of PART_SIZE, in lawnmower order. A cut
// may fall mid-line; the aircraft hovers at the end of a route and the next
// one carries on from the following point.
function surveyParts(points) {
  const parts = [];
  for (let i = 0; i < points.length; i += PART_SIZE) parts.push(points.slice(i, i + PART_SIZE));
  return parts;
}

function footprint(altitude, zoom) {
  const tanD = Math.tan(CAMERA.diagFovDeg / 2 * Math.PI / 180);
  const [a, b] = CAMERA.aspect, d = Math.hypot(a, b);
  const z = Math.min(Math.max(Number(zoom) || 1, 1), CAMERA.maxZoom);
  return { ew: 2 * altitude * tanD * a / d / z, ns: 2 * altitude * tanD * b / d / z };
}

// Photo centres along one axis: the area is cut into equal strips no wider
// than the requested spacing and a photo is taken at the middle of each. The
// outer lines therefore sit half a strip inside the boundary, the same gap as
// half the line spacing, and the outer photos overhang the boundary by
// (footprint - strip) / 2.
function axisPositions(extent, fp, overlap) {
  const n = Math.max(1, Math.ceil(extent / (fp * (1 - overlap)) - 1e-9));
  const step = extent / n;
  return Array.from({ length: n }, (_, k) => (k + 0.5) * step);
}

function surveyPlan(bounds, start, alt, zoom, overlap, lines) {
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const mLat = M_PER_DEG, mLng = M_PER_DEG * Math.cos((sw.lat + ne.lat) / 2 * Math.PI / 180);
  const extEW = (ne.lng - sw.lng) * mLng, extNS = (ne.lat - sw.lat) * mLat;
  const fp = footprint(alt, zoom);
  const xs = axisPositions(extEW, fp.ew, overlap), ys = axisPositions(extNS, fp.ns, overlap);
  const rowsAlongEW = lines === 'ew' ? true : lines === 'ns' ? false : xs.length >= ys.length;
  // start in the corner nearest to where the drag began
  const xo = Math.abs(start.lng - sw.lng) <= Math.abs(start.lng - ne.lng) ? xs : xs.slice().reverse();
  const yo = Math.abs(start.lat - sw.lat) <= Math.abs(start.lat - ne.lat) ? ys : ys.slice().reverse();
  const grid = [];
  if (rowsAlongEW) yo.forEach((y, i) => (i % 2 ? xo.slice().reverse() : xo).forEach((x) => grid.push({ x, y })));
  else xo.forEach((x, i) => (i % 2 ? yo.slice().reverse() : yo).forEach((y) => grid.push({ x, y })));
  const points = grid.map((g) => ({ LATITUDE: sw.lat + g.y / mLat, LONGITUDE: sw.lng + g.x / mLng }));
  return {
    points, fp, extEW, extNS, mLat, mLng, rowsAlongEW,
    centre: { lat: (sw.lat + ne.lat) / 2, lng: (sw.lng + ne.lng) / 2 },
    lines: rowsAlongEW ? ys.length : xs.length,
    perLine: rowsAlongEW ? xs.length : ys.length,
    stepEW: xs.length > 1 ? xs[1] - xs[0] : 0,
    stepNS: ys.length > 1 ? ys[1] - ys[0] : 0,
    overEW: (fp.ew - extEW / xs.length) / 2,   // how far the outer photos reach past the boundary
    overNS: (fp.ns - extNS / ys.length) / 2,
  };
}

const surveyLayers = L.layerGroup().addTo(map);
let surveyRect = null;

function surveyParams() {
  return {
    alt: Math.max(1, Number($('sv-alt').value) || 0),
    zoom: Math.min(Math.max(Number($('sv-zoom').value) || 1, 1), CAMERA.maxZoom),
    overlap: Math.min(Math.max(Number($('sv-overlap').value) || 0, 0), 90) / 100,
    lines: $('sv-lines').value,
    heading: $('sv-heading').value,                     // 'poi' on every waypoint, or 'leadin' then Free hold
    leadins: $('sv-leadins').value,
    settle: $('sv-settle').value === 'hover',        // photo after a 5 s hover, so the heading has settled
    obliques: Number($('sv-obliques').value) || 0,
    obliquePitch: Math.min(85, Math.max(10, Number($('sv-oblpitch').value) || 45)),
    speed: Math.max(1, Math.min(MAX_SPEED_MS, toStoredSpeed($('sv-speed').value, 1) || DEFAULT_SPEED_MS)),   // whole m/s, as the app stores it
    highAlt: Math.max(0, Number($('sv-high').value) || 0),
  };
}

function surveyEnter() {
  const sv = state.survey;
  sv.active = true;
  drawMap();                                          // clear the open route off the map, keep the view
  $('surveypanel').hidden = false;
  let folded = false;
  try { folded = localStorage.getItem('surveyFolded') === '1'; } catch (e) { /* ignore */ }
  surveyFold(folded);
  $('survey').disabled = true;
  map.dragging.disable();
  map.boxZoom.disable();
  $('map').classList.add('survey-draw');
  map.on('mousedown', svDown);
  map.on('mousemove', svMove);
  map.on('mouseup', svUp);
  document.addEventListener('mouseup', svUpDoc);
  surveyReset();
}

function surveyExit() {
  const sv = state.survey;
  sv.active = false; sv.drawing = false; sv.bounds = null; sv.plan = null;
  drawMap();                                          // bring the open route back
  $('surveypanel').hidden = true;
  $('survey').disabled = false;
  map.dragging.enable();
  map.boxZoom.enable();
  $('map').classList.remove('survey-draw');
  map.off('mousedown', svDown);
  map.off('mousemove', svMove);
  map.off('mouseup', svUp);
  document.removeEventListener('mouseup', svUpDoc);
  surveyLayers.clearLayers();
  surveyRect = null;
}

// Fold the panel up to its title bar so the map is clear for drawing; the
// rectangle, stats and Create button keep working underneath. Remembered per browser.
function surveyFold(folded) {
  $('surveypanel').classList.toggle('folded', folded);
  $('surveyfold').innerHTML = folded ? '&#9662;' : '&#9652;';
  $('surveyfold').title = folded ? 'Unfold the survey panel' : 'Fold the panel up to its title bar to clear the map';
  $('surveyfold').setAttribute('aria-expanded', String(!folded));
  try { localStorage.setItem('surveyFolded', folded ? '1' : ''); } catch (e) { /* storage blocked: fold just isn't remembered */ }
}

function surveyReset() {
  const sv = state.survey;
  sv.drawing = false; sv.bounds = null; sv.plan = null; sv.parts = null; sv.high = null; sv.highParts = []; sv.obliques = []; sv.obliqueParts = [];
  syncSpeedField();
  surveyLayers.clearLayers();
  surveyRect = null;
  $('sv-area').value = '';
  $('surveystats').textContent = '';
  $('surveycreate').disabled = true;
  $('surveyhint').textContent = 'Drag a rectangle on the map to mark the survey area.';
  setStatus('Survey: drag a rectangle on the map', 'dirty');
}

function svDown(e) {
  const sv = state.survey;
  if (sv.drawing) return;
  sv.drawing = true;
  sv.start = e.latlng; sv.last = e.latlng;
  surveyLayers.clearLayers();
  surveyRect = L.rectangle(L.latLngBounds(e.latlng, e.latlng),
    { color: '#2ee6a8', weight: 2, dashArray: '6 4', fillOpacity: 0.08 }).addTo(surveyLayers);
  L.DomEvent.stop(e.originalEvent);
}
function svMove(e) {
  const sv = state.survey;
  if (!sv.drawing) return;
  sv.last = e.latlng;
  surveyRect.setBounds(L.latLngBounds(sv.start, e.latlng));
}
function svUp(e) { svFinish(e.latlng); }
function svUpDoc() { if (state.survey.drawing) svFinish(state.survey.last); }

function svFinish(end) {
  const sv = state.survey;
  if (!sv.drawing) return;
  sv.drawing = false;
  const b = L.latLngBounds(sv.start, end);
  const p1 = map.latLngToContainerPoint(sv.start), p2 = map.latLngToContainerPoint(end);
  if (Math.abs(p1.x - p2.x) < 4 || Math.abs(p1.y - p2.y) < 4) {   // a click, not a drag
    surveyLayers.clearLayers(); surveyRect = null;
    $('surveyhint').textContent = 'That was a click — press and drag to draw the area.';
    return;
  }
  sv.bounds = b;
  surveyRect.setBounds(b);
  $('surveyhint').textContent = 'Adjust the parameters, then create the routes. Drag again to redraw the area.';
  surveyRecompute();
}

function surveyRecompute() {
  const sv = state.survey;
  if (!sv.bounds) return;
  const { alt, zoom, overlap, lines: lineDir, heading, leadins, settle, speed, highAlt, obliques, obliquePitch } = surveyParams();
  const plan = surveyPlan(sv.bounds, sv.start, alt, zoom, overlap, lineDir);
  sv.plan = plan;
  sv.parts = surveyRoutes(plan, plan.points, heading, leadins);
  sv.obliques = surveyObliques(plan, alt, obliques, obliquePitch);
  const obl = obliqueRoute(plan, sv.obliques);
  sv.obliqueParts = surveyParts(leadins === 'none' ? obl.slice(1) : obl);
  sv.high = highAlt > alt ? surveyPlan(sv.bounds, sv.start, highAlt, zoom, overlap, lineDir) : null;
  sv.highParts = sv.high ? surveyRoutes(sv.high, sv.high.points, heading, leadins) : [];

  // preview: path, photo centres, and the footprint of the first photo
  surveyLayers.clearLayers();
  surveyRect = L.rectangle(sv.bounds, { color: '#2ee6a8', weight: 2, dashArray: '6 4', fillOpacity: 0.08 }).addTo(surveyLayers);
  const pts = plan.points;
  const p0 = pts[0];
  L.rectangle([[p0.LATITUDE - plan.fp.ns / 2 / plan.mLat, p0.LONGITUDE - plan.fp.ew / 2 / plan.mLng],
               [p0.LATITUDE + plan.fp.ns / 2 / plan.mLat, p0.LONGITUDE + plan.fp.ew / 2 / plan.mLng]],
    { color: '#ffcc55', weight: 1, fillOpacity: 0.15 }).addTo(surveyLayers);
  if (pts.length > 1) L.polyline(pts.map((p) => [p.LATITUDE, p.LONGITUDE]), { color: '#2ee6a8', weight: 2, opacity: 0.9 }).addTo(surveyLayers);
  const show = pts.length <= 600 ? pts : [];   // keep the map responsive on absurd inputs
  show.forEach((p, i) => L.circleMarker([p.LATITUDE, p.LONGITUDE],
    { radius: i === 0 ? 5 : 3, color: i === 0 ? '#ffcc55' : '#2ee6a8', weight: 1, fillOpacity: 0.9 }).addTo(surveyLayers));
  const parts = sv.parts;
  const flown = parts.flat();
  for (const q of sv.obliques) {
    L.circleMarker([q.LATITUDE, q.LONGITUDE], { radius: 5, color: '#ff8c42', fillColor: '#ff8c42', fillOpacity: 0.9, weight: 1 })
      .bindTooltip('Oblique: looks inward at ' + (q.pitch / 100) + '°', { direction: 'top' }).addTo(surveyLayers);
    L.polyline([[q.LATITUDE, q.LONGITUDE], [q.LATITUDE_POI, q.LONGITUDE_POI]], { color: '#ff8c42', weight: 1, dashArray: '4 4', opacity: 0.7 }).addTo(surveyLayers);
  }
  for (const q of [...flown, ...sv.obliqueParts.flat(), ...sv.highParts.flat()]) {
    if (q.kind !== 'leadin' && q.kind !== 'tail') continue;
    L.circleMarker([q.LATITUDE, q.LONGITUDE], { radius: 5, color: '#ffcc55', weight: 2, fillColor: '#12161c', fillOpacity: 1 })
      .bindTooltip(q.kind === 'tail' ? 'Tail: no photo, carries the POI for the last shot' : 'Lead-in: no photo, aims the first shot', { direction: 'top' }).addTo(surveyLayers);
  }
  if (sv.obliques.length > 1) L.polyline([...sv.obliques, sv.obliques[0]].map((q) => [q.LATITUDE, q.LONGITUDE]), { color: '#ff8c42', weight: 1, opacity: 0.5, dashArray: '2 6' }).addTo(surveyLayers);
  parts.forEach((part, k) => L.circleMarker([part[0].LATITUDE, part[0].LONGITUDE],
    { radius: 7, color: '#ffcc55', weight: 2, fillColor: '#12161c', fillOpacity: 1 })
    .bindTooltip('Part ' + (k + 1), { permanent: true, direction: 'right', offset: [8, 0], className: 'part-label' }).addTo(surveyLayers));
  if (sv.high) L.polyline(sv.highParts.flat().map((q) => [q.LATITUDE, q.LONGITUDE]), { color: '#d98cff', weight: 1.5, opacity: 0.8, dashArray: '6 4' }).addTo(surveyLayers);

  const n = pts.length;
  const nLead = flown.filter((q) => q.kind === 'leadin' || q.kind === 'tail').length;
  const nPhotos = n + sv.obliques.length + (sv.high ? sv.high.points.length : 0);
  const len = pathLength(flown) + pathLength(sv.obliqueParts.flat()) + (sv.high ? pathLength(sv.highParts.flat()) : 0);
  const secs = estimateTime(flown, speed) + estimateTime(sv.obliqueParts.flat(), speed) + (sv.high ? estimateTime(sv.highParts.flat(), speed) : 0);
  $('sv-area').value = Math.round(plan.extEW) + ' × ' + Math.round(plan.extNS) + ' m';
  const lines = [
    'Footprint per photo: ' + plan.fp.ew.toFixed(1) + ' m E-W × ' + plan.fp.ns.toFixed(1) + ' m N-S at ' + alt + ' m, ' + zoom + '×',
    'Photo spacing: ' + (plan.stepEW ? plan.stepEW.toFixed(1) + ' m E-W' : 'single column') + ', ' + (plan.stepNS ? plan.stepNS.toFixed(1) + ' m N-S' : 'single row'),
    plan.lines + ' line' + (plan.lines === 1 ? '' : 's') + ' × ' + plan.perLine + ' photo' + (plan.perLine === 1 ? '' : 's') + (nLead ? ' + ' + nLead + ' lead-in/tail point' + (nLead === 1 ? '' : 's') : '') + ' = ' + flown.length + ' waypoints in ' + parts.length + ' route' + (parts.length === 1 ? '' : 's') + ' of up to ' + PART_SIZE,
    'Lines ' + (plan.rowsAlongEW ? 'east-west, flown sideways' : 'north-south, flown forwards and backwards') + (heading === 'poi' ? ' with the nose turned north by POIs (each stored one waypoint late, as the aircraft applies them)' : ' with the nose pointed north by the lead-in and held by Free mode') + ', at ' + speedText(speed, 1),
    settle ? 'Each photo after a 5 s hover, so the heading has settled (measured 3-5° lean into the direction of travel without it)' : 'Single photo on arrival: expect a 3-5° lean into the direction of travel on the row photos',
    sv.obliques.length ? 'Oblique pass: ' + sv.obliques.length + ' photos around the area looking inward at ' + obliquePitch + '° down, plus a lead-in, in ' + sv.obliqueParts.length + ' more route' + (sv.obliqueParts.length === 1 ? '' : 's') + '; openfimi holds the gimbal at ' + obliquePitch + '° down, re-set on the way to every point (with the FIMI app, set it by hand)' : 'No obliques',
    sv.high ? 'High pass at ' + highAlt + ' m: ' + sv.high.points.length + ' photos plus a lead-in in ' + sv.highParts.length + ' more route' + (sv.highParts.length === 1 ? '' : 's') : 'No high pass',
    'Outer photos reach ' + plan.overEW.toFixed(1) + ' m E-W and ' + plan.overNS.toFixed(1) + ' m N-S past the boundary',
    'Path ' + Math.round(len) + ' m, about ' + Math.round((secs + (settle ? 5 * nPhotos : 0)) / 60) + ' min' + (settle ? ' including the hovers' : ' before photo dwell'),
  ];
  const box = $('surveystats');
  box.textContent = '';
  box.className = 'stats';
  for (const t of lines) { const d = document.createElement('div'); d.textContent = t; box.appendChild(d); }
  const warn = (t) => { const d = document.createElement('div'); d.className = 'warn'; d.textContent = t; box.appendChild(d); };
  if (!plan.rowsAlongEW) warn('North-south lines are flown forwards and backwards; in tests the -90 gimbal crept up on those legs. East-west lines held it.');
  if (highAlt > 0 && highAlt <= alt) warn('High pass ignored: ' + highAlt + ' m is not above the survey altitude of ' + alt + ' m. It is an altitude above take-off, not an extra height.');
  const tight = [plan.stepEW, plan.stepNS].filter((v) => v > 0);
  if (tight.length && Math.min(...tight) < MIN_SPACING) {
    warn('Photo spacing under ' + MIN_SPACING + ' m: the app refuses waypoints that close together. Fly higher or lower the overlap.');
  }
  $('surveycreate').disabled = false;
}

// Short stamp for route names: the Fimi app's route list truncates long names,
// so names are kept short and lead with the part number.
function surveyStamp() {
  const d = new Date(), two = (n) => String(n).padStart(2, '0');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return d.getDate() + mon + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

// Every waypoint carries the route's pitch with Gimbal mode Before arrival, so
// openfimi sets it as the route starts and re-asserts it on the way to each
// point, correcting any slight drift before the photo. The stock app ignores
// both columns.
function surveyWaypoint(q, alt, speed, settle) {
  const poi = q.LATITUDE_POI != null ? { LATITUDE_POI: q.LATITUDE_POI, LONGITUDE_POI: q.LONGITUDE_POI, ALTITUDE_POI: q.ALTITUDE_POI }
                                     : { LATITUDE_POI: 0, LONGITUDE_POI: 0, ALTITUDE_POI: 0 };   // lead-in-only heading: Free mode holds
  return Object.assign({}, POINT_DEFAULTS, {
    LATITUDE: q.LATITUDE, LONGITUDE: q.LONGITUDE, ALTITUDE: Math.round(alt), SPEED: speed * 10,
    YAW: 0, YAW_MODE: 0, GIMBAL_PITCH: q.pitch != null ? q.pitch : NADIR_PITCH, GIMBAL_MODE: 1, POINT_ACTION_CMD: q.kind === 'leadin' || q.kind === 'tail' ? 0 : (settle ? 5 : 4), RORATION: 0,
  }, poi);
}

// Saves every route straight to the database as favourites: the grid parts,
// then the high-pass parts if asked for. Every route but the last ends in
// Hover where the next begins.
async function surveyCreate() {
  const sv = state.survey;
  if (!sv.parts || !sv.parts.length) return;
  if (!(await confirmDiscard())) return;
  const { alt, speed, highAlt, settle, heading } = surveyParams();
  const stamp = surveyStamp();
  const sets = [{ label: 'grid', parts: sv.parts, alt }];
  if (sv.obliques.length) sets.push({ label: 'obliques', parts: sv.obliqueParts, alt });
  if (sv.high) sets.push({ label: 'high', parts: sv.highParts, alt: highAlt });
  const routes = [];
  sets.forEach((set, si) => set.parts.forEach((pts, k) => {
    const lastOfAll = si === sets.length - 1 && k === set.parts.length - 1;
    const route = Object.assign({ points: [] }, ROUTE_DEFAULTS, {
      NAME: (set.parts.length > 1 ? (k + 1) + '/' + set.parts.length + ' ' : '') + set.label + ' ' + stamp,   // e.g. "3/9 grid 11Sep 12:45"

      TYPE: 0, SAVE_FLAG: 1, SPEED: speed,
      EXCUTE_END: lastOfAll ? ROUTE_DEFAULTS.EXCUTE_END : 0,   // hover between routes, home after the last
    });
    route.points = pts.map((q) => surveyWaypoint(q, set.alt, speed, settle));
    route.ESTIMATED_TIME = String(Math.round(estimateTime(route.points, speed) + (settle ? 5 * route.points.filter((w) => w.POINT_ACTION_CMD === 5).length : 0)));
    if (heading === 'poi') route.TYPE = 0;
    routes.push(route);
  }));

  $('surveycreate').disabled = true;
  setStatus('Creating ' + routes.length + ' routes…');
  const ids = [];
  try {
    for (const r of routes) ids.push((await api('POST', '/api/routes', r))._id);
    // chain them, so openfimi flies each straight after the one before
    for (let i = 0; i + 1 < ids.length; i++) await api('PUT', '/api/routes/' + ids[i], { AUTO_RECORD: ids[i + 1] });
  } catch (e) {
    setStatus('Route creation failed after ' + ids.length + ' of ' + routes.length + ': ' + e.message, 'err');
    $('surveycreate').disabled = false;
    await loadRoutes();
    return;
  }
  surveyExit();
  state.dirty = false;
  await loadRoutes(ids[0]);
  setStatus('Created ' + routes.length + ' route' + (routes.length === 1 ? '' : 's') + ', saved as favourites', 'ok');
}

// -------------------------------------------------------------- wiring
$('kmlexport').addEventListener('click', exportKml);
$('photoclear').addEventListener('click', clearPhotos);
$('photofile').addEventListener('change', (e) => { uploadPhotos(e.target.files); e.target.value = ''; });
for (const ev of ['dragenter', 'dragover']) $('props').addEventListener(ev, (e) => {
  if (!state.route || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; $('props').classList.add('dropping');
});
$('props').addEventListener('dragleave', (e) => { if (!$('props').contains(e.relatedTarget)) $('props').classList.remove('dropping'); });
$('props').addEventListener('drop', (e) => {
  $('props').classList.remove('dropping');
  if (!state.route || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  uploadPhotos(e.dataTransfer.files);
});
$('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });
$('newroute').addEventListener('click', newRoute);
$('survey').addEventListener('click', surveyEnter);
$('surveyclose').addEventListener('click', surveyExit);
$('surveyfold').addEventListener('click', () => surveyFold(!$('surveypanel').classList.contains('folded')));
$('surveyredraw').addEventListener('click', surveyReset);
$('surveycreate').addEventListener('click', surveyCreate);
for (const id of ['sv-alt', 'sv-zoom', 'sv-overlap', 'sv-speed', 'sv-high', 'sv-oblpitch']) $(id).addEventListener('input', surveyRecompute);
for (const id of ['sv-lines', 'sv-obliques', 'sv-leadins', 'sv-settle', 'sv-heading']) $(id).addEventListener('change', surveyRecompute);
$('sv-heading').addEventListener('change', () => {                 // lead-ins are essential without POIs, optional with them
  $('sv-leadins').value = $('sv-heading').value === 'leadin' ? 'all' : 'none';
  surveyRecompute();
});
// the speed field follows the km/h / m/s toggle like every other speed
let svSpeedMs = DEFAULT_SPEED_MS;
function syncSpeedField() {
  $('sv-speedcap').textContent = 'Speed (' + unitLabel() + ')';
  $('sv-speed').value = fromStoredSpeed(svSpeedMs, 1);
}
$('sv-speed').addEventListener('change', () => { svSpeedMs = surveyParams().speed; syncSpeedField(); surveyRecompute(); });
$('speedunit').addEventListener('change', syncSpeedField);
syncSpeedField();
$('save').addEventListener('click', save);
$('revert').addEventListener('click', () => {
  if (state.route && state.route._id != null) { state.dirty = false; openRoute(state.route._id); }
});
$('delroute').addEventListener('click', deleteRoute);
$('applyall').addEventListener('click', applyToAll);
$('aimnorth').addEventListener('click', aimAllNorth);
$('push').addEventListener('click', sendToPhone);
$('pushclose').addEventListener('click', () => { $('pushpanel').hidden = true; });
$('filter').addEventListener('input', renderRouteList);
$('speedunit').addEventListener('change', (e) => {
  state.unit = e.target.value;
  renderRouteList();
  if (state.route) { renderRouteForm(); renderWaypoints(); }
});
$('rawmode').addEventListener('change', (e) => {
  state.raw = e.target.checked;
  if (state.route) { renderRouteForm(); renderWaypoints(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lightbox').hidden) { $('lightbox').hidden = true; return; }
  if (e.key === 'Escape' && state.poiPick >= 0) { endPoiPick(); setStatus(state.dirty ? 'Unsaved changes' : '', state.dirty ? 'dirty' : ''); return; }
  if (e.key === 'Escape' && state.survey.active) { surveyExit(); setStatus(''); return; }
  if (e.ctrlKey && e.key === 's' && !state.flight) { e.preventDefault(); if (!$('save').disabled) save(); }
  if (e.key === 'Delete' && state.sel >= 0 && !state.flight && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    removePoint(state.sel);
  }
});
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ------------------------------------------------------------ flight mode
// Flies the open (saved) route with openfimi through the server (flight.py):
// connect to the aircraft, launch by hand or hands-off, and watch telemetry,
// route progress and the FPV video. The server owns the connection, so
// leaving this screen or reloading the page changes nothing on the aircraft.
// Connect, auto launch and launch are locked from take-off until landed.
const fl = {
  timer: null, since: 0, st: null, wasConn: false,
  craft: null, home: null, trail: null, lastFit: 0,
  reached: -1,          // waypoints reached on the current route, -1 = route not running
};
const CRAFT_SVG = '<svg viewBox="0 0 28 28"><path d="M14 2 L23 25 L14 19 L5 25 Z" fill="#2ee6a8" stroke="#06121f" stroke-width="1.5"/></svg>';
const PHASE_TEXT = {
  idle: 'Ready', waiting: 'Auto launch armed: waiting for the aircraft', launching: 'Taking off',
  flying: 'Flying the route', done: 'Route finished', failed: 'Stopped', cancelled: 'Launch cancelled',
  rth: 'EMERGENCY RETURN HOME', manual: 'Manual flight', returning: 'Returning home to land', landing: 'Landing',
};

function flightWpClass(i) {
  if (fl.reached < 0) return '';
  return i < fl.reached ? ' done' : (i === fl.reached ? ' cur' : '');
}

async function flightPost(path, body) {
  const r = await fetch('/api/flight/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) {
    const e = new Error(d.error || ('HTTP ' + r.status));
    e.logged = !!d.error;          // the server has put it in the flight log already
    throw e;
  }
  return d;
}

async function enterFlight(manual) {
  let st;
  try { st = await api('GET', '/api/flight'); }
  catch (e) { setStatus('Flight server unavailable: ' + e.message, 'err'); return; }
  if (st.error) { setStatus(st.error, 'err'); return; }
  const routeUnderWay = st.pending || ['waiting', 'launching', 'flying'].includes(st.phase) && st.active;
  if (manual && routeUnderWay && st.route_id != null) {
    setStatus('A route flight is under way; showing it', 'dirty');
    await openRoute(st.route_id);
    manual = false;
  }
  if (!manual && (!state.route || state.route._id == null)) { setStatus('Save the route before flying it', 'err'); return; }
  if (!manual && state.dirty) { setStatus('Save the route first: openfimi flies what is in the database', 'err'); return; }
  const idle = !st.active && !st.pending;
  if (manual) {
    if (idle) {
      try { await flightPost('config', { auto: false }); }
      catch (e) { setStatus('Flight server: ' + e.message, 'err'); return; }
    }
  } else if (!idle && st.route_id !== state.route._id) {
    // something is already under way: show that route, not this one
    setStatus('A flight is under way on route #' + st.route_id + '; showing it', 'dirty');
    await openRoute(st.route_id);
  } else if (idle) {
    // a fresh route flight: auto launch starts off, and the next route
    // defaults to the route's stored link
    try { await flightPost('config', { route_id: state.route._id, auto: false, next_id: state.route.AUTO_RECORD || null }); }
    catch (e) { setStatus('Could not select the route: ' + e.message, 'err'); return; }
  }
  state.flight = true;
  state.flightManual = !!manual;
  document.body.classList.toggle('flightmanual', !!manual);
  fl.centred = false;
  map.keyboard.disable();          // the arrow keys fly the aircraft here, not the map
  if (state.poiPick >= 0) endPoiPick();
  document.body.classList.add('flightmode');
  $('flightpanel').hidden = $('videopanel').hidden = false;
  for (const id of ['save', 'revert', 'push', 'fly', 'manualfly']) $(id).hidden = true;
  $('flyexit').hidden = false;
  try { $('fl-url').value = localStorage.getItem('fimi.flightUrl') || st.url || ''; } catch (e) { $('fl-url').value = st.url || ''; }
  if (st.conn !== 'disconnected') $('fl-url').value = st.url;
  $('fl-route').textContent = manual ? 'Manual flight' : state.route.NAME + ' #' + state.route._id;
  $('fl-log').textContent = '';
  fl.since = 0; fl.st = null; fl.reached = -1; fl.wasConn = false;
  if (!manual) { renderFlightRoute(); fillNextSelect(); }
  flightLayers(true);
  try {
    const t = await api('GET', '/api/flight/trail');
    fl.trail.setLatLngs(t);
  } catch (e) { /* no trail yet */ }
  setTimeout(() => map.invalidateSize(), 0);
  drawMap();
  setStatus('');
  await flightPoll();
  fl.timer = setInterval(flightPoll, 500);
}

function exitFlight() {
  releaseAll();
  if (fl.st && fl.st.manual) flightPost('manual', { on: false }).catch(() => {});
  map.keyboard.enable();
  clearInterval(fl.timer); fl.timer = null;
  state.flight = false;
  state.flightManual = false;
  fl.reached = -1;
  document.body.classList.remove('flightmode', 'flightmanual');
  $('flightpanel').hidden = $('videopanel').hidden = true;
  $('fpv').removeAttribute('src');
  for (const id of ['save', 'revert', 'push', 'fly', 'manualfly']) $(id).hidden = false;
  $('flyexit').hidden = true;
  flightLayers(false);
  gt.layer.clearLayers(); gotoSetPick(null); gt.init = false;
  setTimeout(() => map.invalidateSize(), 0);
  renderAll();
}

function flightLayers(on) {
  for (const k of ['craft', 'home', 'trail']) { if (fl[k]) { map.removeLayer(fl[k]); fl[k] = null; } }
  if (!on) return;
  fl.trail = L.polyline([], { color: '#2ee6a8', weight: 2, opacity: 0.8 }).addTo(map);
}

async function flightPoll() {
  let st;
  try { st = await api('GET', '/api/flight?since=' + fl.since); }
  catch (e) { $('fl-phase').textContent = 'Server unreachable: ' + e.message; $('fl-phase').className = 'fl-phase bad'; return; }
  if (!state.flight) return;
  fl.st = st;
  const log = $('fl-log');
  for (const ev of st.events) {
    const t = new Date(ev.t * 1000).toTimeString().slice(0, 8);
    log.textContent += t + '  ' + ev.text + '\n';
    fl.since = ev.seq;
  }
  if (st.events.length) log.scrollTop = log.scrollHeight;
  if (st.conn === 'connected' && !fl.wasConn) fl.trail.setLatLngs([]);   // a new connection starts a new trail
  fl.wasConn = st.conn === 'connected';
  renderFlightControls(st);
  renderTelemetry(st);
  renderVideo(st);
}

function renderFlightControls(st) {
  const conn = st.conn, locked = st.active;
  const b = $('fl-connect');
  b.textContent = conn === 'connected' ? 'Disconnect' : conn === 'connecting' ? 'Connecting…' : 'Connect';
  b.disabled = locked || conn === 'connecting';
  $('fl-url').disabled = conn !== 'disconnected';
  $('fl-auto').checked = st.auto;
  $('fl-auto').disabled = locked;
  if (document.activeElement !== $('fl-sats')) $('fl-sats').value = st.min_sats;
  $('fl-sats').disabled = locked || st.pending;
  $('fl-launch').disabled = st.auto || conn !== 'connected' || locked || st.pending;
  $('fl-launch').title = st.auto ? 'Disabled while auto launch is on: it takes off by itself'
                                 : 'Check the aircraft now and, if it is ready, take off and fly the route';
  $('flyexit').disabled = locked || st.pending;
  const flying = !!(st.tele && st.tele.flying);
  $('fl-takeoff').disabled = conn !== 'connected' || flying || st.pending;
  for (const id of ['gt-go', 'gt-alt-only', 'gt-hover']) $(id).disabled = conn !== 'connected' || !flying || st.pending;
  if (state.flightManual) { gotoInit(st); gotoDraw(st); }
  $('fl-land').disabled = $('fl-home').disabled = conn !== 'connected' || !flying;
  renderControls(st);
  // a chained flight has moved on to its next route: show that one
  if (!state.flightManual && st.route_id && state.route && st.route_id !== state.route._id && !fl.switching) {
    fl.switching = true;
    openRoute(st.route_id).then(() => {
      fl.reached = -1;
      $('fl-route').textContent = state.route.NAME + ' #' + state.route._id;
      renderFlightRoute();
      fillNextSelect();
    }).finally(() => { fl.switching = false; });
  }
  $('flyexit').title = locked || st.pending ? 'Not while a launch or flight is under way' : 'Back to the route editor; the connection stays open';

  const ph = $('fl-phase');
  let text = conn === 'disconnected' ? 'Not connected' : conn === 'connecting' ? 'Connecting…'
           : st.phase === 'idle' && st.auto ? PHASE_TEXT.waiting : PHASE_TEXT[st.phase] || st.phase;
  if (conn === 'disconnected' && st.auto) text += ' (auto launch arms on connect)';
  if (st.phase === 'idle' && st.tele && st.tele.flying) text = 'Aircraft in the air (not launched from here)';
  if (['manual', 'landing', 'returning'].includes(st.phase) && st.tele && st.tele.flying === false) text = 'On the ground';
  // Returning home shows however it was asked for: this app, the phone bridge's
  // button, the remote's RTH button, the route's finish action or signal loss.
  const t = st.tele || {};
  const rthNow = t.rth && t.flying !== false;
  if (rthNow) text = st.phase === 'returning' ? PHASE_TEXT.returning : 'RETURNING HOME' + (t.ap_status === 5 ? ' (end of route)' : '');
  if (t.rc_rth_pressed) text += ' · RTH button held on the remote';
  const alarm = st.phase === 'rth' || (rthNow && st.phase !== 'returning');
  ph.className = 'fl-phase ' + (alarm ? 'rth'
    : ({ waiting: 'armed', launching: 'flying', flying: 'flying', manual: 'flying', returning: 'armed', landing: 'armed', failed: 'bad' }[st.phase] || (st.auto ? 'armed' : '')));
  ph.textContent = '';
  const bold = document.createElement('b'); bold.textContent = text; ph.appendChild(bold);
  const lastLine = $('fl-log').textContent.trimEnd().split('\n').pop();
  if (lastLine) { const l = document.createElement('span'); l.className = 'last'; l.textContent = lastLine.slice(10); ph.appendChild(l); }
}

// ---------------------------------------------------------- flight controls
// Keyboard control: WASD = forward/back/left/right, up/down arrows = climb/
// descend, PgUp/PgDn = gimbal. The aircraft ignores virtual sticks over the
// remote's link (flight-tested), so the server turns held keys into short
// fly-to moves (openfimi ManualFlight) relative to the desired heading.
// Left/right arrows turn the desired heading; the turn is flown as a one-point
// route with a POI along it (Free heading), as yaw commands don't exist here.
// While a key is held the values are re-sent every 150 ms; 0.6 s without an
// update, or releasing every key, cancels the move and the aircraft hovers.
const STICK_KEYS = {
  w: ['pitch', 1], s: ['pitch', -1], d: ['roll', 1], a: ['roll', -1],
  ArrowUp: ['throttle', 1], ArrowDown: ['throttle', -1], ArrowRight: ['yaw', 1], ArrowLeft: ['yaw', -1],
};
const GIMBAL_STEP = 5;
const held = new Set();
let stickTimer = null, sentZero = true;

// The next-route list: every other route. The chain after it follows each
// route's stored link, shown underneath.
function fillNextSelect() {
  const sel = $('fl-next');
  sel.textContent = '';
  sel.appendChild(new Option('None: finish here', 0));
  for (const r of state.routes) {
    if (state.route && r._id === state.route._id) continue;
    sel.appendChild(new Option((r.NAME || '(unnamed)') + ' #' + r._id, r._id));
  }
}

function chainText(first) {
  const names = [], seen = new Set(state.route ? [state.route._id] : []);
  for (let id = first; id && names.length < 30; ) {
    const r = state.routes.find((x) => x._id === id);
    if (!r) { names.push('#' + id + ' (missing)'); break; }
    if (seen.has(id)) { names.push('#' + id + ' (loop: stops here)'); break; }
    seen.add(id);
    names.push(r.NAME || '#' + id);
    id = r.AUTO_RECORD;
  }
  return names.length > 1 ? 'Chain: ' + names.join(' → ') : '';
}

function renderControls(st) {
  if (!state.flightManual) {
    const sel = $('fl-next');
    if (document.activeElement !== sel) {
      const v = String(st.next_id || 0);
      if (![...sel.options].some((o) => o.value === v)) sel.appendChild(new Option('Route #' + v, v));
      sel.value = v;
    }
    if (document.activeElement !== $('fl-floor')) $('fl-floor').value = st.min_finish;
    $('fl-chain').textContent = chainText(st.next_id);
  }
  const conn = st.conn === 'connected';
  const rthNow = st.phase === 'rth' || (st.tele && st.tele.rth && st.tele.flying && st.phase !== 'returning');
  const b = $('fl-rth');
  b.disabled = !conn;
  b.classList.toggle('on', !!rthNow);
  b.textContent = rthNow ? 'RETURNING HOME…' : 'EMERGENCY RETURN HOME';
  for (const id of ['fl-photo', 'fl-rec', 'fl-gup', 'fl-gdown', 'fl-glevel', 'fl-gnadir', 'fl-srec']) $(id).disabled = !conn;
  const sr = st.streamrec, srb = $('fl-srec');
  srb.classList.toggle('on', !!sr);
  srb.textContent = !sr ? '● Record stream'
    : sr.started ? '■ Stop  ' + new Date((Date.now() / 1000 - sr.started) * 1000).toISOString().slice(11, 19)
    : '■ Stop (waiting for a keyframe)';
  $('fl-rec').textContent = st.recording ? 'Stop recording' : 'Record';
  $('fl-rec').classList.toggle('recording', st.recording);
  $('fl-manual').disabled = !conn;
  $('fl-manual').checked = st.manual;
  if (document.activeElement !== $('fl-step') && st.manual_step) $('fl-step').value = st.manual_step;
  $('fl-pad').classList.toggle('live', st.manual);
  if (!st.manual && held.size) releaseAll();
}

function stickValues() {
  const v = { roll: 0, pitch: 0, throttle: 0, yaw: 0 };   // full input: the step sets how far
  for (const k of held) if (STICK_KEYS[k]) v[STICK_KEYS[k][0]] += STICK_KEYS[k][1];
  return v;
}

function sendSticks() {
  if (!fl.st || !fl.st.manual) return;
  const v = stickValues(), zero = !v.roll && !v.pitch && !v.throttle && !v.yaw;
  if (zero && sentZero) return;
  sentZero = zero;
  flightPost('sticks', v).catch(() => {});
}

function keyDown(k) {
  if (held.has(k)) return;
  held.add(k);
  const cap = document.querySelector('kbd[data-key="' + k + '"]');
  if (cap) cap.classList.add('down');
  if (k === 'PageUp' || k === 'PageDown') gimbalStep(k === 'PageUp' ? GIMBAL_STEP : -GIMBAL_STEP);
  if (STICK_KEYS[k]) {
    sendSticks();
    if (!stickTimer) stickTimer = setInterval(sendSticks, 150);
  }
}
function keyUp(k) {
  held.delete(k);
  const cap = document.querySelector('kbd[data-key="' + k + '"]');
  if (cap) cap.classList.remove('down');
  if (STICK_KEYS[k]) sendSticks();
  if (![...held].some((h) => STICK_KEYS[h])) { clearInterval(stickTimer); stickTimer = null; }
}
function releaseAll() { for (const k of [...held]) keyUp(k); }

let gimbalRepeat = null;
function gimbalStep(delta) { flightPost('gimbal', { delta }).catch((e) => flightLogError(e)); }

function flightKey(e, down) {
  if (!state.flight || !fl.st || fl.st.conn !== 'connected') return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const gimbal = k === 'PageUp' || k === 'PageDown';
  if (!gimbal && !(STICK_KEYS[k] && fl.st.manual)) return;
  e.preventDefault();
  if (down && e.repeat && gimbal) { gimbalStep(k === 'PageUp' ? GIMBAL_STEP : -GIMBAL_STEP); return; }
  if (down) keyDown(k); else keyUp(k);
}

function flightLogError(e) { if (!e.logged) $('fl-log').textContent += '!! ' + e.message + '\n'; }

function teleCell(box, key, val, cls, title) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (title) d.title = title;
  const k = document.createElement('span'); k.className = 'k'; k.textContent = key;
  const v = document.createElement('span'); v.className = 'v'; v.textContent = val;
  d.append(k, v);
  box.appendChild(d);
}

function renderTelemetry(st) {
  const t = st.tele || {}, box = $('fl-tele');
  const has = (k) => t[k] !== undefined && t[k] !== null;
  const f = (k, digits, unit) => has(k) ? Number(t[k]).toFixed(digits) + (unit || '') : '—';
  const spd = (ms) => (ms * (state.unit === 'kmh' ? 3.6 : 1)).toFixed(1) + ' ' + unitLabel();
  box.textContent = '';
  box.classList.toggle('stale', !st.tele || !has('age') || t.age > 2);
  $('fl-age').textContent = !st.tele ? '' : has('age') ? (t.age > 2 ? 'telemetry ' + t.age.toFixed(0) + ' s old' : 'live') : 'no position yet';
  const phase = { 0: 'Ground (0)', 1: 'On ground', 2: 'Taking off', 3: 'Flying', 4: 'Landing', 5: 'Ground (5)' }[t.phase];
  teleCell(box, 'Position', has('lat') ? t.lat.toFixed(6) + ', ' + t.lon.toFixed(6) : '—', 'wide');
  teleCell(box, 'State', phase || '—', t.flying ? 'warn' : '');
  teleCell(box, 'Altitude', f('height_m', 1, ' m'), '', 'Height above the take-off point');
  teleCell(box, 'Speed', has('speed_ms') ? spd(t.speed_ms) : '—', '', 'Ground speed');
  teleCell(box, 'Climb', f('vspeed_ms', 1, ' m/s'), '', 'Vertical speed, positive = up');
  teleCell(box, 'Heading', f('yaw', 0, '°'));
  teleCell(box, 'Home', f('home_m', 0, ' m'), '', 'Distance from the home point');
  teleCell(box, 'Satellites', f('sats', 0), has('sats') && t.sats < st.min_sats ? 'warn' : '');
  // Battery, temperature and the remote get a filled alarm tile: orange, then flashing red.
  teleCell(box, 'Battery', has('battery_pct') ? t.battery_pct + '% ' + t.volts.toFixed(2) + ' V' : '—',
           !has('battery_pct') ? '' : t.battery_pct < 40 ? 'alarm-red' : t.battery_pct < 50 ? 'alarm-orange' : '',
           'Orange below 50%, red below 40%');
  teleCell(box, 'Batt temp', f('battery_temp', 0, ' °C'), !has('battery_temp') ? '' : t.battery_temp >= 50 ? 'alarm-red' : t.battery_temp >= 45 ? 'alarm-orange' : '',
           'Orange from 45 °C, red from 50 °C. Take-off was refused at 46 °C with the overheat alarm on; a chained route is skipped from 50 °C');
  teleCell(box, 'Sensors', !has('overheat') ? '—' : t.overheat ? 'TOO HOT' : 'OK', t.overheat ? 'bad' : '',
           'The aircraft\'s "sensor temperature too high" alarm, which refuses take-off (code 236). Cooled by flying; overheats left on the ground.');
  teleCell(box, 'RC signal', f('rc_signal', 0, '%'),
           !has('rc_signal') ? '' : t.rc_signal < 30 ? 'alarm-red' : t.rc_signal < 50 ? 'alarm-orange' : '',
           'Orange below 50%, red below 30%');
  teleCell(box, 'RC battery', f('rc_battery_pct', 0, '%'),
           !has('rc_battery_pct') ? '' : t.rc_battery_pct < 20 ? 'alarm-red' : t.rc_battery_pct < 30 ? 'alarm-orange' : '',
           'Orange below 30%, red below 20%');
  teleCell(box, 'Gimbal', f('gimbal_pitch', 1, '°'), '', 'Gimbal pitch, -90 = straight down');
  teleCell(box, 'Zoom', 'n/a', '', 'openfimi does not decode the camera zoom yet');
  teleCell(box, 'Attitude', has('roll') ? 'R ' + t.roll.toFixed(0) + '° P ' + t.pitch.toFixed(0) + '°' : '—');
  teleCell(box, 'Take-off', !has('takeoff_block') ? '—' : t.takeoff_block ? 'blocked ' + t.takeoff_block : 'allowed',
           t.takeoff_block ? 'warn' : '', 'The aircraft\'s own take-off clearance (0 = allowed; 236 = too hot, 240 = IMU check in progress)');

  // route progress: the aircraft counts waypoints REACHED, 65535 just as it starts
  let reached = fl.reached;
  if (state.flightManual) reached = -1;
  else if (t.route) reached = has('reached') ? t.reached : 0;
  else if (st.phase === 'done' && fl.reached >= 0) reached = state.route.points.length;
  else if (st.phase !== 'flying') reached = -1;
  if (reached !== fl.reached) { fl.reached = reached; renderFlightRoute(); drawMap(); }

  // aircraft and home on the map
  if (has('lat') && (t.lat || t.lon)) {
    const ll = [t.lat, t.lon];
    if (!fl.craft) {
      fl.craft = L.marker(ll, { zIndexOffset: 2000, interactive: false,
        icon: L.divIcon({ className: '', html: '<div class="craft-marker">' + CRAFT_SVG + '</div>', iconSize: [28, 28], iconAnchor: [14, 14] }) }).addTo(map);
    } else fl.craft.setLatLng(ll);
    const el = fl.craft.getElement();
    if (el) el.querySelector('svg').style.transform = 'rotate(' + (t.yaw || 0) + 'deg)';
    const tr = fl.trail.getLatLngs(), last = tr[tr.length - 1];
    if (!last || Math.abs(last.lat - t.lat) > 2e-6 || Math.abs(last.lng - t.lon) > 2e-6) fl.trail.addLatLng(ll);
    if (state.flightManual && !fl.centred) { map.setView(ll, Math.max(map.getZoom(), 18)); fl.centred = true; }
    else if ($('fl-follow').checked && !map.getBounds().pad(-0.1).contains(ll)) map.panTo(ll);
  }
  if (has('home_lat')) {
    if (!fl.home) {
      fl.home = L.marker([t.home_lat, t.home_lon], { interactive: false,
        icon: L.divIcon({ className: '', html: '<div class="home-marker">H</div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
    } else fl.home.setLatLng([t.home_lat, t.home_lon]);
  }
}

// Under openfimi each waypoint flies at its own speed (the leg arriving at it);
// the route speed is only a fallback for a waypoint whose speed is 0.
function flightEstimate(pts, routeSpeed) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const v = Math.max((pts[i].SPEED || routeSpeed * 10) / 10, 0.1);
    s += haversine(pts[i - 1], pts[i]) / v + LEG_OVERHEAD;
  }
  return s;
}

function renderFlightRoute() {
  const r = state.route, pts = r.points, box = $('fl-stats');
  box.textContent = '';
  const speeds = pts.map((p) => p.SPEED / 10);
  const lo = Math.min(...speeds), hi = Math.max(...speeds);
  const sp = (ms) => (ms * (state.unit === 'kmh' ? 3.6 : 1)).toFixed(1);
  const photos = pts.filter((p) => PHOTOS_PER_ACTION[p.POINT_ACTION_CMD]).length;
  const gimbal = pts.filter((p) => p.GIMBAL_MODE).length;
  teleCell(box, 'Waypoints', String(pts.length));
  teleCell(box, 'Distance', Math.round(pathLength(pts)) + ' m');
  teleCell(box, 'Est. time', pts.length > 1 ? Math.round(flightEstimate(pts, r.SPEED) / 60) + ' min' : '—', '', 'Waypoint speeds plus 15 s per leg; action dwell not included');
  teleCell(box, 'Speeds', pts.length ? (lo === hi ? sp(lo) : sp(lo) + '–' + sp(hi)) + ' ' + unitLabel() : '—', '', 'Per-waypoint speeds, which openfimi flies');
  teleCell(box, 'Photo points', String(photos));
  teleCell(box, 'Gimbal points', String(gimbal), '', 'Waypoints with a gimbal mode, applied by openfimi during the route');
  teleCell(box, 'At end', ENUMS.EXCUTE_END.find((e) => e[0] === r.EXCUTE_END)?.[1] || String(r.EXCUTE_END));
  teleCell(box, 'Signal loss', ENUMS.DISCONNECT_TYPE.find((e) => e[0] === r.DISCONNECT_TYPE)?.[1] || String(r.DISCONNECT_TYPE));
  teleCell(box, 'Heading', ENUMS.TYPE.find((e) => e[0] === r.TYPE)?.[1] || String(r.TYPE));

  const ol = $('fl-wps');
  ol.textContent = '';
  pts.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = flightWpClass(i).trim();
    const n = document.createElement('span'); n.className = 'n'; n.textContent = i + 1;
    const d = document.createElement('span'); d.className = 'd';
    const act = ENUMS.POINT_ACTION_CMD.find((e) => e[0] === p.POINT_ACTION_CMD);
    d.textContent = p.ALTITUDE + ' m  ' + speedText(p.SPEED, 0.1) +
                    (p.POINT_ACTION_CMD ? '  ' + (act ? act[1] : 'action ' + p.POINT_ACTION_CMD) : '') +
                    (p.GIMBAL_MODE ? '  gimbal ' + p.GIMBAL_PITCH / 100 + '°' : '');
    li.append(n, d);
    ol.appendChild(li);
  });
  const cur = ol.querySelector('li.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function renderVideo(st) {
  const img = $('fpv'), msg = $('fpvmsg');
  if (st.video && !img.getAttribute('src')) img.src = '/api/flight/video.mjpg?t=' + Date.now();
  if (st.conn !== 'connected' && img.getAttribute('src')) img.removeAttribute('src');
  msg.hidden = !!(st.video && img.getAttribute('src'));
  msg.textContent = st.conn === 'connected' ? 'Waiting for video…' : 'No video: not connected';
}

$('fpv').addEventListener('error', () => { $('fpv').removeAttribute('src'); });   // retried on the next poll

async function flightAction(fn) {
  try { await fn(); }
  catch (e) { flightLogError(e); }
  await flightPoll();
}

// ------------------------------------------------------------------ go to
// Manual flight's explicit moves: a target picked on the map (or none, for a
// height change in place), altitude, speed, which way to face and an optional
// gimbal pitch. The server flies it as a fly-to, or as a one-point route with a
// POI when a facing is asked for (fly-to itself turns toward travel).
const gt = { target: null, face: null, pick: null, layer: L.layerGroup().addTo(map), init: false };

function gotoInit(st) {
  if (gt.init || !st.tele) return;
  gt.init = true;
  if (st.tele.height_m != null) $('gt-alt').value = Math.max(10, Math.round(st.tele.height_m));
}
function gotoSpeedField() {
  $('gt-speedcap').textContent = 'Speed (' + unitLabel() + ')';
  if (!$('gt-speed').value) $('gt-speed').value = fromStoredSpeed(5, 1);
}
function bearingTo(a, b) {
  const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function gotoSetPick(mode) {
  gt.pick = gt.pick === mode ? null : mode;
  $('gt-pick').classList.toggle('on', gt.pick === 'target');
  $('gt-facepick').classList.toggle('on', gt.pick === 'face');
  map.getContainer().style.cursor = gt.pick ? 'crosshair' : '';
}
function gotoMapClick(e) {
  if (!state.flightManual || !gt.pick) return;
  if (gt.pick === 'target') gt.target = e.latlng; else gt.face = e.latlng;
  gotoSetPick(null);
  gotoDraw();
}
function gotoDraw(st) {
  gt.layer.clearLayers();
  const t = st || fl.st || {}, tele = t.tele || {};
  const craft = tele.lat ? L.latLng(tele.lat, tele.lon) : null;
  const sent = t.goto && !t.goto.here ? L.latLng(t.goto.lat, t.goto.lon) : null;
  if (sent && craft && tele.task_mode && [1, 2].includes(tele.task_mode)) {
    L.polyline([craft, sent], { color: '#2ee6a8', weight: 2, dashArray: '6 4' }).addTo(gt.layer);
    L.marker(sent, { interactive: false, icon: L.divIcon({ className: '', html: '<div class="goto-marker sent"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(gt.layer);
  }
  if (gt.target) {
    const m = L.marker(gt.target, { draggable: true, icon: L.divIcon({ className: '', html: '<div class="goto-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(gt.layer);
    m.bindTooltip('Go to here', { direction: 'top', offset: [0, -12] });
    m.on('dragend', () => { gt.target = m.getLatLng(); gotoDraw(); });
    if (craft) L.polyline([craft, gt.target], { color: '#ffcc55', weight: 2, dashArray: '4 6', opacity: .8 }).addTo(gt.layer);
  }
  if (gt.face && $('gt-facing').value === 'point') {
    L.marker(gt.face, { interactive: false, icon: L.divIcon({ className: '', html: '<div class="poi-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(gt.layer);
    if (gt.target) L.polyline([gt.target, gt.face], { color: '#ffcc55', weight: 1, dashArray: '2 4' }).addTo(gt.layer);
  }
  let text = 'No target: altitude changes happen here';
  if (gt.target) {
    text = gt.target.lat.toFixed(6) + ', ' + gt.target.lng.toFixed(6);
    if (craft) {
      const a = { LATITUDE: craft.lat, LONGITUDE: craft.lng }, b = { LATITUDE: gt.target.lat, LONGITUDE: gt.target.lng };
      text += '  ·  ' + Math.round(haversine(a, b)) + ' m at ' + Math.round(bearingTo(craft, gt.target)) + '°';
    }
  }
  $('gt-target').textContent = text;
}
function gotoHeading() {
  const f = $('gt-facing').value;
  if (f === 'bearing') {
    const v = $('gt-bearing').value;
    if (v === '') throw new Error('enter a bearing to face');
    return ((Number(v) % 360) + 360) % 360;
  }
  if (f === 'point') {
    if (!gt.face) throw new Error('pick the point to face');
    const from = gt.target || (fl.st && fl.st.tele && L.latLng(fl.st.tele.lat, fl.st.tele.lon));
    return bearingTo(from, gt.face);
  }
  return f;                         // 'travel' or 'current'
}
function gotoBody(withTarget) {
  const alt = Number($('gt-alt').value);
  if (!alt) throw new Error('enter an altitude');
  const g = $('gt-gimbal').value;
  const body = {
    alt, speed: Number($('gt-speed').value) / (state.unit === 'kmh' ? 3.6 : 1),
    heading: gotoHeading(), gimbal: g === '' ? null : Math.max(-90, Math.min(0, Number(g))),
  };
  if (withTarget) {
    if (!gt.target) throw new Error('pick a target on the map first');
    body.lat = gt.target.lat; body.lon = gt.target.lng;
  }
  return body;
}
$('gt-pick').addEventListener('click', () => gotoSetPick('target'));
$('gt-facepick').addEventListener('click', () => gotoSetPick('face'));
$('gt-clear').addEventListener('click', () => { gt.target = null; gotoSetPick(null); gotoDraw(); });
$('gt-facing').addEventListener('change', () => {
  const f = $('gt-facing').value;
  $('gt-bearing').hidden = f !== 'bearing';
  $('gt-facepick').hidden = f !== 'point';
  if (f === 'point' && !gt.face) gotoSetPick('face');
  gotoDraw();
});
$('gt-go').addEventListener('click', () => flightAction(() => flightPost('goto', gotoBody(true))));
$('gt-alt-only').addEventListener('click', () => flightAction(() => {
  const b = gotoBody(false);
  if (b.heading === 'travel') b.heading = 'current';   // no travel: keep pointing where it is
  return flightPost('goto', b);
}));
$('gt-hover').addEventListener('click', () => flightAction(() => { releaseAll(); return flightPost('hover'); }));
$('speedunit').addEventListener('change', () => { $('gt-speed').value = ''; gotoSpeedField(); });
gotoSpeedField();

$('fly').addEventListener('click', () => enterFlight(false));
$('manualfly').addEventListener('click', () => enterFlight(true));
$('fl-takeoff').addEventListener('click', () => flightAction(async () => {
  if (!confirm('Take off now and hover?')) return;
  await flightPost('config', { min_sats: Number($('fl-sats').value) || 10 });
  return flightPost('takeoff');
}));
$('fl-land').addEventListener('click', () => flightAction(() => { releaseAll(); return flightPost('land'); }));
$('fl-home').addEventListener('click', () => flightAction(() => { releaseAll(); return flightPost('home'); }));
document.addEventListener('keydown', (e) => flightKey(e, true));
document.addEventListener('keyup', (e) => flightKey(e, false));
window.addEventListener('blur', releaseAll);
for (const cap of document.querySelectorAll('#fl-pad kbd')) {      // the key caps work with mouse or touch too
  const k = cap.dataset.key;
  const ok = () => fl.st && fl.st.conn === 'connected' && (k.startsWith('Page') || fl.st.manual);
  cap.addEventListener('pointerdown', (e) => {
    if (!ok()) return;
    cap.setPointerCapture(e.pointerId);
    keyDown(k);
    if (k.startsWith('Page')) gimbalRepeat = setInterval(() => gimbalStep(k === 'PageUp' ? GIMBAL_STEP : -GIMBAL_STEP), 300);
  });
  const up = () => { clearInterval(gimbalRepeat); gimbalRepeat = null; if (held.has(k)) keyUp(k); };
  cap.addEventListener('pointerup', up);
  cap.addEventListener('pointercancel', up);
}
$('fl-rth').addEventListener('click', () => flightAction(() => { releaseAll(); return flightPost('rth'); }));
$('fl-srec').addEventListener('click', () => flightAction(() => flightPost('streamrec', { on: !(fl.st && fl.st.streamrec) })));
$('fl-photo').addEventListener('click', () => flightAction(() => flightPost('photo')));
$('fl-rec').addEventListener('click', () => flightAction(() => flightPost('record', { on: !(fl.st && fl.st.recording) })));
$('fl-gup').addEventListener('click', () => gimbalStep(GIMBAL_STEP));
$('fl-gdown').addEventListener('click', () => gimbalStep(-GIMBAL_STEP));
$('fl-glevel').addEventListener('click', () => flightAction(() => flightPost('gimbal', { pitch: 0 })));
$('fl-gnadir').addEventListener('click', () => flightAction(() => flightPost('gimbal', { pitch: -90 })));
$('fl-manual').addEventListener('change', (e) => flightAction(async () => {
  const on = e.target.checked;
  if (on && !confirm('Keyboard control flies nudges: WASD moves relative to the desired heading, ' +
                     'up/down arrows climb and descend, left/right arrows turn. Each nudge starts about 1 s after the key ' +
                     'and stops gently on release. Keep the remote in hand.\n\nTurn keyboard control on?')) {
    e.target.checked = false;
    return;
  }
  releaseAll();
  e.target.blur();                 // so the arrow keys fly instead of toggling the switch
  return flightPost('manual', { on, step: Number($('fl-step').value) || 25 });
}));
$('fl-step').addEventListener('change', (e) => flightAction(() => {
  const step = Number(e.target.value) || 25;
  return fl.st && fl.st.manual ? flightPost('manual', { on: true, step }) : null;   // takes effect when switched on otherwise
}));

// Every flight panel section folds from its header; the choice is remembered.
for (const sec of document.querySelectorAll('.fl-sec')) {
  const key = 'fimi.fold.' + sec.dataset.sec;
  try { if (localStorage.getItem(key) === '1') sec.classList.add('folded'); } catch (e) { /* not remembered */ }
  sec.querySelector('.panel-head').addEventListener('click', (e) => {
    if (e.target.closest('input, label, button')) return;
    const folded = sec.classList.toggle('folded');
    try { localStorage.setItem(key, folded ? '1' : '0'); } catch (err) { /* not remembered */ }
  });
}
$('flyexit').addEventListener('click', exitFlight);
$('fl-connect').addEventListener('click', () => flightAction(async () => {
  if (fl.st && fl.st.conn === 'connected') return flightPost('disconnect');
  const url = $('fl-url').value.trim();
  try { localStorage.setItem('fimi.flightUrl', url); } catch (e) { /* not remembered */ }
  await flightPost('config', { min_sats: Number($('fl-sats').value) || 10 });
  return flightPost('connect', { url });
}));
$('fl-auto').addEventListener('change', (e) => flightAction(async () => {
  const on = e.target.checked;
  if (on && !confirm('Auto launch takes off BY ITSELF, without asking again, as soon as the aircraft is connected, ' +
                     'has GPS and a home point, and has been set down level and still for 5 s. Keep clear of it once it is set down.\n\nArm auto launch?')) {
    e.target.checked = false;
    return;
  }
  return flightPost('config', { auto: on, min_sats: Number($('fl-sats').value) || 10 });
}));
$('fl-next').addEventListener('change', (e) => flightAction(() => flightPost('config', { next_id: Number(e.target.value) || null })));
$('fl-floor').addEventListener('change', (e) => flightAction(() => flightPost('config', { min_finish: Number(e.target.value) })));
$('fl-sats').addEventListener('change', (e) => flightAction(() => flightPost('config', { min_sats: Number(e.target.value) || 10 })));
$('fl-launch').addEventListener('click', () => flightAction(async () => {
  if (!confirm('Take off now and fly "' + state.route.NAME + '" (' + state.route.points.length + ' waypoints)?')) return;
  return flightPost('launch');
}));

updateNativeZoom();
api('GET', '/api/db').then((d) => { $('dbname').textContent = d.path; });
loadRoutes().then(() => {
  if (state.routes.length) openRoute(state.routes[0]._id);
});
