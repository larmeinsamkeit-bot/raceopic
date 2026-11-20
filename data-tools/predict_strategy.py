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


def race_session(cache, year, circuit):
    # Circuit names are stable across years; locations are not (Abu Dhabi: "Yas Island", then "Yas Marina").
    sessions = fetch(cache, "sessions", {"year": year, "circuit_short_name": circuit, "session_name": "Race"})
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


# ---------------------------------------------------------------------------------------------
# Practice model: tyre degradation from this year's practice long runs, compound pace and pit loss
# from the previous edition's race, then simulate every one- and two-stop plan over the race.

FUEL_PER_LAP = .06  # s/lap gained as fuel burns; long-run slopes are corrected by this
PACE_STEP = .35     # s/lap between adjacent compounds when a compound has no race data
TEMPERATURE = 3.0   # s of race time that separate a plan from one about e (2.7) times likelier
COMPOUNDS = ("SOFT", "MEDIUM", "HARD")
# Longest stint the simulation allows per compound. Generic on purpose: taking last year's longest
# stints made the model copy last year's strategy, which backtested worse than history alone.
TYRE_LIFE = {"SOFT": 25, "MEDIUM": 35, "HARD": 45}
WEIGHTS = (0., .3, .6)  # practice shares tried in the backtest; the best mean Brier score is used
SHORT = {"SOFT": "S", "MEDIUM": "M", "HARD": "H"}


def drop_empty(folder):
    """A session that has not run yet returns []; never keep that answer in the cache."""
    for path in folder.glob("*.json"):
        if path.read_text().strip() == "[]":
            path.unlink()


