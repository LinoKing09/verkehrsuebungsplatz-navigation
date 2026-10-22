import { Graph, bearing, dist, turnDelta } from './graph.js';
import { MapView } from './render.js';
import { Voice, Tracker, Simulator, reroute, speech, bannerText, maneuverSVG, fmtDist, fmtMin } from './nav.js';

const SITES = [
  { id: 'leonberg', file: 'data/leonberg.json', title: 'Leonberg', sub: 'ADAC Verkehrsübungsanlage am Solitude-Ring', dest: 'Start- und Zielturm' },
  { id: 'heilbronn', file: 'data/heilbronn.json', title: 'Heilbronn', sub: 'Verkehrsübungsplatz am Wartberg', dest: 'Parkplatz Langer Zug' },
];

const $ = (id) => document.getElementById(id);
const app = $('app');
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('vup.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('vup.' + k, JSON.stringify(v)); } catch { /* privater Modus */ }
  },
};

const view = new MapView($('map'));
const voice = new Voice();
const S = {
  mode: 'pick',
  sites: {},
  site: null,
  meta: null,
  graph: null,
  route: null,
  seed: store.get('seed', 1 + Math.floor(Math.random() * 9999)),
  minutes: store.get('minutes', 15),
  src: store.get('src', 'gps'),
  gps: null, // letzte GPS-Position {p, heading, speed, acc, t}
  watchId: null,
  camTarget: null,
  free: false,
  nav: null,
};

// ---------- Theme ----------
const mq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = store.get('theme', 'auto');
  const night = pref === 'night' || (pref === 'auto' && mq.matches);
  document.documentElement.dataset.theme = night ? 'night' : 'day';
  view.setTheme(night ? 'night' : 'day');
}
mq.addEventListener?.('change', applyTheme);
$('btnTheme').onclick = () => {
  const order = ['auto', 'night', 'day'];
  const next = order[(order.indexOf(store.get('theme', 'auto')) + 1) % 3];
  store.set('theme', next);
  applyTheme();
  toast({ auto: 'Design: automatisch', night: 'Design: Nacht', day: 'Design: Tag' }[next]);
};
applyTheme();

// ---------- Helfer ----------
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function dialog(title, text, actions) {
  return new Promise((resolve) => {
    $('dlgTitle').textContent = title;
    $('dlgText').innerHTML = text;
    const box = $('dlgActions');
    box.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.onclick = () => {
        $('dialog').hidden = true;
        resolve(a.value);
      };
      box.appendChild(b);
    }
    $('dialog').hidden = false;
  });
}

function setMode(m) {
  S.mode = m;
  app.dataset.mode = m;
}

function toLocal(site, lat, lon) {
  return [(lon - site.origin[1]) * site.k[0], (lat - site.origin[0]) * site.k[1]];
}

function lerpAngle(a, b, t) {
  return (a + turnDelta(a, b) * t + 360) % 360;
}

function clock(secFromNow) {
  const d = new Date(Date.now() + secFromNow * 1000);
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function routeBounds(route, from = 0) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  route.pts.forEach((p, i) => {
    if (route.cum[i] < from) return;
    b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])];
  });
  return b;
}

// ---------- Startseite: Platzauswahl ----------
async function loadSites() {
  await Promise.all(SITES.map(async (m) => {
    const r = await fetch(m.file);
    S.sites[m.id] = await r.json();
  }));
  const box = $('siteCards');
  for (const m of SITES) {
    const site = S.sites[m.id];
    const b = document.createElement('button');
    b.className = 'site-card';
    b.innerHTML = `${thumbSVG(site)}<div><b>${m.title}</b><span>${m.sub}</span>` +
      `<span>${(netLength(site) / 1000).toFixed(1).replace('.', ',')} km Übungsstrecke${site.edges.some((e) => e.r) ? ' · Kreisverkehr' : ''}</span>` +
      `<span class="dist" data-dist="${m.id}"></span></div>`;
    b.onclick = () => selectSite(m.id);
    box.appendChild(b);
  }
  // Entfernung anzeigen, falls GPS schon erlaubt ist
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' });
    if (perm?.state === 'granted') startWatch();
  } catch { /* egal */ }
}

function netLength(site) {
  let L = 0;
  for (const e of site.edges) for (let i = 1; i < e.p.length; i++) L += dist(site.nodes[e.p[i - 1]], site.nodes[e.p[i]]);
  return L;
}

