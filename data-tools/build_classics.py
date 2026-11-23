"""Build famous races since 2021 for the lab from F1Archive (race timing, tyres, pit stops, race
control, weather, classification and qualifying telemetry), into dist/past/ alongside the others.

F1Archive's race data is converted to the OpenF1-shaped `source` that build_dataset.build() takes,
so outlier laps, neutralisations and the pit model follow exactly the same rules.
    python3 -B data-tools/build_classics.py --cache /tmp/raceopic-classics --dist dist [id ...]
"""
import argparse
from bisect import bisect_left
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from statistics import median

from build_dataset import build, write_past_index
from build_season_lab import NS, get, telemetry_for

# (id, year, F1Archive slug, Chinese name, Chinese tagline, English tagline)
CLASSICS = [
    ("2021-abu-dhabi", 2021, "abu-dhabi", "阿布扎比大奖赛", "年度冠军决战，最后一圈超车", "Title decider, settled on the last lap"),
    ("2021-sao-paulo", 2021, "sao-paulo", "圣保罗大奖赛", "HAM 从第 10 位起跑反超夺冠", "Hamilton wins from tenth on the grid"),
    ("2021-british", 2021, "british", "英国大奖赛", "VER 与 HAM 在 Copse 弯相撞", "Verstappen and Hamilton collide at Copse"),
    ("2021-hungarian", 2021, "hungarian", "匈牙利大奖赛", "开赛连环相撞，OCO 拿下首胜", "First-lap chaos and Ocon's first win"),
    ("2021-italian", 2021, "italian", "意大利大奖赛", "RIC 夺冠，VER 与 HAM 相撞", "Ricciardo wins as Verstappen and Hamilton collide"),
    ("2022-saudi-arabian", 2022, "saudi-arabian", "沙特阿拉伯大奖赛", "VER 与 LEC 的最后缠斗", "Verstappen and Leclerc duel to the end"),
    ("2022-british", 2022, "british", "英国大奖赛", "SAI 拿下首胜", "Sainz's first win"),
    ("2022-sao-paulo", 2022, "sao-paulo", "圣保罗大奖赛", "RUS 拿下首胜", "Russell's first win"),
    ("2023-dutch", 2023, "dutch", "荷兰大奖赛", "雨战，VER 主场夺冠", "Wet race, Verstappen wins at home"),
    ("2023-singapore", 2023, "singapore", "新加坡大奖赛", "SAI 终结 Red Bull 连胜", "Sainz ends Red Bull's winning run"),
    ("2024-miami", 2024, "miami", "迈阿密大奖赛", "NOR 拿下首胜", "Norris's first win"),
    ("2024-austrian", 2024, "austrian", "奥地利大奖赛", "VER 与 NOR 争胜相撞，RUS 渔翁得利", "Verstappen and Norris collide, Russell takes the win"),
]
EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)  # F1Archive times are session-relative ns


