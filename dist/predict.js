'use strict';

// Renders the committed pre-race strategy forecasts, a picker between races, and the season record.
(() => {
  const NAMES = {
    'Las Vegas': L('拉斯维加斯', 'Las Vegas'), 'Lusail': L('卡塔尔', 'Qatar'), 'Yas Marina Circuit': L('阿布扎比', 'Abu Dhabi'),
  };
  const TYRE = {S: [L('软', 'soft'), 'tyre-S'], M: [L('中性', 'medium'), 'tyre-M'], H: [L('硬', 'hard'), 'tyre-H'],
    I: [L('半雨', 'intermediate'), 'tyre-I'], W: [L('全雨', 'wet'), 'tyre-W']};
  const el = id => document.getElementById(id);
  const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const when = iso => new Date(iso).toLocaleString(L('zh-CN', 'en-GB'), {month: L('numeric', 'short'), day: 'numeric', hour: '2-digit', minute: '2-digit'});
  const place = race => NAMES[race.circuit || race.location] || race.circuit || race.location;
  const raceName = race => L(`${place(race)}大奖赛`, `${place(race)} Grand Prix`);
  const stopsText = n => L(`${n} 停`, `${n} stop${n === 1 ? '' : 's'}`);
  const years = list => list.join(L('、', ', '));
  const CONDITIONS = {dry: L('干地', 'dry'), mixed: L('干湿混合', 'mixed'), wet: L('雨战', 'wet')};
  const counts = r => r && r.counts_toward_record !== false;
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

  function practiceLine(data) {
    // Say what practice gave the model: used, rained out, no long runs, or not run yet.
    const status = data.practice_status;
    const sessions = status ? status.sessions_run.map(name => name.replace('Practice ', 'FP')).join(L('、', ', ')) : '';
    if (data.uses_practice) return L('本次预测已用上今年练习赛的长距离数据。', 'This forecast uses this year\'s practice long runs.');
    if (status?.state === 'wet') return L(`今年的练习赛（${sessions}）在雨中进行，只用了半雨胎和全雨胎，没有可用的干地长距离，本次预测只用历史数据。`,
      `This year's practice (${sessions}) ran in the wet on intermediates and wets, with no dry long runs, so this forecast uses history only.`);
    if (status?.state === 'used' && !data.practice_weight) return L('回测显示练习赛模拟在这条赛道没有帮助，本次预测只用历史数据。',
      'Backtests show the practice simulation does not help at this circuit, so this forecast uses history only.');
    if (status?.state === 'no_long_runs') return L(`今年的练习赛（${sessions}）没有足够的长距离，本次预测只用历史数据。`,
      `This year's practice (${sessions}) had no usable long runs, so this forecast uses history only.`);
    return L('今年的练习赛数据尚未产生，本次预测只用历史数据；练习赛后会重新生成。', 'This year\'s practice has not run yet, so this forecast uses history only; it is regenerated after practice.');
  }

  function render(data, file) {
    const {race, prediction: p, result: r, baseline_backtest: bt} = data;
    const locked = race.date_start && new Date(data.created) < new Date(race.date_start);
    el('predictionEyebrow').textContent = `${L('赛前策略预测', 'Pre-race strategy forecast')} · ${race.year}`;
    el('predictionTitle').textContent = `${raceName(race)}${L('：', ': ')}${r ? L('赛后成绩', 'scored') : L('预测已锁定', 'forecast locked')}`;
    el('predictionSource').href = `predictions/${file}`;
    const history = years(data.history.map(h => h.year));
    el('predictionLead').textContent = L(
      `生成于 ${when(data.created)}${locked ? '，早于正赛发车' : ''}。基于 ${history} 年同站数据，越近的年份权重越高。` +
        (r ? '' : `正赛 ${race.date_start ? when(race.date_start) : ''} 结束后用 OpenF1 实际轮胎记录打分。`) +
        '本预测假设干地比赛；若正赛下雨，仍会打分但不计入整季记录。',
      `Created ${when(data.created)}${locked ? ', before lights out' : ''}. Built on ${history} at this circuit, recent years weighted more. ` +
        (r ? '' : `Scored against OpenF1 tyre records after the race on ${race.date_start ? when(race.date_start) : ''}. `) +
        'It assumes a dry race; a wet race is still scored but left out of the season record.');

    const stops = p.most_likely_stops;
    const top = p.top_sequences[0];
    const w = p.first_stop_window;
    el('predictionCards').innerHTML = [
      card(L('预测停站次数', 'Predicted stops'), stopsText(stops), `${L('概率', 'probability')} ${pct(p.stop_probabilities[stops])}`, true),
      card(L('首选配方顺序', 'Most likely compounds'), chips(top.sequence), `${L('概率', 'probability')} ${pct(top.probability)}`),
      card(L('首停窗口', 'First-stop window'), `L${w.from}–L${w.to}`, L(`中位数第 ${w.median} 圈`, `median lap ${w.median}`)),
      r ? card(L('赛后：停站次数命中', 'After the race: stops correct'), pct(r.stop_count_hit_rate),
        L(`首停误差 ${r.first_stop_mae_laps ?? '—'} 圈 · ${r.drivers} 位车手`, `first-stop error ${r.first_stop_mae_laps ?? '—'} laps · ${r.drivers} drivers`) +
        (counts(r) ? '' : L(` · ${CONDITIONS[r.conditions] || r.conditions}比赛，不计入整季记录`, ` · ${CONDITIONS[r.conditions] || r.conditions} race, not in the season record`)))
        : card(L('赛后：准确度', 'After the race: accuracy'), L('待比赛', 'Pending'), L('比赛结束后自动填入', 'Filled in once the race is scored')),
    ].join('');

    el('stopBars').innerHTML = Object.entries(p.stop_probabilities).map(([k, v]) => `
      <div class="stop-row${Number(k) === stops ? ' best' : ''}">
        <span>${stopsText(Number(k))}</span><div class="stop-track"><div style="width:${(v * 100).toFixed(1)}%"></div></div><span class="numeric">${pct(v)}</span>
      </div>`).join('');
    el('sequenceList').innerHTML = p.top_sequences.map(s =>
      `<li><span class="sequence">${chips(s.sequence)}</span><span class="numeric">${pct(s.probability)}</span></li>`).join('');

    const extra = data.notes_zh?.length || 0;
    const notes = L(data.notes_zh || [], extra ? (data.caveats || []).slice(-extra) : []);
    if (data.backtests?.length) {
      // Every backtested edition: history alone vs history + that year's practice at each tried weight.
      const chosen = data.practice_weight ?? 0;
      const weights = Object.keys(data.backtests[0].by_weight ?? {'0.0': null});
      const label = w => Number(w) === 0 ? L('仅历史', 'History only') : L(`历史 + 练习赛 ${Math.round(Number(w) * 100)}%`, `History + ${Math.round(Number(w) * 100)}% practice`);
      const rows = data.backtests.flatMap(b => Object.entries(b.by_weight ?? {'0.0': b.history_only}).map(([wt, s]) => `
        <tr${Number(wt) === chosen ? ' class="chosen"' : ''}><th scope="row">${b.target_year}</th><td>${label(wt)}</td>
          <td class="numeric">${pct(s.stop_count_hit_rate)}</td><td class="numeric">${pct(s.first_stop_in_window)}</td>
          <td class="numeric">${s.first_stop_mae_laps ?? '—'}</td><td class="numeric">${s.stop_count_brier}</td></tr>`)).join('');
      const brier = data.weight_selection?.mean_brier ?? {};
      const targets = years(data.backtests.map(b => b.target_year));
      const choice = weights.map(wt => `${label(wt)} ${brier[wt] ?? '—'}`).join(L('，', ', '));
      el('predictionBacktest').innerHTML = `
        <p><strong>${L('回测', 'Backtest')}</strong>${L('：', ': ')}${L(`用更早的年份预测 ${targets} 年，再和实际结果比对。`, `earlier years predict ${targets}, then are checked against what happened. `)}
        ${weights.length > 1 ? (() => {
          const pooled = data.weight_selection?.pooled_over?.length;
          return pooled
            ? L(`练习赛模拟的占比取所有赛道合并的 ${pooled} 个回测中平均 Brier 分数（越低越好）最低者：${choice}，采用「${label(chosen)}」。只看单一赛道两届的结果容易选到运气，因此不按赛道各自挑选。`,
                `The practice share is the one with the lowest mean Brier score (lower is better) over all ${pooled} backtests pooled across circuits: ${choice}; using “${label(chosen)}”. With two editions per circuit, choosing per circuit would mostly fit luck. `)
            : L(`练习赛模拟的占比按平均 Brier 分数（越低越好）自动选择：${choice}，采用「${label(chosen)}」。`,
                `The practice share is picked by mean Brier score (lower is better): ${choice}; using “${label(chosen)}”. `);
        })() : ''}
        ${practiceLine(data)}</p>
        <div class="standings-scroll"><table class="sports-table backtest-table">
          <thead><tr><th scope="col">${L('年份', 'Year')}</th><th scope="col">${L('模型', 'Model')}</th><th scope="col">${L('停站次数命中', 'Stops correct')}</th>
            <th scope="col">${L('首停在窗口内', 'First stop in window')}</th><th scope="col">${L('首停误差（圈）', 'First-stop error (laps)')}</th><th scope="col">Brier</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        ${notes.length ? `<p class="backtest-note">${L('注意：', 'Note: ')}${notes.map(esc).join(' ')}</p>` : ''}
        <p class="backtest-note">${L('可回测的届数很少，差距很小；赛道演进强的周末，练习赛长距离常常越跑越快，轮胎衰退难以量测。',
          'Only a few editions can be backtested and the differences are small; on weekends with strong track evolution, practice long runs often get faster with tyre age, so degradation is hard to measure.')}</p>`;
    } else if (bt) {
      const s = bt.score;
      el('predictionBacktest').innerHTML = L(
        `<strong>基准回测</strong>：只用 ${years(bt.trained_on)} 年数据预测 ${bt.target_year} 年，停站次数命中 ${pct(s.stop_count_hit_rate)}，首选配方命中 ${pct(s.top_sequence_hit_rate)}，首停落在窗口内 ${pct(s.first_stop_in_window)}，首停平均误差 ${s.first_stop_mae_laps} 圈。`,
        `<strong>Baseline backtest</strong>: ${years(bt.trained_on)} predicting ${bt.target_year} got the stop count right ${pct(s.stop_count_hit_rate)}, the top compounds ${pct(s.top_sequence_hit_rate)}, the first stop in window ${pct(s.first_stop_in_window)}, first-stop error ${s.first_stop_mae_laps} laps.`);
    } else {
      el('predictionBacktest').innerHTML = '';
    }
  }

  function renderRecord(forecasts) {
    // One row per race: what was forecast, and how it scored once the race ran.
    const rows = forecasts.map(({data}) => {
      const {race, prediction: p, result: r} = data;
      return `<tr><th scope="row">${esc(place(race))}</th><td class="numeric">${race.date_start ? when(race.date_start) : '—'}</td>
        <td>${stopsText(p.most_likely_stops)} · ${chips(p.top_sequences[0].sequence)}</td>
        <td class="numeric">L${p.first_stop_window.from}–L${p.first_stop_window.to}</td>
        <td class="numeric">${r ? pct(r.stop_count_hit_rate) + (counts(r) ? '' : ` <small>(${CONDITIONS[r.conditions] || r.conditions})</small>`) : L('待比赛', 'Pending')}</td>
        <td class="numeric">${r ? pct(r.first_stop_in_window) : '—'}</td>
        <td class="numeric">${r ? r.stop_count_brier : '—'}</td></tr>`;
    }).join('');
    // Wet or mixed races are shown but kept out of the averages: the forecast assumed a dry race.
    const scored = forecasts.filter(f => counts(f.data.result));
    const mean = key => scored.length ? scored.reduce((sum, f) => sum + f.data.result[key], 0) / scored.length : null;
    el('forecastRecord').innerHTML = `
      <h3>${L('整季预测记录', 'Season forecast record')}</h3>
      <div class="standings-scroll"><table class="sports-table record-table">
        <thead><tr><th scope="col">${L('分站', 'Race')}</th><th scope="col">${L('正赛', 'Start')}</th><th scope="col">${L('预测', 'Forecast')}</th>
          <th scope="col">${L('首停窗口', 'First-stop window')}</th><th scope="col">${L('停站次数命中', 'Stops correct')}</th>
          <th scope="col">${L('首停在窗口内', 'First stop in window')}</th><th scope="col">Brier</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th scope="row">${L(`已打分 ${forecasts.filter(f => f.data.result).length} · 计入记录 ${scored.length} / ${forecasts.length}`,
          `Scored ${forecasts.filter(f => f.data.result).length} · in record ${scored.length} / ${forecasts.length}`)}</th><td></td><td></td><td></td>
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
