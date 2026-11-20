'use strict';

// Teammate head-to-head across the season: qualifying and race-pace gap per round for one pair.
(() => {
  const el = id => document.getElementById(id);
  const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(3)}`;

  function render(pair) {
    const [a, b] = pair.drivers;
    const s = pair.summary;
    el('teammateSummary').innerHTML = L(
      `排位 <strong>${a} ${s.quali_ahead[0]} : ${s.quali_ahead[1]} ${b}</strong>（中位差 ${s.quali_median == null ? '—' : signed(s.quali_median) + ' 秒'}）· ` +
        `正赛配速 <strong>${a} ${s.race_ahead[0]} : ${s.race_ahead[1]} ${b}</strong>（中位差 ${s.race_median == null ? '—' : signed(s.race_median) + ' 秒'}）`,
      `Qualifying <strong>${a} ${s.quali_ahead[0]} : ${s.quali_ahead[1]} ${b}</strong> (median ${s.quali_median == null ? '—' : signed(s.quali_median) + ' s'}) · ` +
        `Race pace <strong>${a} ${s.race_ahead[0]} : ${s.race_ahead[1]} ${b}</strong> (median ${s.race_median == null ? '—' : signed(s.race_median) + ' s'})`);
    const gaps = pair.rounds.flatMap(r => [r.quali, r.race]).filter(v => v != null).map(Math.abs).sort((x, y) => x - y);
    const span = Math.max(.2, Math.ceil((gaps[Math.floor(gaps.length * .9)] || .2) * 10) / 10);
    const rounds = pair.rounds;
    const slot = 940 / Math.max(rounds.length, 1);
    const x = i => 40 + i * slot;
    // Above the line: the first driver was faster (negative gap), below: the second.
    const y = v => 130 + Math.max(-span, Math.min(span, v)) / span * 110;
    let grid = '';
    for (const v of [-span, -span / 2, 0, span / 2, span]) {
      grid += `<line class="chart-grid" x1="40" x2="980" y1="${y(v)}" y2="${y(v)}" ${v ? 'stroke-dasharray="3 5"' : ''}/>
        <text class="chart-label" x="2" y="${y(v) + 4}">${v ? `${Math.abs(v).toFixed(1)}s` : '0'}</text>`;
    }
    const bars = rounds.map((r, i) => {
      const parts = [['quali', r.quali, .12], ['race', r.race, .52]].map(([kind, v, offset]) => {
        if (v == null) return '';
        const top = Math.min(y(0), y(v));
        const height = Math.max(1.5, Math.abs(y(v) - y(0)));
        const who = v < 0 ? 'a' : 'b';
        const session = kind === 'quali' && r.quali_session ? ` (${r.quali_session === 'telemetry' ? L('遥测', 'telemetry') : r.quali_session})` : '';
        const label = `${kind === 'quali' ? L('排位', 'Qualifying') : L('正赛配速', 'Race pace')}${session} · ${v < 0 ? a : b} ${L('快', 'faster by')} ${Math.abs(v).toFixed(3)} ${L('秒', 's')}`;
        return `<rect class="tm-bar tm-${kind} tm-${who}" x="${x(i) + slot * offset}" width="${slot * .36}" y="${top}" height="${height}"><title>R${r.round} · ${label}</title></rect>`;
      }).join('');
      return `<a href="index.html?race=${encodeURIComponent(r.id)}&a=${a}&b=${b}" aria-label="R${r.round} ${gpName(r.name)}">${parts}</a>
        <text class="chart-label" x="${x(i) + slot / 2}" y="262" text-anchor="middle">${r.round}</text>`;
    }).join('');
    el('teammateChart').innerHTML = `<svg viewBox="0 0 1000 270" preserveAspectRatio="none" role="img"
      aria-label="${L(`${a} 与 ${b} 每站的排位与正赛配速差距`, `${a} vs ${b}: qualifying and race-pace gap by round`)}">
      ${grid}<text class="chart-label tm-side" x="44" y="26">${L(`${a} 更快`, `${a} faster`)}</text>
      <text class="chart-label tm-side" x="44" y="244">${L(`${b} 更快`, `${b} faster`)}</text>${bars}</svg>`;
    el('teammateLegend').innerHTML =
      `<span><i class="swatch tm-legend-quali"></i>${L('排位差距（官方）', 'Qualifying gap (official)')}</span>` +
      `<span><i class="swatch tm-legend-race"></i>${L('正赛配对圈中位差', 'Race-pace gap')}</span>`;
  }

  async function init() {
    let pairs;
    try {
      const response = await fetch('teammates-2026.json', {cache: 'no-cache'});
      if (!response.ok) return;
      pairs = await response.json();
    } catch {
      return;
    }
    if (!pairs.length) return;
    const select = el('teammatePair');
    select.replaceChildren(...pairs.map((p, i) => new Option(
      `${p.team} · ${p.drivers.join(' vs ')} · ${L(`${p.rounds.length} 站`, `${p.rounds.length} rounds`)}`, i)));
    select.onchange = () => render(pairs[Number(select.value)]);
    // Open on Mercedes, the team whose colours the site wears; otherwise the first pair.
    const start = Math.max(0, pairs.findIndex(p => p.team === 'Mercedes'));
    select.value = start;
    render(pairs[start]);
    el('teammates').hidden = false;
  }

  init();
})();
