"""Summarise teammate head-to-heads across the 2026 rounds for the season page.

For each round and team: the qualifying gap (fastest lap with telemetry, first driver minus second)
and the race-pace gap (median over laps both ran clean). Pairs are keyed by the two drivers, so a
mid-season driver change starts a new pair. Run: python3 -B data-tools/build_teammates.py dist
"""
import json
from pathlib import Path
from statistics import median
import sys

MIN_PAIRED_LAPS = 10


def round_gaps(event):
    telemetry = event["telemetry"]["laps"]
    teams = {}
    for driver in event["drivers"]:
        teams.setdefault(driver["team"], []).append(driver)
    rows = []
    for team, members in teams.items():
        if len(members) != 2:
            continue
        a, b = sorted(members, key=lambda d: d["code"])
        best = [min((lap["time"] for lap in telemetry.get(str(d["id"]), [])), default=None) for d in (a, b)]
        quali = round(best[0] - best[1], 3) if None not in best else None
        clean = [{lap["lap"]: lap["time"] for lap in d["laps"] if lap["time"] is not None and not lap["excluded"]}
                 for d in (a, b)]
        paired = [clean[0][n] - clean[1][n] for n in clean[0] if n in clean[1]]
        race = round(median(paired), 3) if len(paired) >= MIN_PAIRED_LAPS else None
        rows.append({"team": team, "drivers": [a["code"], b["code"]], "quali": quali, "race": race,
                     "paired_laps": len(paired)})
    return rows


def build(dist):
    pairs = {}
    for path in sorted((dist / "lab-2026").glob("r*.json")):
        event = json.loads(path.read_text())
        for row in round_gaps(event):
            key = (row["team"], *row["drivers"])
            pair = pairs.setdefault(key, {"team": row["team"], "drivers": row["drivers"], "rounds": []})
            pair["rounds"].append({"round": event["round"], "name": event["name"], "id": event["id"],
                                   "quali": row["quali"], "race": row["race"], "paired_laps": row["paired_laps"]})
    result = []
    for pair in pairs.values():
        quali = [r["quali"] for r in pair["rounds"] if r["quali"] is not None]
        race = [r["race"] for r in pair["rounds"] if r["race"] is not None]
        pair["summary"] = {
            "quali_ahead": [sum(g < 0 for g in quali), sum(g > 0 for g in quali)],
            "race_ahead": [sum(g < 0 for g in race), sum(g > 0 for g in race)],
            "quali_median": round(median(quali), 3) if quali else None,
            "race_median": round(median(race), 3) if race else None,
        }
        result.append(pair)
    result.sort(key=lambda p: (-len(p["rounds"]), p["team"]))
    return result


if __name__ == "__main__":
    dist = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
    data = build(dist)
    (dist / "teammates-2026.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    for pair in data:
        s = pair["summary"]
        print(f"{pair['team']:<22} {'/'.join(pair['drivers']):<8} rounds {len(pair['rounds']):>2}  "
              f"quali {s['quali_ahead'][0]}-{s['quali_ahead'][1]} ({s['quali_median']})  "
              f"race {s['race_ahead'][0]}-{s['race_ahead'][1]} ({s['race_median']})")
