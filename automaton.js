// DOM-freier Kern des Live-Players - bewusst als eigene Datei, damit zwei
// Konsumenten dieselbe Logik ausfuehren statt zwei Kopien auseinanderlaufen
// zu lassen:
//   - web/player.html laedt ihn per <script src="automaton.js">,
//   - tests/js_trace.mjs laedt ihn unter Node und vergleicht den Zustand
//     gegen den Python-Runner (tests/render_parity.py, Regel 1 des CLAUDE.md).
//
// Die Hex-Geometrie entspricht src/renderer/renderer.py (X_SIZE/Y_SIZE/
// MARGTIN/dx/dy/xshift), die Automaten-Logik src/animation/gameOfRz/
// gameOfRz.py. Arithmetik, die es auf der Python-Seite ebenfalls gibt
// (Spiegel-Funktionen), ist jeweils vermerkt - bei Aenderungen immer an
// beiden Stellen anfassen.

const X_SIZE = 81, Y_SIZE = 65, MARGTIN = 3;
const dx = X_SIZE + 45 + 2 * MARGTIN / Math.cos(Math.PI / 12);
const dy = Y_SIZE / 2 + MARGTIN;
const xshift = dx / 2;

const NEIGHBORS_EVEN = [[0, 2], [-1, 1], [-1, -1], [0, -2], [0, -1], [0, 1]];
const NEIGHBORS_ODD = [[0, 2], [0, 1], [0, -1], [0, -2], [1, -1], [1, 1]];

// Zwei Zeiten schliessen nur an, wenn sie praktisch gleich sind - Rundungen
// in Profil-JSONs und vom Editor verschobene Spans duerfen nicht uebernommen
// werden. Spiegel von musicAnimationRunner.CARRY_EPSILON.
const CARRY_EPSILON = 1e-3;

function mod(a, n) {
  return ((a % n) + n) % n;
}

