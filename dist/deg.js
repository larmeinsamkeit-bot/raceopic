'use strict';

// Tyre degradation: each stint's clean laps, fuel-corrected, against tyre age, with a fitted slope.
const FUEL_PER_LAP = .06; // s/lap gained as fuel burns, the same value the forecast model uses
const COMPOUND_COLOUR = {SOFT: '#ed7476', MEDIUM: '#e6ca66', HARD: '#f2f6f7', INTERMEDIATE: '#63c893', WET: '#73a9e5'};

function stintRuns(driver) {
  return driver.stints.map(stint => {
    const laps = driver.laps.filter(r => r.lap >= stint.start && r.lap <= stint.end
      && r.time != null && !r.excluded && !r.neutralized && r.age != null)
      .map(r => ({age: r.age, time: r.time + FUEL_PER_LAP * r.lap, lap: r.lap}));
    // Drop traffic and slow laps: keep laps within 2% of the stint's median.
    const sorted = laps.map(r => r.time).sort((a, b) => a - b);
    const middle = sorted[sorted.length >> 1];
    const clean = laps.filter(r => r.time <= middle * 1.02);
    let slope = null;
    if (clean.length >= 5) {
      const ma = clean.reduce((s, r) => s + r.age, 0) / clean.length;
      const mt = clean.reduce((s, r) => s + r.time, 0) / clean.length;
      const sxx = clean.reduce((s, r) => s + (r.age - ma) ** 2, 0);
      slope = sxx ? clean.reduce((s, r) => s + (r.age - ma) * (r.time - mt), 0) / sxx : null;
    }
    return {stint, laps: clean, slope};
  }).filter(run => run.laps.length >= 3);
}

function renderDeg() {
  const drivers = pair();
  const runs = drivers.map(stintRuns);
  const all = runs.flat();
  if (!all.length) {
    $('degChart').innerHTML = '';
    $('degTable').innerHTML = '';
    $('degNote').textContent = L('这组车手没有足够的干净长距离可画轮胎衰退。', 'Not enough clean running to plot tyre degradation for this pair.');
    return;
  }
  const best = Math.min(...all.flatMap(r => r.laps.map(l => l.time)));
  const values = all.flatMap(r => r.laps.map(l => l.time - best)).sort((a, b) => a - b);
  const top = Math.max(1, Math.ceil(values[Math.floor(values.length * .97)] * 2) / 2);
  const maxAge = Math.max(...all.flatMap(r => r.laps.map(l => l.age)));
  const x = age => 40 + age / Math.max(1, maxAge) * 940;
  // Slower is higher, so a worn tyre's line climbs.
  const y = t => 234 - Math.min(t, top) / top * 220;
  let grid = '';
  for (let v = 0; v <= top + 1e-9; v += top / 4) {
    grid += `<line class="chart-grid" x1="40" x2="980" y1="${y(v)}" y2="${y(v)}" stroke-dasharray="3 5"/>
      <text class="chart-label" x="2" y="${y(v) + 4}">+${v.toFixed(1)}s</text>`;
  }
  for (let age = 0; age <= maxAge; age += maxAge > 30 ? 10 : 5) {
    grid += `<text class="chart-label" x="${x(age)}" y="254" text-anchor="middle">${age}</text>`;
  }
  const lines = runs.flatMap((list, i) => list.map(run => {
    const colour = COMPOUND_COLOUR[run.stint.compound] || '#90a1a4';
    const dots = run.laps.map(l => `<circle cx="${x(l.age)}" cy="${y(l.time - best)}" r="2.6" fill="${colour}" opacity=".55"/>`).join('');
    let fit = '';
    if (run.slope != null) {
      const a0 = Math.min(...run.laps.map(l => l.age));
      const a1 = Math.max(...run.laps.map(l => l.age));
      const ma = run.laps.reduce((s, l) => s + l.age, 0) / run.laps.length;
      const mt = run.laps.reduce((s, l) => s + l.time, 0) / run.laps.length - best;
      const at = age => mt + run.slope * (age - ma);
      fit = `<line class="deg-fit deg-${i}" x1="${x(a0)}" y1="${y(at(a0))}" x2="${x(a1)}" y2="${y(at(a1))}" stroke="${colour}"/>`;
    }
    return `<g><title>${drivers[i].code} · ${tyres[run.stint.compound]?.[1] ?? run.stint.compound}</title>${dots}${fit}</g>`;
  })).join('');
  $('degChart').innerHTML = `<svg viewBox="0 0 1000 262" preserveAspectRatio="none" role="img"
      aria-label="${L('两位车手各段轮胎的燃油修正圈速与胎龄', 'Fuel-corrected lap time against tyre age for each stint of both drivers')}">${grid}${lines}</svg>`;
  $('degTable').innerHTML = `<table class="sports-table deg-table"><thead><tr>
      <th scope="col">${L('车手', 'Driver')}</th><th scope="col">${L('配方', 'Compound')}</th><th scope="col">${L('圈', 'Laps')}</th>
      <th scope="col">${L('衰退 秒/圈', 'Degradation s/lap')}</th></tr></thead><tbody>${
    runs.flatMap((list, i) => list.map(run => `<tr><th scope="row" class="driver-${i ? 'secondary' : 'primary'}">${drivers[i].code}</th>
      <td><span class="tyre-chip tyre-${tyres[run.stint.compound]?.[0] ?? ''}">${tyres[run.stint.compound]?.[0] ?? '?'}</span></td>
      <td class="numeric">${run.stint.start}–${run.stint.end}</td>
      <td class="numeric">${run.slope == null ? '—' : Math.abs(run.slope) < .0005 ? '0.000' : `${run.slope > 0 ? '+' : '−'}${Math.abs(run.slope).toFixed(3)}`}</td></tr>`)).join('')}</tbody></table>`;
  $('degNote').textContent = L(
    `每圈加回 ${FUEL_PER_LAP} 秒以抵消燃油减轻；只用非进出站、非安全车、且在该段中位数 2% 以内的圈。负值多半是赛道变快或车手提速，不代表轮胎变好。`,
    `Each lap gets ${FUEL_PER_LAP} s added back to offset the fuel burn; only laps away from pit stops and safety cars and within 2% of the stint median count. Negative values usually mean the track or the driver got faster, not the tyres.`);
}
