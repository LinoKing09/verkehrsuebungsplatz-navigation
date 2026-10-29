// Kartendarstellung im Google-Maps-Stil.
// Die Karte wird auf ein großes Canvas gezeichnet, das per CSS-3D-Transform
// geneigt wird (Navigationsansicht). Alles, was aufrecht stehen soll
// (Beschriftungen, Pins, Schilder), zeichnet ein zweites, ungeneigtes Canvas.

export const THEMES = {
  day: {
    land: '#F1EFEA', area: '#E9E6DF', areaEdge: '#D9D4CA',
    forest: '#C3E2B5', grass: '#D3ECC9', scrub: '#CBE5BE', vineyard: '#DFEAC2', farmland: '#EFEEDC',
    water: '#A8D8FA', urban: '#ECEAE5', building: '#E0DDD8', buildingEdge: '#CFCBC4', parking: '#E5E5EA', pavement: '#E3E4E8',
    road: '#FFFFFF', roadCase: '#CDD0D4', major: '#FEF0B3', majorCase: '#E5C46A', track: '#CFC6B2', path: '#BDB6A8',
    route: '#1A73E8', routeCase: '#0B57D0', routeFar: '#8AB4F8', routeFarCase: '#6A9BE8',
    text: '#3C4043', textHalo: '#FFFFFF', streetText: '#5F6368', oneway: '#9AA0A6',
    arrow: '#FFFFFF', arrowCase: '#0B57D0', car: '#1A73E8', carEdge: '#FFFFFF', sky: '#DCE3EA',
  },
  night: {
    land: '#1E242C', area: '#222A33', areaEdge: '#2E3742',
    forest: '#1C3328', grass: '#20382C', scrub: '#1F352A', vineyard: '#263623', farmland: '#232A26',
    water: '#17324D', urban: '#20262E', building: '#2A323D', buildingEdge: '#36404C', parking: '#28303A', pavement: '#28303A',
    road: '#3D4756', roadCase: '#2A313B', major: '#5C5338', majorCase: '#463F2B', track: '#3A3D38', path: '#3A3D38',
    route: '#5C9DFF', routeCase: '#2C67C8', routeFar: '#2D4E80', routeFarCase: '#24406A',
    text: '#E8EAED', textHalo: '#1E242C', streetText: '#BDC1C6', oneway: '#6F7782',
    arrow: '#FFFFFF', arrowCase: '#2C67C8', car: '#5C9DFF', carEdge: '#FFFFFF', sky: '#141A21',
  },
};

const ROAD_W = { 5: 12, 4: 9, 3: 7.5, 2: 6, 1: 4.5 };