function arraysEqual(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- Grid-Wechsel (Spiegel von src/animation/gridSwitch.py) ---
// "Epoche" = Anzahl der Wechsel mit t <= Zeitpunkt; Zellen einer Epoche
// liegen in den Gitterkoordinaten dieser Epoche. Bei mehreren Zellen auf
// derselben Zielzelle gewinnt die erste in Iterationsreihenfolge.
const SWITCH_EPS = 1e-9;

function epochAt(switches, t) {
  let n = 0;
  for (const s of switches || []) if (s.t <= t + SWITCH_EPS) n++;
  return n;
}

function gridAtEpoch(baseX, baseY, switches, epoch) {
  let gx = baseX, gy = baseY;
  for (const s of (switches || []).slice(0, epoch)) {
    if (s.mode === "refine") { gx *= 2; gy *= 2; } else { gx = Math.floor(gx / 2); gy = Math.floor(gy / 2); }
  }
  return [gx, gy];
}

// cells: [[x, y, orientation, color], ...] -> gleiche Form im gewechselten Gitter.
function remapCells(cells, mode, gx, gy) {
  const out = [], seen = new Set();
  const add = (x, y, c) => {
    const key = x + "," + y;
    if (!seen.has(key)) { seen.add(key); out.push([x, y, c[2], c[3]]); }
  };
  if (mode === "refine") {
    for (const c of cells) {
      const base = 2 * c[0] + (c[1] % 2);
      for (const cx of [base, base + 1]) {
        for (const cy of [2 * c[1], 2 * c[1] + 1]) {
          add(mod(cx, 2 * gx), mod(cy, 2 * gy), c);
        }
      }
    }
  } else {
    const ngx = Math.floor(gx / 2), ngy = Math.floor(gy / 2);
    for (const c of cells) {
      const Y = Math.floor(c[1] / 2);
      const X = Math.floor((c[0] - (Y % 2)) / 2);
      add(mod(X, ngx), mod(Y, ngy), c);
    }
  }
  return out;
}

function cellsToEpoch(cells, fromEpoch, toEpoch, baseX, baseY, switches) {
  let [gx, gy] = gridAtEpoch(baseX, baseY, switches, fromEpoch);
  for (let e = fromEpoch; e < toEpoch; e++) {
    cells = remapCells(cells, switches[e].mode, gx, gy);
    [gx, gy] = gridAtEpoch(baseX, baseY, switches, e + 1);
  }
  return cells;
}

// --- Choreografie (Spiegel von src/animation/choreography.py) ---
// Span mit "choreography": Zellen als reine Funktion des Schritts k, kein
// Automat. Rundung floor(x + 0.5) wie in Python, keine Trigonometrie.
function choreographyEnergy(spec, k) {
  const e = spec.energy;
  if (!e || !e.length) return null;
  return e[Math.min(k, e.length) - 1];
}

function choreographyOffset(spec, k) {
  const vx = spec.vx ?? 0, vy = spec.vy ?? 0;
  let fx = 0, fy = 0;
  if (spec.energy && spec.energy.length) {
    for (let j = 1; j <= k; j++) {
      const speed = 0.5 + choreographyEnergy(spec, j);
      fx += vx * speed;
      fy += vy * speed;
    }
  } else {
    fx = k * vx;
    fy = k * vy;
  }
  const ox = Math.floor(fx + 0.5);
  let oy = 2 * Math.floor(fy / 2 + 0.5);
  if (spec.rule === "hop") {
    const period = spec.hop_period;
    const phase = k % period;
    const e = choreographyEnergy(spec, k);
    const amp = spec.hop_height * (e === null ? 1.0 : 0.3 + 0.7 * e);
    const rise = Math.floor(amp * 4 * phase * (period - phase) / (period * period) + 0.5);
    oy -= 2 * rise;
  }
  return [ox, oy];
}

// Form um `rings` Hex-Ringe erweitern (Spiegel von choreography.grow).
function growShape(cells, rings, gx, gy) {
  const out = cells.map(c => [c[0], c[1], c[2]]);
  const seen = new Set(cells.map(c => c[0] + "," + c[1]));
  let frontier = out.slice();
  for (let r = 0; r < rings; r++) {
    const next = [];
    for (const [x, y, orientation] of frontier) {
      const offsets = y % 2 ? NEIGHBORS_ODD : NEIGHBORS_EVEN;
      for (const [dx, dy] of offsets) {
        const cx = mod(x + dx, gx), cy = mod(y + dy, gy);
        const key = cx + "," + cy;
        if (!seen.has(key)) {
          seen.add(key);
          const item = [cx, cy, orientation];
          out.push(item);
          next.push(item);
        }
      }
    }
    frontier = next;
  }
  return out;
}

// -> [[x, y, orientation, color], ...] im Basisgitter gx x gy
function choreographyCells(spec, k, color, gx, gy) {
  const [ox, oy] = choreographyOffset(spec, k);
  let shape = spec.cells;
  if (spec.rule === "pulse") {
    const e = choreographyEnergy(spec, k);
    const rings = Math.floor((spec.grow_max ?? 2) * (e === null ? 0.5 : e) + 0.5);
    shape = growShape(shape, rings, gx, gy);
  }
  const window = spec.window || "";
  const out = [], seen = new Set();
  for (const [x, y, orientation] of shape) {
    const rx = x + ox, ry = y + oy;
    if (window === "x" && !(rx >= 0 && rx < gx)) continue;
    if (window === "y" && !(ry >= 0 && ry < gy)) continue;
    const px = mod(rx, gx), py = mod(ry, gy);
    const key = px + "," + py;
    if (!seen.has(key)) { seen.add(key); out.push([px, py, orientation, color.slice()]); }
  }
  return out;
}

// --- Zellen-Masken (Spiegel von musicAnimationRunner._apply_masks) ---
function growCells(keys, rings, gx, gy) {
  const grown = new Set(keys);
  let frontier = [...keys];
  for (let r = 0; r < rings; r++) {
    const next = [];
    for (const key of frontier) {
      const [x, y] = key.split(",").map(Number);
      const offsets = y % 2 ? NEIGHBORS_ODD : NEIGHBORS_EVEN;
      for (const [dx, dy] of offsets) {
        const cell = mod(x + dx, gx) + "," + mod(y + dy, gy);
        if (!grown.has(cell)) { grown.add(cell); next.push(cell); }
      }
    }
    frontier = next;
  }
  return grown;
}

// groups: [{layer, cells: [[x,y,o,c],...], ...}] -> maskiert/gefiltert
function maskGroups(groups, layers, gx, gy) {
  if (!layers.some(l => l.mask || l.mask_only || l.duck)) return groups;
  const byLayer = new Map(groups.map(g => [g.layer, g.cells]));
  const alphaOf = new Map(groups.map(g => [g.layer, g.alpha]));
  const out = [];
  for (const g of groups) {
    const layer = layers[g.layer] || {};
    let cells = g.cells;
    if (layer.mask && byLayer.has(layer.mask.source)) {
      const allowed = growCells(new Set(byLayer.get(layer.mask.source).map(c => c[0] + "," + c[1])),
                                layer.mask.grow ?? 0, gx, gy);
      cells = cells.filter(c => allowed.has(c[0] + "," + c[1]));
    }
    if (layer.mask_only) continue;
    let alpha = g.alpha;
    // Ducking: solange die Quelle (Logo-Moment) sichtbar ist, treten diese Layer zurueck.
    if (layer.duck) {
      const specs = Array.isArray(layer.duck) ? layer.duck : [layer.duck];
      // Faktor folgt der Sichtbarkeit der Quelle (1 - (1-f) * alpha), wie in Python.
      const factors = specs.filter(d => byLayer.has(d.source))
        .map(d => 1 - (1 - (d.factor ?? 0.25)) * Math.min(1, alphaOf.get(d.source)));
      if (factors.length) alpha = alpha * Math.min(...factors);
    }
    if (cells.length) out.push(Object.assign({}, g, { cells, alpha }));
  }
  return out;
}

// Gleiche Schnittstelle wie HexAutomaton (epoch/remap/step/activeCells), damit
// stepProfile Choreografie-Spans ohne Sonderpfad im Schritt-Loop fuehrt. Die
// Zellen entstehen bei jedem Schritt neu aus (Spec, k); ein Grid-Wechsel
// aendert nur die Epoche, in die sie ueberfuehrt werden.
class ChoreoAutomaton {
  constructor(spec, color, baseX, baseY, switches) {
    this.spec = spec;
    this.color = color;
    this.baseX = baseX;
    this.baseY = baseY;
    this.switches = switches;
    this.k = 0;
    this.epoch = 0;
  }
  remap() { this.epoch++; }
  step() { this.k++; }
  activeCells() {
    if (this.k === 0) return [];
    const base = choreographyCells(this.spec, this.k, this.color, this.baseX, this.baseY);
    return cellsToEpoch(base, 0, this.epoch, this.baseX, this.baseY, this.switches)
      .map(([x, y, orientation, color]) => ({ x, y, orientation, color }));
  }
}

class HexAutomaton {
  constructor(startPoints, ruleSet, color, orientation, maxX, maxY) {
    this.MAX_X = maxX;
    this.MAX_Y = maxY;
    this.ruleSet = ruleSet;
    this.orientation = orientation;
    this.epoch = 0;

    this.colorPalet = ruleSet.map((_, i) => [0, 1, 2].map(
      c => Math.floor(color[c] + (255 - color[c]) / ruleSet.length * i)
    ));

    this.points = Array.from({ length: maxX }, () => new Array(maxY).fill(0));
    // Optionale vierte Komponente: eigene Farbe. Uebernommene Zellen aus dem
    // vorherigen Segment behalten damit ihre alte Farbe und sterben nach und
    // nach aus - genau wie auf der Python-Seite, wo die Point-Objekte mit
    // ihrer Farbe weitergereicht werden.
    for (const [x, y, pointOrientation, pointColor] of startPoints) {
      if (x >= 0 && x < maxX && y >= 0 && y < maxY) {
        this.points[x][y] = {
          color: pointColor ?? color,
          orientation: pointOrientation ?? orientation,
        };
      }
    }
  }

  step() {
    const offsetsX = this.MAX_X - 2, offsetsY = this.MAX_Y - 2;
    const neighborsAt = (x, y) => {
      const isOdd = y % 2;
      const offsets = isOdd ? NEIGHBORS_ODD : NEIGHBORS_EVEN;
      const bits = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 6; i++) {
        const cx = mod(x + offsets[i][0], offsetsX);
        const cy = mod(y + offsets[i][1], offsetsY);
        if (this.points[cx][cy] !== 0) bits[i] = 1;
      }
      return bits;
    };

    const newPoints = Array.from({ length: this.MAX_X }, () => new Array(this.MAX_Y).fill(0));
    for (let x = 0; x < this.MAX_X; x++) {
      for (let y = 0; y < this.MAX_Y; y++) {
        const bits = neighborsAt(x, y);
        for (let ruleIndex = 0; ruleIndex < this.ruleSet.length; ruleIndex++) {
          if (arraysEqual(this.ruleSet[ruleIndex], bits)) {
            newPoints[x][y] = { color: this.colorPalet[ruleIndex], orientation: this.orientation };
            break;
          }
        }
      }
    }
    this.points = newPoints;
  }

  // Zustand in das gewechselte Gitter ueberfuehren (siehe remapCells); die
  // Farben der lebenden Zellen bleiben erhalten.
  remap(mode) {
    const cells = this.activeCells().map(c => [c.x, c.y, c.orientation, c.color]);
    const mapped = remapCells(cells, mode, this.MAX_X, this.MAX_Y);
    if (mode === "refine") { this.MAX_X *= 2; this.MAX_Y *= 2; }
    else { this.MAX_X = Math.floor(this.MAX_X / 2); this.MAX_Y = Math.floor(this.MAX_Y / 2); }
    this.points = Array.from({ length: this.MAX_X }, () => new Array(this.MAX_Y).fill(0));
    for (const [x, y, orientation, color] of mapped) this.points[x][y] = { color, orientation };
    this.epoch++;
  }

  activeCells() {
    const cells = [];
    for (let x = 0; x < this.MAX_X; x++) {
      for (let y = 0; y < this.MAX_Y; y++) {
        if (this.points[x][y] !== 0) cells.push({ x, y, ...this.points[x][y] });
      }
    }
    return cells;
  }
}