function thumbSVG(site) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const q of site.boundary) {
    minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]);
    miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]);
  }
  const pad = 15, w = maxx - minx + 2 * pad, h = maxy - miny + 2 * pad, s = Math.max(w, h);
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const path = site.edges.map((e) => 'M' + e.p.map((i) => `${site.nodes[i][0].toFixed(0)} ${(-site.nodes[i][1]).toFixed(0)}`).join('L')).join('');
  const veg = site.polys.filter((p) => ['forest', 'grass', 'vineyard', 'scrub'].includes(p.t))
    .map((p) => 'M' + p.p.map((q) => `${q[0].toFixed(0)} ${(-q[1]).toFixed(0)}`).join('L') + 'Z').join('');
  return `<svg class="thumb" viewBox="${cx - s / 2} ${-cy - s / 2} ${s} ${s}">` +
    `<path d="${veg}" fill="#CFE8C3"/>` +
    `<path d="${path}" fill="none" stroke="#B8BCC2" stroke-width="${s / 22}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${path}" fill="none" stroke="#fff" stroke-width="${s / 34}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${path}" fill="none" stroke="#1A73E8" stroke-width="${s / 90}" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/></svg>`;
}

function updateSiteDistances() {
  if (!S.gps?.ll) return;
  for (const m of SITES) {
    const el = document.querySelector(`[data-dist="${m.id}"]`);
    if (!el) continue;
    const site = S.sites[m.id];
    const p = toLocal(site, S.gps.ll[0], S.gps.ll[1]);
    const d = Math.hypot(p[0], p[1]);
    el.textContent = d < 400 ? '📍 Du bist hier!' : `${fmtDist(d)} entfernt`;
  }
}

function selectSite(id) {
  const site = S.sites[id];
  S.site = site;
  S.meta = SITES.find((m) => m.id === id);
  S.graph = new Graph(site);
  store.set('site', id);
  view.setSite(site);
  $('searchText').textContent = S.meta.sub;
  $('limit').textContent = site.maxspeed;
  setMode('plan');
  S.free = false;
  planRoute();
  // vorher alles zeigen, dann auf Route zoomen
  if (!view.site || !S.camTarget) Object.assign(view.cam, view.fit(view.bounds, planPad()));
}

$('btnBack').onclick = () => {
  setMode('pick');
  $('searchText').textContent = 'Übungsplatz wählen';
  S.route = null;
};

// ---------- Planung ----------
function planPad() {
  const sheet = $('sheetPlan').getBoundingClientRect();
  return { top: 80, bottom: Math.min(window.innerHeight * 0.75, sheet.height || 420) + 16, left: 28, right: 28 };
}

function startArcFor(p = null, heading = null) {
  const g = S.graph;
  if (p) return g.nearestArc(p, heading);
  const all = g.out.get(S.site.start) || [];
  const outs = all.filter((a) => !g.arcs[a].intoSpur);
  const pick = outs.length ? outs : all;
  return { arc: pick[S.seed % pick.length], s: 0 };
}

function makeRoute(startP = null, heading = null) {
  const g = S.graph;
  const st = startArcFor(startP, heading);
  return g.randomRoute({ startArc: st.arc, startS: st.s, goal: S.site.start, targetSec: S.minutes * 60, seed: S.seed });
}

function planRoute() {
  const onSite = S.gps && S.src === 'gps' && gpsOnSite();
  S.route = makeRoute(onSite ? S.gps.p : null, onSite ? S.gps.heading : null);
  S.plannedAt = onSite ? S.gps.p : null;
  const r = S.route;
  $('planTime').textContent = fmtMin(r.totalTime);
  $('planDist').textContent = `(${fmtDist(r.length)})`;
  $('planSub').textContent = `Übungsroute #${S.seed} · Ziel: ${S.meta.dest}`;
  const st = r.stats();
  const chip = (icon, text) => `<span class="chip">${icon}${text}</span>`;
  const ic = (m) => maneuverSVG(m, 18);
  $('planStats').innerHTML = [
    st.left && chip(ic({ type: 'turn', mod: 'left' }), `${st.left}× links`),
    st.right && chip(ic({ type: 'turn', mod: 'right' }), `${st.right}× rechts`),
    st.straight && chip(ic({ type: 'turn', mod: 'straight' }), `${st.straight}× geradeaus`),
    st.roundabout && chip(ic({ type: 'roundabout', angle: 90 }), `${st.roundabout}× Kreisel`),
    st.uturn && chip(ic({ type: 'uturn' }), `${st.uturn}× wenden`),
    chip('🗺️ ', `${Math.round(st.coverage * 100)} % des Platzes`),
  ].filter(Boolean).join('');
  if (!S.free) S.camTarget = view.fit(routeBounds(r), planPad());
}

