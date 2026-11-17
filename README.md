# Raceopic

中文 F1 分析站。按比赛与车手比较圈速及轮胎策略，在赛道图上切换分段优势、行车线和双车遥测回放。

```sh
python3 -m http.server 8765 --directory dist
```

访问 http://localhost:8765。赛季页面位于 `dist/season.html`。

- `dist/season-2026.json` 保存全年赛历、分轮车手和车队积分及正赛、排位、冲刺分类成绩。开启赛季页面时会检查 Jolpica，并在浏览器保存后续更新。
- `dist/season-2026/` 保存已有分站的 OpenF1 正赛计时、轮胎、进站、天气及赛会消息。赛季页面可预览和下载各站档案。
- `dist/events.json` 保存用于互动分析的比赛子集和排位遥测。走线由公开定位采样插值，同步回放以所选圈的各自开始时间为零点。

数据来源：[Jolpica F1](https://github.com/jolpica/jolpica-f1)、[OpenF1](https://openf1.org/docs/)。

从项目目录运行以下命令可刷新快照。需要联网，建议使用新的缓存目录获取可能修订的数据。赛季正赛归档如已存在，脚本会保留该站已有文件。

```sh
python3 -B data-tools/pull_openf1.py --cache /tmp/raceopic-archive
python3 -B data-tools/pull_season.py --cache /tmp/raceopic-2026 --output dist all
python3 -B data-tools/pull_season.py --cache /tmp/raceopic-2026 --output dist telemetry
python3 -B data-tools/build_dataset.py /tmp/raceopic-archive dist/events.json /tmp/raceopic-2026
```

## 赛前策略预测

`data-tools/predict_strategy.py` 用同站往年数据（越近权重越高）预测停站次数、配方顺序和首停窗口，并自动用“去掉最近一年”的回测给出基线分数。预测文件须在正赛发车前提交；提交时间就是盲测证明。

```sh
python3 -B data-tools/predict_strategy.py predict --cache /tmp/raceopic-predict --output dist/predictions/2026-las-vegas.json
# 正赛结束后：
python3 -B data-tools/predict_strategy.py evaluate --cache /tmp/raceopic-predict --output dist/predictions/2026-las-vegas.json
```

赛季页的“策略预测”面板读取该文件，赛后自动显示准确度。

## 部署

推送到 `main` 后，`.github/workflows/pages.yml` 会把 `dist/` 发布到 GitHub Pages。首次使用需在仓库 Settings → Pages 将 Source 设为 GitHub Actions。
