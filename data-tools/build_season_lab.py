"""Build one laboratory dataset per completed 2026 Grand Prix."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.client import IncompleteRead
import gzip
import hashlib
import json
from pathlib import Path
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from build_dataset import build, build_telemetry, interp

API = "https://f1archive.org/api/v1"
NS = 1_000_000_000
NAMES = {
    "australian": "澳大利亚", "chinese": "中国", "japanese": "日本", "miami": "迈阿密",
    "canadian": "加拿大", "monaco": "摩纳哥", "barcelona": "巴塞罗那", "austrian": "奥地利",
    "british": "英国", "belgian": "比利时", "hungarian": "匈牙利", "dutch": "荷兰",
    "italian": "意大利", "spanish": "西班牙", "azerbaijan": "阿塞拜疆", "bahrain": "巴林（马来西亚）",
    "singapore": "新加坡", "united-states": "美国", "mexico-city": "墨西哥城", "sao-paulo": "巴西",
    "las-vegas": "拉斯维加斯", "qatar": "卡塔尔", "abu-dhabi": "阿布扎比",
}

def read(path):
    return json.loads(path.read_text())

def get(cache, route, **params):
    address = API + route + ("?" + urlencode(params) if params else "")
    key = hashlib.sha256(address.encode()).hexdigest()[:24]
    cached = cache / f"{key}.json.gz"
    if cached.exists():
        return json.loads(gzip.decompress(cached.read_bytes()))
    for attempt in range(5):
        try:
            request = Request(address, headers={"Accept-Encoding": "gzip", "User-Agent": "Raceopic telemetry archive"})
            with urlopen(request, timeout=45) as response:
                payload = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    payload = gzip.decompress(payload)
            data = json.loads(payload)
            cached.write_bytes(gzip.compress(payload, compresslevel=3))
            return data
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
            sleep(int(error.headers.get("Retry-After", 2)) if error.code == 429 else 2 * (attempt + 1))
        except (URLError, TimeoutError, IncompleteRead, ConnectionError):
            # Long telemetry transfers are occasionally cut off mid-stream; the next try usually completes.
            if attempt == 4:
                raise
            sleep(2 * (attempt + 1))

def write(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    temp.replace(path)

def timed(lap):
    start, end, length = (lap.get(field) for field in ("start_ns", "end_ns", "lap_time_ns"))
    sectors = [lap.get(f"s{i}_ns") for i in (1, 2, 3)]
    return (isinstance(start, int) and isinstance(end, int) and isinstance(length, int)
            and start < end and all(sectors) and abs(sum(sectors) - length) < .12 * NS
            and abs(end - start - length) < .4 * NS and not lap["deleted"]
            and lap["pit_in_ns"] is None and lap["pit_out_ns"] is None)

def capture(lap, trace):
    if not trace:
        return None
    start, end = lap["start_ns"], lap["end_ns"]
    length = lap["lap_time_ns"] / NS
    def relative(t):
        return (t - start) * length / (end - start)
    location = []
    car = []
    last_xy = None
    for t, x, y, speed, throttle, brake in zip(*(trace[field] for field in
                                                  ("ts_ns", "x", "y", "speed", "throttle", "brake"))):
        if t < start - 2 * NS:
            continue
        if t > end + 2 * NS:
            break
        second = relative(t)
        if x is not None and y is not None and (x or y) and (x, y) != last_xy:
            location.append((second, x, y))
            last_xy = (x, y)
        if speed is not None and throttle is not None:
            sample = {"speed": speed, "throttle": throttle, "brake": brake}
            if not car or second > car[-1][0]:
                car.append((second, sample))
    if any(not rows or rows[0][0] > .4 or rows[-1][0] < length - .4 for rows in (location, car)):
        return None
    ts, x, y = map(list, zip(*location))
    points = [(0., interp(ts, x, 0), interp(ts, y, 0))]
    points.extend(p for p in location if 0 < p[0] < length)
    points.append((length, interp(ts, x, length), interp(ts, y, length)))
    if len(points) < 100 or max(b[0] - a[0] for a, b in zip(points, points[1:])) > 1.4:
        return None
    timing = {"lap_number": lap["lap"], "lap_duration": length}
    timing.update({f"duration_sector_{i}": round(lap[f"s{i}_ns"] / NS, 3) for i in (1, 2, 3)})
    return timing, points, car

def group_by_window(laps):
    group = []
    used = set()
    for lap in sorted(laps, key=lambda row: row["start_ns"]):
        if group and (len(used | {lap["driver"]}) > 6 or
                      lap["end_ns"] - group[0]["start_ns"] > 420 * NS):
            yield group
            group = []
            used = set()
        group.append(lap)
        used.add(lap["driver"])
    if group:
        yield group

def telemetry_for(cache, route, roster, laps_per_driver=4):
    laps = get(cache, route + "/laps")
    candidates = {str(number): [] for number in roster}
    for lap in laps:
        if lap["driver"] in candidates and timed(lap):
            candidates[lap["driver"]].append(lap)
    for choices in candidates.values():
        choices.sort(key=lambda row: (not row["is_accurate"], row["lap_time_ns"]))
    raw = {number: [] for number in candidates}
    attempted = set()

    def capture_laps(selection):
        for group in group_by_window(selection):
            drivers = sorted({lap["driver"] for lap in group})
            payload = get(cache, route + "/telemetry",
                          drivers=",".join(drivers),
                          from_ns=max(0, min(lap["start_ns"] for lap in group) - 2 * NS),
                          to_ns=max(lap["end_ns"] for lap in group) + 2 * NS,
                          channels="x,y,speed,throttle,brake")
            if payload["truncated"]:
                raise RuntimeError(f"Unexpected truncated telemetry window: {route}")
            for lap in group:
                number = lap["driver"]
                attempted.add((number, lap["lap"]))
                value = capture(lap, payload["drivers"].get(number))
                if value is not None:
                    raw[number].append(value)

    # Fastest clean laps first; top up from slower candidates when a lap fails to capture.
    capture_laps([lap for choices in candidates.values() for lap in choices[:laps_per_driver]])
    top_up = [lap for number, choices in candidates.items()
              for lap in [c for c in choices if (number, c["lap"]) not in attempted][:laps_per_driver - len(raw[number])]
              if len(raw[number]) < laps_per_driver]
    if top_up:
        capture_laps(top_up)
    result = build_telemetry(raw, consensus=True)
    retry = [lap for number, choices in candidates.items() if not result["laps"].get(number)
             for lap in [candidate for candidate in choices if (number, candidate["lap"]) not in attempted][:2]]
    if retry:
        capture_laps(retry)
        result = build_telemetry(raw, consensus=True)
    return result

def season_data(cache, dist, rounds, laps_per_driver=4):
    snapshot = read(dist / "season-2026.json")
    archive = read(dist / "archive-2026.json")
    catalogue = get(cache, "/seasons/2026")
    selected_rounds = [row for row in snapshot["rounds"] if str(row["round"]) in snapshot["snapshots"]]
    output = dist / "lab-2026"
    output.mkdir(exist_ok=True)
    known = {event["round"]: event for event in catalogue["events"] if not event["is_testing"]}

    def process(round_data):
        round_no = round_data["round"]
        event = known[round_no]
        quali = next(s for s in event["sessions"] if s["kind"] == "qualifying" and s["has_telemetry"])
        records = [item for item in archive if item["date"] == round_data["date"]]
        if len(records) != 1:
            raise ValueError(f"No unique race archive for round {round_no}")
        source = read(dist / "season-2026" / f"{records[0]['key']}.json")
        source["race"] = source["session"]
        source["quali"] = {"session_key": quali["key"]}
        roster = [entry["driver_number"] for entry in source["drivers"]]
        source["drivers_selected"] = sorted(roster, key=lambda n: (n not in (63, 12), n != 63, n))
        slug = event["slug"]
        name = f"{NAMES[slug]}大奖赛" if slug in NAMES else round_data["name"]
        telemetry = telemetry_for(cache, f"/sessions/2026/{slug}/{quali['slug']}", roster, laps_per_driver)
        entry = build(f"2026-r{round_no:02}", source, name=name, telemetry=telemetry)
        entry.update(round=round_no, date=round_data["date"], telemetrySource="F1Archive")
        write(output / f"r{round_no:02}.json", entry)
        print(f"R{round_no:02} {name}: {len(entry['drivers'])} race drivers, "
              f"{len(telemetry['laps'])} telemetry drivers, {sum(map(len, telemetry['laps'].values()))} laps", flush=True)

    work = [row for row in selected_rounds if not rounds or row["round"] in rounds]
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(process, work))
    index = []
    for row in selected_rounds:
        round_no = row["round"]
        path = output / f"r{round_no:02}.json"
        if path.exists():
            entry = read(path)
            index.append({key: entry[key] for key in ("id", "name", "year", "round", "date", "raceKey")})
    write(output / "index.json", index)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--laps", type=int, default=4, help="qualifying laps to keep per driver")
    parser.add_argument("round", nargs="*", type=int)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    season_data(args.cache, args.dist, args.round, args.laps)