// Spiegel von MusicVideoRenderer.fade_at (Python-Seite), damit der Player
// dasselbe Nachleuchten zeigt wie der Video-Export.
function fadeAt(t, fade, envelope, fadeRange) {
  if (!envelope || !envelope.length || !fadeRange) return fade;

  let value;
  if (t <= envelope[0][0]) {
    value = envelope[0][1];
  } else if (t >= envelope[envelope.length - 1][0]) {
    value = envelope[envelope.length - 1][1];
  } else {
    value = envelope[envelope.length - 1][1];
    for (let i = 0; i < envelope.length - 1; i++) {
      const [t0, v0] = envelope[i];
      const [t1, v1] = envelope[i + 1];
      if (t0 <= t && t <= t1) {
        const span = (t1 - t0) || 1;
        value = v0 + (v1 - v0) * (t - t0) / span;
        break;
      }
    }
  }
  return Math.max(0, Math.min(1, fade + (value * 2 - 1) * fadeRange));
}

// Binaersuche im aufsteigenden step_times-Array: wie viele Generationen
// sind zum Zeitpunkt t bereits faellig. (Im Player schliesst das das
// 60-Mal-pro-Sekunde-Ueber-das-ganze-Array-Filtern aus.)
function countUpTo(stepTimes, t) {
  let low = 0, high = stepTimes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (stepTimes[mid] <= t) low = mid + 1; else high = mid;
  }
  return low;
}

