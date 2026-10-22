// Straßengraph, Zufallsrouten und Abbiegehinweise.
// Koordinaten: lokale Meter (x = Ost, y = Nord) relativ zu site.origin.

export const deg = (r) => (r * 180) / Math.PI;
export const bearing = (p, q) => (deg(Math.atan2(q[0] - p[0], q[1] - p[1])) + 360) % 360;
export const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
// Vorzeichenbehaftete Differenz b - a in (-180, 180]; positiv = rechts
export const turnDelta = (a, b) => ((b - a + 540) % 360) - 180;

// Fahrzeit-Modell (Fahrschüler-Tempo auf dem Übungsplatz)
const V_STRAIGHT = 6.1; // m/s ≈ 22 km/h
const V_CURVY = 4.4; // m/s ≈ 16 km/h
const V_ROUNDABOUT = 4.0; // m/s ≈ 14 km/h
const PENALTY = { straight: 2, slight: 2, turn: 5, sharp: 7, uturn: 22, roundabout: 4, none: 0 };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Graph {
  constructor(site) {
    this.site = site;
    this.nodes = site.nodes;
    this.arcs = [];
    this.out = new Map();
    this.degree = new Map(); // ungerichteter Grad je Knoten
    site.edges.forEach((e, ei) => {
      const pts = e.p.map((i) => this.nodes[i]);
      const len = polyLen(pts);
      const fwd = this.addArc(ei, e, e.p, pts, len);
      if (!e.o) {
        const back = this.addArc(ei, e, [...e.p].reverse(), [...pts].reverse(), len);
        fwd.twin = back.id;
        back.twin = fwd.id;
      }
      for (const n of [e.p[0], e.p[e.p.length - 1]]) this.degree.set(n, (this.degree.get(n) || 0) + 1);
    });
    for (const a of this.arcs) {
      a.deadEnd = this.degree.get(a.to) === 1;
      a.time = a.len / (a.rb ? V_ROUNDABOUT : a.curvy ? V_CURVY : V_STRAIGHT);
    }
    this.markSpurs(site);
  }

  // Sackgassen-Äste finden: Endknoten wiederholt abschneiden. Bögen, die vom
  // Netz in einen solchen Ast hineinführen (intoSpur), zwingen zum Wenden und
  // werden von Zufallsrouten gemieden.
  markSpurs(site) {
    const deg = new Map(this.degree);
    const edgesAt = new Map();
    site.edges.forEach((e, ei) => {
      for (const n of [e.p[0], e.p[e.p.length - 1]]) {
        if (!edgesAt.has(n)) edgesAt.set(n, []);
        edgesAt.get(n).push(ei);
      }
    });
    const inward = new Map(); // abgeschnittene Kante -> Knoten am Sackgassen-Ende
    const queue = [...deg.keys()].filter((n) => deg.get(n) === 1);
    while (queue.length) {
      const v = queue.pop();
      if (deg.get(v) !== 1) continue;
      const ei = edgesAt.get(v).find((x) => !inward.has(x));
      if (ei == null) continue;
      inward.set(ei, v);
      deg.set(v, 0);
      const e = site.edges[ei];
      const u = e.p[0] === v ? e.p[e.p.length - 1] : e.p[0];
      deg.set(u, deg.get(u) - 1);
      if (deg.get(u) === 1) queue.push(u);
    }
    for (const a of this.arcs) a.intoSpur = inward.get(a.edge) === a.to;
  }

  addArc(edgeIdx, e, ids, pts, len) {
    const n = pts.length;
    let turning = 0;
    for (let i = 1; i < n - 1; i++) turning += Math.abs(turnDelta(bearing(pts[i - 1], pts[i]), bearing(pts[i], pts[i + 1])));
    const arc = {
      id: this.arcs.length,
      edge: edgeIdx,
      from: ids[0],
      to: ids[n - 1],
      ids,
      pts,
      len,
      name: e.n,
      rb: !!e.r,
      lanes: e.l || 1,
      twin: -1,
      b0: bearing(pts[0], pts[1]),
      b1: bearing(pts[n - 2], pts[n - 1]),
      curvy: len > 0 && turning / len > 0.9, // > 0.9°/m
    };
    this.arcs.push(arc);
    if (!this.out.has(arc.from)) this.out.set(arc.from, []);
    this.out.get(arc.from).push(arc.id);
    return arc;
  }

  // Erlaubte Folgebögen (Wenden nur in Sackgassen)
  next(arcId) {
    const a = this.arcs[arcId];
    const outs = this.out.get(a.to) || [];
    const noU = outs.filter((b) => b !== a.twin);
    return noU.length ? noU : outs;
  }

  classify(aId, bId) {
    const a = this.arcs[aId], b = this.arcs[bId];
    if (b.id === a.twin) return { type: 'uturn', d: 180 };
    if (b.rb && !a.rb) return { type: 'roundabout', d: 0 };
    const d = turnDelta(a.b1, b.b0);
    const ad = Math.abs(d);
    const type = ad < 22 ? 'straight' : ad < 50 ? 'slight' : ad < 140 ? 'turn' : 'sharp';
    return { type, d };
  }

  transitionCost(aId, bId) {
    const a = this.arcs[aId];
    if (a.rb && this.arcs[bId].rb) return 0;
    const opts = this.next(aId).length;
    const t = this.classify(aId, bId).type;
    return opts > 1 || t === 'uturn' ? PENALTY[t] : 0;
  }

  // Dijkstra über Bögen (verhindert Wenden außerhalb von Sackgassen)
  shortestArcs(startArc, goalNode, maxCost = Infinity) {
    if (this.arcs[startArc].to === goalNode) return [];
    const best = new Map([[startArc, 0]]);
    const prev = new Map();
    const heap = [[0, startArc]];
    while (heap.length) {
      let mi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[mi][0]) mi = i;
      const [c, a] = heap[mi];
      heap[mi] = heap[heap.length - 1];
      heap.pop();
      if (c > best.get(a) || c > maxCost) continue;
      if (a !== startArc && this.arcs[a].to === goalNode) {
        const path = [];
        for (let x = a; x !== startArc; x = prev.get(x)) path.push(x);
        return path.reverse();
      }
      for (const b of this.next(a)) {
        const nc = c + this.transitionCost(a, b) + this.arcs[b].time + (this.arcs[b].intoSpur ? 1000 : 0);
        if (nc < (best.has(b) ? best.get(b) : Infinity)) {
          best.set(b, nc);
          prev.set(b, a);
          heap.push([nc, b]);
        }
      }
    }
    return null;
  }

  // Fahrzeit von jedem Knoten zum Ziel (rückwärts, grob – nur als Schätzung)
  timeToNode(goal) {
    const rin = new Map();
    for (const a of this.arcs) {
      if (!rin.has(a.to)) rin.set(a.to, []);
      rin.get(a.to).push(a);
    }
    const t = new Map([[goal, 0]]);
    const q = [goal];
    while (q.length) {
      let mi = 0;
      for (let i = 1; i < q.length; i++) if (t.get(q[i]) < t.get(q[mi])) mi = i;
      const v = q[mi];
      q[mi] = q[q.length - 1];
      q.pop();
      for (const a of rin.get(v) || []) {
        const nt = t.get(v) + a.time + 3;
        if (nt < (t.has(a.from) ? t.get(a.from) : Infinity)) {
          t.set(a.from, nt);
          q.push(a.from);
        }
      }
    }
    return t;
  }

  // Nächster Bogen zu einem Punkt (optional mit Fahrtrichtung)
  nearestArc(p, heading = null) {
    let best = null;
    for (const a of this.arcs) {
      const pr = projectOnPolyline(a.pts, p);
      let cost = pr.d;
      if (heading != null) {
        const segB = bearing(a.pts[pr.i], a.pts[pr.i + 1]);
        cost += (Math.abs(turnDelta(heading, segB)) / 180) * 25;
      }
      if (pr.s > a.len - 3) cost += 3; // lieber den Bogen, der hier beginnt
      if (heading == null && a.intoSpur) cost += 5; // ohne Richtung: nicht in die Sackgasse
      if (!best || cost < best.cost) best = { arc: a.id, cost, d: pr.d, s: pr.s };
    }
    return best;
  }

  // Ausfahrt beim Einfahren in den Kreisel wählen (höchstens eine Runde)
  planExit(entryArc, used, rnd) {
    const start = this.arcs[entryArc].from;
    const opts = [];
    let arc = entryArc;
    for (let i = 0; i < 40 && arc != null; i++) {
      const node = this.arcs[arc].to;
      const outs = this.out.get(node) || [];
      const exits = outs.filter((x) => !this.arcs[x].rb && !this.arcs[x].intoSpur);
      if (exits.length) {
        const w = node === start ? 0.05 : exits.reduce((s, x) => s + 1 / (1 + 2 * (used.get(this.arcs[x].edge) || 0)), 0);
        opts.push({ node, w });
      }
      if (node === start) break;
      arc = outs.find((x) => this.arcs[x].rb);
    }
    if (!opts.length) return null;
    let r = rnd() * opts.reduce((s, o) => s + o.w, 0);
    for (const o of opts) if ((r -= o.w) <= 0) return o.node;
    return opts[opts.length - 1].node;
  }

  // ---------- Zufallsroute ----------
  // Gewichteter Zufallslauf mit Vorliebe für Unbekanntes und abwechselnde
  // Manöver; wenn die Restzeit gerade noch für die Rückfahrt reicht, geht es
  // auf kürzestem Weg zum Ziel.
  randomRoute({ startArc, startS = 0, goal, targetSec, seed }) {
    const rnd = mulberry32(seed);
    const back = this.timeToNode(goal);
    const used = new Map();
    const typeCount = { straight: 1, slight: 1, turn: 1, sharp: 1, uturn: 1, roundabout: 1, left: 1, right: 1 };
    const arcs = [startArc];
    used.set(this.arcs[startArc].edge, 1);
    let t = this.arcs[startArc].time * (1 - startS / Math.max(1, this.arcs[startArc].len));
    let last = [];
    let rbExit = null;
    let guard = 0;
    while (guard++ < 5000) {
      const cur = arcs[arcs.length - 1];
      const a = this.arcs[cur];
      const remainBack = back.get(a.to) ?? 0;
      if (!a.rb && t + remainBack * 1.2 >= targetSec - 10) break;
      let cands = this.next(cur);
      // Nie freiwillig in eine Sackgasse (dort müsste man wenden)
      const open = cands.filter((b) => !this.arcs[b].intoSpur);
      if (open.length) cands = open;
      if (a.rb && rbExit != null) {
        // Im Kreisel: bis zur geplanten Ausfahrt im Kreis bleiben
        const f = cands.filter((b) => this.arcs[b].rb === (a.to !== rbExit));
        if (f.length) cands = f;
      }
      const weights = cands.map((b) => {
        const arc = this.arcs[b];
        const cls = this.classify(cur, b);
        const side = cls.d > 0 ? 'right' : 'left';
        let w = 1;
        const u = used.get(arc.edge) || 0;
        w *= 1 / (1 + 2.5 * Math.pow(u, 1.6));
        if (cands.length > 1) {
          w *= 1.6 / typeCount[cls.type];
          if (cls.type === 'turn' || cls.type === 'sharp' || cls.type === 'slight') w *= 1.4 / typeCount[side];
          if (last.length && last[last.length - 1] === cls.type) w *= 0.7;
        }
        if (cls.type === 'roundabout') w *= 2.2;
        return Math.max(w, 1e-4);
      });
      let r = rnd() * weights.reduce((s, x) => s + x, 0);
      let pick = cands[cands.length - 1];
      for (let i = 0; i < cands.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          pick = cands[i];
          break;
        }
      }
      if (!a.rb && this.arcs[pick].rb) rbExit = this.planExit(pick, used, rnd);
      else if (!this.arcs[pick].rb) rbExit = null;
      const cls = this.classify(cur, pick);
      if (cands.length > 1 || cls.type === 'uturn') {
        if (!(a.rb && this.arcs[pick].rb)) {
          typeCount[cls.type]++;
          if (cls.type !== 'straight' && cls.type !== 'roundabout' && cls.type !== 'uturn') typeCount[cls.d > 0 ? 'right' : 'left']++;
          last.push(cls.type);
        }
      }
      t += this.transitionCost(cur, pick) + this.arcs[pick].time;
      used.set(this.arcs[pick].edge, (used.get(this.arcs[pick].edge) || 0) + 1);
      arcs.push(pick);
    }
    const tail = this.shortestArcs(arcs[arcs.length - 1], goal) || [];
    arcs.push(...tail);
    return new Route(this, arcs, startS);
  }
}