export class MapView {
  constructor(root) {
    this.root = root;
    this.wrap = document.createElement('div');
    this.wrap.className = 'map-wrap';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'map-overlay';
    this.wrap.appendChild(this.canvas);
    root.appendChild(this.wrap);
    root.appendChild(this.overlay);
    this.ctx = this.canvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');
    this.cam = { x: 0, y: 0, heading: 0, scale: 2, tilt: 0 };
    this.anchor = { fx: 0.5, fy: 0.5 }; // Bildschirmposition des Kamerazentrums (Anteil)
    this.maxTilt = 52;
    this.theme = THEMES.day;
    this.site = null;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const W = this.root.clientWidth, H = this.root.clientHeight;
    this.W = W;
    this.H = H;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.persp = 1.6 * H;
    // Canvas-Ränder so groß wählen, dass auch bei maximaler Neigung alles bedeckt ist
    const a = (this.maxTilt * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const P = this.persp;
    const needUp = H * 0.8 + 40; // Anker liegt höchstens bei 80 % Höhe
    const v = (needUp * P) / Math.max(1, c * P - needUp * s);
    const far = P / (P + v * s);
    this.padTop = Math.ceil(v - H * 0.2);
    this.padX = Math.ceil((W / 2) / far - W / 2 + 20);
    this.padBottom = 40;
    this.cw = W + 2 * this.padX;
    this.ch = H + this.padTop + this.padBottom;
    const mdpr = Math.min(this.dpr, (12e6 / (this.cw * this.ch)) ** 0.5); // Speicher schonen
    this.mdpr = mdpr;
    this.canvas.width = Math.round(this.cw * mdpr);
    this.canvas.height = Math.round(this.ch * mdpr);
    Object.assign(this.canvas.style, {
      width: this.cw + 'px', height: this.ch + 'px', left: -this.padX + 'px', top: -this.padTop + 'px',
    });
    this.overlay.width = Math.round(W * this.dpr);
    this.overlay.height = Math.round(H * this.dpr);
    this.overlay.style.width = W + 'px';
    this.overlay.style.height = H + 'px';
  }

  setTheme(name) {
    this.theme = THEMES[name] || THEMES.day;
  }

  setSite(site) {
    this.site = site;
    const P = () => new Path2D();
    const polys = {};
    for (const p of site.polys) {
      const path = polys[p.t] || (polys[p.t] = P());
      p.p.forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1])));
      path.closePath();
    }
    this.polyPaths = polys;
    const area = P();
    site.boundary.forEach((q, i) => (i ? area.lineTo(q[0], q[1]) : area.moveTo(q[0], q[1])));
    area.closePath();
    this.areaPath = area;
    // Kontextstraßen (außerhalb der Anlage)
    const lines = {};
    for (const l of site.lines) {
      if (l.in) continue;
      const key = l.t === 'water' ? 'water' : l.z <= -1 ? 'path' : l.z === 0 ? 'track' : 'z' + l.z;
      const path = lines[key] || (lines[key] = P());
      l.p.forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1])));
    }
    this.linePaths = lines;
    // Übungsstraßen nach Breite gruppiert
    const roads = {};
    const oneway = [];
    for (const e of site.edges) {
      const w = e.l >= 3 ? 8 : e.l === 2 ? 6.5 : 5;
      const path = roads[w] || (roads[w] = P());
      e.p.forEach((i, k) => (k ? path.lineTo(...site.nodes[i]) : path.moveTo(...site.nodes[i])));
      if (e.o && !e.r) oneway.push(e.p.map((i) => site.nodes[i]));
    }
    this.roadPaths = roads;
    this.oneway = oneway;
    // Beschriftung: je Straßenname der längste Abschnitt
    const best = new Map();
    for (const e of site.edges) {
      const pts = e.p.map((i) => site.nodes[i]);
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (e.r) continue;
      if (!best.has(e.n) || best.get(e.n).L < L) best.set(e.n, { L, pts });
    }
    this.labels = [...best.entries()].map(([name, { pts }]) => ({ name, at: midpoint(pts) }));
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const q of site.boundary) {
      minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]);
      miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]);
    }
    this.bounds = [minx, miny, maxx, maxy];
  }

  // Kamera so setzen, dass ein Rechteck (Weltkoordinaten) sichtbar ist
  fit(b, pad = { top: 80, bottom: 300, left: 24, right: 24 }) {
    const w = this.W - pad.left - pad.right, h = this.H - pad.top - pad.bottom;
    const scale = Math.min(w / Math.max(1, b[2] - b[0]), h / Math.max(1, b[3] - b[1]));
    return {
      x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, heading: 0, scale, tilt: 0,
      fy: (pad.top + h / 2) / this.H,
    };
  }

  // Welt -> Canvas-CSS-Pixel (vor der Neigung)
  worldMatrix() {
    const c = this.cam;
    const ox = this.padX + this.W * this.anchor.fx, oy = this.padTop + this.H * this.anchor.fy;
    return new DOMMatrix().translate(ox, oy).scale(c.scale, -c.scale).rotate(c.heading).translate(-c.x, -c.y);
  }

  tiltMatrix() {
    return new DOMMatrix(`perspective(${this.persp}px) rotateX(${this.cam.tilt}deg)`);
  }

  // Welt -> Bildschirm (mit Neigung)
  project(p) {
    const q = this.wm.transformPoint(new DOMPoint(p[0], p[1]));
    const ox = this.padX + this.W * this.anchor.fx, oy = this.padTop + this.H * this.anchor.fy;
    const r = this.tm.transformPoint(new DOMPoint(q.x - ox, q.y - oy, 0, 1));
    return { x: r.x / r.w + this.W * this.anchor.fx, y: r.y / r.w + this.H * this.anchor.fy, k: 1 / r.w };
  }

  // Bildschirm -> Welt (nur ohne Neigung exakt)
  unproject(x, y) {
    const ox = this.padX, oy = this.padTop;
    const p = this.wm.inverse().transformPoint(new DOMPoint(x + ox, y + oy));
    return [p.x, p.y];
  }

  draw(state) {
    const t = this.theme, ctx = this.ctx, c = this.cam;
    this.wm = this.worldMatrix();
    this.tm = this.tiltMatrix();
    const ox = this.padX + this.W * this.anchor.fx, oy = this.padTop + this.H * this.anchor.fy;
    this.canvas.style.transformOrigin = `${ox}px ${oy}px`;
    this.canvas.style.transform = c.tilt > 0.01 ? `perspective(${this.persp}px) rotateX(${c.tilt}deg)` : 'none';
    this.root.style.background = c.tilt > 1 ? t.sky : t.land;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t.land;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const m = new DOMMatrix().scale(this.mdpr).multiply(this.wm);
    ctx.setTransform(m);
    const px = 1 / c.scale; // 1 CSS-Pixel in Metern
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.fillStyle = t.area;
    ctx.fill(this.areaPath);
    for (const k of ['urban', 'farmland', 'vineyard', 'grass', 'scrub', 'forest', 'water', 'pavement', 'parking']) {
      if (!this.polyPaths[k]) continue;
      ctx.fillStyle = t[k];
      ctx.fill(this.polyPaths[k]);
    }
    if (this.polyPaths.vineyard && c.scale > 1.2) this.drawVineRows(ctx, px);
    if (this.polyPaths.building) {
      ctx.fillStyle = t.building;
      ctx.fill(this.polyPaths.building);
      ctx.strokeStyle = t.buildingEdge;
      ctx.lineWidth = px;
      ctx.stroke(this.polyPaths.building);
    }
    ctx.strokeStyle = t.areaEdge;
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.stroke(this.areaPath);
    ctx.setLineDash([]);

    // Kontext-Wege und -Straßen
    const L = this.linePaths;
    if (L.water) this.stroke(L.water, t.water, Math.max(2, 2 * px));
    if (L.path) {
      ctx.setLineDash([3 * px, 3 * px]);
      this.stroke(L.path, t.path, Math.max(1.2 * px, 0.8));
      ctx.setLineDash([]);
    }
    if (L.track) {
      ctx.setLineDash([6 * px, 4 * px]);
      this.stroke(L.track, t.track, Math.max(2 * px, 1.5));
      ctx.setLineDash([]);
    }
    for (const z of [1, 2, 3, 4, 5]) {
      const p = L['z' + z];
      if (!p) continue;
      const w = Math.max(ROAD_W[z], (z >= 4 ? 7 : 4) * px);
      this.stroke(p, z >= 4 ? t.majorCase : t.roadCase, w + 2 * px);
    }
    for (const z of [1, 2, 3, 4, 5]) {
      const p = L['z' + z];
      if (!p) continue;
      const w = Math.max(ROAD_W[z], (z >= 4 ? 7 : 4) * px);
      this.stroke(p, z >= 4 ? t.major : t.road, w);
    }
    // Übungsstraßen
    const widths = Object.keys(this.roadPaths).map(Number);
    for (const w of widths) this.stroke(this.roadPaths[w], t.roadCase, Math.max(w, 5 * px) + 2.4 * px);
    for (const w of widths) this.stroke(this.roadPaths[w], t.road, Math.max(w, 5 * px));
    if (c.scale > 1.5) this.drawOneway(ctx, px);

    // Route
    if (state.route) this.drawRoute(ctx, state, px);
    // Gepunktete Linie vom Standort zur Route (wie bei Google Maps)
    if (state.join) {
      ctx.setLineDash([0.1, 9 * px]);
      this.polyline(state.join, t.routeCase, 5 * px);
      ctx.setLineDash([]);
    }
    this.drawOverlay(state);
  }

  stroke(path, color, w) {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = w;
    this.ctx.stroke(path);
  }

  drawVineRows(ctx, px) {
    ctx.save();
    ctx.clip(this.polyPaths.vineyard);
    ctx.strokeStyle = 'rgba(120,150,60,0.18)';
    ctx.lineWidth = Math.max(0.5, px);
    const [x0, y0, x1, y1] = this.bounds;
    ctx.beginPath();
    for (let y = y0 - 200; y < y1 + 200; y += 3.5) {
      ctx.moveTo(x0 - 200, y);
      ctx.lineTo(x1 + 200, y + 40);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawOneway(ctx, px) {
    ctx.fillStyle = this.theme.oneway;
    const step = Math.max(25, 60 * px);
    for (const pts of this.oneway) {
      walk(pts, step, step / 2, (p, b) => {
        ctx.save();
        ctx.translate(p[0], p[1]);
        ctx.rotate(-b);
        const s = Math.max(1.2, 4 * px);
        ctx.beginPath();
        ctx.moveTo(0, s);
        ctx.lineTo(s * 0.8, -s * 0.5);
        ctx.lineTo(0, -s * 0.1);
        ctx.lineTo(-s * 0.8, -s * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
    }
  }

  drawRoute(ctx, st, px) {
    const t = this.theme, r = st.route;
    const s0 = st.progress || 0;
    const near = st.nearLen ?? r.length;
    const wNear = Math.max(4.2, 8 * px), wFar = Math.max(3, 5 * px);
    const far = r.slice(s0 + near, r.length);
    if (far.length > 1) {
      ctx.globalAlpha = st.mode === 'nav' ? 0.55 : 0.9;
      this.polyline(far, t.routeFarCase, wFar + 2 * px);
      this.polyline(far, t.routeFar, wFar);
      ctx.globalAlpha = 1;
    }
    const nearPts = r.slice(s0, s0 + near);
    if (nearPts.length > 1) {
      this.polyline(nearPts, t.routeCase, wNear + 2.5 * px);
      this.polyline(nearPts, t.route, wNear);
    }
    // Abbiegepfeil auf der Fahrbahn
    if (st.mode === 'nav' && st.nextManeuver && st.nextManeuver.type !== 'arrive' && st.nextManeuver.type !== 'depart') {
      const ms = st.nextManeuver.s;
      if (ms - s0 < 140) {
        const arr = r.slice(Math.max(s0, ms - 12), Math.min(r.length, ms + (st.nextManeuver.type === 'roundabout' ? 26 : 10)));
        if (arr.length > 1) {
          const w = Math.max(1.6, 3.2 * px);
          this.polyline(arr, t.arrowCase, w + 2 * px, true);
          this.polyline(arr, t.arrow, w, true);
        }
      }
    }
  }

  polyline(pts, color, w, head = false) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    if (head) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const L = w * 2.2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(b[0] + Math.cos(ang) * L, b[1] + Math.sin(ang) * L);
      ctx.lineTo(b[0] + Math.cos(ang + 2.2) * L, b[1] + Math.sin(ang + 2.2) * L);
      ctx.lineTo(b[0] + Math.cos(ang - 2.2) * L, b[1] + Math.sin(ang - 2.2) * L);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawOverlay(st) {
    const o = this.octx, t = this.theme;
    o.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    o.clearRect(0, 0, this.W, this.H);
    const site = this.site;
    // Straßennamen
    const boxes = [];
    o.font = '500 12px "Google Sans", Roboto, system-ui, sans-serif';
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    if (this.cam.scale > 1.1) {
      for (const lb of this.labels) {
        const p = this.project(lb.at);
        if (p.k < 0.45 || p.x < 0 || p.x > this.W || p.y < 90 || p.y > this.H) continue;
        const w = o.measureText(lb.name).width + 8;
        const box = [p.x - w / 2, p.y - 9, p.x + w / 2, p.y + 9];
        if (boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
        boxes.push(box);
        o.lineWidth = 3;
        o.lineJoin = 'round';
        o.strokeStyle = t.textHalo;
        o.strokeText(lb.name, p.x, p.y);
        o.fillStyle = t.streetText;
        o.fillText(lb.name, p.x, p.y);
      }
    }
    // Stoppschilder, Schranken
    for (const poi of site.pois) {
      const p = this.project(site.nodes[poi.n]);
      if (p.k < 0.5 || p.y < 80 || p.y > this.H) continue;
      if (poi.t === 'stop') drawStop(o, p.x, p.y - 14, 9);
      else if (poi.t === 'give_way') drawGiveWay(o, p.x, p.y - 14, 10);
    }
    // Ziel-Pin
    if (st.dest) {
      const p = this.project(st.dest);
      if (p.k > 0.3) drawPin(o, p.x, p.y, st.mode === 'nav' ? 1.1 : 1);
    }
    // Startpunkt in der Vorschau
    if (st.mode !== 'nav' && st.route) {
      const p = this.project(st.route.pts[0]);
      o.fillStyle = '#fff';
      o.strokeStyle = '#5F6368';
      o.lineWidth = 3;
      o.beginPath();
      o.arc(p.x, p.y, 7, 0, 7);
      o.fill();
      o.stroke();
    }
    // Eigene Position
    if (st.me) {
      if (st.mode === 'nav') this.drawCar(o, st.me);
      else this.drawDot(o, st.me);
    }
  }

  drawCar(o, me) {
    // Pfeil liegt "auf der Straße": Eckpunkte in Weltkoordinaten projizieren
    const L = 26 / this.cam.scale;
    const b = (me.heading * Math.PI) / 180;
    const f = [Math.sin(b), Math.cos(b)], r = [Math.cos(b), -Math.sin(b)];
    const P = (a, c) => this.project([me.p[0] + f[0] * a * L + r[0] * c * L, me.p[1] + f[1] * a * L + r[1] * c * L]);
    const tip = P(0.62, 0), lw = P(-0.45, -0.5), rw = P(-0.45, 0.5), nk = P(-0.18, 0);
    const ctr = this.project(me.p);
    o.save();
    // Schatten
    o.fillStyle = 'rgba(0,0,0,0.22)';
    o.beginPath();
    o.ellipse(ctr.x, ctr.y + 4, 22 * ctr.k, 12 * ctr.k, 0, 0, 7);
    o.fill();
    o.beginPath();
    o.moveTo(tip.x, tip.y);
    o.lineTo(rw.x, rw.y);
    o.lineTo(nk.x, nk.y);
    o.lineTo(lw.x, lw.y);
    o.closePath();
    o.lineJoin = 'round';
    o.lineWidth = 4;
    o.strokeStyle = this.theme.carEdge;
    o.stroke();
    o.fillStyle = this.theme.car;
    o.fill();
    o.restore();
  }

  drawDot(o, me) {
    const p = this.project(me.p);
    if (me.acc) {
      o.fillStyle = 'rgba(26,115,232,0.15)';
      o.beginPath();
      o.arc(p.x, p.y, Math.max(12, me.acc * this.cam.scale), 0, 7);
      o.fill();
    }
    if (me.heading != null) {
      const b = ((me.heading - this.cam.heading) * Math.PI) / 180;
      const g = o.createRadialGradient(p.x, p.y, 4, p.x, p.y, 40);
      g.addColorStop(0, 'rgba(26,115,232,0.45)');
      g.addColorStop(1, 'rgba(26,115,232,0)');
      o.fillStyle = g;
      o.beginPath();
      o.moveTo(p.x, p.y);
      o.arc(p.x, p.y, 40, b - Math.PI / 2 - 0.55, b - Math.PI / 2 + 0.55);
      o.closePath();
      o.fill();
    }
    o.fillStyle = '#fff';
    o.beginPath();
    o.arc(p.x, p.y, 10, 0, 7);
    o.fill();
    o.fillStyle = '#1A73E8';
    o.beginPath();
    o.arc(p.x, p.y, 7, 0, 7);
    o.fill();
  }
}

function midpoint(pts) {
  let L = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    L += d;
  }
  let s = L / 2;
  for (let i = 0; i < seg.length; i++) {
    if (s <= seg[i]) {
      const t = seg[i] ? s / seg[i] : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    s -= seg[i];
  }
  return pts[0];
}

// Ruft fn(punkt, richtung) alle `step` Meter entlang der Polylinie auf
function walk(pts, step, offset, fn) {
  let next = offset, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (next <= acc + d) {
      const t = (next - acc) / d;
      fn([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], Math.atan2(b[0] - a[0], b[1] - a[1]));
      next += step;
    }
    acc += d;
  }
}

function drawPin(o, x, y, s = 1) {
  o.save();
  o.translate(x, y);
  o.scale(s, s);
  o.fillStyle = 'rgba(0,0,0,0.25)';
  o.beginPath();
  o.ellipse(0, 0, 6, 2.5, 0, 0, 7);
  o.fill();
  o.fillStyle = '#EA4335';
  o.strokeStyle = '#B31412';
  o.lineWidth = 1.2;
  o.beginPath();
  o.moveTo(0, 0);
  o.bezierCurveTo(-4, -10, -13, -17, -13, -27);
  o.arc(0, -27, 13, Math.PI, 0);
  o.bezierCurveTo(13, -17, 4, -10, 0, 0);
  o.fill();
  o.stroke();
  // Zielflagge
  o.fillStyle = '#fff';
  o.fillRect(-6, -33, 12, 10);
  o.fillStyle = '#202124';
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2 === 0) o.fillRect(-6 + i * 4, -33 + j * 5, 4, 5);
  o.restore();
}

function drawStop(o, x, y, r) {
  o.save();
  o.translate(x, y);
  o.fillStyle = '#fff';
  octagon(o, r + 1.5);
  o.fill();
  o.fillStyle = '#D93025';
  octagon(o, r);
  o.fill();
  o.fillStyle = '#fff';
  o.font = `bold ${r * 0.62}px Roboto, sans-serif`;
  o.textAlign = 'center';
  o.textBaseline = 'middle';
  o.fillText('STOP', 0, 0.5);
  o.restore();
}

function octagon(o, r) {
  o.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    o.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  o.closePath();
}

function drawGiveWay(o, x, y, r) {
  o.save();
  o.translate(x, y);
  o.fillStyle = '#D93025';
  o.beginPath();
  o.moveTo(-r, -r * 0.6);
  o.lineTo(r, -r * 0.6);
  o.lineTo(0, r);
  o.closePath();
  o.fill();
  o.fillStyle = '#fff';
  o.beginPath();
  o.moveTo(-r * 0.5, -r * 0.32);
  o.lineTo(r * 0.5, -r * 0.32);
  o.lineTo(0, r * 0.45);
  o.closePath();
  o.fill();
  o.restore();
}
