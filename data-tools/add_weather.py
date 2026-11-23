"""Attach per-lap weather (track and air temperature, rain) to the lab's race files.

Each lap is matched to the weather sample nearest the median start time of that lap across the
field. 2026 rounds read the race archives in dist/season-2026/; past races fetch weather and lap
timestamps from OpenF1 into the given cache.
Run after build_season_lab.py / build_dataset.py:
    python3 -B data-tools/add_weather.py --dist dist --cache /tmp/raceopic-weather
"""
import argparse
from bisect import bisect_left
from datetime import datetime
import json
from pathlib import Path
from statistics import median

from pull_openf1 import fetch


def stamp(value):
    return datetime.fromisoformat(value).timestamp()


def lap_weather(laps, weather):
    """[{lap, track, air, rain}] for every lap number that has start times and a weather sample."""
    samples = sorted((stamp(w["date"]), w) for w in weather
                     if w.get("date") and w.get("track_temperature") is not None)
    if not samples:
        return []
    times = [t for t, _ in samples]
    starts = {}
    for lap in laps:
        if lap.get("date_start") and lap.get("lap_number"):
            starts.setdefault(lap["lap_number"], []).append(stamp(lap["date_start"]))
    rows = []
    for number in sorted(starts):
        moment = median(starts[number])
        i = bisect_left(times, moment)
        nearest = min((j for j in (i - 1, i) if 0 <= j < len(samples)), key=lambda j: abs(times[j] - moment))
        w = samples[nearest][1]
        rows.append({"lap": number, "track": w["track_temperature"], "air": w.get("air_temperature"),
                     "rain": bool(w.get("rainfall"))})
    return rows


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")


def main(dist, cache):
    for path in sorted((dist / "lab-2026").glob("r*.json")):
        event = json.loads(path.read_text())
        archive_path = dist / "season-2026" / f"{event['raceKey']}.json"
        if not archive_path.exists():
            print(f"{path.name}: no race archive, skipped")
            continue
        archive = json.loads(archive_path.read_text())
        event["weather"] = lap_weather(archive["laps"], archive["weather"])
        write(path, event)
        print(f"{path.name}: {len(event['weather'])} laps with weather")
    for path in sorted((dist / "past").glob("*.json")):
        if path.name == "index.json":
            continue
        event = json.loads(path.read_text())
        if event.get("classic"):
            continue  # build_classics.py attaches F1Archive weather itself
        query = {"session_key": event["raceKey"]}
        event["weather"] = lap_weather(fetch(cache, "laps", query), fetch(cache, "weather", query))
        write(path, event)
        print(f"{path.name}: {len(event['weather'])} laps with weather")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dist", type=Path, default=Path("dist"))
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    main(args.dist, args.cache)