export function polyLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

export function projectOnPolyline(pts, p, cum = null, from = 0, to = pts.length - 1) {
  let best = { d: Infinity, s: 0, i: 0, t: 0, pt: pts[0] };
  let acc = cum ? cum[from] : 0;
  for (let i = from; i < to; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + t * dx, a[1] + t * dy];
    const d = dist(p, q);
    const L = Math.sqrt(L2);
    if (d < best.d) best = { d, s: acc + t * L, i, t, pt: q };
    acc += L;
  }
  return best;
}

// ---------- Route: Polylinie + Manöver ----------
export class Route {
  constructor(graph, arcIds, startS = 0) {
    this.g = graph;
    this.arcIds = arcIds;
    const pts = [];
    const cum = [];
    const arcStart = []; // Distanz, bei der jeder Bogen beginnt
    let s = 0;
    arcIds.forEach((id, k) => {
      const a = graph.arcs[id];
      let ap = a.pts;
      if (k === 0 && startS > 0) {
        // Erster Bogen beginnt mitten auf der Straße
        const cut = pointAt(a.pts, startS);
        ap = [cut.pt, ...a.pts.slice(cut.i + 1)];
      }
      arcStart.push(s);
      ap.forEach((p, j) => {
        if (pts.length && j === 0) return;
        if (pts.length) s += dist(pts[pts.length - 1], p);
        pts.push(p);
        cum.push(s);
      });
    });
    this.pts = pts;
    this.cum = cum;
    this.length = s;
    this.arcStart = arcStart;
    this.buildManeuvers();
    this.buildTimes();
  }

