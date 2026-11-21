# Raceopic

**Where does the lap time between two Formula 1 drivers actually come from?** Raceopic answers that with real timing and telemetry: pick a race and two drivers, and it lines up their qualifying laps on the track map, their race pace lap by lap, and their tyre strategies — and before each race it commits a strategy forecast that is scored once the race is over.

**Live site: https://larmeinsamkeit-bot.github.io/raceopic/** · [中文说明](#中文说明)

![Telemetry lab: paired-lap gap, sector advantage and speed trace](docs/lab.png)

## What it does

- **Track map with four views.** Sector advantage, 24 mini-sectors coloured by who gained time, both drivers' racing lines, and a synchronised two-car replay of their qualifying laps.
- **Where the gap is made.** A distance-aligned trace of the two qualifying laps: cumulative time gap (integrated from car speed and scaled to the official lap times, so it ends on the real difference), speed, throttle and brake, plus a summary of the stretches where most time changed hands.
- **Zoom anywhere on the circuit.** Scroll or pinch over any corner to zoom in there, drag to pan, double-click to dive in, and let the camera follow a car during the replay. A minimap shows where you are.
- **Race pace on one lap axis.** Lap times, a per-lap delta strip ("faster on N laps"), track and air temperature with rain laps, and tyre stints share the same x axis, with outlier laps (starts, pit laps, safety cars) excluded by default.
- **Whole-race replay.** Every car on the map with the running order, gaps, tyres and pit stops, rebuilt from lap times shaped by a qualifying lap's speed profile (not GPS); the 2026 Brazil finish comes out in the official order.
- **Race story and tyre wear.** Every driver's gap to the leader lap by lap with pit stops and safety cars, and each stint's fuel-corrected lap time against tyre age with a fitted degradation slope.
- **Pit-stop what-if.** A dry-race model fitted on the whole field estimates what moving one stop would have cost or gained.
- **Classic races since 2021.** Twelve famous races in full (all drivers' race timing, qualifying telemetry, weather): Abu Dhabi 2021, São Paulo 2021 and 2022, Silverstone 2021 and 2022, Hungary 2021, Monza 2021, Jeddah 2022, Zandvoort 2023, Singapore 2023, Miami 2024 and Austria 2024, each with a one-line note on why it matters.
- **Favourites and your own races.** Star any race to pin it to the top of the menu. "Add another race" downloads any 2023+ Grand Prix straight from OpenF1 in the browser (about 20 requests, usually seconds), builds it with the same rules as the bundled data and keeps it in that browser (IndexedDB); a shared link to an added race offers to download it.
- **Shareable comparisons.** The URL carries race, drivers, qualifying laps and view, e.g. [`?race=brazil&a=VER&b=NOR&mode=replay`](https://larmeinsamkeit-bot.github.io/raceopic/?race=brazil&a=VER&b=NOR&mode=replay).
- **2026 season.** Calendar, driver and constructor standings after every round, a teammate head-to-head (official qualifying and race-pace gap in every round, in seconds or % of lap time), classifications, and per-round OpenF1 race archives.
- **English and Chinese.** The interface follows the browser language; the EN / 中文 button switches and remembers it.

![Replay zoomed in and following a car through Monaco](docs/replay.gif)

## Pre-race strategy forecast

Before a race, `data-tools/predict_strategy.py` writes a forecast of the stop count, compound sequence and first-stop window, and the file is committed **before lights out** — the commit time is the proof the forecast was blind. After the race the same script scores it against the real stints.

The forecast blends two models:

1. **History prior** — recency-weighted strategy frequencies from earlier editions of the same race.
2. **Practice simulation** — tyre degradation measured from this weekend's practice long runs, compound pace and pit loss from last year's race, then every one- and two-stop plan simulated; plans close to the fastest become probabilities.

The blend weight is not hand-picked: the script backtests each earlier edition and uses the weight with the lowest mean stop-count Brier score. For Las Vegas it currently picks 30% practice:

| Backtest | Model | Stop count correct | First stop in window | First-stop error | Brier |
|---|---|---:|---:|---:|---:|
| 2024 | history only | 83.3% | 100% | 4.1 laps | 0.463 |
| 2024 | history + 30% practice | 5.6% | 94.4% | 6.3 laps | 0.732 |
| 2025 | history only | 17.6% | 5.9% | 11.1 laps | 1.067 |
| 2025 | history + 30% practice | 17.6% | 23.5% | 9.0 laps | 0.589 |

Honest reading: two editions are not enough to claim the practice model is better — it helps 2025 (a one-stop race) and hurts 2024 (a two-stop race). Las Vegas has strong track evolution, so practice long runs often get *faster* with tyre age and degradation is hard to measure.

The weight is chosen once, over all six backtests pooled across the three circuits (Las Vegas, Qatar, Abu Dhabi × 2024–2025), not per circuit: with two editions each, a per-circuit choice mostly fits luck (it had picked 30%, 60% and 0%). Pooled, 30% practice wins with a mean Brier score of 0.771 against 0.887 for history alone and 0.834 for 60%.

| Race (2026) | Start | Practice weight | Forecast (history so far) |
|---|---|---:|---|
| [Las Vegas](dist/predictions/2026-las-vegas.json) | 22 Nov | 30% | 1 stop (49.5%), M→H |
| [Qatar](dist/predictions/2026-qatar.json) | 29 Nov | 30% | 2 stops (44.4%), M→M→H |
| [Abu Dhabi](dist/predictions/2026-abu-dhabi.json) | 6 Dec | 30% | 1 stop (56.6%), M→H |

Las Vegas FP1 and FP2 in 2026 were wet (intermediates and wets only), so there were no dry long runs and its forecast stays on history; the forecast file records this as `practice_status`. Each forecast is regenerated once that weekend's practice has run and committed before the race; the season page keeps a record table that fills in as races are scored. Qatar's history is distorted by tyre-life limits imposed for safety in 2023 and 2025, which forced extra stops.

![Forecast panel with the backtest table](docs/forecast.png)

## Data

| Source | Used for |
|---|---|
| [OpenF1](https://openf1.org/docs/) | Race laps, sectors, stints, pit stops, race control, weather; practice long runs; qualifying telemetry for past seasons |
| [F1Archive](https://f1archive.org/docs) | 2026 qualifying position and car telemetry; the 2021–2024 classic races (timing, tyres, pit stops, race control, weather, qualifying telemetry) |
| [Jolpica F1](https://github.com/jolpica/jolpica-f1) | Calendar, standings and classifications |

The site is static and ships data snapshots in `dist/`:

- `dist/lab-2026/` — one file per completed 2026 round (race timing plus up to four qualifying laps per driver), loaded when the round is picked.
- `dist/past/` — selected earlier races (five qualifying laps per selected driver) and the classic races (every driver, two qualifying laps each), also loaded on demand.
- `dist/season-2026.json`, `dist/season-2026/` — season standings and per-round race archives.
- `dist/predictions/` — pre-race forecasts and, after the race, their scores.

## Run locally

```sh
python3 -m http.server 8765 --directory dist
```

Then open http://localhost:8765. Everything is plain HTML, CSS and JavaScript; the data tools use only the Python standard library.

## Refresh the data

After a race weekend one command runs the whole pipeline: standings and race archives, lab files for newly completed rounds, per-lap weather, teammate head-to-heads, and scores for forecasts whose race has finished (`--dry-run` prints the plan):

```sh
python3 -B data-tools/refresh.py --cache /tmp/raceopic-refresh
```

`.github/workflows/refresh.yml` runs it every three hours on Sundays and Mondays UTC, so a race is picked up within hours (and on demand), then the unit tests, and opens a `Refresh race data` pull request with whatever changed. It needs **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** turned on.

The individual steps, each needing network access (use fresh cache folders to pick up revised data):

```sh
python3 -B data-tools/pull_openf1.py --cache /tmp/raceopic-archive
python3 -B data-tools/build_dataset.py /tmp/raceopic-archive dist/past
python3 -B data-tools/build_classics.py --cache /tmp/raceopic-classics --dist dist
python3 -B data-tools/pull_season.py --cache /tmp/raceopic-2026 --output dist all
python3 -B data-tools/build_season_lab.py --cache /tmp/raceopic-season-lab --dist dist
python3 -B data-tools/add_weather.py --dist dist --cache /tmp/raceopic-weather
python3 -B data-tools/build_teammates.py dist
```

`build_dataset.py` keeps past races already in `dist/past/` when their downloads are not in the cache, so one race can be added on its own. `build_classics.py` converts F1Archive's race feeds to the OpenF1 shape `build_dataset.build()` reads, so outlier laps, safety cars and the pace model follow the same rules; F1Archive has no "session started" message, so after a red flag the race counts as green once the first car completes the restart lap. Add a race by appending to `CLASSICS` and passing its id. The in-browser importer (`dist/importer.js`) is a line-for-line port of the same build and gives identical output on the bundled OpenF1 races. `build_season_lab.py --laps N` sets how many qualifying laps to keep per driver.

Strategy forecast (run `predict` before the race, `evaluate` after it):

```sh
python3 -B data-tools/predict_strategy.py predict --circuit "Las Vegas" --laps 50 --cache /tmp/raceopic-predict --output dist/predictions/2026-las-vegas.json
python3 -B data-tools/predict_strategy.py predict --circuit Lusail --laps 57 --cache /tmp/raceopic-predict --output dist/predictions/2026-qatar.json
python3 -B data-tools/predict_strategy.py predict --circuit "Yas Marina Circuit" --laps 58 --cache /tmp/raceopic-predict --output dist/predictions/2026-abu-dhabi.json
python3 -B data-tools/predict_strategy.py evaluate --cache /tmp/raceopic-predict --output dist/predictions/2026-las-vegas.json
```

## Tests and deployment

```sh
python3 -B -m unittest discover -s data-tools/tests -v
```

Browser smoke test (opens every race, the four map views, zoom, replay, a shared link, the season page, English mode and a phone-width layout):

```sh
node tests/e2e/smoke.mjs
```

CI (`.github/workflows/ci.yml`) runs the unit tests, syntax-checks every site script, validates all site data and runs the browser smoke test in Chromium. Pushing to `main` publishes `dist/` to GitHub Pages (`.github/workflows/pages.yml`).

Raceopic is an independent data project and not an official Formula 1 product.

---

## 中文说明

Raceopic 是一个 F1 数据分析网站，回答一个问题：**两位车手之间的圈速差，到底来自哪里？** 选择比赛和两位车手，就能在赛道图上对比排位圈的分段优势、行车线和双车回放，并按圈比较正赛节奏与轮胎策略。

**网站：https://larmeinsamkeit-bot.github.io/raceopic/**

- **赛道图**：分段优势、24 个迷你分段、行车线、双车同步回放。可在赛道任意位置滚动、双指或双击放大，拖动平移，回放时镜头可跟随车手，并有小地图显示当前位置。
- **时间差曲线**：两圈排位沿赛道距离对齐的累积时间差（由车速积分并按官方圈速缩放）、车速、油门与制动，并自动指出差距最大的路段。
- **正赛节奏**：圈速、每圈差值、赛道温度与降雨、轮胎时间线共用同一条圈数轴，默认排除发车圈、进出站圈和安全车圈。
- **整场回放**：全场车辆在赛道上移动，配实时排名、差距、轮胎与进站，由每圈圈速按排位圈的速度分布重建（非 GPS）。
- **比赛进程与轮胎衰退**：全场每圈与领先者的差距（标出进站与安全车），以及各段轮胎修正燃油后的圈速与胎龄、衰退斜率。
- **进站情景**：用全场数据拟合的干地模型，估算换一圈进站的得失。
- **2021 年起的经典名局**：12 场完整收录（全场正赛计时、排位遥测、天气）：2021 阿布扎比、2021 与 2022 圣保罗、2021 与 2022 英国、2021 匈牙利、2021 意大利、2022 沙特、2023 荷兰、2023 新加坡、2024 迈阿密、2024 奥地利，每场附一句看点。
- **收藏与自行加入比赛**：按 ☆ 收藏的比赛会排在选单最上方。「加入其他比赛」可直接在浏览器从 OpenF1 下载 2023 年起的任何一站，用与本站相同的规则整理，保存在这个浏览器里（IndexedDB）。
- **可分享链接**：网址会记录赛事、车手、排位圈和模式。
- **2026 赛季**：赛历、每轮后的车手与车队积分、整季队友对决、分类成绩与各站 OpenF1 正赛档案。
- **中英文界面**：默认跟随浏览器语言，可用 EN / 中文 按钮切换并记住选择。
- **三站赛前预测**：拉斯维加斯、卡塔尔、阿布扎比。练习赛模型的占比取三条赛道合并的 6 个回测中最好的一个（30%），避免每条赛道只有两届数据时挑到运气。

### 赛前策略预测

`data-tools/predict_strategy.py` 在正赛前生成停站次数、配方顺序和首停窗口的预测，并在发车前提交到仓库，提交时间就是盲测证明；赛后用实际轮胎记录打分。

预测混合两个模型：往年同站的策略频率（越近权重越高），以及用本周末练习赛长距离的轮胎衰退、去年正赛的配方速度和进站损失模拟所有一停与两停方案。混合比例由回测自动选择（平均 Brier 分数最低者），目前为练习赛 30%。只有 2024、2025 两届可以回测：练习赛模型改善了 2025 年（一停赛），却拖累了 2024 年（两停赛），样本太少，不能宣称一定更准。拉斯维加斯赛道演进很强，练习赛长距离常常越跑越快，轮胎衰退难以量测。所有回测结果都显示在赛季页，11 月 22 日赛后会补上实际准确度。

### 本地运行、更新数据与测试

指令与上方英文部分相同：`python3 -m http.server 8765 --directory dist` 启动网站；`data-tools/` 下的脚本只用 Python 标准库；`python3 -B -m unittest discover -s data-tools/tests -v` 运行测试。推送到 `main` 后会自动部署到 GitHub Pages。

本站为独立数据项目，并非 F1 官方产品。