// Spiegel von musicAnimationRunner.layer_times: eigenes Zeitraster eines
// Layers, abgeleitet vom Beat-Raster. rate < 1: nur jeder Nte Beat,
// rate > 1: mehrere Generationen pro Beat.
function layerTimes(beatTimes, rate) {
  if (!beatTimes || !beatTimes.length) return [];
  if (rate >= 1) {
    const factor = Math.max(1, Math.round(rate));
    if (factor === 1) return beatTimes.slice();
    const times = [];
    for (let i = 0; i < beatTimes.length - 1; i++) {
      for (let k = 0; k < factor; k++) {
        times.push(beatTimes[i] + (beatTimes[i + 1] - beatTimes[i]) * k / factor);
      }
    }
    times.push(beatTimes[beatTimes.length - 1]);
    return times;
  }
  const step = Math.max(1, Math.round(1 / rate));
  const times = [];
  for (let i = 0; i < beatTimes.length; i += step) times.push(beatTimes[i]);
  return times;
}

// Spiegel von src/audio/layerProfiles.span_alpha_at: Sichtbarkeit eines
// Layers zum Zeitpunkt t (0 ausserhalb der Spans, innerhalb lineare Rampe
// ueber fade_in/fade_out, Maximum bei ueberlappenden Spans).
function spanAlpha(spans, t) {
  let alpha = 0.0;
  for (const span of spans) {
    if (t >= span.in && t < span.out) {
      const fadeIn = Math.max(0, span.fade_in ?? 0);
      const fadeOut = Math.max(0, span.fade_out ?? 0);
      const rise = fadeIn > 0 ? (t - span.in) / fadeIn : 1.0;
      const fall = fadeOut > 0 ? (span.out - t) / fadeOut : 1.0;
      alpha = Math.max(alpha, Math.min(1, rise, fall));
    }
  }
  return alpha;
}