const slider = $('duration');
function syncSlider() {
  slider.value = S.minutes;
  $('durationVal').textContent = S.minutes + ' Min.';
  slider.style.setProperty('--p', ((S.minutes - slider.min) / (slider.max - slider.min)) * 100 + '%');
}
let sliderTimer;
slider.oninput = () => {
  S.minutes = +slider.value;
  store.set('minutes', S.minutes);
  syncSlider();
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(planRoute, 80);
};
syncSlider();

$('btnDice').onclick = () => {
  S.seed = 1 + Math.floor(Math.random() * 9999);
  store.set('seed', S.seed);
  S.free = false;
  planRoute();
  const b = $('btnDice');
  b.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 450 });
};

document.querySelectorAll('.seg-btn').forEach((b) => {
  b.onclick = () => {
    S.src = b.dataset.src;
    store.set('src', S.src);
    syncSrc();
    if (S.src === 'gps') startWatch();
    planRoute();
  };
});
function syncSrc() {
  document.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.dataset.src === S.src;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
}
syncSrc();

$('btnPreview').onclick = () => {
  const r = S.route;
  const rows = r.maneuvers.map((m) => {
    const t = bannerText(m, S.meta.dest);
    return `<div style="display:flex;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)">` +
      `<span style="color:var(--text)">${maneuverSVG(m, 28)}</span><div style="flex:1"><div style="color:var(--text)">${t.sub}</div>` +
      `<div class="small">${t.main} · ${fmtDist(m.s)}</div></div></div>`;
  }).join('');
  dialog(`Schritte (${r.maneuvers.length})`, `<div style="max-height:55vh;overflow:auto">${rows}</div>`, [{ label: 'Schließen', value: 0 }]);
};

// ---------- GPS ----------
function gpsOnSite() {
  if (!S.gps || !S.site) return false;
  const p = toLocal(S.site, S.gps.ll[0], S.gps.ll[1]);
  const [x0, y0, x1, y1] = view.bounds;
  return p[0] > x0 - 150 && p[0] < x1 + 150 && p[1] > y0 - 150 && p[1] < y1 + 150;
}

function startWatch() {
  if (S.watchId != null || !navigator.geolocation) return;
  S.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
  });
}

function onPosition(pos) {
  const c = pos.coords;
  const ll = [c.latitude, c.longitude];
  const p = S.site ? toLocal(S.site, ll[0], ll[1]) : null;
  let heading = Number.isFinite(c.heading) && (c.speed || 0) > 0.8 ? c.heading : null;
  const prev = S.gps;
  let speed = Number.isFinite(c.speed) ? c.speed : null;
  if (prev && prev.p && p) {
    const d = dist(prev.p, p);
    const dt = (pos.timestamp - prev.t) / 1000;
    if (heading == null && d > 2.5) heading = bearing(prev.p, p);
    if (speed == null && dt > 0) speed = d / dt;
  }
  if (heading == null && prev) heading = prev.heading;
  S.gps = { ll, p, heading, speed: speed || 0, acc: c.accuracy, t: pos.timestamp };
  updateSiteDistances();
  // In der Planung: Route ab dem eigenen Standort, sobald man auf dem Platz ist
  if (S.mode === 'plan' && S.src === 'gps' && gpsOnSite() && (!S.plannedAt || dist(S.plannedAt, p) > 25)) planRoute();
  if (S.nav && !S.nav.sim && p) handleFix({ p, heading, speed: S.gps.speed, acc: c.accuracy });
}

function onPositionError(err) {
  if (err.code === 1) toast('Standortzugriff verweigert – bitte in den Browser-Einstellungen erlauben.', 4000);
  else if (err.code === 2 && S.nav && !S.nav.sim) toast('GPS-Signal fehlt');
}

