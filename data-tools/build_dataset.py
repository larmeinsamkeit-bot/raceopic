"""Join timing feeds and build the browser-size snapshot from the OpenF1 cache."""
from bisect import bisect_left
from collections import defaultdict
from datetime import datetime
import json
from math import hypot
from pathlib import Path
from statistics import median
import sys

EVENT_NAMES = {"bahrain": "巴林大奖赛", "silverstone": "英国大奖赛", "monza": "意大利大奖赛",
               "brazil": "圣保罗大奖赛", "monza-2026": "意大利大奖赛"}
DRY = ("HARD", "MEDIUM", "SOFT")
BINS = 180

def timestamp(value):
    return datetime.fromisoformat(value).timestamp()

def interp(xs, ys, x):
    right = bisect_left(xs, x)
    if right == 0:
        return ys[0]
    if right >= len(xs):
        return ys[-1]
    left = right - 1
    f = (x - xs[left]) / (xs[right] - xs[left])
    return ys[left] + f * (ys[right] - ys[left])

def neutral_periods(messages):
    """Use full-course messages only; a clear sector cannot end a neutralization."""
    start = None
    stopped = False
    resumed = False
    periods = []
    for row in sorted(messages, key=lambda r: timestamp(r["date"])):
        msg = row["message"].upper()
        flag = row.get("flag")
        when = timestamp(row["date"])
        red = flag == "RED" or msg == "SESSION ABORTED" or msg.startswith("RED FLAG - RACE SUSPENDED")
        deployed = msg in ("SAFETY CAR DEPLOYED", "VIRTUAL SAFETY CAR DEPLOYED", "VSC DEPLOYED")
        formation = msg == "EXTRA FORMATION LAP"
        if red or deployed or formation:
            start = start if start is not None else when
            if red or formation:
                stopped = True
                resumed = formation
            continue
        if start is None:
            continue
        if stopped and msg == "SESSION STARTED":
            resumed = True
        ordinary_green = row.get("scope") == "Track" and flag in ("GREEN", "CLEAR") and not stopped
        restart = stopped and resumed and msg in ("STANDING START", "ROLLING START")
        if ordinary_green or restart or msg == "OVERTAKE ENABLED":
            periods.append((start, when))
            start = None
            stopped = resumed = False
    if start is not None:
        periods.append((start, float("inf")))
    return periods

def race_rows(source):
    periods = neutral_periods(source["race_control"])
    stints = defaultdict(list)
    stops = defaultdict(dict)
    laps = defaultdict(list)
    for s in sorted(source["stints"], key=lambda row: row["stint_number"]):
        stints[s["driver_number"]].append({
            "start": s["lap_start"], "end": s["lap_end"], "compound": s["compound"],
            "age": s["tyre_age_at_start"], "number": s["stint_number"],
        })
    for p in source["pit"]:
        stops[p["driver_number"]][p["lap_number"]] = p.get("lane_duration") or p.get("pit_duration")
    for row in sorted(source["laps"], key=lambda r: r["lap_number"]):
        driver, number, duration = row["driver_number"], row["lap_number"], row["lap_duration"]
        stint = next((s for s in reversed(stints[driver]) if s["start"] <= number <= s["end"]), None)
        start = timestamp(row["date_start"]) if row.get("date_start") else None
        neutralized = bool(start and duration and any(start < end and start + duration > begin for begin, end in periods))
        reason = None
        if not duration or not start or not all(row.get(f"duration_sector_{i}") for i in (1, 2, 3)):
            reason = "缺失计时"
        elif number == 1:
            reason = "发车圈"
        elif number in stops[driver] or number + 1 in [s["start"] for s in stints[driver][1:]]:
            reason = "进站圈"
        elif row["is_pit_out_lap"] or number in [s["start"] for s in stints[driver][1:]]:
            reason = "出站圈"
        elif neutralized:
            reason = "全场减速"
        age = (stint["age"] + number - stint["start"] + 1
               if stint and stint["age"] is not None else None)
        laps[driver].append({
            "lap": number, "time": duration, "compound": stint["compound"] if stint else None,
            "age": age, "excluded": reason, "neutralized": neutralized,
            "sectors": [row.get(f"duration_sector_{i}") for i in (1, 2, 3)],
        })
    return laps, stints, stops