// --- Zustandsmaschine (pure, kein DOM) ---

function freshProfileState() {
  return { layered: null, segment: null };
}

// Findet den Index des Spans, der t enthaelt, oder -1.
function findSpanIndex(spans, t) {
  for (let i = 0; i < spans.length; i++) {
    if (t >= spans[i].in && t < spans[i].out) return i;
  }
  return -1;
}

// Spielt ein Profil zum Zeitpunkt t und liefert die sichtbaren Beitraege:
// { groups: [{ cells: [[x, y, orientation, color], ...], alpha }] }.
//
// Profile mit `layers` laufen mehrschichtig: pro Layer ein eigener Automat
// auf dem eigenen Zeitraster (layerTimes), sichtbar nur innerhalb seiner
// Spans, Ein-/Ausblenden ueber spanAlpha. Uebernahme des Vorgaengerzustands
// (carry_over) nur, wenn der vorherige Span lueckenlos anschliesst - dieselbe
// Regel wie in musicAnimationRunner.runToBeats. Profile mit nur `segments`
// verhalten sich exakt wie der bisherige Einzelschicht-Player.
function stepProfile(profile, t, state) {
  const layers = profile.layers;
  if (Array.isArray(layers) && layers.length) {
    if (!state.layerStates || state.layerStates.length !== layers.length) {
      state.layerStates = layers.map(() => ({ spanIndex: -1, automaton: null, appliedSteps: 0, lastCells: null }));
    }
    const groups = [];
    let totalSteps = 0;
    const switches = profile.grid_switches || [];
    const nowEpoch = epochAt(switches, t);
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const st = state.layerStates[li];
      const spans = layer.spans || [];
      const spanIndex = findSpanIndex(spans, t);

      if (spanIndex === -1) {
        st.spanIndex = -1;
        st.automaton = null;
        // lastCells bleibt bestehen: Python haelt den letzten nicht-leeren
        // Frame ueber Span-Grenzen hinweg und zeichnet ihn, sobald wieder
        // ein Span deckt (siehe _run_layers_with_identity, held[index]).
        continue;
      }

      const span = spans[spanIndex];
      if (spanIndex !== st.spanIndex) {
        // Zustandsuebernahme wie in musicAnimationRunner.runToBeats - nur
        // beim lueckenlosen Weiterlaufen, nicht nach Spulen oder Loecken.
        // Uebernommen werden die gehaltenen (letzten nicht-leeren) Zellen,
        // nicht ein leerer Nachzustand.
        const continuous = st.automaton && st.spanIndex === spanIndex - 1
          && Math.abs(spans[st.spanIndex].out - span.in) <= CARRY_EPSILON;
        // Python uebergibt den GEHALTENEN letzten nicht-leeren Frame
        // (carried_points = last_frame), nicht den aktuellen Nachzustand.
        const carriedCells = continuous ? (st.lastCells || []) : [];
        // Epoche des Spans = Epoche seines ersten Schritts (wie Python:
        // segment_beats[0]); Startzellen stehen im Basisgitter.
        const layerGrid = layerTimes(profile.step_times || [], layer.subdivision ?? 1.0);
        const firstStep = layerGrid[countUpTo(layerGrid, span.in - 1e-9)];
        const e0 = epochAt(switches, firstStep === undefined ? t : firstStep);
        let seedPoints = cellsToEpoch((span.start_points || []).map(p => p.slice()), 0, e0,
                                      profile.grid_x, profile.grid_y, switches);
        if (span.carry_over && carriedCells.length) {
          const carried = cellsToEpoch(carriedCells.map(c => [c.x, c.y, c.orientation, c.color]),
                                       st.lastEpoch ?? 0, e0, profile.grid_x, profile.grid_y, switches);
          const occupied = new Set(carried.map(([x, y]) => x + "," + y));
          seedPoints = carried.concat(seedPoints.filter(([x, y]) => !occupied.has(x + "," + y)));
        }
        const [gx0, gy0] = gridAtEpoch(profile.grid_x, profile.grid_y, switches, e0);
        st.automaton = span.choreography
          ? new ChoreoAutomaton(span.choreography, span.color, profile.grid_x, profile.grid_y, switches)
          : new HexAutomaton(seedPoints, span.ruleSet, span.color, span.orientation ?? 0, gx0, gy0);
        st.automaton.epoch = e0;
        st.appliedSteps = 0;
        st.spanIndex = spanIndex;
      }

      const grid = layerTimes(profile.step_times || [], layer.subdivision ?? 1.0);
      const targetSteps = countUpTo(grid, t) - countUpTo(grid, span.in - 1e-9);
      const firstIdx = countUpTo(grid, span.in - 1e-9);
      while (st.appliedSteps < targetSteps) {
        // Wechsel greift beim ersten Schritt ab dem Wechselzeitpunkt.
        const e = epochAt(switches, grid[firstIdx + st.appliedSteps]);
        while (st.automaton.epoch < e) st.automaton.remap(switches[st.automaton.epoch].mode);
        st.automaton.step();
        st.appliedSteps++;
      }

      // Sichtbarkeit folgt der Python-Semantik:
      // - Vor dem ersten Schritt des Layer-Rasters im aktuellen Span stehen
      //   die GEHALTENEN Zellen des Vorgaengers weiter (Python haelt den
      //   Frame ueber die Span-Grenze, bis der neue Automat beim ersten
      //   Beat weiterrechnet). Ganz ohne Vorgaenger (erster Span) ist der
      //   Layer bis dahin unsichtbar.
      // - Stirbt der Automat innerhalb eines Spans, bleibt der letzte
      //   nicht-leere Frame stehen (runToBeats: last_frame).
      let cells = [];
      let cellsEpoch = 0;
      // Choreografie darf leer sein (Text ganz aus dem Fenster): dann wird
      // NICHTS gehalten - anders als beim Automaten, dessen letzter nicht-
      // leerer Frame stehen bleibt (Python: choreo-Pfad in runToBeats).
      const isChoreo = st.automaton instanceof ChoreoAutomaton;
      if (st.appliedSteps > 0) {
        cells = st.automaton.activeCells();
        if (cells.length || isChoreo) {
          st.lastCells = cells;
          st.lastEpoch = st.automaton.epoch;
        }
        cellsEpoch = st.automaton.epoch;
      }
      if (!cells.length && st.lastCells && !isChoreo) {
        cells = st.lastCells;
        cellsEpoch = st.lastEpoch ?? 0;
      }

      const alpha = spanAlpha(spans, t);
      if (cells.length && alpha > 0) {
        // Gehaltene Zellen folgen dem Gitter der Epoche von t (Python: Merge
        // in _run_layers_with_identity).
        const outCells = cellsToEpoch(cells.map(c => [c.x, c.y, c.orientation, c.color]),
                                      cellsEpoch, nowEpoch, profile.grid_x, profile.grid_y, switches);
        groups.push({
          layer: li,
          span: spanIndex,
          alpha,
          appliedSteps: st.appliedSteps,
          cells: outCells,
        });
      }
      totalSteps += st.appliedSteps;
    }
    const [mgx, mgy] = gridAtEpoch(profile.grid_x, profile.grid_y, switches, nowEpoch);
    return { groups: maskGroups(groups, layers, mgx, mgy), totalSteps };
  }

  // Einzelsegment-Modus (Rueckfallebene / Galerie)
  if (!state.segment) {
    state.segment = { index: -1, automaton: null, appliedSteps: 0, lastCells: null };
  }
  const seg = state.segment;
  const segments = profile.segments || [];
  const switches = profile.grid_switches || [];
  const nowEpoch = epochAt(switches, t);

  let segIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if (t < segments[i].end_time || i === segments.length - 1) { segIndex = i; break; }
  }
  if (segIndex === -1) segIndex = 0;
  const segment = segments[segIndex];

  if (segIndex !== seg.index) {
    const continuous = seg.automaton && segIndex === seg.index + 1;
    // Gehaltener letzter nicht-leerer Frame als Uebergabe (wie Python).
    const carriedCells = continuous ? (seg.lastCells || []) : [];
    const stepsAll = profile.step_times || [];
    const firstStep = stepsAll[countUpTo(stepsAll, segment.start_time - 1e-9)];
    const e0 = epochAt(switches, firstStep === undefined ? t : firstStep);
    let seedPoints = cellsToEpoch(segment.start_points.map(p => p.slice()), 0, e0,
                                  profile.grid_x, profile.grid_y, switches);
    if (segment.carry_over && carriedCells.length) {
      const carried = cellsToEpoch(carriedCells.map(c => [c.x, c.y, c.orientation, c.color]),
                                   seg.lastEpoch ?? 0, e0, profile.grid_x, profile.grid_y, switches);
      const occupied = new Set(carried.map(([x, y]) => x + "," + y));
      seedPoints = carried.concat(seedPoints.filter(([x, y]) => !occupied.has(x + "," + y)));
    }
    const [gx0, gy0] = gridAtEpoch(profile.grid_x, profile.grid_y, switches, e0);
    seg.index = segIndex;
    seg.automaton = new HexAutomaton(
      seedPoints, segment.ruleSet, segment.color, segment.orientation ?? 0, gx0, gy0
    );
    seg.automaton.epoch = e0;
    seg.appliedSteps = 0;
    seg.lastCells = null;
  }

  const targetSteps = countUpTo(profile.step_times || [], t)
    - countUpTo(profile.step_times || [], segment.start_time - 1e-9);
  const segFirst = countUpTo(profile.step_times || [], segment.start_time - 1e-9);
  while (seg.appliedSteps < targetSteps) {
    const e = epochAt(switches, (profile.step_times || [])[segFirst + seg.appliedSteps]);
    while (seg.automaton.epoch < e) seg.automaton.remap(switches[seg.automaton.epoch].mode);
    seg.automaton.step();
    seg.appliedSteps++;
  }

  // Stirbt der Automat, haelt der letzte nicht-leere Frame (wie runToBeats).
  let cells = seg.automaton.activeCells();
  let cellsEpoch = seg.automaton.epoch;
  if (cells.length) {
    seg.lastCells = cells;
    seg.lastEpoch = cellsEpoch;
  } else if (seg.lastCells) {
    cells = seg.lastCells;
    cellsEpoch = seg.lastEpoch ?? 0;
  }
  const outCells = cellsToEpoch(cells.map(c => [c.x, c.y, c.orientation, c.color]),
                                cellsEpoch, nowEpoch, profile.grid_x, profile.grid_y, switches);

  return {
    groups: cells.length ? [{
      layer: 0,
      span: segIndex,
      alpha: 1,
      appliedSteps: seg.appliedSteps,
      cells: outCells,
    }] : [],
    totalSteps: seg.appliedSteps,
    segmentIndex: segIndex,
  };
}

