"""Pre-race tyre strategy prediction and post-race scoring for one circuit.

predict:  build a forecast from earlier editions of the same race and write it to a JSON file.
          Commit that file before lights out; the commit time is the proof the forecast was blind.
evaluate: after the race, score the committed forecast against the real stints from OpenF1.

The model is deliberately simple and explainable: recency-weighted frequencies of stop counts and
compound sequences among drivers who ran (nearly) the full distance, plus a weighted first-stop
window expressed as a share of race distance so it carries over between editions.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path

from pull_openf1 import fetch

COMPOUND = {"SOFT": "S", "MEDIUM": "M", "HARD": "H", "INTERMEDIATE": "I", "WET": "W"}
FULL_DISTANCE = .9  # a driver counts once they complete 90% of the laps


def race_session(cache, year, location):
    sessions = fetch(cache, "sessions", {"year": year, "location": location, "session_name": "Race"})
    return sessions[0] if sessions else None


def strategies(cache, session_key):
    """Return {driver_number: {"stops", "sequence", "first_stop", "laps"}} for full-distance runners."""
    stints = fetch(cache, "stints", {"session_key": session_key})
    laps = fetch(cache, "laps", {"session_key": session_key})
    total = max((lap["lap_number"] for lap in laps), default=0)
    by_driver = {}
    for stint in sorted(stints, key=lambda s: (s["driver_number"], s["stint_number"])):
        by_driver.setdefault(stint["driver_number"], []).append(stint)
    result = {}
    for number, rows in by_driver.items():
        last = max((r.get("lap_end") or 0) for r in rows)
        compounds = [COMPOUND.get((r.get("compound") or "").upper()) for r in rows]
        if not total or last < FULL_DISTANCE * total or None in compounds:
            continue
        result[number] = {
            "stops": len(rows) - 1,
            "sequence": "-".join(compounds),
            "first_stop": rows[0].get("lap_end") if len(rows) > 1 else None,
            "laps": total,
        }
    return result, total


def weighted_quantile(pairs, fraction):
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    running = 0
    for value, weight in pairs:
        running += weight
        if running >= fraction * total:
            return value
    return pairs[-1][0]


def model(history, laps):
    """Recency-weighted strategy frequencies; each race contributes its weight split over its drivers."""
    stops, sequences, first = Counter(), Counter(), []
    for race in history:
        share = race["weight"] / len(race["rows"])
        for row in race["rows"].values():
            stops[row["stops"]] += share
            sequences[row["sequence"]] += share
            if row["first_stop"]:
                first.append((row["first_stop"] / race["laps"], share))
    norm = sum(stops.values())
    stop_probs = {str(k): round(v / norm, 3) for k, v in sorted(stops.items())}
    window = [round(weighted_quantile(first, q) * laps) for q in (.25, .5, .75)]
    return {
        "most_likely_stops": int(max(stop_probs, key=stop_probs.get)),
        "stop_probabilities": stop_probs,
        "top_sequences": [{"sequence": k, "probability": round(v / norm, 3)} for k, v in sequences.most_common(5)],
        "first_stop_window": {"from": window[0], "median": window[1], "to": window[2]},
    }


def score(p, rows):
    actual = list(rows.values())
    probs = {int(k): v for k, v in p["stop_probabilities"].items()}
    top = p["top_sequences"][0]["sequence"]
    w = p["first_stop_window"]
    firsts = [r["first_stop"] for r in actual if r["first_stop"]]
    outcomes = sorted(set(probs) | {r["stops"] for r in actual})
    brier = sum(sum((probs.get(k, 0) - (r["stops"] == k)) ** 2 for k in outcomes) for r in actual) / len(actual)
    return {
        "drivers": len(actual),
        "stop_count_hit_rate": round(sum(r["stops"] == p["most_likely_stops"] for r in actual) / len(actual), 3),
        "top_sequence_hit_rate": round(sum(r["sequence"] == top for r in actual) / len(actual), 3),
        "first_stop_in_window": round(sum(w["from"] <= f <= w["to"] for f in firsts) / len(firsts), 3) if firsts else None,
        "first_stop_mae_laps": round(sum(abs(f - w["median"]) for f in firsts) / len(firsts), 2) if firsts else None,
        "stop_count_brier": round(brier, 3),
        "actual_stop_counts": dict(Counter(str(r["stops"]) for r in actual)),
        "actual_sequences": dict(Counter(r["sequence"] for r in actual).most_common(5)),
    }


def predict(args):
    history = []
    for offset, year in enumerate(sorted(args.history)):
        session = race_session(args.cache, year, args.location)
        if not session:
            print(f"{year}: no race session, skipped")
            continue
        rows, total = strategies(args.cache, session["session_key"])
        weight = offset + 1  # the most recent edition counts most
        history.append({"year": year, "session_key": session["session_key"], "laps": total,
                        "drivers": len(rows), "weight": weight, "rows": rows})
        print(f"{year}: {len(rows)} full-distance drivers, {total} laps, weight {weight}")
    if not history:
        raise SystemExit("No historical races found.")

    prediction = model(history, args.laps)
    target = race_session(args.cache, args.year, args.location)
    backtest = None
    if len(history) > 1:
        last = history[-1]
        guess = model(history[:-1], last["laps"])
        backtest = {"target_year": last["year"], "trained_on": [r["year"] for r in history[:-1]],
                    "prediction": guess, "score": score(guess, last["rows"])}
        print(f"Backtest on {last['year']}:", json.dumps(backtest["score"]))
    forecast = {
        "race": {"year": args.year, "location": args.location, "laps": args.laps,
                 "session_key": target and target["session_key"],
                 "date_start": target and target["date_start"]},
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": "Recency-weighted frequencies over full-distance runners in earlier editions; "
                  "first stop scaled by race distance.",
        "history": [{k: v for k, v in race.items() if k != "rows"} for race in history],
        "prediction": prediction,
        "baseline_backtest": backtest,
        "caveats": ["Earlier editions ran under different technical rules and tyre allocations.",
                    "Safety cars and red flags are not modelled; they move stop laps."],
        "result": None,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(forecast, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(forecast["prediction"], indent=2))


def evaluate(args):
    forecast = json.loads(args.output.read_text())
    if forecast["race"]["date_start"] and datetime.fromisoformat(forecast["created"]) >= \
            datetime.fromisoformat(forecast["race"]["date_start"]):
        print("Warning: forecast was created after the race started; it is not a blind prediction.")
    rows, total = strategies(args.cache, forecast["race"]["session_key"])
    if not rows:
        raise SystemExit("No stint data for the race yet.")
    forecast["result"] = {"scored": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                          "laps": total, **score(forecast["prediction"], rows)}
    args.output.write_text(json.dumps(forecast, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(forecast["result"], indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("predict", "evaluate"))
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--location", default="Las Vegas")
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--laps", type=int, default=50, help="scheduled race distance of the target race")
    parser.add_argument("--history", type=int, nargs="+", default=[2023, 2024, 2025])
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    (predict if args.command == "predict" else evaluate)(args)
