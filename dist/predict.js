'use strict';

// Renders the committed pre-race strategy forecasts, a picker between races, and the season record.
(() => {
  const NAMES = {'Las Vegas': '拉斯维加斯', 'Lusail': '卡塔尔', 'Yas Marina Circuit': '阿布扎比'};
  const TYRE = {S: ['软', 'tyre-S'], M: ['中性', 'tyre-M'], H: ['硬', 'tyre-H'], I: ['半雨', 'tyre-I'], W: ['全雨', 'tyre-W']};
  const el = id => document.getElementById(id);
  const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const when = iso => new Date(iso).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  const place = race => NAMES[race.circuit || race.location] || race.circuit || race.location;
  const chips = seq => seq.split('-').map(c => {
    const [label, cls] = TYRE[c] || [c, ''];
    return `<span class="tyre-chip ${cls}" title="${label}">${esc(c)}</span>`;
  }).join('<span class="tyre-arrow" aria-hidden="true">→</span>');
  const card = (label, value, note, accent) =>
    `<article${accent ? ' class="accent"' : ''}><span class="label">${label}</span><strong>${value}</strong><small>${note}</small></article>`;

  async function readJson(url) {
    const response = await fetch(url, {cache: 'no-cache'});
    if (!response.ok) throw new Error(url);
    return response.json();
  }

  function render(data, file) {
    const {race, prediction: p, result: r, baseline_backtest: bt} = data;
    const locked = race.date_start && new Date(data.created) < new Date(race.date_start);
    el('predictionEyebrow').textContent = `赛前策略预测 · ${race.year}`;
    el('predictionTitle').textContent = `${place(race)}大奖赛：${r ? '赛后成绩' : '预测已锁定'}`;
    el('predictionSource').href = `predictions/${file}`;
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

    const notes = data.notes_zh || [];
    if (data.backtests?.length) {
      // Every backtested edition: history alone vs history + that year's practice at each tried weight.
      const chosen = data.practice_weight ?? 0;
      const weights = Object.keys(data.backtests[0].by_weight ?? {'0.0': null});
      const label = w => Number(w) === 0 ? '仅历史' : `历史 + 练习赛 ${Math.round(Number(w) * 100)}%`;
      const rows = data.backtests.flatMap(b => Object.entries(b.by_weight ?? {'0.0': b.history_only}).map(([w, s]) => `
        <tr${Number(w) === chosen ? ' class="chosen"' : ''}><th scope="row">${b.target_year}</th><td>${label(w)}</td>
          <td class="numeric">${pct(s.stop_count_hit_rate)}</td><td class="numeric">${pct(s.first_stop_in_window)}</td>
          <td class="numeric">${s.first_stop_mae_laps ?? '—'}</td><td class="numeric">${s.stop_count_brier}</td></tr>`)).join('');
      const brier = data.weight_selection?.mean_brier ?? {};
      el('predictionBacktest').innerHTML = `
        <p><strong>回测</strong>：用更早的年份预测 ${data.backtests.map(b => b.target_year).join('、')} 年，再和实际结果比对。
        ${weights.length > 1 ? `练习赛模拟的占比按平均 Brier 分数（越低越好）自动选择：${weights.map(w => `${label(w)} ${brier[w] ?? '—'}`).join('，')}，采用「${label(chosen)}」。` : ''}
        ${data.uses_practice ? '本次预测已用上今年练习赛的长距离数据。' : '今年的练习赛数据尚未产生，本次预测只用历史数据；练习赛后会重新生成。'}</p>
        <div class="standings-scroll"><table class="sports-table backtest-table">
          <thead><tr><th scope="col">年份</th><th scope="col">模型</th><th scope="col">停站次数命中</th>
            <th scope="col">首停在窗口内</th><th scope="col">首停误差（圈）</th><th scope="col">Brier</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        ${notes.length ? `<p class="backtest-note">注意：${notes.map(esc).join(' ')}</p>` : ''}
        <p class="backtest-note">可回测的届数很少，差距很小；赛道演进强的周末，练习赛长距离常常越跑越快，轮胎衰退难以量测。</p>`;
    } else if (bt) {
      const s = bt.score;
      el('predictionBacktest').innerHTML =
        `<strong>基准回测</strong>：只用 ${bt.trained_on.join('、')} 年数据预测 ${bt.target_year} 年，` +
        `停站次数命中 ${pct(s.stop_count_hit_rate)}，首选配方命中 ${pct(s.top_sequence_hit_rate)}，` +
        `首停落在窗口内 ${pct(s.first_stop_in_window)}，首停平均误差 ${s.first_stop_mae_laps} 圈。`;
    } else {
      el('predictionBacktest').innerHTML = '';
    }
  }

  function renderRecord(forecasts) {
    // One row per race: what was forecast, and how it scored once the race ran.
    const rows = forecasts.map(({data}) => {
      const {race, prediction: p, result: r} = data;
      return `<tr><th scope="row">${esc(place(race))}</th><td class="numeric">${race.date_start ? when(race.date_start) : '—'}</td>
        <td>${p.most_likely_stops} 停 · ${chips(p.top_sequences[0].sequence)}</td>
        <td class="numeric">L${p.first_stop_window.from}–L${p.first_stop_window.to}</td>
        <td class="numeric">${r ? pct(r.stop_count_hit_rate) : '待比赛'}</td>
        <td class="numeric">${r ? pct(r.first_stop_in_window) : '—'}</td>
        <td class="numeric">${r ? r.stop_count_brier : '—'}</td></tr>`;
    }).join('');
    const scored = forecasts.filter(f => f.data.result);
    const mean = key => scored.length ? scored.reduce((sum, f) => sum + f.data.result[key], 0) / scored.length : null;
    el('forecastRecord').innerHTML = `
      <h3>整季预测记录</h3>
      <div class="standings-scroll"><table class="sports-table record-table">
        <thead><tr><th scope="col">分站</th><th scope="col">正赛</th><th scope="col">预测</th><th scope="col">首停窗口</th>
          <th scope="col">停站次数命中</th><th scope="col">首停在窗口内</th><th scope="col">Brier</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th scope="row">已完赛 ${scored.length} / ${forecasts.length}</th><td></td><td></td><td></td>
          <td class="numeric">${scored.length ? pct(mean('stop_count_hit_rate')) : '—'}</td>
          <td class="numeric">${scored.length ? pct(mean('first_stop_in_window')) : '—'}</td>
          <td class="numeric">${scored.length ? mean('stop_count_brier').toFixed(3) : '—'}</td></tr></tfoot>
      </table></div>`;
  }

  async function init() {
    let forecasts;
    try {
      const index = await readJson('predictions/index.json');
      forecasts = await Promise.all(index.map(async entry => ({file: entry.file, data: await readJson(`predictions/${entry.file}`)})));
    } catch {
      return;
    }
    if (!forecasts.length) return;
    // Open on the next race still to run; after the season, on the last one.
    const now = Date.now();
    let current = forecasts.findIndex(f => !f.data.result && new Date(f.data.race.date_start) > now - 6 * 3600e3);
    if (current < 0) current = forecasts.length - 1;
    const pick = index => {
      current = index;
      for (const [i, button] of [...el('forecastPicker').children].entries()) button.setAttribute('aria-pressed', i === index);
      render(forecasts[index].data, forecasts[index].file);
    };
    el('forecastPicker').replaceChildren(...forecasts.map(({data}, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place(data.race);
      button.onclick = () => pick(i);
      return button;
    }));
    el('forecastPicker').hidden = forecasts.length < 2;
    renderRecord(forecasts);
    pick(current);
    el('prediction').hidden = false;
  }

  init();
})();