// Rueckwaertssprung: der Automatenzustand gehoert zur alten Position und
// muss neu aufgebaut werden (Loop der Galerie, Zurueckspulen im Audio).
function resetProfileState(state) {
  state.layerStates = null;
  state.segment = null;
}

// --- Canvas-Effekte: Kamera und Hintergrund (Spiegel von
// src/renderer/canvasFx.py; tests/canvasfx_parity.py prueft den Gleichlauf) ---

function smoothstep(u) {
  return u * u * (3 - 2 * u);
}

// [zoom, x, y] der Kamera zur Zeit t; ohne Keyframes Identitaet.
function cameraAt(keyframes, t) {
  if (!keyframes || !keyframes.length) return [1, 0.5, 0.5];
  const kv = k => [Number(k.zoom), Number(k.x), Number(k.y)];
  if (t <= keyframes[0].t) return kv(keyframes[0]);
  const last = keyframes[keyframes.length - 1];
  if (t >= last.t) return kv(last);
  for (let i = 0; i + 1 < keyframes.length; i++) {
    const a = keyframes[i], b = keyframes[i + 1];
    if (a.t <= t && t <= b.t) {
      const lin = (t - a.t) / ((b.t - a.t) || 1);
      const u = a.ease === "linear" ? lin : smoothstep(lin);
      const va = kv(a), vb = kv(b);
      return va.map((v, j) => v + (vb[j] - v) * u);
    }
  }
  return kv(last);
}

