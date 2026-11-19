"""Unit tests for the pure functions in the data tools. Run: python3 -m unittest discover -s data-tools/tests"""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build_dataset import distance_along, interp, neutral_periods, solve  # noqa: E402
from build_season_lab import NS, group_by_window, timed  # noqa: E402
import predict_strategy as P  # noqa: E402


def message(time, text, flag=None, scope=None):
    return {"date": f"2025-01-01T00:{time:02d}:00+00:00", "message": text, "flag": flag, "scope": scope}


class Interpolation(unittest.TestCase):
    def test_linear_between_points(self):
        self.assertAlmostEqual(interp([0, 10], [0, 100], 2.5), 25)

    def test_clamps_outside_range(self):
        self.assertEqual(interp([0, 10], [5, 7], -3), 5)
        self.assertEqual(interp([0, 10], [5, 7], 30), 7)

    def test_distance_along_path(self):
        points = [(0, 0, 0), (1, 3, 4), (2, 3, 4)]
        self.assertEqual(distance_along(points), [0, 5, 5])


class LinearSolve(unittest.TestCase):
    def test_two_by_two(self):
        x = solve([[2, 1], [1, 3]], [3, 5])
        self.assertAlmostEqual(x[0], .8)
        self.assertAlmostEqual(x[1], 1.4)

    def test_singular_returns_none(self):
        self.assertIsNone(solve([[1, 2], [2, 4]], [1, 2]))


class NeutralPeriods(unittest.TestCase):
    def test_safety_car_until_green(self):
        periods = neutral_periods([
            message(5, "SAFETY CAR DEPLOYED"),
            message(9, "TRACK CLEAR", flag="CLEAR", scope="Track"),
        ])
        self.assertEqual(len(periods), 1)
        start, end = periods[0]
        self.assertEqual(end - start, 4 * 60)

    def test_sector_clear_does_not_end_neutralisation(self):
        periods = neutral_periods([
            message(5, "VSC DEPLOYED"),
            message(6, "CLEAR IN SECTOR 3", flag="CLEAR", scope="Sector"),
            message(8, "OVERTAKE ENABLED"),
        ])
        self.assertEqual(periods[0][1] - periods[0][0], 3 * 60)

    def test_unfinished_period_runs_to_end(self):
        periods = neutral_periods([message(5, "RED FLAG - RACE SUSPENDED", flag="RED")])
        self.assertEqual(periods[0][1], float("inf"))


class SeasonLab(unittest.TestCase):
    def lap(self, **change):
        lap = {"start_ns": 0, "end_ns": 90 * NS, "lap_time_ns": 90 * NS,
               "s1_ns": 30 * NS, "s2_ns": 30 * NS, "s3_ns": 30 * NS,
               "deleted": False, "pit_in_ns": None, "pit_out_ns": None}
        lap.update(change)
        return lap

    def test_clean_lap_is_timed(self):
        self.assertTrue(timed(self.lap()))

    def test_deleted_or_pit_laps_are_not(self):
        self.assertFalse(timed(self.lap(deleted=True)))
        self.assertFalse(timed(self.lap(pit_in_ns=80 * NS)))

    def test_sectors_must_add_up(self):
        self.assertFalse(timed(self.lap(s3_ns=20 * NS)))

    def test_windows_hold_at_most_six_drivers(self):
        laps = [{"driver": str(d), "start_ns": d * NS, "end_ns": d * NS + 90 * NS} for d in range(9)]
        groups = list(group_by_window(laps))
        self.assertEqual([len(g) for g in groups], [6, 3])


class Forecast(unittest.TestCase):
    rows = {1: {"stops": 1, "sequence": "M-H", "first_stop": 20},
            2: {"stops": 1, "sequence": "M-H", "first_stop": 22},
            3: {"stops": 2, "sequence": "M-H-H", "first_stop": 12}}

    def test_weighted_quantile(self):
        pairs = [(1, 1), (2, 1), (3, 2)]
        self.assertEqual(P.weighted_quantile(pairs, .5), 2)
        self.assertEqual(P.weighted_quantile(pairs, .9), 3)

    def test_history_model_frequencies(self):
        history = [{"weight": 1, "laps": 50, "rows": self.rows}]
        p = P.model(history, 50)
        self.assertEqual(p["most_likely_stops"], 1)
        self.assertAlmostEqual(p["stop_probabilities"]["1"], .667, places=3)
        self.assertEqual(p["top_sequences"][0]["sequence"], "M-H")

    def test_perfect_forecast_scores_perfectly(self):
        prediction = {"most_likely_stops": 1, "stop_probabilities": {"1": 1.},
                      "top_sequences": [{"sequence": "M-H", "probability": 1.}],
                      "first_stop_window": {"from": 20, "median": 21, "to": 22}}
        result = P.score(prediction, {k: v for k, v in self.rows.items() if k != 3})
        self.assertEqual(result["stop_count_hit_rate"], 1)
        self.assertEqual(result["top_sequence_hit_rate"], 1)
        self.assertEqual(result["first_stop_in_window"], 1)
        self.assertEqual(result["stop_count_brier"], 0)

    def test_simulation_prefers_fewer_stops_when_tyres_do_not_wear(self):
        pace = {c: {"offset": 0., "slope": .001} for c in P.COMPOUNDS}
        plans = P.simulate(50, pace, 21., P.TYRE_LIFE)
        prediction = P.plans_to_prediction(plans, 50)
        self.assertGreater(prediction["stop_probabilities"]["1"], .9)

    def test_simulation_adds_a_stop_when_tyres_wear_fast(self):
        pace = {c: {"offset": 0., "slope": .2} for c in P.COMPOUNDS}
        plans = P.simulate(50, pace, 21., P.TYRE_LIFE)
        prediction = P.plans_to_prediction(plans, 50)
        self.assertGreater(prediction["stop_probabilities"]["2"], .5)

    def test_every_plan_uses_two_compounds_and_respects_tyre_life(self):
        pace = {c: {"offset": 0., "slope": .05} for c in P.COMPOUNDS}
        for sequence, stops, _ in P.simulate(50, pace, 21., P.TYRE_LIFE):
            self.assertGreaterEqual(len(set(sequence)), 2)
            edges = [0, *stops, 50]
            for compound, a, b in zip(sequence, edges, edges[1:]):
                self.assertLessEqual(b - a, P.TYRE_LIFE[compound])

    def test_blend_keeps_probabilities_normalised(self):
        history = P.model([{"weight": 1, "laps": 50, "rows": self.rows}], 50)
        pace = {c: {"offset": 0., "slope": .001} for c in P.COMPOUNDS}
        practice = P.plans_to_prediction(P.simulate(50, pace, 21., P.TYRE_LIFE), 50)
        mixed = P.blend(history, practice, .3)
        self.assertAlmostEqual(sum(mixed["stop_probabilities"].values()), 1, places=2)

    def test_degradation_is_fuel_corrected(self):
        # Lap times flat on fuel-corrected terms: raw times fall by the fuel gain each lap.
        laps = [(age, 10 + age, 90 - P.FUEL_PER_LAP * age) for age in range(8)]
        result = P.degradation_from_runs([{"compound": "MEDIUM", "laps": laps}])
        self.assertAlmostEqual(result["MEDIUM"]["slope"], 0, places=6)


if __name__ == "__main__":
    unittest.main()