function firstFix(timeout = 12000) {
  return new Promise((resolve) => {
    if (S.gps && Date.now() - S.gps.t < 5000) return resolve(S.gps);
    startWatch();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (S.gps && S.gps.t > t0 - 5000) {
        clearInterval(iv);
        resolve(S.gps);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(null);
      }
    }, 200);
  });
}

// ---------- Navigation ----------
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* nicht unterstützt */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.nav) keepAwake();
});

$('btnStart').onclick = async () => {
  voice.unlock();
  if (S.src === 'gps') {
    toast('Suche GPS-Signal …', 3000);
    const fix = await firstFix();
    if (!fix) {
      const v = await dialog('Kein GPS-Signal', 'Die Position konnte nicht ermittelt werden. Ist die Standortfreigabe für diese Seite erlaubt?',
        [{ label: 'Abbrechen', value: 0 }, { label: 'Simulation starten', value: 1, primary: true }]);
      if (v) startNav(true);
      return;
    }
    S.gps.p = toLocal(S.site, fix.ll[0], fix.ll[1]);
    if (!gpsOnSite()) {
      const d = Math.hypot(...S.gps.p);
      const v = await dialog('Nicht auf dem Platz',
        `Du bist etwa <b>${fmtDist(d)}</b> vom ${S.meta.title}er Übungsplatz entfernt. Mit GPS navigieren geht erst vor Ort – bis dahin kannst du die Route in der Simulation abfahren.`,
        [{ label: 'Abbrechen', value: 0 }, { label: 'Simulation starten', value: 1, primary: true }]);
      if (v) startNav(true);
      return;
    }
    S.route = makeRoute(S.gps.p, S.gps.heading);
    startNav(false);
  } else {
    startNav(true);
  }
};

function startNav(sim) {
  const r = S.route;
  S.nav = {
    sim: sim ? new Simulator(r) : null,
    route: r,
    tracker: new Tracker(r),
    fix: null,
    res: { s: 0, onRoute: true },
    dispS: 0,
    dispP: r.pts[0],
    dispH: r.maneuvers[0].b,
    speed: 0,
    t0: performance.now(),
    spoken: new Map(),
    nextIdx: -1,
    overview: false,
    driven: 0,
    lastP: null,
    scale: 5.4,
    rerouting: 0,
    pace: 1,
  };
  app.classList.toggle('sim', !!sim);
  setMode('nav');
  S.free = false;
  $('btnRecenter').hidden = true;
  $('reroute').hidden = true;
  view.anchor.fy = 0.68;
  Object.assign(view.cam, { x: r.pts[0][0], y: r.pts[0][1], heading: S.nav.dispH });
  keepAwake();
  if (!sim) startWatch();
  // Startansage
  const m0 = r.maneuvers[0], m1 = r.maneuvers[1];
  voice.say(speech(m0, null, S.meta.dest, m1 && m1.s < 60 ? m1 : null));
  if (m1 && m1.s < 60) S.nav.spoken.set(1, { far: true, near: false });
}

function handleFix(fix) {
  const n = S.nav;
  if (!n || n.arrived) return;
  n.fix = { ...fix, t: performance.now() };
  n.speed = fix.speed || 0;
  if (n.lastP) {
    const d = dist(n.lastP, fix.p);
    if (d > 0.3 && d < 50) n.driven += d;
  }
  n.lastP = fix.p;
  n.res = n.tracker.update(fix);
  if (!n.sim && n.tracker.off >= 3 && performance.now() - n.rerouting > 6000) doReroute(fix);
}

function doReroute(fix) {
  const n = S.nav;
  n.rerouting = performance.now();
  const nr = reroute(S.graph, n.route, n.res.s, fix.p, fix.heading);
  if (!nr) return;
  $('reroute').hidden = false;
  setTimeout(() => ($('reroute').hidden = true), 1800);
  voice.say('Route wird neu berechnet.');
  n.route = nr;
  n.tracker = new Tracker(nr);
  n.res = n.tracker.update(fix);
  n.dispS = n.res.s;
  n.spoken = new Map();
  n.nextIdx = -1;
}

function nextManeuverIndex(r, s) {
  for (let i = 1; i < r.maneuvers.length; i++) if (r.maneuvers[i].s > s + 1.5) return i;
  return r.maneuvers.length - 1;
}

