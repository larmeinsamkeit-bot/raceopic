"""Store the 2026 calendar, standings, classifications and race data for Raceopic."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pull_openf1 import fetch, download

YEAR = 2026
JOLPICA = f"https://api.jolpi.ca/ergast/f1/{YEAR}/"
DATASETS = ("drivers", "laps", "stints", "pit", "weather", "race_control")
SESSION_LABELS = ("FirstPractice", "SecondPractice", "ThirdPractice", "SprintQualifying",
                  "Sprint", "Qualifying")

def read_jolpica(path):
    url = JOLPICA + path.strip("/") + ("/" if path else "") + "?limit=100"
    for attempt in range(5):
        try:
            with urlopen(Request(url, headers={"User-Agent": "Raceopic historical archive"}), timeout=20) as result:
                return json.load(result)["MRData"]
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
            sleep(min(12, 2 * (attempt + 1)))
        except (TimeoutError, URLError):
            if attempt == 4:
                raise
            sleep(1 + attempt)

def name(driver):
    return f"{driver['givenName']} {driver['familyName']}"

def driver_row(row):
    d = row["Driver"]
    return {"id": d["driverId"], "name": name(d), "code": d.get("code"),
            "rank": int(row["position"]) if row.get("position") else None,
            "points": float(row.get("points") or 0), "wins": int(row.get("wins") or 0),
            "team": " / ".join(t["name"] for t in row["Constructors"])}

def team_row(row):
    t = row["Constructor"]
    return {"id": t["constructorId"], "name": t["name"],
            "rank": int(row["position"]) if row.get("position") else None,
            "points": float(row.get("points") or 0), "wins": int(row.get("wins") or 0)}

def calendar_row(row):
    circuit = row["Circuit"]
    sessions = {key: row[key] for key in SESSION_LABELS if key in row}
    sessions["Race"] = {"date": row["date"], "time": row.get("time")}
    return {"round": int(row["round"]), "name": row["raceName"], "date": row["date"],
            "time": row.get("time"), "url": row.get("url"), "circuit": circuit["circuitName"],
            "country": circuit["Location"]["country"], "sessions": sessions}

def result_rows(data, key):
    races = data["RaceTable"]["Races"]
    return [{
        "rank": row.get("positionText") or row.get("position"), "name": name(row["Driver"]),
        "code": row["Driver"].get("code"), "team": row["Constructor"]["name"],
        "points": float(row["points"]) if "points" in row else None,
        "grid": int(row["grid"]) if row.get("grid") is not None else None,
        "laps": int(row["laps"]) if row.get("laps") is not None else None,
        "time": row.get("Time", {}).get("time"), "status": row.get("status"),
        "q1": row.get("Q1"), "q2": row.get("Q2"), "q3": row.get("Q3"),
    } for row in (races[0].get(key, []) if races else [])]

def save(path, data):
    scratch = path.with_suffix(".tmp")
    scratch.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    scratch.replace(path)

def championship(output):
    schedule = list(map(calendar_row, read_jolpica("")["RaceTable"]["Races"]))
    latest = read_jolpica("driverstandings")["StandingsTable"]["StandingsLists"]
    last_round = int(latest[0]["round"]) if latest else 0
    completed = [r for r in schedule if r["round"] <= last_round]
    def fetch_round(race):
        number = race["round"]
        drivers = read_jolpica(f"{number}/driverstandings")["StandingsTable"]["StandingsLists"]
        teams = read_jolpica(f"{number}/constructorstandings")["StandingsTable"]["StandingsLists"]
        if not drivers or not teams:
            return str(number), None
        results = {}
        for endpoint, key in (("results", "Results"), ("qualifying", "QualifyingResults"), ("sprint", "SprintResults")):
            if endpoint != "sprint" or "Sprint" in race["sessions"]:
                results[endpoint] = result_rows(read_jolpica(f"{number}/{endpoint}"), key)
        print("standings", number, race["name"], flush=True)
        return str(number), {"drivers": list(map(driver_row, drivers[0]["DriverStandings"])),
                             "teams": list(map(team_row, teams[0]["ConstructorStandings"])),
                             "results": results}
    with ThreadPoolExecutor(max_workers=3) as pool:
        snapshots = {number: data for number, data in pool.map(fetch_round, completed) if data}
    write_time = datetime.now(timezone.utc).isoformat()
    save(output / "season-2026.json", {"year": YEAR, "updated": write_time, "rounds": schedule,
                                    "snapshots": snapshots, "source": "https://api.jolpi.ca/"})
    return schedule

def archive(cache, output):
    directory = output / "season-2026"
    directory.mkdir(parents=True, exist_ok=True)
    race_sessions = fetch(cache, "sessions", {"year": YEAR, "session_name": "Race"})
    now = datetime.now(timezone.utc)
    completed = [s for s in race_sessions if datetime.fromisoformat(s["date_end"]) < now]
    index = []
    for session in sorted(completed, key=lambda s: s["date_start"]):
        key = session["session_key"]
        path = directory / f"{key}.json"
        if path.exists():
            data = json.loads(path.read_text())
        else:
            data = {kind: fetch(cache, kind, {"session_key": key}) for kind in DATASETS}
            if not data["laps"]:
                continue
            # Minimize duplicated event fields while preserving every timing and weather row.
            for kind, rows in data.items():
                for row in rows:
                    for field in ("session_key", "meeting_key"):
                        row.pop(field, None)
                    if kind == "laps":
                        for field in ("segments_sector_1", "segments_sector_2", "segments_sector_3"):
                            row.pop(field, None)
                    if kind == "drivers":
                        row.pop("headshot_url", None)
            data = {"source": "OpenF1", "session": session, **data}
            save(path, data)
        counts = {kind: len(data[kind]) for kind in DATASETS}
        index.append({"key": key, "date": session["date_start"][:10], "circuit": session["circuit_short_name"],
                      "counts": counts})
        save(output / "archive-2026.json", index)
        print("archive", key, session["circuit_short_name"], counts, flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("mode", choices=("standings", "archive", "telemetry", "all"))
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    if args.mode == "all":
        with ThreadPoolExecutor(max_workers=2) as pool:
            tasks = [pool.submit(championship, args.output), pool.submit(archive, args.cache, args.output)]
            for task in tasks:
                task.result()
    elif args.mode == "standings":
        championship(args.output)
    elif args.mode == "archive":
        archive(args.cache, args.output)
    else:
        download(args.cache, ("monza-2026", 2026, "Monza", [63, 12, 3, 1]))
