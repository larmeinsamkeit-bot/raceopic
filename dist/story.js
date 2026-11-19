'use strict';

// Race story: every driver's gap to the leader lap by lap, with pit stops and neutralised laps,
// the selected pair highlighted. A missing lap time is filled with that lap's field median.
const STORY_CLIP = 60; // s behind the leader shown; further back is pinned to the bottom edge

function raceHistory(event) {
  const total = event.totalLaps;
  const field = [];
  for (let lap = 1; lap <= total; lap++) {
    const times = event.drivers.map(d => d.laps.find(r => r.lap === lap)?.time).filter(t => t != null).sort((a, b) => a - b);
    field.push(times.length ? times[times.length >> 1] : null);
  }
  let estimated = 0;
  const drivers = event.drivers.filter(d => d.laps.length).map(driver => {
    const byLap = new Map(driver.laps.map(r => [r.lap, r]));
    const last = Math.max(...driver.laps.map(r => r.lap));
    const clock = [];
    let sum = 0;
    for (let lap = 1; lap <= last; lap++) {
      let time = byLap.get(lap)?.time;
      if (time == null) {
        time = field[lap - 1];
        estimated++;
      }
      if (time == null) break;
      sum += time;
      clock.push(sum);
    }
    return {driver, clock, pits: Object.keys(driver.pit || {}).map(Number)};
  });
  const leader = [];
  for (let lap = 1; lap <= total; lap++) {
    const done = drivers.map(d => d.clock[lap - 1]).filter(t => t != null);
    leader.push(done.length ? Math.min(...done) : null);
  }
  const neutral = [];
  for (let lap = 1; lap <= total; lap++) {
    if (event.drivers.some(d => d.laps.find(r => r.lap === lap)?.neutralized)) neutral.push(lap);
  }
  return {drivers, leader, neutral, estimated, total};
}

function positionsAt(history, lap) {
  return history.drivers.filter(d => d.clock[lap - 1] != null)
    .sort((a, b) => a.clock[lap - 1] - b.clock[lap - 1]).map(d => d.driver.id);
}

function renderStory() {
  const event = state.event;
  const history = raceHistory(event);
  const pairIds = pair().map(d => d.id);
  // Past races carry only a few selected drivers: no real positions, and the "leader" is the best of them.
  const fullField = history.drivers.length >= 15;
  $('storyTitle').textContent = fullField ? '比赛进程 · 与领先者的差距' : '比赛进程 · 与精选车手中最快者的差距';
  const n = history.total;
  const x = lap => 40 + (lap - 1) / Math.max(1, n - 1) * 940;
  const y = gap => 14 + Math.min(gap, STORY_CLIP) / STORY_CLIP * 236;
  const series = d => d.clock.map((t, i) => [x(i + 1), y(t - history.leader[i])]);
  let grid = '';
  for (const gap of [0, 15, 30, 45, 60]) {
    grid += `<line class="chart-grid" x1="40" x2="980" y1="${y(gap)}" y2="${y(gap)}" stroke-dasharray="3 5"/>
      <text class="chart-label" x="2" y="${y(gap) + 4}">${gap ? `+${gap}s` : fullField ? '领先' : '最快'}</text>`;
  }
  for (const lap of [1, ...[10, 20, 30, 40, 50, 60, 70].filter(l => l < n - 3), n]) {
    grid += `<text class="chart-label" x="${x(lap)}" y="272" text-anchor="middle">${lap}</text>`;
  }
  const neutral = history.neutral.map(lap =>
    `<rect class="story-neutral" x="${x(lap) - 470 / Math.max(1, n - 1)}" width="${940 / Math.max(1, n - 1)}" y="10" height="244"/>`).join('');
  const ordered = [...history.drivers].sort((a, b) => pairIds.includes(a.driver.id) - pairIds.includes(b.driver.id));
  const lines = ordered.map(d => {
    const index = pairIds.indexOf(d.driver.id);
    const cls = index < 0 ? 'story-field' : `chart-${index ? 'secondary' : 'primary'} story-pair`;
    const pts = series(d);
    const pits = d.pits.filter(lap => lap <= pts.length).map(lap =>
      `<circle class="story-pit ${index < 0 ? '' : `pit-${index}`}" cx="${pts[lap - 1][0]}" cy="${pts[lap - 1][1]}" r="${index < 0 ? 2.2 : 4}"/>`).join('');
    return `<g><title>${d.driver.code}</title><path class="${cls}" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}"/>${pits}</g>`;
  }).join('');
  $('storyChart').innerHTML = `<svg viewBox="0 0 1000 280" preserveAspectRatio="none" role="img"
      aria-label="全场车手每圈落后领先者的时间，所选两位车手高亮">
    ${neutral}${grid}${lines}<line id="storyCursor" class="chart-cursor" y1="10" y2="254" opacity="0"/></svg>`;
  $('storyNote').textContent = (fullField ? '' : `本站只收录 ${history.drivers.length} 位精选车手，不显示名次。`) +
    `灰线为其他车手，圆点为进站，阴影为安全车或虚拟安全车。落后超过 ${STORY_CLIP} 秒的车手贴在底边。` +
    (history.estimated ? `本站有 ${history.estimated} 圈缺失计时，按同圈全场中位数估算。` : '');
  const drivers = pair();
  const describe = lap => {
    const order = positionsAt(history, lap);
    return `第 ${lap} 圈 · ` + drivers.map(d => {
      const row = history.drivers.find(h => h.driver.id === d.id);
      const t = row?.clock[lap - 1];
      if (t == null) return `${d.code} 未完成`;
      const gap = t - history.leader[lap - 1];
      const place = fullField ? `P${order.indexOf(d.id) + 1}` : '';
      return [d.code, place, gap < .05 ? (fullField ? '领先' : '最快') : `+${gap.toFixed(1)}s`].filter(Boolean).join(' ');
    }).join(' / ');
  };
  $('storyReadout').textContent = describe(n);
  $('storyChart').onpointermove = event => {
    const rect = $('storyChart').getBoundingClientRect();
    const lap = clamp(Math.round(((event.clientX - rect.left) / rect.width * 1000 - 40) / 940 * (n - 1)) + 1, 1, n);
    $('storyCursor').setAttribute('x1', x(lap));
    $('storyCursor').setAttribute('x2', x(lap));
    $('storyCursor').setAttribute('opacity', 1);
    $('storyReadout').textContent = describe(lap);
  };
}