  buildManeuvers() {
    const g = this.g, ids = this.arcIds;
    const m = [];
    const first = g.arcs[ids[0]];
    m.push({ s: 0, type: 'depart', name: first.name, b: first.b0, k: 0 });
    for (let k = 0; k < ids.length - 1; k++) {
      const a = g.arcs[ids[k]], b = g.arcs[ids[k + 1]];
      const at = this.arcStart[k + 1];
      if (a.rb && b.rb) continue;
      if (a.rb && !b.rb) continue; // Ausfahrt wurde bei der Einfahrt angesagt
      const opts = g.next(ids[k]);
      const cls = g.classify(ids[k], ids[k + 1]);
      if (cls.type === 'roundabout') {
        // Ausfahrten zählen
        let exitNo = 0, j = k + 1, outB = b.b0;
        while (j < ids.length && g.arcs[ids[j]].rb) {
          const node = g.arcs[ids[j]].to;
          const hasExit = (g.out.get(node) || []).some((x) => !g.arcs[x].rb);
          if (hasExit) exitNo++;
          j++;
        }
        const exitArc = j < ids.length ? g.arcs[ids[j]] : null;
        if (exitArc) outB = exitArc.b0;
        m.push({ s: at, type: 'roundabout', exit: Math.max(1, exitNo), name: exitArc ? exitArc.name : b.name,
          angle: turnDelta(a.b1, outB), k: k + 1 });
        continue;
      }
      if (cls.type === 'uturn') {
        m.push({ s: at, type: 'uturn', name: b.name, k: k + 1 });
        continue;
      }
      if (opts.length < 2) continue; // nur Kurve, keine Wahl
      if (cls.type === 'straight') {
        // Geradeaus nur ansagen, wenn es eine echte Kreuzung mit anderer Straße ist
        const others = opts.filter((x) => x !== ids[k + 1]).map((x) => Math.abs(g.classify(ids[k], x).d));
        if (a.name === b.name && others.every((d) => d > 55)) continue;
      }
      const mod = cls.type === 'straight' ? 'straight' : (cls.type === 'turn' ? '' : cls.type + '-') + (cls.d > 0 ? 'right' : 'left');
      m.push({ s: at, type: 'turn', mod, name: b.name, k: k + 1 });
    }
    const last = this.pts[this.pts.length - 1], prev = this.pts[this.pts.length - 2] || last;
    m.push({ s: this.length, type: 'arrive', name: '', b: bearing(prev, last), k: ids.length });
    this.maneuvers = m;
  }