def solve(matrix, targets):
    """Solve the small weighted normal equation with partial pivoting."""
    size = len(targets)
    augmented = [row[:] + [t] for row, t in zip(matrix, targets)]
    for i in range(size):
        pivot = max(range(i, size), key=lambda k: abs(augmented[k][i]))
        if abs(augmented[pivot][i]) < 1e-9:
            return None
        augmented[i], augmented[pivot] = augmented[pivot], augmented[i]
        div = augmented[i][i]
        augmented[i] = [v / div for v in augmented[i]]
        for k in range(size):
            if k != i and augmented[k][i]:
                scale = augmented[k][i]
                augmented[k] = [a - scale * b for a, b in zip(augmented[k], augmented[i])]
    return [row[-1] for row in augmented]

def fit_pace(laps):
    # Race lap trend and per-compound tyre slope; driver offsets absorb pace differences.
    race_laps = max(row["lap"] for rows in laps.values() for row in rows)
    samples = []
    ages = defaultdict(list)
    for driver, rows in sorted(laps.items()):
        usable = [r for r in rows if not r["excluded"] and r["compound"] in DRY and r["age"] is not None]
        if len(usable) < 12:
            continue
        midpoint = median(r["time"] for r in usable)
        for row in usable:
            if abs(row["time"] - midpoint) <= 8:
                samples.append((driver, row))
                ages[row["compound"]].append(row["age"])
    compounds = [c for c in DRY if len(ages[c]) >= 25]
    samples = [(d, row) for d, row in samples if row["compound"] in compounds]
    if len(samples) < 120 or len(compounds) < 2:
        return None
    drivers = sorted({d for d, _ in samples})
    size = len(drivers) + 2 * len(compounds)
    features = []
    for driver, row in samples:
        compound = compounds.index(row["compound"])
        values = {drivers.index(driver): 1, len(drivers): row["lap"] / race_laps,
                  len(drivers) + len(compounds) + compound: row["age"] / race_laps}
        if compound:
            values[len(drivers) + compound] = 1
        features.append((list(values.items()), row["time"]))
    weights = [1] * len(samples)
    for _ in range(6):
        matrix = [[0.] * size for _ in range(size)]
        targets = [0.] * size
        for w, (values, y) in zip(weights, features):
            for i, a in values:
                targets[i] += w * a * y
                for j, b in values:
                    matrix[i][j] += w * a * b
        coefficients = solve(matrix, targets)
        if coefficients is None:
            return None
        residuals = [abs(y - sum(coefficients[i] * v for i, v in values)) for values, y in features]
        cutoff = max(.35, 1.5 * median(residuals))
        weights = [min(1, cutoff / max(.0001, r)) for r in residuals]
    offsets = [0] + coefficients[len(drivers) + 1:len(drivers) + len(compounds)]
    slopes = [c / race_laps for c in coefficients[-len(compounds):]]
    return {
        "count": len(samples), "drivers": len(drivers), "medianError": round(median(residuals), 3),
        "compounds": {c: {"offset": round(o, 5), "slope": round(s, 6), "maxAge": max(ages[c])}
                      for c, o, s in zip(compounds, offsets, slopes)},
    }

def raw_capture(capture):
    lap = capture["lap"]
    start = timestamp(lap["date_start"])
    duration = lap["lap_duration"]
    location = sorted({timestamp(row["date"]) - start: (row["x"], row["y"])
                       for row in capture["location"]
                       if row.get("x") is not None and row.get("y") is not None
                       and (row["x"] or row["y"])}.items())
    car = sorted({timestamp(row["date"]) - start: row for row in capture["car"]
                  if row.get("speed") is not None and row.get("throttle") is not None}.items())
    if not location or not car:
        return None
    if any(rows[0][0] > .35 or rows[-1][0] < duration - .35 for rows in (location, car)):
        return None
    xs = [t for t, _ in location]
    coords = [p for _, p in location]
    trimmed = [(t, *p) for t, p in location if 0 < t < duration]
    ends = [(t, *(interp(xs, [p[i] for p in coords], t) for i in (0, 1)))
            for t in (0, duration)]
    points = [ends[0], *trimmed, ends[1]]
    if len(points) < 100 or max(b[0] - a[0] for a, b in zip(points, points[1:])) > 1.4:
        return None
    return lap, points, car