def stamp(ns):
    return (EPOCH + timedelta(microseconds=ns // 1000)).isoformat()


def seconds(ns):
    return round(ns / NS, 3) if isinstance(ns, int) else None


def source_from_archive(cache, year, slug):
    """F1Archive race and qualifying -> the OpenF1-shaped dict build() expects."""
    season = get(cache, f"/seasons/{year}")
    event = next(e for e in season["events"] if e["slug"] == slug)
    race = next(s for s in event["sessions"] if s["kind"] == "race")
    quali = next(s for s in event["sessions"] if s["kind"] == "qualifying")
    route = f"/sessions/{year}/{slug}/{race['slug']}"
    raw_laps = get(cache, route + "/laps")
    drivers = get(cache, route + "/drivers")
    laps, stints = [], []
    for number in sorted({row["driver"] for row in raw_laps}, key=int):
        rows = sorted((r for r in raw_laps if r["driver"] == number), key=lambda r: r["lap"])
        current = None
        for row in rows:
            # Some completed laps (all three sectors timed) carry no lap time but do carry both
            # timing-line crossings; end - start equals the lap time to within the timing rounding
            # wherever both are present. A lap a car never finished has no sector 3 and stays empty.
            duration = row["lap_time_ns"]
            if (duration is None and isinstance(row["start_ns"], int) and isinstance(row["end_ns"], int)
                    and all(isinstance(row[f"s{i}_ns"], int) for i in (1, 2, 3))):
                duration = row["end_ns"] - row["start_ns"]
            laps.append({
                "driver_number": int(number), "lap_number": row["lap"],
                "lap_duration": seconds(duration),
                "date_start": stamp(row["start_ns"]) if isinstance(row["start_ns"], int) else None,
                "is_pit_out_lap": row["lap"] > 1 and row["pit_out_ns"] is not None,
                **{f"duration_sector_{i}": seconds(row[f"s{i}_ns"]) for i in (1, 2, 3)},
            })
            # A new set starts on the first lap and on every out-lap; laps carry their own compound.
            if current is None or (row["lap"] > 1 and row["pit_out_ns"] is not None):
                age = row.get("tyre_age")
                current = {"driver_number": int(number), "stint_number": len([s for s in stints if s["driver_number"] == int(number)]) + 1,
                           "compound": (row.get("compound") or "UNKNOWN").upper(), "lap_start": row["lap"],
                           "lap_end": row["lap"], "tyre_age_at_start": age - 1 if isinstance(age, (int, float)) else 0}
                stints.append(current)
            current["lap_end"] = row["lap"]
    pit = [{"driver_number": int(p["driver_number"]), "lap_number": p["lap"], "pit_duration": seconds(p["duration_ns"])}
           for p in get(cache, route + "/pit-stops") if p.get("driver_number")]
    messages = [m for m in get(cache, route + "/race-control") if isinstance(m.get("ts_ns"), int)]
    control = [{"date": stamp(m["ts_ns"]), "message": m["message"], "flag": m.get("flag"), "scope": m.get("scope"),
                "category": m.get("category")} for m in restart_signals(messages, raw_laps)]
    roster = [{"driver_number": int(d["number"]), "name_acronym": d["abbreviation"], "full_name": d["full_name"].title(),
               "last_name": d["full_name"].split()[-1].title(), "team_name": d["team_name"],
               "team_colour": (d.get("team_colour") or "").lstrip("#")} for d in drivers]
    weather = lap_weather(raw_laps, get(cache, route + "/weather"))
    results = get(cache, route + "/results")
    source = {
        "laps": laps, "stints": stints, "pit": pit, "race_control": control, "drivers": roster,
        "race": {"session_key": race["key"], "year": year, "circuit_short_name": event["location"],
                 "date_start": race["start_utc"]},
        "quali": {"session_key": quali["key"]},
        "drivers_selected": [int(d["number"]) for d in drivers],
    }
    return source, f"/sessions/{year}/{slug}/{quali['slug']}", weather, results, event


def restart_signals(messages, raw_laps):
    """F1Archive has no SESSION STARTED message, so a red flag would never end for neutral_periods().
    After each red flag, the last start-procedure message ("SAFETY CAR WILL ENTER PITS: STANDING
    START", "STANDING START", "... ROLLING START PROCEDURE") opens the restart; the race is green
    once the first car completes the lap that begins after it (that lap holds the formation and the
    start, like lap 1). Add OpenF1's SESSION STARTED + STANDING / ROLLING START pair there."""
    messages = sorted(messages, key=lambda m: m["ts_ns"])
    extra = []
    reds = [i for i, m in enumerate(messages) if m.get("flag") == "RED"]
    for n, i in enumerate(reds):
        stop = reds[n + 1] if n + 1 < len(reds) else len(messages)
        starts = [m for m in messages[i + 1:stop] if "STANDING START" in m["message"].upper() or "ROLLING START" in m["message"].upper()]
        if not starts:
            continue
        last = starts[-1]
        after = [lap for lap in raw_laps if isinstance(lap.get("start_ns"), int) and isinstance(lap.get("end_ns"), int)
                 and lap["start_ns"] >= last["ts_ns"]]
        if not after:
            continue
        first = min(lap["start_ns"] for lap in after)
        green = min(lap["end_ns"] for lap in after if lap["start_ns"] - first < 60 * NS)
        kind = "STANDING START" if "STANDING START" in last["message"].upper() else "ROLLING START"
        extra += [{"ts_ns": green, "message": "SESSION STARTED", "category": "Synthetic"},
                  {"ts_ns": green, "message": kind, "category": "Synthetic"}]
    return sorted(messages + extra, key=lambda m: m["ts_ns"])


def lap_weather(raw_laps, weather):
    samples = sorted((w["ts_ns"], w) for w in weather if isinstance(w.get("ts_ns"), int) and w.get("track_temp_c") is not None)
    if not samples:
        return []
    times = [t for t, _ in samples]
    starts = {}
    for lap in raw_laps:
        if isinstance(lap.get("start_ns"), int):
            starts.setdefault(lap["lap"], []).append(lap["start_ns"])
    rows = []
    for number in sorted(starts):
        moment = median(starts[number])
        i = bisect_left(times, moment)
        j = min((k for k in (i - 1, i) if 0 <= k < len(samples)), key=lambda k: abs(times[k] - moment))
        w = samples[j][1]
        rows.append({"lap": number, "track": w["track_temp_c"], "air": w.get("air_temp_c"), "rain": bool(w.get("rainfall"))})
    return rows


def main(cache, dist, only, laps_per_driver):
    output = dist / "past"
    for event_id, year, slug, name, tagline, tagline_en in CLASSICS:
        if only and event_id not in only:
            continue
        source, quali_route, weather, results, meta = source_from_archive(cache, year, slug)
        roster = [d["driver_number"] for d in source["drivers"]]
        telemetry = telemetry_for(cache, quali_route, roster, laps_per_driver)
        event = build(event_id, source, name=name, telemetry=telemetry)
        red = any(m.get("flag") == "RED" for m in source["race_control"])
        event.update(round=meta.get("round"), weather=weather, redFlag=red, tagline=tagline, taglineEn=tagline_en,
                     telemetrySource="F1Archive", classic=True)
        # The order the lap timing gives must match the official classification.
        finishers = [r["abbreviation"] for r in sorted(results, key=lambda r: r["position"] or 99)][:3]
        (output / f"{event_id}.json").write_text(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        print(f"{event_id}: {len(event['drivers'])} drivers, {event['totalLaps']} laps, "
              f"{sum(map(len, telemetry['laps'].values()))} telemetry laps, wet={event['wet']}, podium {finishers}", flush=True)
    write_past_index(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--dist", type=Path, default=Path("dist"))
    parser.add_argument("--laps", type=int, default=2, help="qualifying laps with telemetry per driver")
    parser.add_argument("only", nargs="*", help="build only these ids")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    main(args.cache, args.dist, set(args.only), args.laps)