function navFrame(dt, now) {
  const n = S.nav;
  if (n.sim) {
    const f = n.sim.step(dt);
    if (f) handleFix(f);
    else n.speed = 0;
  }
  const r = n.route;
  // Anzeige-Position glätten (GPS: zwischen den Fixes vorausrechnen)
  if (n.res.onRoute) {
    let target = n.res.s;
    if (!n.sim && n.fix) target += n.speed * Math.min(1.2, (now - n.fix.t) / 1000);
    target = Math.min(r.length, target);
    n.dispS += (target - n.dispS) * Math.min(1, dt * (n.sim ? 12 : 4));
    const a = r.pointAt(n.dispS);
    n.dispP = a.pt;
    const look = bearing(r.pointAt(n.dispS - 2).pt, r.pointAt(n.dispS + 6).pt);
    n.dispH = lerpAngle(n.dispH, look, Math.min(1, dt * 4));
  } else if (n.fix) {
    n.dispP = [n.dispP[0] + (n.fix.p[0] - n.dispP[0]) * Math.min(1, dt * 4), n.dispP[1] + (n.fix.p[1] - n.dispP[1]) * Math.min(1, dt * 4)];
    if (n.fix.heading != null) n.dispH = lerpAngle(n.dispH, n.fix.heading, Math.min(1, dt * 3));
  }

  const idx = nextManeuverIndex(r, n.dispS);
  const m = r.maneuvers[idx];
  const d = m.s - n.dispS;

  // Kamera
  if (!S.free && !n.overview) {
    const near = d < 70 && m.type !== 'arrive';
    const want = near ? 6.2 : n.speed > 5 ? 4.6 : 5.4;
    n.scale += (want - n.scale) * Math.min(1, dt * 1.5);
    S.camTarget = null;
    const c = view.cam;
    c.x = n.dispP[0];
    c.y = n.dispP[1];
    c.heading = n.dispH;
    c.scale = n.scale;
    c.tilt += (view.maxTilt - c.tilt) * Math.min(1, dt * 3);
    view.anchor.fy += (0.68 - view.anchor.fy) * Math.min(1, dt * 3);
  }

  // Ansagen
  if (n.res.onRoute) speakLogic(r, idx, d);

  // Ankunft
  if (n.res.s >= r.length - 6 || (n.sim && n.sim.s >= r.length - 0.5)) {
    arrive();
    return;
  }

  // UI (gedrosselt)
  if (now - (n.uiT || 0) > 200 || idx !== n.nextIdx) {
    n.uiT = now;
    updateBanner(r, idx, d);
    const elapsed = (now - n.t0) / 1000;
    const modeled = r.totalTime - r.remainingTime(n.dispS);
    if (elapsed > 45 && modeled > 30) n.pace += (Math.max(0.7, Math.min(1.6, elapsed / modeled)) - n.pace) * 0.02;
    const rem = r.remainingTime(n.dispS) * n.pace;
    $('navTime').textContent = fmtMin(rem);
    $('navInfo').textContent = `${fmtDist(r.length - n.dispS)} · ${clock(rem)}`;
    const kmh = Math.round(n.speed * 3.6);
    $('speedVal').textContent = kmh;
    $('speed').classList.toggle('over', kmh > S.site.maxspeed + 2);
  }
}

function speakLogic(r, idx, d) {
  const n = S.nav;
  const m = r.maneuvers[idx];
  const flags = n.spoken.get(idx) || { far: false, near: false };
  n.spoken.set(idx, flags);
  const v = Math.max(n.speed, 3);
  const prevS = r.maneuvers[idx - 1]?.s ?? 0;
  const then = r.maneuvers[idx + 1] && r.maneuvers[idx + 1].s - m.s < 45 ? r.maneuvers[idx + 1] : null;
  if (!flags.far && !flags.near && d > 45 && d <= Math.max(75, v * 13) && m.s - prevS > 75) {
    flags.far = true;
    voice.say(speech(m, d, S.meta.dest));
  }
  if (!flags.near && d <= Math.max(16, v * 4)) {
    flags.near = true;
    flags.far = true;
    if (m.type === 'arrive') return; // kommt bei arrive()
    voice.say(speech(m, null, S.meta.dest, then));
  }
}