def distance_along(points):
    distances = [0.]
    for a, b in zip(points, points[1:]):
        distances.append(distances[-1] + hypot(b[1] - a[1], b[2] - a[2]))
    return distances

def align(points, center, distances):
    """Project onto nearby reference segments, keeping the lap traversal monotonic."""
    aligned = []
    last = -1.
    for time, x, y in points:
        estimate = time / points[-1][0]
        nearest = None
        for i, (a, b) in enumerate(zip(center, center[1:])):
            if abs(distances[i] - estimate) > .16:
                continue
            dx, dy = b[1] - a[1], b[2] - a[2]
            divisor = dx * dx + dy * dy
            if not divisor:
                continue
            fraction = max(0, min(1, ((x - a[1]) * dx + (y - a[2]) * dy) / divisor))
            error = hypot(a[1] + fraction * dx - x, a[2] + fraction * dy - y)
            progress = distances[i] + fraction * (distances[i + 1] - distances[i])
            if nearest is None or error < nearest[0]:
                nearest = (error, progress)
        if nearest and nearest[1] > last + .00001:
            last = nearest[1]
            aligned.append((last, time, x, y))
    if not aligned or aligned[0][0] > .035 or aligned[-1][0] < .965:
        return []
    return aligned

def telemetry_data(source):
    raw = {d: [r for item in entries if (r := raw_capture(item)) is not None]
           for d, entries in source["telemetry"].items()}
    return build_telemetry(raw)


def build_telemetry(raw, *, consensus=False):
    available = [r for entries in raw.values() for r in entries]
    if not available:
        raise ValueError("No complete telemetry available")
    if consensus:
        def reference_score(capture):
            lap, points, _ = capture
            radius = .025 * distance_along(points)[-1]
            # Some timing clocks place the nominal finish away from the rest of the grid.
            # Only combine traces that agree on the start and finish locations.
            def nearby(other):
                return all(hypot(points[i][1] - other[i][1], points[i][2] - other[i][2]) <= radius
                           for i in (0, -1))
            support = sum(any(nearby(other) for _, other, _ in entries) for entries in raw.values())
            return -support, lap["lap_duration"]
        reference_lap, center, _ = min(available, key=reference_score)
    else:
        reference_lap, center, _ = min(available, key=lambda r: r[0]["lap_duration"])
    cumulative = distance_along(center)
    if not cumulative[-1]:
        raise ValueError("Invalid reference position trace")
    distances = [d / cumulative[-1] for d in cumulative]
    center_times = [p[0] for p in center]
    first = reference_lap["duration_sector_1"]
    second = first + reference_lap["duration_sector_2"]
    cuts = [round(interp(center_times, distances, t) * BINS) for t in (first, second)]
    width = max(p[1] for p in center) - min(p[1] for p in center)
    height = max(p[2] for p in center) - min(p[2] for p in center)
    scale = max(width, height)
    mx = (max(p[1] for p in center) + min(p[1] for p in center)) / 2
    my = (max(p[2] for p in center) + min(p[2] for p in center)) / 2
    def xy(x, y):
        return [round((x - mx) * 1000 / scale, 2), round((my - y) * 1000 / scale, 2)]

    positions = [i / BINS for i in range(BINS + 1)]
    reference = [xy(interp(distances, [p[1] for p in center], fraction),
                    interp(distances, [p[2] for p in center], fraction)) for fraction in positions]
    result = defaultdict(list)
    for driver, captures in raw.items():
        captures = sorted(captures, key=lambda capture: capture[0]["lap_duration"])
        for lap, points, car in captures:
            aligned = align(points, center, distances)
            if not aligned:
                continue
            progress, times, xx, yy = map(list, zip(*aligned))
            car_times, car_rows = map(list, zip(*car))
            speed = [r["speed"] for r in car_rows]
            throttle = [r["throttle"] for r in car_rows]
            samples = []
            for fraction in positions:
                time = interp(progress, times, fraction)
                elapsed = 0 if fraction == 0 else lap["lap_duration"] if fraction == 1 else time
                index = min(len(car_times) - 1, bisect_left(car_times, time))
                if index and abs(car_times[index - 1] - time) < abs(car_times[index] - time):
                    index -= 1
                samples.append([*xy(interp(progress, xx, fraction), interp(progress, yy, fraction)),
                                round(interp(car_times, speed, time), 1),
                                round(interp(car_times, throttle, time)), bool(car_rows[index].get("brake")),
                                round(elapsed, 3)])
            result[driver].append({
                "lap": lap["lap_number"], "time": lap["lap_duration"], "samples": samples,
                "sectors": [lap[f"duration_sector_{i}"] for i in (1, 2, 3)],
                "positionSamples": len(points), "carSamples": sum(0 <= t <= lap["lap_duration"] for t in car_times),
            })
    if len(result) < 2:
        raise ValueError("Need at least two aligned drivers")
    return {"reference": reference, "cuts": cuts, "laps": result}