  buildTimes() {
    // Modellierte Restzeit ab jeder Bogen-Grenze
    const g = this.g, ids = this.arcIds;
    const arcT = ids.map((id, k) => {
      const a = g.arcs[id];
      const len = (k + 1 < ids.length ? this.arcStart[k + 1] : this.length) - this.arcStart[k];
      const v = a.len / a.time;
      return len / v + (k > 0 ? g.transitionCost(ids[k - 1], id) : 0);
    });
    this.arcTime = arcT;
    this.totalTime = arcT.reduce((s, x) => s + x, 0);
  }

  arcIndexAt(s) {
    let lo = 0, hi = this.arcStart.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.arcStart[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  remainingTime(s) {
    const k = this.arcIndexAt(s);
    const end = k + 1 < this.arcStart.length ? this.arcStart[k + 1] : this.length;
    const span = Math.max(1, end - this.arcStart[k]);
    let t = this.arcTime[k] * Math.max(0, (end - s) / span);
    for (let j = k + 1; j < this.arcTime.length; j++) t += this.arcTime[j];
    return t;
  }

  pointAt(s) {
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = this.pts[lo], b = this.pts[hi] || a;
    const L = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / L;
    return { pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], b: bearing(a, b), i: lo };
  }

  // Ausschnitt der Polylinie zwischen s0 und s1
  slice(s0, s1) {
    s0 = Math.max(0, s0);
    s1 = Math.min(this.length, s1);
    if (s1 <= s0) return [];
    const out = [this.pointAt(s0).pt];
    for (let i = 0; i < this.pts.length; i++) if (this.cum[i] > s0 && this.cum[i] < s1) out.push(this.pts[i]);
    out.push(this.pointAt(s1).pt);
    return out;
  }

  stats() {
    const c = { left: 0, right: 0, straight: 0, roundabout: 0, uturn: 0 };
    for (const m of this.maneuvers) {
      if (m.type === 'turn') c[m.mod === 'straight' ? 'straight' : m.mod.endsWith('right') ? 'right' : 'left']++;
      else if (m.type in c) c[m.type]++;
    }
    const edges = new Set(this.arcIds.map((id) => this.g.arcs[id].edge));
    c.coverage = edges.size / this.g.site.edges.length;
    return c;
  }
}

function pointAt(pts, s) {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const L = dist(pts[i], pts[i + 1]);
    if (acc + L >= s) {
      const t = L ? (s - acc) / L : 0;
      return { pt: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t], i };
    }
    acc += L;
  }
  return { pt: pts[pts.length - 1], i: pts.length - 2 };
}