function updateBanner(r, idx, d) {
  const n = S.nav;
  const m = r.maneuvers[idx];
  const t = bannerText(m, S.meta.dest);
  if (idx !== n.nextIdx) {
    n.nextIdx = idx;
    $('bIcon').innerHTML = maneuverSVG(m, 56);
    $('bStreet').textContent = t.main;
    $('bSub').textContent = t.sub;
    $('banner').classList.remove('pulse');
    void $('banner').offsetWidth;
    $('banner').classList.add('pulse');
    const nx = r.maneuvers[idx + 1];
    if (nx && nx.s - m.s < 80) {
      $('bThen').hidden = false;
      $('bThen').innerHTML = `Dann ${maneuverSVG(nx, 24)}`;
    } else $('bThen').hidden = true;
  }
  $('bDist').textContent = fmtDist(d);
}

function arrive() {
  const n = S.nav;
  if (n.arrived) return;
  n.arrived = true;
  voice.say(speech({ type: 'arrive' }, null, S.meta.dest));
  const secs = (performance.now() - n.t0) / 1000 * (n.sim ? n.sim.mult : 1);
  const st = n.route.stats();
  $('arriveName').textContent = S.meta.dest + ' · ' + S.meta.sub;
  $('arriveStats').innerHTML =
    `<div><b>${fmtMin(secs).replace(' Min.', '')}</b><span>Minuten</span></div>` +
    `<div><b>${(Math.max(n.driven, n.route.length) / 1000).toFixed(1).replace('.', ',')}</b><span>km</span></div>` +
    `<div><b>${st.left + st.right + st.roundabout + st.uturn}</b><span>Manöver</span></div>`;
  const done = n.route;
  stopNav();
  setMode('arrive');
  S.free = false;
  S.camTarget = view.fit(routeBounds(done), { top: 40, bottom: 420, left: 28, right: 28 });
  confetti();
}

function stopNav() {
  S.nav = null;
  app.classList.remove('sim');
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  view.anchor.fy = 0.5;
}

$('btnStop').onclick = () => {
  speechSynthesis?.cancel?.();
  stopNav();
  setMode('plan');
  S.free = false;
  planRoute();
};
$('btnAgain').onclick = () => {
  S.seed = 1 + Math.floor(Math.random() * 9999);
  store.set('seed', S.seed);
  setMode('plan');
  S.free = false;
  planRoute();
};
$('btnDone').onclick = () => {
  setMode('plan');
  S.free = false;
  planRoute();
};

$('btnMute').onclick = () => {
  voice.enabled = !voice.enabled;
  $('btnMute').classList.toggle('muted', !voice.enabled);
  if (!voice.enabled) speechSynthesis?.cancel?.();
  toast(voice.enabled ? 'Sprachansagen an' : 'Sprachansagen aus');
};

function toggleOverview() {
  const n = S.nav;
  if (!n) return;
  n.overview = !n.overview;
  $('btnRecenter').hidden = !n.overview && !S.free;
  if (n.overview) {
    S.camTarget = view.fit(routeBounds(n.route, n.dispS), { top: 190, bottom: 120, left: 30, right: 80 });
  } else {
    S.free = false;
  }
}
$('btnOverview').onclick = toggleOverview;
$('btnAlt').onclick = toggleOverview;
$('btnRecenter').onclick = () => {
  if (S.nav) S.nav.overview = false;
  S.free = false;
  S.camTarget = null;
  $('btnRecenter').hidden = true;
};

document.querySelectorAll('.sim-ctrl button').forEach((b) => {
  b.onclick = () => {
    const sim = S.nav?.sim;
    if (!sim) return;
    if (b.dataset.pause) {
      sim.paused = !sim.paused;
      b.textContent = sim.paused ? '▶' : '⏸';
      return;
    }
    sim.mult = +b.dataset.mult;
    document.querySelectorAll('.sim-ctrl [data-mult]').forEach((x) => x.classList.toggle('active', x === b));
  };
});

function confetti() {
  const box = $('confetti');
  box.innerHTML = '';
  const colors = ['#4285F4', '#EA4335', '#FBBC04', '#34A853', '#A142F4', '#24C1E0'];
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('i');
    c.style.left = Math.random() * 100 + '%';
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', (Math.random() - 0.5) * 160 + 'px');
    c.style.setProperty('--r', (Math.random() * 900 - 450) + 'deg');
    c.style.animationDuration = 1.8 + Math.random() * 1.8 + 's';
    c.style.animationDelay = Math.random() * 0.6 + 's';
    box.appendChild(c);
  }
  setTimeout(() => (box.innerHTML = ''), 4500);
}

