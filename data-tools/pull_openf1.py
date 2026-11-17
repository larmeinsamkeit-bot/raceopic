"""Cache a small set of historical OpenF1 sessions for the static dashboard."""
import argparse
from datetime import datetime, timedelta
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import urlopen

LAPS_PER_DRIVER = 5  # fastest complete qualifying laps kept per selected driver

EVENTS = [
    ("bahrain", 2024, "Sakhir", [63, 44, 1, 16]),
    ("silverstone", 2024, "Silverstone", [44, 63, 1, 4]),
    ("monza", 2025, "Monza", [63, 12, 1, 4]),
    ("brazil", 2024, "Interlagos", [1, 4, 63, 16]),
]

def fetch(cache, endpoint, filters, time_window=None):
    query = urlencode(filters)
    if time_window:
        start, end = time_window
        query += f"&date>{quote(start.isoformat())}&date<{quote(end.isoformat())}"
    key = endpoint + "-" + query.replace("&", "_").replace("%", "_").replace(">", "gt").replace("<", "lt")
    path = cache / (key + ".json")
    if path.exists():
        return json.loads(path.read_text())
    for attempt in range(5):
        try:
            time.sleep(.35)
            with urlopen(f"https://api.openf1.org/v1/{endpoint}?{query}", timeout=25) as response:
                payload = json.load(response)
            if not isinstance(payload, list):
                raise ValueError(f"Expected an array from {endpoint}")
            path.write_text(json.dumps(payload))
            return payload
        except HTTPError as error:
            if error.code == 404:
                return []
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
            time.sleep(min(20, int(error.headers.get("Retry-After", "2")) * (attempt + 1)))
        except (TimeoutError, URLError):
            if attempt == 4:
                raise
            time.sleep(2 + attempt)

def complete(lap):
    return (lap.get("date_start") and lap.get("lap_duration")
            and not lap.get("is_pit_out_lap")
            and all(lap.get(f"duration_sector_{sector}") for sector in (1, 2, 3)))

def download(cache, event):
    slug, year, circuit, selected_drivers = event
    sessions = fetch(cache, "sessions", {"year": year, "circuit_short_name": circuit})
    race = next(s for s in sessions if s["session_name"] == "Race")
    quali = next(s for s in sessions if s["session_name"] == "Qualifying")
    print(slug, "race", race["session_key"], "qualifying", quali["session_key"], flush=True)
    race_query = {"session_key": race["session_key"]}
    result = {key: fetch(cache, key, race_query)
              for key in ("laps", "stints", "pit", "race_control", "drivers")}
    result.update(race=race, quali=quali, drivers_selected=selected_drivers, telemetry={})
    quali_query = {"session_key": quali["session_key"]}
    quali_laps = fetch(cache, "laps", quali_query)
    for number in selected_drivers:
        candidates = sorted((lap for lap in quali_laps if lap["driver_number"] == number and complete(lap)),
                            key=lambda lap: lap["lap_duration"])[:LAPS_PER_DRIVER]
        result["telemetry"][str(number)] = []
        for lap in candidates:
            start = datetime.fromisoformat(lap["date_start"])
            end = start + timedelta(seconds=lap["lap_duration"])
            window = (start - timedelta(seconds=2), end + timedelta(seconds=2))
            query = {**quali_query, "driver_number": number}
            location = fetch(cache, "location", query, window)
            car = fetch(cache, "car_data", query, window)
            if len(location) > 100 and len(car) > 100:
                result["telemetry"][str(number)].append({"lap": lap, "location": location, "car": car})
        print(slug, number, [item["lap"]["lap_number"] for item in result["telemetry"][str(number)]], flush=True)
    (cache / f"{slug}.json").write_text(json.dumps(result))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("events", nargs="*")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    for event in EVENTS:
        if not args.events or event[0] in args.events:
            download(args.cache, event)