// [links, oben, rechts, unten] in Pixeln des nativen Canvas.
function cropBox(zoom, x, y, width, height) {
  zoom = Math.max(1, zoom);
  const w = width / zoom, h = height / zoom;
  const left = Math.min(Math.max(x * width - w / 2, 0), width - w);
  const top = Math.min(Math.max(y * height - h / 2, 0), height - h);
  return [left, top, left + w, top + h];
}

// [x0, y0, x1, y1] der Verlaufslinie wie CSS linear-gradient.
function gradientEndpoints(angle, width, height) {
  const a = angle * Math.PI / 180;
  const sx = Math.sin(a), sy = Math.cos(a);
  const length = Math.abs(width * sx) + Math.abs(height * sy);
  const cx = width / 2, cy = height / 2;
  return [cx - sx * length / 2, cy - sy * length / 2,
          cx + sx * length / 2, cy + sy * length / 2];
}

// --- Logo-Overlay (Spiegel von canvasFx.loudness_at / overlay_state) ---
function loudnessAt(envelope, t) {
  if (!envelope || !envelope.length) return 0.5;
  if (t <= envelope[0][0]) return envelope[0][1];
  const last = envelope[envelope.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i + 1 < envelope.length; i++) {
    const [t0, v0] = envelope[i], [t1, v1] = envelope[i + 1];
    if (t0 <= t && t <= t1) return v0 + (v1 - v0) * (t - t0) / ((t1 - t0) || 1);
  }
  return last[1];
}

// [alpha, scale] oder null
function overlayState(o, t, envelope) {
  if (t < o.in || t >= o.out) return null;
  const fIn = o.fade_in ?? 0, fOut = o.fade_out ?? 0;
  const aIn = fIn <= 0 ? 1 : Math.min(1, Math.max(0, (t - o.in) / fIn));
  const aOut = fOut <= 0 ? 1 : Math.min(1, Math.max(0, (o.out - t) / fOut));
  const alpha = aIn * aOut;
  if (alpha <= 0) return null;
  const e = loudnessAt(envelope, t);
  return [alpha, (o.scale ?? 0.8) * (1 + 0.08 * (e * 2 - 1))];
}

