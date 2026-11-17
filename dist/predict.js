'use strict';

// Renders the committed pre-race strategy forecast (and its post-race score, once present).
(() => {
  const FILE = 'predictions/2026-las-vegas.json';
  const NAMES = {'Las Vegas': '拉斯维加斯'};
  const TYRE = {S: ['软', 'tyre-S'], M: ['中性', 'tyre-M'], H: ['硬', 'tyre-H'], I: ['半雨', 'tyre-I'], W: ['全雨', 'tyre-W']};
  const el = id => document.getElementById(id);
  const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const when = iso => new Date(iso).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  const chips = seq => seq.split('-').map(c => {
    const [label, cls] = TYRE[c] || [c, ''];
    return `<span class="tyre-chip ${cls}" title="${label}">${esc(c)}</span>`;
  }).join('<span class="tyre-arrow" aria-hidden="true">→</span>');
  const card = (label, value, note, accent) =>
    `<article${accent ? ' class="accent"' : ''}><span class="label">${label}</span><strong>${value}</strong><small>${note}</small></article>`;

  async function init() {
    let data;
    try {
      const response = await fetch(FILE, {cache: 'no-cache'});
      if (!response.ok) return;
      data = await response.json();
    } catch {
      return;
    }
    const {race, prediction: p, result: r, baseline_backtest: bt} = data;
    const place = NAMES[race.location] || race.location;
    const locked = race.date_start && new Date(data.created) < new Date(race.date_start);
    el('predictionEyebrow').textContent = `赛前策略预测 · ${race.year}`;
    el('predictionTitle').textContent = `${place}大奖赛：${r ? '赛后成绩' : '预测已锁定'}`;
    el('predictionLead').textContent =
      `生成于 ${when(data.created)}${locked ? '，早于正赛发车' : ''}。` +
      `基于 ${data.history.map(h => h.year).join('、')} 年同站数据，越近的年份权重越高。` +
      (r ? '' : `正赛 ${race.date_start ? when(race.date_start) : ''} 结束后用 OpenF1 实际轮胎记录打分。`);

    const stops = p.most_likely_stops;
    const top = p.top_sequences[0];
    const w = p.first_stop_window;
    el('predictionCards').innerHTML = [
      card('预测停站次数', `${stops} 停`, `概率 ${pct(p.stop_probabilities[stops])}`, true),
      card('首选配方顺序', chips(top.sequence), `概率 ${pct(top.probability)}`),
      card('首停窗口', `L${w.from}–L${w.to}`, `中位数第 ${w.median} 圈`),
      r ? card('赛后：停站次数命中', pct(r.stop_count_hit_rate), `首停误差 ${r.first_stop_mae_laps ?? '—'} 圈 · ${r.drivers} 位车手`)
        : card('赛后：准确度', '待比赛', '比赛结束后自动填入'),
    ].join('');

    el('stopBars').innerHTML = Object.entries(p.stop_probabilities).map(([k, v]) => `
      <div class="stop-row${Number(k) === stops ? ' best' : ''}">
        <span>${k} 停</span><div class="stop-track"><div style="width:${(v * 100).toFixed(1)}%"></div></div><span class="numeric">${pct(v)}</span>
      </div>`).join('');
    el('sequenceList').innerHTML = p.top_sequences.map(s =>
      `<li><span class="sequence">${chips(s.sequence)}</span><span class="numeric">${pct(s.probability)}</span></li>`).join('');

    if (bt) {
      const s = bt.score;
      el('predictionBacktest').innerHTML =
        `<strong>基准回测</strong>：只用 ${bt.trained_on.join('、')} 年数据预测 ${bt.target_year} 年，` +
        `停站次数命中 ${pct(s.stop_count_hit_rate)}，首选配方命中 ${pct(s.top_sequence_hit_rate)}，` +
        `首停落在窗口内 ${pct(s.first_stop_in_window)}，首停平均误差 ${s.first_stop_mae_laps} 圈。` +
        `纯历史频率模型跟不上逐年变化，这是之后改进要超越的基线。`;
    }
    el('prediction').hidden = false;
  }

  init();
})();
