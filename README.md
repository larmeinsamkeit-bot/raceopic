# Raceopic

中文 F1 分析站。按比赛与车手比较圈速及轮胎策略，在赛道图上切换分段优势、行车线和双车遥测回放。

```sh
python3 -m http.server 8765 --directory dist
```

访问 http://localhost:8765。赛季页面位于 `dist/season.html`。

- `dist/season-2026.json` 保存全年赛历、分轮车手和车队积分及正赛、排位、冲刺分类成绩。开启赛季页面时会检查 Jolpica，并在浏览器保存后续更新。
- `dist/season-2026/` 保存已有分站的 OpenF1 正赛计时、轮胎、进站、天气及赛会消息。赛季页面可预览和下载各站档案。
- `dist/events.json` 保存用于互动分析的比赛子集和排位遥测。走线由公开定位采样插值，同步回放以所选圈的各自开始时间为零点。
- `dist/lab-2026/` 按轮保存 2026 实验室数据。正赛沿用 OpenF1 档案，排位轨迹来自 F1Archive。数据保留能完整对齐的排位圈，其余车手仍可用正赛圈速对比。

数据来源：[Jolpica F1](https://github.com/jolpica/jolpica-f1)、[OpenF1](https://openf1.org/docs/)、[F1Archive](https://f1archive.org/docs)。

从项目目录运行以下命令可刷新快照。需要联网，建议使用新的缓存目录获取可能修订的数据。赛季正赛归档如已存在，脚本会保留该站已有文件。

```sh
python3 -B data-tools/pull_openf1.py --cache /tmp/raceopic-archive
python3 -B data-tools/pull_season.py --cache /tmp/raceopic-2026 --output dist all
python3 -B data-tools/pull_season.py --cache /tmp/raceopic-2026 --output dist telemetry
python3 -B data-tools/build_dataset.py /tmp/raceopic-archive dist/events.json /tmp/raceopic-2026
python3 -B data-tools/build_season_lab.py --cache /tmp/raceopic-season-lab --dist dist
```