// ---------- Karten-Gesten (verschieben, zoomen) ----------
const pointers = new Map();
let gesture = null;
const mapEl = $('map');
mapEl.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  mapEl.setPointerCapture(e.pointerId);
  gesture = { pts: new Map(pointers), cam: { ...view.cam } };
});
mapEl.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const ids = [...pointers.keys()];
  const a0 = gesture.pts.get(ids[0]), a1 = pointers.get(ids[0]);
  if (!a0) return;
  const moved = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
  if (moved < 6 && ids.length === 1 && !S.free) return;
  enterFree();
  const c0 = gesture.cam;
  let scale = c0.scale;
  if (ids.length >= 2 && gesture.pts.get(ids[1])) {
    const b0 = gesture.pts.get(ids[1]), b1 = pointers.get(ids[1]);
    scale = Math.max(0.6, Math.min(12, c0.scale * Math.hypot(a1[0] - b1[0], a1[1] - b1[1]) / Math.max(10, Math.hypot(a0[0] - b0[0], a0[1] - b0[1]))));
  }
  const dx = a1[0] - a0[0], dy = a1[1] - a0[1];
  const h = (c0.heading * Math.PI) / 180;
  // Bildschirmverschiebung -> Weltverschiebung (Karte ist um heading gedreht)
  const wx = (dx * Math.cos(h) - dy * Math.sin(h)) / scale;
  const wy = (-dx * Math.sin(h) - dy * Math.cos(h)) / scale;
  Object.assign(view.cam, { x: c0.x - wx, y: c0.y - wy, scale });
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  gesture = pointers.size ? { pts: new Map(pointers), cam: { ...view.cam } } : null;
};
mapEl.addEventListener('pointerup', endPointer);
mapEl.addEventListener('pointercancel', endPointer);
mapEl.addEventListener('wheel', (e) => {
  enterFree();
  view.cam.scale = Math.max(0.6, Math.min(12, view.cam.scale * Math.exp(-e.deltaY * 0.0015)));
}, { passive: true });

function enterFree() {
  if (S.free) return;
  S.free = true;
  S.camTarget = null;
  if (S.nav) $('btnRecenter').hidden = false;
}

// ---------- Hauptschleife ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (S.site) {
    if (S.nav) navFrame(dt, now);
    // Kamerafahrt zu Ziel (Planung / Übersicht)
    const T = S.camTarget;
    if (T && !S.free) {
      const k = Math.min(1, dt * 4), c = view.cam;
      c.x += (T.x - c.x) * k;
      c.y += (T.y - c.y) * k;
      c.scale += (T.scale - c.scale) * k;
      c.tilt += (T.tilt - c.tilt) * k;
      c.heading = lerpAngle(c.heading, T.heading, k);
      if (T.fy) view.anchor.fy += (T.fy - view.anchor.fy) * k;
    } else if (!S.nav && view.cam.tilt > 0.05) {
      view.cam.tilt *= 1 - Math.min(1, dt * 4);
    }
    const n = S.nav;
    const me = n
      ? { p: n.dispP, heading: n.dispH }
      : S.gps && S.gps.p && S.src === 'gps' && gpsOnSite() ? { p: toLocal(S.site, ...S.gps.ll), heading: S.gps.heading, acc: S.gps.acc } : null;
    const route = n ? n.route : S.mode === 'plan' ? S.route : null;
    const nextM = n ? n.route.maneuvers[nextManeuverIndex(n.route, n.dispS)] : null;
    view.draw({
      mode: n ? 'nav' : 'plan',
      route,
      progress: n ? n.dispS : 0,
      nearLen: n ? Math.max(250, (nextM ? nextM.s - n.dispS : 0) + 120) : undefined,
      nextManeuver: nextM,
      me,
      dest: S.site.nodes[S.site.start],
    });
  }
  requestAnimationFrame(frame);
}

// ---------- Start ----------
loadSites().then(() => {
  const last = store.get('site', null);
  if (last && S.sites[last]) {
    selectSite(last);
  } else {
    const site = S.sites[SITES[0].id];
    view.setSite(site);
    S.site = site;
    Object.assign(view.cam, view.fit(view.bounds, { top: 80, bottom: 380, left: 20, right: 20 }));
    view.anchor.fy = view.cam.fy;
  }
  requestAnimationFrame(frame);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Zum Testen in der Konsole
window.__vup = { S, view, planRoute };
