'use strict';

// Weather along the race: track and air temperature per lap, rain marked, on the pace chart's lap axis.
function renderWeather() {
  const rows = state.event.weather || [];
  const block = $('weatherChart');
  if (!rows.length) {
    block.innerHTML = `<p class="note">${L('这一站没有天气记录。', 'No weather record for this race.')}</p>`;
    $('weatherLegend').textContent = '';
    return;
  }
  const n = state.event.totalLaps;
  // Same horizontal mapping as the pace chart (laps between x = 38 and 680 of 700).
  const x = lap => 38 + (lap - 1) / Math.max(1, n - 1) * 642;
  const temps = rows.flatMap(r => [r.track, r.air]).filter(v => v != null);
  const low = Math.floor(Math.min(...temps) / 5) * 5;
  const high = Math.max(low + 5, Math.ceil(Math.max(...temps) / 5) * 5);
  const y = v => 66 - (v - low) / (high - low) * 56;
  const line = key => rows.filter(r => r[key] != null && r.lap <= n)
    .map((r, i) => `${i ? 'L' : 'M'}${x(r.lap).toFixed(1)} ${y(r[key]).toFixed(1)}`).join(' ');
  const step = 642 / Math.max(1, n - 1);
  const rain = rows.filter(r => r.rain && r.lap <= n)
    .map(r => `<rect class="weather-rain" x="${x(r.lap) - step / 2}" width="${step}" y="4" height="66"><title>${L(`第 ${r.lap} 圈 · 降雨`, `Lap ${r.lap} · rain`)}</title></rect>`).join('');
  block.innerHTML = `<svg viewBox="0 0 700 74" preserveAspectRatio="none" role="img"
      aria-label="${L('每圈赛道温度与气温，降雨圈以蓝色标出', 'Track and air temperature by lap, rain laps in blue')}">
    ${rain}
    <text class="chart-label" x="1" y="${y(high) + 4}">${high}°</text><text class="chart-label" x="1" y="${y(low) + 2}">${low}°</text>
    <path class="weather-track" d="${line('track')}"/><path class="weather-air" d="${line('air')}"/></svg>`;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const rainy = rows.filter(r => r.rain).length;
  $('weatherLegend').innerHTML =
    `<span><i class="swatch weather-swatch-track"></i>${L('赛道', 'Track')} ${first.track}° → ${last.track}°</span>` +
    `<span><i class="swatch weather-swatch-air"></i>${L('气温', 'Air')} ${first.air ?? '—'}° → ${last.air ?? '—'}°</span>` +
    (rainy ? `<span><i class="swatch weather-swatch-rain"></i>${L(`降雨 ${rainy} 圈`, `rain on ${rainy} laps`)}</span>` : '');
}
