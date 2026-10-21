// Navigation: Texte, Symbole, Sprachausgabe, GPS-Abgleich und Simulation.
import { projectOnPolyline, turnDelta, dist, bearing, Route } from './graph.js';

const ORD = ['erste', 'zweite', 'dritte', 'vierte', 'fünfte', 'sechste', 'siebte'];
const VERB = {
  left: 'links abbiegen', right: 'rechts abbiegen',
  'slight-left': 'leicht links halten', 'slight-right': 'leicht rechts halten',
  'sharp-left': 'scharf links abbiegen', 'sharp-right': 'scharf rechts abbiegen',
  straight: 'geradeaus weiterfahren',
};
const DIRS = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function compass(b) {
  return DIRS[Math.round(((b % 360) + 360) % 360 / 45) % 8];
}

export function fmtDist(m) {
  if (m >= 1000) return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  if (m >= 100) return Math.round(m / 10) * 10 + ' m';
  return Math.max(0, Math.round(m / 5) * 5) + ' m';
}

export function fmtMin(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return m + ' Min.';
  return Math.floor(m / 60) + ' Std. ' + (m % 60) + ' Min.';
}

// Kurztext für das Banner
export function bannerText(m, destName) {
  switch (m.type) {
    case 'depart': return { main: m.name, sub: 'Richtung ' + compass(m.b) };
    case 'arrive': return { main: destName, sub: 'Ziel' };
    case 'uturn': return { main: 'Wenden', sub: m.name };
    case 'roundabout': return { main: m.name, sub: `Kreisverkehr · ${m.exit}. Ausfahrt` };
    default: return { main: m.name, sub: cap(VERB[m.mod]) };
  }
}

// Sprachtext
export function speech(m, d, destName, then = null) {
  let s;
  const pre = d != null ? `In ${Math.max(10, Math.round(d / 10) * 10)} Metern ` : '';
  switch (m.type) {
    case 'depart': s = `Fahren Sie Richtung ${compass(m.b)} auf ${m.name}`; break;
    case 'arrive': s = d != null ? `${pre}erreichen Sie Ihr Ziel, ${destName}` : `Sie haben Ihr Ziel erreicht. ${destName}`; break;
    case 'uturn': s = d != null ? `${pre}wenden` : 'Bitte wenden'; break;
    case 'roundabout': {
      const ord = ORD[m.exit - 1] || m.exit + '.';
      s = d != null ? `${pre}in den Kreisverkehr einfahren und die ${ord} Ausfahrt nehmen` : `Im Kreisverkehr die ${ord} Ausfahrt nehmen auf ${m.name}`;
      break;
    }
    default: {
      const v = VERB[m.mod];
      s = d != null ? `${pre}${v}` : `${cap(v)} auf ${m.name}`;
    }
  }
  if (then) {
    const t = then.type === 'turn' ? VERB[then.mod] : then.type === 'uturn' ? 'wenden' : then.type === 'roundabout' ? 'in den Kreisverkehr' : 'erreichen Sie Ihr Ziel';
    s += `, dann ${t}`;
  }
  return cap(s) + '.';
}