def practice_runs(cache, year, circuit):
    """Long runs (5+ representative laps on one set) from every practice session of the weekend."""
    folder = cache / f"practice-{year}"
    folder.mkdir(parents=True, exist_ok=True)
    sessions = [s for s in fetch(folder, "sessions", {"year": year, "circuit_short_name": circuit})
                if s["session_name"].startswith("Practice")]
    runs = []
    for session in sessions:
        key = {"session_key": session["session_key"]}
        laps = fetch(folder, "laps", key)
        stints = fetch(folder, "stints", key)
        by_driver = {}
        for lap in laps:
            if lap.get("lap_duration") and not lap.get("is_pit_out_lap"):
                by_driver.setdefault(lap["driver_number"], {})[lap["lap_number"]] = lap["lap_duration"]
        for stint in stints:
            compound = (stint.get("compound") or "").upper()
            if compound not in COMPOUNDS or stint.get("lap_start") is None or stint.get("lap_end") is None:
                continue
            times = by_driver.get(stint["driver_number"], {})
            rows = [(stint["tyre_age_at_start"] + n - stint["lap_start"], n, times[n])
                    for n in range(stint["lap_start"], stint["lap_end"] + 1) if n in times]
            if len(rows) < 5:
                continue
            middle = sorted(t for _, _, t in rows)[len(rows) // 2]
            rows = [r for r in rows if r[2] <= middle * 1.025]  # drop cool-down and traffic laps
            if len(rows) >= 5:
                runs.append({"compound": compound, "session": session["session_name"],
                             "driver": stint["driver_number"], "laps": rows})
    drop_empty(folder)
    return runs


def practice_status(cache, year, circuit):
    """What practice has produced so far: sessions run, dry long runs, and wet-tyre stints."""
    folder = cache / f"practice-{year}"
    folder.mkdir(parents=True, exist_ok=True)
    sessions = [s for s in fetch(folder, "sessions", {"year": year, "circuit_short_name": circuit})
                if s["session_name"].startswith("Practice")]
    ran, wet = [], 0
    for session in sessions:
        laps = fetch(folder, "laps", {"session_key": session["session_key"]})
        if any(lap.get("lap_duration") for lap in laps):
            ran.append(session["session_name"])
        wet += sum((s.get("compound") or "").upper() in ("INTERMEDIATE", "WET")
                   for s in fetch(folder, "stints", {"session_key": session["session_key"]}))
    drop_empty(folder)
    runs = practice_runs(cache, year, circuit)
    state = "used" if runs else "wet" if ran and wet else "no_long_runs" if ran else "not_run"
    return {"state": state, "sessions_run": ran, "dry_long_runs": len(runs), "wet_stints": wet}


def degradation_from_runs(runs):
    """Pooled within-run slope per compound, corrected for fuel burn: s lost per lap of tyre age."""
    result = {}
    for compound in COMPOUNDS:
        sxy = sxx = 0.
        count = 0
        for run in (r for r in runs if r["compound"] == compound):
            ages = [a for a, _, _ in run["laps"]]
            times = [t + FUEL_PER_LAP * (n - run["laps"][0][1]) for _, n, t in run["laps"]]
            mean_a, mean_t = sum(ages) / len(ages), sum(times) / len(times)
            sxy += sum((a - mean_a) * (t - mean_t) for a, t in zip(ages, times))
            sxx += sum((a - mean_a) ** 2 for a in ages)
            count += len(ages)
        if sxx > 0:
            result[compound] = {"slope": sxy / sxx, "laps": count}
    return result


def race_pace(cache, session_key):
    """Compound offsets and degradation from a race: lap time = driver base + offset + slope * age."""
    laps = fetch(cache, "laps", {"session_key": session_key})
    stints = fetch(cache, "stints", {"session_key": session_key})
    pits = fetch(cache, "pit", {"session_key": session_key})
    tyre = {}
    for stint in stints:
        compound = (stint.get("compound") or "").upper()
        if compound in COMPOUNDS and stint.get("lap_start") and stint.get("lap_end"):
            for n in range(stint["lap_start"], stint["lap_end"] + 1):
                tyre[(stint["driver_number"], n)] = (compound, stint["tyre_age_at_start"] + n - stint["lap_start"])
    in_laps = {(p["driver_number"], p["lap_number"]) for p in pits}
    rows = [(lap["driver_number"], *tyre[(lap["driver_number"], lap["lap_number"])],
             lap["lap_duration"] + FUEL_PER_LAP * lap["lap_number"])
            for lap in laps
            if lap.get("lap_duration") and lap["lap_number"] > 1 and not lap.get("is_pit_out_lap")
            and (lap["driver_number"], lap["lap_number"]) not in in_laps
            and (lap["driver_number"], lap["lap_number"]) in tyre]
    if not rows:
        return None
    best = sorted(t for *_, t in rows)[len(rows) // 2]
    rows = [r for r in rows if r[3] <= best * 1.04]  # drop safety-car and traffic laps
    base = {d: sorted(t for dd, *_, t in rows if dd == d)[0] for d in {r[0] for r in rows}}
    fit = {}
    for _ in range(15):  # backfitting: driver bases, then one line per compound
        fit = {}
        for compound in COMPOUNDS:
            points = [(age, t - base[d]) for d, c, age, t in rows if c == compound]
            if len(points) < 20:
                continue
            ma = sum(a for a, _ in points) / len(points)
            mt = sum(t for _, t in points) / len(points)
            sxx = sum((a - ma) ** 2 for a, _ in points)
            slope = sum((a - ma) * (t - mt) for a, t in points) / sxx if sxx else 0.
            fit[compound] = {"offset": mt - slope * ma, "slope": slope, "laps": len(points)}
        residual = {}
        for d, c, age, t in rows:
            if c in fit:
                residual.setdefault(d, []).append(t - fit[c]["offset"] - fit[c]["slope"] * age)
        base = {d: base[d] + sum(v) / len(v) for d, v in residual.items()} | {d: b for d, b in base.items() if d not in residual}
    reference = fit.get("HARD") or next(iter(fit.values()), None)
    if reference is None:
        return None
    reference_offset = reference["offset"]
    for compound in fit:
        fit[compound]["offset"] -= reference_offset
    lanes = sorted(p["lane_duration"] for p in pits if p.get("lane_duration") and 15 < p["lane_duration"] < 35)
    stints_by = {}
    for stint in stints:
        if (stint.get("compound") or "").upper() in COMPOUNDS and stint.get("lap_start") and stint.get("lap_end"):
            stints_by.setdefault(stint["compound"].upper(), []).append(stint["lap_end"] - stint["lap_start"] + 1)
    longest = {c: sorted(v)[int(.9 * (len(v) - 1))] for c, v in stints_by.items()}
    return {"compounds": fit, "pit_loss": lanes[len(lanes) // 2] if lanes else 21.,
            "longest_stint": longest}


def simulate(laps, pace, pit_loss, longest):
    """Total race time of every 1- and 2-stop plan with at least two dry compounds."""
    def stint(compound, length):
        p = pace[compound]
        return length * p["offset"] + p["slope"] * length * (length + 1) / 2

    def allowed(compound, length):
        return 4 <= length <= longest.get(compound, laps)

    plans = []
    for first in COMPOUNDS:
        for second in COMPOUNDS:
            if first != second:
                for stop in range(4, laps - 3):
                    if allowed(first, stop) and allowed(second, laps - stop):
                        plans.append(((first, second), (stop,),
                                      stint(first, stop) + stint(second, laps - stop) + pit_loss))
            for third in COMPOUNDS:
                if len({first, second, third}) < 2:
                    continue
                for a in range(4, laps - 7):
                    if not allowed(first, a):
                        continue
                    for b in range(a + 4, laps - 3):
                        if allowed(second, b - a) and allowed(third, laps - b):
                            plans.append(((first, second, third), (a, b),
                                          stint(first, a) + stint(second, b - a) + stint(third, laps - b) + 2 * pit_loss))
    return plans


def plans_to_prediction(plans, laps):
    """Turn simulated race times into probabilities: plans within a few seconds of the best are plausible."""
    best = min(t for *_, t in plans)
    by_sequence = {}
    for sequence, stops, total in plans:
        key = "-".join(SHORT[c] for c in sequence)
        if key not in by_sequence or total < by_sequence[key][1]:
            by_sequence[key] = (stops, total)
    weights = {key: pow(2.718281828, -(total - best) / TEMPERATURE) for key, (_, total) in by_sequence.items()}
    norm = sum(weights.values())
    stop_probs = Counter()
    for key, w in weights.items():
        stop_probs[str(key.count("-"))] += w / norm
    first = [(stops[0] / laps, pow(2.718281828, -(total - best) / TEMPERATURE))
             for _, stops, total in plans if total - best < 3 * TEMPERATURE]
    window = [round(weighted_quantile(first, q) * laps) for q in (.25, .5, .75)]
    ranked = sorted(weights.items(), key=lambda kv: -kv[1])
    return {
        "stop_probabilities": {k: round(v, 3) for k, v in sorted(stop_probs.items())},
        "top_sequences": [{"sequence": k, "probability": round(w / norm, 3)} for k, w in ranked[:5]],
        "first_stop_window": {"from": window[0], "median": window[1], "to": window[2]},
        "best_plan": {"sequence": ranked[0][0], "stops": list(by_sequence[ranked[0][0]][0])},
    }


def practice_model(cache, year, circuit, laps, prior_session):
    """Simulated prediction from practice degradation, or None when practice has no usable long runs."""
    runs = practice_runs(cache, year, circuit)
    prior = race_pace(cache, prior_session)
    if not prior or not runs:
        return None
    measured = degradation_from_runs(runs)
    pace = {}
    hard = prior["compounds"].get("HARD", {"offset": 0., "slope": .03})
    for i, compound in enumerate(COMPOUNDS):  # SOFT, MEDIUM, HARD
        base = prior["compounds"].get(compound, {"offset": hard["offset"] - PACE_STEP * (2 - i),
                                                 "slope": hard["slope"] * (1.6 if i == 0 else 1.3 if i == 1 else 1)})
        slope = base["slope"]
        if compound in measured and measured[compound]["laps"] >= 15:
            slope = measured[compound]["slope"]  # this year's tyres and track, when the sample is big enough
        pace[compound] = {"offset": base["offset"], "slope": max(.005, slope)}
    plans = simulate(laps, pace, prior["pit_loss"], TYRE_LIFE)
    if not plans:
        return None
    prediction = plans_to_prediction(plans, laps)
    prediction["inputs"] = {
        "long_runs": len(runs), "long_run_laps": sum(len(r["laps"]) for r in runs),
        "practice_degradation": {SHORT[c]: {"slope": round(v["slope"], 4), "laps": v["laps"]} for c, v in measured.items()},
        "pace_used": {SHORT[c]: {k: round(v, 4) for k, v in p.items()} for c, p in pace.items()},
        "pit_loss": round(prior["pit_loss"], 2),
        "tyre_life": {SHORT[c]: v for c, v in TYRE_LIFE.items()},
        "previous_longest_stint": {SHORT[c]: v for c, v in prior["longest_stint"].items()},
    }
    return prediction


def blend(history_prediction, practice_prediction, weight):
    """Mix the practice simulation with the history prior; weight is the share given to practice."""
    stops = Counter()
    for source, w in ((history_prediction, 1 - weight), (practice_prediction, weight)):
        for k, v in source["stop_probabilities"].items():
            stops[k] += w * v
    sequences = Counter()
    for source, w in ((history_prediction, 1 - weight), (practice_prediction, weight)):
        for row in source["top_sequences"]:
            sequences[row["sequence"]] += w * row["probability"]
    window = {key: round((1 - weight) * history_prediction["first_stop_window"][key]
                         + weight * practice_prediction["first_stop_window"][key])
              for key in ("from", "median", "to")}
    stop_probs = {k: round(v, 3) for k, v in sorted(stops.items())}
    return {
        "most_likely_stops": int(max(stop_probs, key=stop_probs.get)),
        "stop_probabilities": stop_probs,
        "top_sequences": [{"sequence": k, "probability": round(v, 3)} for k, v in sequences.most_common(5)],
        "first_stop_window": window,
    }


def full_model(cache, circuit, year, laps, history, weight):
    """History prior blended with this year's practice simulation (prior race = latest edition in history)."""
    history_prediction = model(history, laps)
    practice = practice_model(cache, year, circuit, laps, history[-1]["session_key"])
    if practice is None:
        return history_prediction, None
    return blend(history_prediction, practice, weight), practice


def write_index(folder):
    """List every forecast in the folder, oldest race first, for the season page."""
    entries = []
    for path in sorted(folder.glob("*.json")):
        if path.name == "index.json":
            continue
        race = json.loads(path.read_text())["race"]
        entries.append({"file": path.name, "year": race["year"], "circuit": race.get("circuit") or race["location"],
                        "date_start": race["date_start"]})
    entries.sort(key=lambda entry: entry["date_start"] or "")
    (folder / "index.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n")


def predict(args):
    history = []
    for offset, year in enumerate(sorted(args.history)):
        session = race_session(args.cache, year, args.circuit)
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

    # Backtest every edition that has earlier ones: history alone, and history + that year's practice
    # at each candidate weight. The weight with the best mean Brier score is used for the forecast.
    backtests = []
    for i in range(1, len(history)):
        target_race, earlier = history[i], history[:i]
        row = {"target_year": target_race["year"], "trained_on": [r["year"] for r in earlier], "by_weight": {}}
        for weight in WEIGHTS:
            guess, used = full_model(args.cache, args.circuit, target_race["year"], target_race["laps"],
                                     earlier, weight)
            if weight == 0 or used:
                row["by_weight"][str(weight)] = score(guess, target_race["rows"])
        row["history_only"] = row["by_weight"]["0.0"]
        backtests.append(row)
    # Pick the weight across every circuit's backtests, not this circuit's alone: with two editions
    # per circuit, a per-circuit choice mostly fits noise. Other forecasts in the folder add their rows.
    pooled = [(args.circuit, b) for b in backtests]
    for path in sorted(args.output.parent.glob("*.json")):
        if path.name in ("index.json", args.output.name):
            continue
        other = json.loads(path.read_text())
        circuit = other["race"].get("circuit") or other["race"]["location"]
        if circuit != args.circuit:
            pooled += [(circuit, b) for b in other.get("backtests", []) if b.get("by_weight")]
    usable = [w for w in WEIGHTS if pooled and all(str(w) in b["by_weight"] for _, b in pooled)]
    mean_brier = {str(w): round(sum(b["by_weight"][str(w)]["stop_count_brier"] for _, b in pooled) / len(pooled), 3)
                  for w in usable}
    own_brier = {str(w): round(sum(b["by_weight"][str(w)]["stop_count_brier"] for b in backtests) / len(backtests), 3)
                 for w in usable if all(str(w) in b["by_weight"] for b in backtests)}
    chosen = args.practice_weight if args.practice_weight is not None else \
        (float(min(mean_brier, key=mean_brier.get)) if mean_brier else 0.)
    for row in backtests:
        row["with_practice"] = row["by_weight"].get(str(chosen)) if chosen else None
        print(f"Backtest {row['target_year']} (trained on {row['trained_on']}):")
        for weight, result in row["by_weight"].items():
            print(f"  practice {weight}: stops {result['stop_count_hit_rate']}, window {result['first_stop_in_window']}, "
                  f"MAE {result['first_stop_mae_laps']}, Brier {result['stop_count_brier']}")
    print("pooled over", [f"{c} {b['target_year']}" for c, b in pooled])
    print("mean Brier by practice weight (pooled):", mean_brier, "this circuit:", own_brier, "-> using", chosen)

    prediction, practice = full_model(args.cache, args.circuit, args.year, args.laps, history, chosen)
    status = practice_status(args.cache, args.year, args.circuit)
    print("practice data:", "used" if practice else "not used, history only", status)
    target = race_session(args.cache, args.year, args.circuit)
    latest = backtests[-1] if backtests else None
    forecast = {
        "race": {"year": args.year, "circuit": args.circuit, "location": args.circuit, "laps": args.laps,
                 "session_key": target and target["session_key"],
                 "date_start": target and target["date_start"]},
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": ("History prior (recency-weighted strategy frequencies) blended "
                   f"{round(100 * chosen)}% with a race simulation that uses this year's "
                   "practice long-run tyre degradation, the previous edition's compound pace and pit loss."
                   if practice else
                   "Recency-weighted frequencies over full-distance runners in earlier editions; "
                   "practice data not available yet."),
        "scenario": "dry",
        "uses_practice": practice is not None and chosen > 0,
        "practice_status": status,
        "practice_weight": chosen,
        "weight_selection": {"candidates": list(WEIGHTS), "mean_brier": mean_brier, "this_circuit_brier": own_brier,
                             "pooled_over": [{"circuit": c, "year": b["target_year"]} for c, b in pooled],
                             "rule": "lowest mean stop-count Brier score across every circuit's backtests"},
        "practice": practice,
        "history": [{k: v for k, v in race.items() if k != "rows"} for race in history],
        "prediction": prediction,
        "backtests": backtests,
        "baseline_backtest": latest and {"target_year": latest["target_year"], "trained_on": latest["trained_on"],
                                         "score": latest["history_only"]},
        "practice_backtest": latest and latest["with_practice"] and {
            "target_year": latest["target_year"], "trained_on": latest["trained_on"], "score": latest["with_practice"]},
        "caveats": ["Earlier editions ran under different technical rules and tyre allocations.",
                    "Safety cars and red flags are not modelled; they move stop laps.",
                    "The forecast assumes a dry race: none of the earlier editions was wet, so there is no history "
                    "to forecast a wet strategy from. A wet or mixed race is scored but left out of the season record.",
                    "Pit loss uses the median pit-lane time of the previous edition.",
                    "Las Vegas track evolution is strong: practice long runs often get faster with tyre age, "
                    "so degradation is floored and the simulation mostly weighs pit loss against tyre life.",
                    "Only a few editions can be backtested; the chosen weight is a small-sample choice.",
                    *args.note],
        "notes_zh": args.note_zh,
        "result": None,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(forecast, ensure_ascii=False, indent=2) + "\n")
    write_index(args.output.parent)
    print(json.dumps(forecast["prediction"], indent=2))


def race_conditions(rows):
    """'dry', 'mixed' or 'wet' from the tyres the full-distance runners used."""
    wet = sum(any(c in row["sequence"].split("-") for c in ("I", "W")) for row in rows.values())
    return "dry" if wet == 0 else "wet" if wet == len(rows) else "mixed"


def evaluate(args):
    forecast = json.loads(args.output.read_text())
    if forecast["race"]["date_start"] and datetime.fromisoformat(forecast["created"]) >= \
            datetime.fromisoformat(forecast["race"]["date_start"]):
        print("Warning: forecast was created after the race started; it is not a blind prediction.")
    rows, total = strategies(args.cache, forecast["race"]["session_key"])
    if not rows:
        raise SystemExit("No stint data for the race yet.")
    conditions = race_conditions(rows)
    # The forecast assumes a dry race; a wet or mixed one is still scored but kept out of the season record.
    forecast["result"] = {"scored": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                          "laps": total, "conditions": conditions, "counts_toward_record": conditions == "dry",
                          **score(forecast["prediction"], rows)}
    args.output.write_text(json.dumps(forecast, ensure_ascii=False, indent=2) + "\n")
    write_index(args.output.parent)
    print(json.dumps(forecast["result"], indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("predict", "evaluate"))
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--circuit", default="Las Vegas", help="OpenF1 circuit_short_name, e.g. Lusail")
    parser.add_argument("--note", action="append", default=[], help="extra caveat recorded in the forecast")
    parser.add_argument("--note-zh", action="append", default=[], help="the same caveat in Chinese for the site")
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--laps", type=int, default=50, help="scheduled race distance of the target race")
    parser.add_argument("--history", type=int, nargs="+", default=[2023, 2024, 2025])
    parser.add_argument("--practice-weight", type=float, default=None,
                        help="share given to the practice simulation; default picks it by backtest")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    (predict if args.command == "predict" else evaluate)(args)