def build(slug, source, *, name=None, telemetry=None):
    laps, stints, stops = race_rows(source)
    roster = {r["driver_number"]: r for r in source["drivers"]}
    telemetry = telemetry if telemetry is not None else telemetry_data(source)
    drivers = [{
        "id": d, "code": roster[d]["name_acronym"], "name": roster[d]["full_name"],
        "surname": roster[d]["last_name"], "team": roster[d]["team_name"],
        "teamColour": roster[d].get("team_colour"), "laps": laps[d], "stints": stints[d], "pit": stops[d],
    } for d in source["drivers_selected"] if d in roster and (laps[d] or str(d) in telemetry["laps"])]
    wet = any(s["compound"] in ("INTERMEDIATE", "WET") for entries in stints.values() for s in entries)
    return {
        "id": slug, "wet": wet, "name": name or EVENT_NAMES[slug], "year": source["race"]["year"],
        "circuit": source["race"]["circuit_short_name"],
        "raceKey": source["race"]["session_key"], "qualiKey": source["quali"]["session_key"],
        "totalLaps": max(row["lap"] for rows in laps.values() for row in rows),
        "sourceLaps": sum(len(rows) for rows in laps.values()),
        "drivers": drivers, "telemetry": telemetry,
        "paceModel": None if wet else fit_pace(laps),
    }

INDEX_FIELDS = ("id", "name", "year", "circuit", "raceKey", "wet")

def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")

if __name__ == "__main__":
    # Writes one file per past event plus a small index, so the page loads a race only when it is picked.
    cache, output = map(Path, sys.argv[1:3])
    sources = [cache, *map(Path, sys.argv[3:])]
    files = {slug: next((folder / f"{slug}.json" for folder in sources
                         if (folder / f"{slug}.json").exists()), None) for slug in EVENT_NAMES}
    events = [build(slug, json.loads(path.read_text())) for slug, path in files.items() if path]
    # 2026 rounds come from build_season_lab.py (dist/lab-2026); only earlier seasons belong here.
    events = [event for event in events if event["year"] < 2026]
    if not events:
        raise SystemExit("No complete OpenF1 downloads for past seasons")
    output.mkdir(parents=True, exist_ok=True)
    for event in events:
        write_json(output / f"{event['id']}.json", event)
        print(event["name"], event["year"], event["sourceLaps"], len(event["drivers"]),
              {d: len(rows) for d, rows in event["telemetry"]["laps"].items()},
              event["paceModel"])
    # Events already in the folder but not in these caches are kept, so one race can be added
    # without re-fetching every other event's telemetry.
    entries = []
    for path in sorted(output.glob("*.json")):
        if path.name == "index.json":
            continue
        event = json.loads(path.read_text())
        entries.append({key: event[key] for key in INDEX_FIELDS})
    entries.sort(key=lambda entry: -entry["raceKey"])
    write_json(output / "index.json", entries)
    print("index:", ", ".join(entry["id"] for entry in entries))
