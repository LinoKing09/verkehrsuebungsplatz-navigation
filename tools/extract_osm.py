#!/usr/bin/env python3
"""Erzeugt die Kartendaten (data/<id>.json) der Verkehrsübungsplätze aus OpenStreetMap.

Aufruf:  python3 tools/extract_osm.py [cache-verzeichnis]
Lädt die Rohdaten über die OSM-API (api.openstreetmap.org/api/0.6/map) und
baut daraus Straßengraph, Kontext-Karte und Start-/Zielpunkt.
Daten © OpenStreetMap-Mitwirkende, ODbL.
"""
import json, math, os, sys, urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict

SITES = [
    {
        "id": "leonberg",
        "name": "ADAC Verkehrsübungsanlage am Solitude-Ring",
        "short": "Leonberg · Solitude-Ring",
        "area_way": "28728977",
        "start_way": "49184499",  # Start- und Zielturm
        "bbox": (9.0390, 48.7635, 9.0565, 48.7710),
        "maxspeed": 30,
        # Korrekturen vor Ort: OSM-Weg-ID -> Tags
        "overrides": {
            "28731474": {"oneway": "yes"},  # Rechts-vor-links-Weg: Einbahn aus dem Kreisel heraus
        },
        "names": ["Solitude-Ring", "Glemseck-Kurve", "Mahdentalweg", "Blinkerstraße", "Schulterblick-Allee",
                  "Kupplungsgasse", "Spiegelweg", "Vorfahrtsring", "Handbremsweg", "Zielturmstraße",
                  "Boxengasse", "Rechts-vor-links-Weg", "Parklückenstraße", "Lenkradallee", "Seewiesenweg",
                  "Rückwärtsgang-Gasse", "Toter-Winkel-Weg", "Bremspedalstraße", "Krummbachweg",
                  "Haarnadelgasse", "Warnblinkerweg", "Spurwechselstraße", "Fahrschulgasse", "Hupenweg"],
    },
    {
        "id": "heilbronn",
        "name": "Verkehrsübungsplatz am Wartberg",
        "short": "Heilbronn · Wartberg",
        "area_way": "24815584",
        "start_way": "59421553",  # Langer Zug 1
        "bbox": (9.2505, 49.1578, 9.2602, 49.1645),
        "maxspeed": 30,
        "names": ["Wartbergsteige", "Anfahrberg", "Weinbergweg", "Trollingerstraße", "Blinkerstraße",
                  "Schulterblick-Allee", "Kupplungsgasse", "Spiegelweg", "Handbremsweg", "Rebenweg",
                  "Rechts-vor-links-Weg", "Parklückenstraße", "Lenkradallee", "Wengerterweg",
                  "Rückwärtsgang-Gasse", "Toter-Winkel-Weg", "Bremspedalstraße", "Kelterweg",
                  "Serpentinengasse", "Warnblinkerweg", "Spurwechselstraße", "Fahrschulgasse", "Hupenweg"],
    },
]

DRIVABLE = {"service", "living_street", "residential", "unclassified", "tertiary"}
CONTEXT_ROADS = {"motorway": 5, "trunk": 5, "primary": 4, "secondary": 4, "tertiary": 3, "unclassified": 2,
                 "residential": 2, "living_street": 2, "service": 1, "track": 0, "path": -1, "footway": -1,
                 "cycleway": -1, "bridleway": -1, "steps": -1}


def fetch(site, cache):
    path = os.path.join(cache, site["id"] + ".osm")
    if not os.path.exists(path):
        url = "https://api.openstreetmap.org/api/0.6/map?bbox=%f,%f,%f,%f" % site["bbox"]
        req = urllib.request.Request(url, headers={"User-Agent": "vup-nav-extractor/1.0"})
        with urllib.request.urlopen(req, timeout=180) as r, open(path, "wb") as f:
            f.write(r.read())
    return ET.parse(path).getroot()