// Manöver-Symbol (weiß, für das grüne Banner)
export function maneuverSVG(m, size = 48) {
  const head = (d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  let body = '';
  let mirror = false;
  const mod = m.mod || '';
  if (mod.endsWith('left')) mirror = true;
  switch (m.type) {
    case 'arrive':
      body = `<path d="M24 44c-1-6-12-14-12-24a12 12 0 0 1 24 0c0 10-11 18-12 24z" fill="currentColor"/><circle cx="24" cy="20" r="4.5" fill="#188038"/>`;
      break;
    case 'uturn':
      body = head('M32 42V20Q32 9 23 9Q14 9 14 20V32') + head('M7 26l7 7 7-7');
      break;
    case 'roundabout': {
      const th = ((m.angle ?? 0) * Math.PI) / 180;
      const cx = 24, cy = 22, r = 8;
      const ex = cx + r * Math.sin(th), ey = cy - r * Math.cos(th);
      const ox = cx + 19 * Math.sin(th), oy = cy - 19 * Math.cos(th);
      let trav = 180 - (m.angle ?? 0);
      trav = ((trav % 360) + 360) % 360 || 360;
      const large = trav > 180 ? 1 : 0;
      const ha = Math.atan2(oy - ey, ox - ex);
      const hp = (a) => `${ox + 7 * Math.cos(ha + a)} ${oy + 7 * Math.sin(ha + a)}`;
      body = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="4"/>` +
        head(`M24 44V${cy + r}A${r} ${r} 0 ${large} 0 ${ex} ${ey}L${ox} ${oy}`) +
        head(`M${hp(2.4)}L${ox} ${oy}L${hp(-2.4)}`);
      break;
    }
    default:
      if (m.type === 'depart' || mod === 'straight') body = head('M24 43V8') + head('M14 18L24 8l10 10');
      else if (mod.startsWith('slight')) body = head('M18 43V28L34 12') + head('M23 11h12v12');
      else if (mod.startsWith('sharp')) body = head('M15 43V15q0-6 6-2l15 17') + head('M37 18v13H24');
      else body = head('M16 43V26q0-8 8-8h13') + head('M30 10l8 8-8 8');
  }
  const tr = mirror ? ' transform="translate(48 0) scale(-1 1)"' : '';
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true"><g${tr}>${body}</g></svg>`;
}

// ---------- Sprachausgabe ----------
export class Voice {
  constructor() {
    this.enabled = true;
    this.voice = null;
    const pick = () => {
      const vs = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('de'));
      this.voice = vs.find((v) => /google/i.test(v.name)) || vs[0] || null;
    };
    if ('speechSynthesis' in window) {
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
  }
  say(text) {
    if (!this.enabled || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.02;
    speechSynthesis.speak(u);
  }
  // Muss einmal innerhalb einer Nutzer-Geste aufgerufen werden (Android/Chrome)
  unlock() {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

// ---------- Abgleich der Position mit der Route ----------
export class Tracker {
  constructor(route, s = 0) {
    this.route = route;
    this.s = s;
    this.off = 0;
  }

  idxAt(s) {
    const c = this.route.cum;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  update(fix) {
    const r = this.route;
    const ahead = Math.max(60, (fix.speed || 0) * 8 + 40);
    const i0 = this.idxAt(Math.max(0, this.s - 25));
    const i1 = Math.min(r.pts.length - 1, this.idxAt(this.s + ahead) + 1);
    // Kandidaten im Fenster: Abstand + Richtungsabweichung
    let best = null;
    for (let i = i0; i < i1; i++) {
      const pr = projectOnPolyline(r.pts, fix.p, r.cum, i, i + 1);
      let cost = pr.d + Math.abs(pr.s - this.s) * 0.02;
      if (fix.heading != null && (fix.speed || 0) > 1.5) {
        cost += (Math.abs(turnDelta(fix.heading, bearing(r.pts[i], r.pts[i + 1]))) / 180) * 20;
      }
      if (!best || cost < best.cost) best = { ...pr, cost };
    }
    if (!best) return { s: this.s, d: 0, onRoute: true };
    const tol = Math.max(22, Math.min(45, (fix.acc || 10) * 1.2));
    if (best.d > tol) {
      this.off++;
    } else {
      this.off = 0;
      // GPS-Zittern: höchstens ein kleines Stück zurückspringen
      this.s = best.s >= this.s ? best.s : Math.max(best.s, this.s - 3);
    }
    return { s: this.s, d: best.d, onRoute: best.d <= tol, pt: best.pt };
  }
}

// Neue Route ab aktueller Position, die möglichst bald wieder auf die alte trifft
export function reroute(g, route, s, p, heading) {
  const na = g.nearestArc(p, heading);
  if (!na) return null;
  const k0 = route.arcIndexAt(s);
  let best = null;
  for (let k = k0; k < Math.min(route.arcIds.length, k0 + 60); k++) {
    const target = route.arcIds[k];
    const fromNode = g.arcs[target].from;
    const path = g.shortestArcs(na.arc, fromNode, 600);
    if (!path) continue;
    const last = path.length ? path[path.length - 1] : na.arc;
    if (g.classify(last, target).type === 'uturn' && !g.arcs[last].deadEnd) continue;
    if (last === target) continue;
    let cost = 0;
    for (const a of path) cost += g.arcs[a].time;
    let skipped = 0;
    for (let j = k0; j < k; j++) skipped += route.arcTime[j];
    cost += 0.5 * skipped;
    if (!best || cost < best.cost) best = { cost, arcs: [na.arc, ...path, ...route.arcIds.slice(k)] };
  }
  if (!best) return null;
  return new Route(g, best.arcs, Math.min(na.s, g.arcs[na.arc].len - 0.5));
}

// ---------- Simulation: fährt die Route wie ein Fahrschüler ab ----------
const MAN_SPEED = { turn: 3.0, sharp: 2.2, slight: 4.6, straight: 5.4, roundabout: 3.8, uturn: 0.6, arrive: 0, depart: 6 };

export class Simulator {
  constructor(route) {
    this.setRoute(route, 0);
    this.v = 0;
    this.mult = 1;
    this.paused = false;
  }
  setRoute(route, s) {
    this.route = route;
    this.s = s;
  }
  step(dt) {
    if (this.paused) return null;
    dt *= this.mult;
    const r = this.route;
    let vmax = 6.1;
    const k = r.arcIndexAt(this.s);
    const arc = r.g.arcs[r.arcIds[k]];
    if (arc.rb) vmax = 4.0;
    else if (arc.curvy) vmax = 4.6;
    for (const m of r.maneuvers) {
      if (m.s < this.s - 1 || m.type === 'depart') continue;
      const d = m.s - this.s;
      if (d > 80) break;
      const key = m.type === 'turn' ? (m.mod === 'straight' ? 'straight' : m.mod.split('-').length > 1 ? m.mod.split('-')[0] : 'turn') : m.type;
      const vm = MAN_SPEED[key] ?? 4;
      vmax = Math.min(vmax, Math.sqrt(vm * vm + 2 * 1.1 * Math.max(0, d - 3)));
    }
    if (this.v < vmax) this.v = Math.min(vmax, this.v + 1.2 * dt);
    else this.v = Math.max(vmax, this.v - 2.5 * dt);
    if (this.v < 0.8 && this.s < r.length - 1) this.v = 0.8;
    this.s = Math.min(r.length, this.s + this.v * dt);
    const at = r.pointAt(this.s);
    return { p: at.pt, heading: at.b, speed: this.v, acc: 4, sim: true };
  }
}

export { dist };
