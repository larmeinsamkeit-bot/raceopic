"""Refresh every data snapshot the site uses after a race weekend, in order.

1. Calendar, standings, classifications and race archives (pull_season.py all).
2. Lab files for completed rounds that do not have one yet (build_season_lab.py <rounds>).
3. Per-lap weather on every race file (add_weather.py).
4. Teammate head-to-heads (build_teammates.py).
5. Score forecasts whose race has finished and is not scored yet (predict_strategy.py evaluate);
   a race whose data is not published yet is skipped and tried again next time.

    python3 -B data-tools/refresh.py --cache /tmp/raceopic-refresh [--dry-run]
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys

TOOLS = Path(__file__).resolve().parent
SCORE_AFTER = timedelta(hours=3)  # race start + this before trying to score a forecast


def run(step, *args, dry_run=False, required=True):
    command = [sys.executable, "-B", str(TOOLS / step), *map(str, args)]
    print("$", " ".join(command[2:]), flush=True)
    if dry_run:
        return True
    result = subprocess.run(command)
    if result.returncode and required:
        raise SystemExit(f"{step} failed with exit code {result.returncode}")
    return result.returncode == 0


def missing_rounds(dist):
    season = json.loads((dist / "season-2026.json").read_text())
    done = {int(r) for r in season["snapshots"]}
    have = {int(p.stem[1:]) for p in (dist / "lab-2026").glob("r*.json")}
    return sorted(done - have)


def forecasts_to_score(dist, now):
    due = []
    for path in sorted((dist / "predictions").glob("*.json")):
        if path.name == "index.json":
            continue
        forecast = json.loads(path.read_text())
        start = forecast["race"].get("date_start")
        if forecast.get("result") is None and start and datetime.fromisoformat(start) + SCORE_AFTER < now:
            due.append(path)
    return due


def keep_timestamp_if_unchanged(path, before):
    """pull_season.py stamps "updated" on every run; undo that when nothing else changed,
    so a frequent schedule does not churn the data with empty commits."""
    if before is None or not path.exists():
        return
    after = json.loads(path.read_text())
    old = json.loads(before)
    if {k: v for k, v in after.items() if k != "updated"} == {k: v for k, v in old.items() if k != "updated"}:
        path.write_text(before)


def main(dist, cache, dry_run):
    season_path = dist / "season-2026.json"
    before = season_path.read_text() if season_path.exists() else None
    run("pull_season.py", "--cache", cache / "season", "--output", dist, "all", dry_run=dry_run)
    if not dry_run:
        keep_timestamp_if_unchanged(season_path, before)
    rounds = missing_rounds(dist)
    print("new rounds for the lab:", rounds or "none")
    if rounds:
        run("build_season_lab.py", "--cache", cache / "lab", "--dist", dist, *rounds, dry_run=dry_run)
    run("add_weather.py", "--dist", dist, "--cache", cache / "weather", dry_run=dry_run)
    run("build_teammates.py", dist, dry_run=dry_run)
    for path in forecasts_to_score(dist, datetime.now(timezone.utc)):
        ok = run("predict_strategy.py", "evaluate", "--cache", cache / "predict", "--output", path,
                 dry_run=dry_run, required=False)
        print(f"{path.name}: {'scored' if ok else 'not scored yet (race data not published?)'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dist", type=Path, default=Path("dist"))
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true", help="print the plan without fetching or writing")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    main(args.dist, args.cache, args.dry_run)