def poly_kind(t):
    if t.get("building"):
        return "building"
    if t.get("amenity") == "parking":
        return "parking"
    if t.get("highway") and t.get("area") == "yes":
        return "pavement"
    lu, nat = t.get("landuse"), t.get("natural")
    if lu == "forest" or nat == "wood":
        return "forest"
    if nat == "scrub":
        return "scrub"
    if lu == "vineyard":
        return "vineyard"
    if lu in ("grass", "meadow", "recreation_ground", "village_green") or nat == "grassland" or t.get("leisure") == "park":
        return "grass"
    if lu in ("farmland", "orchard", "allotments"):
        return "farmland"
    if nat == "water" or t.get("waterway") == "riverbank":
        return "water"
    if lu in ("residential", "commercial", "industrial"):
        return "urban"
    return None


def angle_diff(a, b):
    d = (b - a + 540) % 360 - 180
    return abs(d)


def build(site, cache):
    root = fetch(site, cache)
    raw = {n.get("id"): (float(n.get("lat")), float(n.get("lon"))) for n in root.iter("node")}
    ntags = {n.get("id"): {t.get("k"): t.get("v") for t in n.findall("tag")} for n in root.iter("node")}
    ways = {w.get("id"): ([nd.get("ref") for nd in w.findall("nd")], {t.get("k"): t.get("v") for t in w.findall("tag")})
            for w in root.iter("way")}

    for wid, tags in site.get("overrides", {}).items():
        nds, t = ways[wid]
        ways[wid] = (nds, dict(t, **tags))

    area = [raw[i] for i in ways[site["area_way"]][0]]
    lat0 = sum(p[0] for p in area) / len(area)
    lon0 = sum(p[1] for p in area) / len(area)
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110540

    def xy(nid):
        la, lo = raw[nid]
        return (round((lo - lon0) * kx, 1), round((la - lat0) * ky, 1))

    poly = [xy(i) for i in ways[site["area_way"]][0]]

    # Kleine geschlossene Fahrbahn-Ringe ohne Tag sind Kreisverkehre (z. B. Leonberg):
    # als junction=roundabout gegen den Uhrzeigersinn behandeln.
    for wid, (nds, t) in list(ways.items()):
        if t.get("highway") not in DRIVABLE or t.get("area") == "yes" or len(nds) < 5 or nds[0] != nds[-1]:
            continue
        pts = [xy(n) for n in nds if n in raw]
        if len(pts) != len(nds):
            continue
        ext = max(max(p[0] for p in pts) - min(p[0] for p in pts), max(p[1] for p in pts) - min(p[1] for p in pts))
        if ext > 50:
            continue
        area2 = sum(pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1] for i in range(len(pts) - 1))
        t = dict(t, junction="roundabout")
        ways[wid] = (nds if area2 > 0 else nds[::-1], t)

    def inside(p):
        x, y = p
        c = False
        for i in range(len(poly)):
            x1, y1 = poly[i]
            x2, y2 = poly[i - 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    # ---------- Straßengraph der Übungsanlage ----------
    drive_ways = {}
    for wid, (nds, t) in ways.items():
        hw = t.get("highway")
        if hw not in DRIVABLE or t.get("area") == "yes" or t.get("motor_vehicle") == "no":
            continue
        nds = [n for n in nds if n in raw]
        if any(inside(xy(n)) for n in nds):
            drive_ways[wid] = (nds, t)

    use = defaultdict(int)
    for nds, _ in drive_ways.values():
        for i, n in enumerate(nds):
            use[n] += 1 if 0 < i < len(nds) - 1 else 2  # Endpunkte zählen als Knoten
    is_vertex = {n for n, c in use.items() if c >= 2}

    edges = []  # dicts: a, b, pts(node ids), oneway, roundabout, way
    for wid, (nds, t) in drive_ways.items():
        ow = t.get("oneway") in ("yes", "1", "true") or t.get("junction") == "roundabout"
        rb = t.get("junction") == "roundabout"
        seg = [nds[0]]
        for n in nds[1:]:
            seg.append(n)
            if n in is_vertex:
                if len(seg) >= 2 and seg[0] != seg[-1]:
                    mid = seg[len(seg) // 2] if len(seg) > 2 else None
                    pm = xy(mid) if mid else ((xy(seg[0])[0] + xy(seg[-1])[0]) / 2, (xy(seg[0])[1] + xy(seg[-1])[1]) / 2)
                    if inside(pm):
                        edges.append({"a": seg[0], "b": seg[-1], "pts": seg, "oneway": ow, "rb": rb, "way": wid})
                seg = [n]

    # Größte stark zusammenhängende Komponente (Einbahnstraßen beachten)
    adj = defaultdict(list)
    radj = defaultdict(list)
    for e in edges:
        adj[e["a"]].append(e["b"]); radj[e["b"]].append(e["a"])
        if not e["oneway"]:
            adj[e["b"]].append(e["a"]); radj[e["a"]].append(e["b"])
    verts = set(adj) | set(radj)

    def reach(start, g):
        seen = {start}; st = [start]
        while st:
            v = st.pop()
            for w in g[v]:
                if w not in seen:
                    seen.add(w); st.append(w)
        return seen
    best = set()
    left = set(verts)
    while left:
        v = next(iter(left))
        comp = reach(v, adj) & reach(v, radj)
        left -= comp
        if len(comp) > len(best):
            best = comp
    edges = [e for e in edges if e["a"] in best and e["b"] in best]

    # Mehrfachkanten / Schleifen entfernen
    seen = set(); clean = []
    for e in edges:
        k = (e["a"], e["b"], len(e["pts"]))
        if k in seen:
            continue
        seen.add(k); clean.append(e)
    edges = clean

    # ---------- Straßennamen (verspielt): Kanten zu "Straßen" zusammenfassen ----------
    parent = list(range(len(edges)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i

    def bearing(p, q):
        return math.degrees(math.atan2(q[0] - p[0], q[1] - p[1])) % 360

    inc = defaultdict(list)  # node -> (edge idx, bearing leaving node along edge)
    for i, e in enumerate(edges):
        p = [xy(n) for n in e["pts"]]
        inc[e["a"]].append((i, bearing(p[0], p[1])))
        inc[e["b"]].append((i, bearing(p[-1], p[-2])))
    rb_root = None
    for i, e in enumerate(edges):
        if e["rb"]:
            if rb_root is None:
                rb_root = i
            parent[find(i)] = find(rb_root)
    for n, lst in inc.items():
        pairs = []
        for x in range(len(lst)):
            for y in range(x + 1, len(lst)):
                i, bi = lst[x]; j, bj = lst[y]
                if edges[i]["rb"] or edges[j]["rb"] or i == j:
                    continue
                dev = 180 - angle_diff(bi, bj)
                if dev < 40:
                    pairs.append((dev, i, j))
        pairs.sort()
        used = set()
        for dev, i, j in pairs:
            if i in used or j in used:
                continue
            used.add(i); used.add(j)
            parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i in range(len(edges)):
        groups[find(i)].append(i)
    def glen(g):
        s = 0
        for i in g:
            p = [xy(n) for n in edges[i]["pts"]]
            s += sum(math.dist(p[k], p[k + 1]) for k in range(len(p) - 1))
        return s
    order = sorted(groups.values(), key=lambda g: -glen(g))
    names = list(site["names"])
    street_of = {}
    for gi, g in enumerate(order):
        real = {drive_ways[edges[i]["way"]][1].get("name") for i in g} - {None}
        if any(edges[i]["rb"] for i in g):
            nm = "Kreisel " + site["short"].split(" · ")[1].split("-")[0]
        elif real:
            nm = sorted(real)[0]
        elif names:
            nm = names.pop(0)
        else:
            nm = "Übungsweg %d" % gi
        for i in g:
            street_of[i] = nm

    node_ids = sorted({n for e in edges for n in e["pts"]})
    idx = {n: k for k, n in enumerate(node_ids)}
    out_nodes = [list(xy(n)) for n in node_ids]
    out_edges = []
    for i, e in enumerate(edges):
        out_edges.append({
            "p": [idx[n] for n in e["pts"]],
            "o": 1 if e["oneway"] else 0,
            "r": 1 if e["rb"] else 0,
            "n": street_of[i],
            "l": int(drive_ways[e["way"]][1].get("lanes", "1") or 1) if (drive_ways[e["way"]][1].get("lanes", "1") or "1").isdigit() else 1,
        })

    pois = []
    for n in node_ids:
        t = ntags.get(n, {})
        hw = t.get("highway")
        if hw in ("traffic_signals", "stop", "give_way", "crossing"):
            pois.append({"t": hw, "n": idx[n]})
        if t.get("barrier") in ("gate", "lift_gate"):
            pois.append({"t": "gate", "n": idx[n]})

    # Start: Knoten nächst dem Start-Gebäude (Parkplatz / Zielturm)
    sp = [xy(n) for n in ways[site["start_way"]][0]]
    sc = (sum(p[0] for p in sp) / len(sp), sum(p[1] for p in sp) / len(sp))
    vert_idx = sorted({idx[e["a"]] for e in edges} | {idx[e["b"]] for e in edges})
    start = min(vert_idx, key=lambda k: math.dist(out_nodes[k], sc))

    # ---------- Kontext-Karte ----------
    bx0, by0, bx1, by1 = site["bbox"]
    def in_bbox(n):
        la, lo = raw[n]
        return by0 <= la <= by1 and bx0 <= lo <= bx1
    polys, lines = [], []
    drive_set = set(drive_ways)
    for wid, (nds, t) in ways.items():
        nds = [n for n in nds if n in raw]
        if len(nds) < 2 or not any(in_bbox(n) for n in nds) or wid == site["area_way"]:
            continue
        k = poly_kind(t)
        if k and nds[0] == nds[-1]:
            polys.append({"t": k, "p": [list(xy(n)) for n in nds]})
            continue
        hw = t.get("highway")
        if hw in CONTEXT_ROADS and t.get("area") != "yes":
            lines.append({"t": hw, "z": CONTEXT_ROADS[hw], "in": 1 if wid in drive_set else 0,
                          "n": t.get("name", ""), "p": [list(xy(n)) for n in nds]})
        elif t.get("waterway") in ("stream", "river", "ditch"):
            lines.append({"t": "water", "z": -2, "in": 0, "n": "", "p": [list(xy(n)) for n in nds]})
    # Rendering-Reihenfolge der Flächen
    zorder = ["urban", "farmland", "vineyard", "grass", "scrub", "forest", "water", "pavement", "parking", "building"]
    polys.sort(key=lambda p: zorder.index(p["t"]))
    lines.sort(key=lambda l: l["z"])

    return {
        "id": site["id"], "name": site["name"], "short": site["short"],
        "origin": [round(lat0, 7), round(lon0, 7)], "k": [round(kx, 3), ky],
        "maxspeed": site["maxspeed"], "boundary": poly, "start": start,
        "nodes": out_nodes, "edges": out_edges, "pois": pois,
        "polys": polys, "lines": lines,
        "attribution": "© OpenStreetMap-Mitwirkende (ODbL)",
    }


def main():
    cache = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vup-osm-cache"
    os.makedirs(cache, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    for site in SITES:
        d = build(site, cache)
        out = os.path.join(here, "..", "data", site["id"] + ".json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
        total = 0
        for e in d["edges"]:
            p = [d["nodes"][i] for i in e["p"]]
            total += sum(math.dist(p[k], p[k + 1]) for k in range(len(p) - 1))
        print("%s: %d Knoten, %d Kanten, %.0f m Straßennetz, %d Flächen, %d Linien, %d kB"
              % (site["id"], len(d["nodes"]), len(d["edges"]), total, len(d["polys"]), len(d["lines"]),
                 os.path.getsize(out) // 1024))
        print("  Straßen:", sorted({e["n"] for e in d["edges"]}))


if __name__ == "__main__":
    main()
