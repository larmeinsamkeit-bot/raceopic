'use strict';

// Distance-aligned telemetry for the two selected qualifying laps: cumulative time gap, speed,
// throttle and brake on one shared axis, plus a summary of where the gap was made.
// Samples are [x, y, speed, throttle, brake, elapsed] at the same reference positions for both laps.
const TRACE_SEGMENTS = 24;
const traceState = {count: 0};

function lapClock(lap) {
  // Time at each reference point from speed, not from the noisy position timestamps:
  // each step is an equal slice of the lap, crossed in time proportional to 1 / speed.
  // Scaled so the last point lands exactly on the official lap time.
  const pace = lap.samples.map(p => 1 / Math.max(p[2], 5));
  const steps = pace.slice(1).map((v, i) => (v + pace[i]) / 2);
  const total = steps.reduce((sum, v) => sum + v, 0);
  const clock = [0];
  for (const step of steps) clock.push(clock.at(-1) + step / total * lap.time);
  return clock;
}

function traceGap(first, second) {
  // Positive: the first driver reached this point later, i.e. is behind.
  const a = lapClock(first);
  const b = lapClock(second);
  return a.map((t, i) => t - b[i]);
}

function traceSegments(gap, bends, cuts) {
  const n = gap.length - 1;
  const segments = [];
  for (let k = 0; k < TRACE_SEGMENTS; k++) {
    const a = Math.round(k * n / TRACE_SEGMENTS);
    const b = Math.round((k + 1) * n / TRACE_SEGMENTS);
    const bend = bends.findIndex(index => index >= a && index <= b);
    const sector = b <= cuts[0] ? 1 : b <= cuts[1] ? 2 : 3;
    segments.push({a, b, change: gap[b] - gap[a], bend, sector});
  }
  return segments;
}

function traceSummary(gap, drivers, bends, cuts) {
  const n = gap.length - 1;
  const top = traceSegments(gap, bends, cuts)
    .filter(s => Math.abs(s.change) >= .005)
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, 3);
  const total = gap[n] - gap[0];
  const lead = total === 0 ? L('两圈同时到达终点', 'Both laps end level') :
    L(`全圈 ${drivers[total > 0 ? 1 : 0].code} 快 ${Math.abs(total).toFixed(3)} 秒`, `${drivers[total > 0 ? 1 : 0].code} is ${Math.abs(total).toFixed(3)} s faster over the lap`);
  if (!top.length) return L(`${lead}。`, `${lead}.`);
  const parts = top.map(s => {
    const where = `${Math.round(100 * s.a / n)}–${Math.round(100 * s.b / n)}%` +
      (s.bend >= 0 ? L(`（弯区 ${s.bend + 1}）`, ` (corner ${s.bend + 1})`) : L(`（S${s.sector}）`, ` (S${s.sector})`));
    return L(`${drivers[s.change > 0 ? 1 : 0].code} 在 ${where}赢 ${Math.abs(s.change).toFixed(3)} 秒`, `${drivers[s.change > 0 ? 1 : 0].code} gains ${Math.abs(s.change).toFixed(3)} s at ${where}`);
  });
  return L(`${lead}。差距最大的路段：${parts.join('；')}。`, `${lead}. Biggest swings: ${parts.join('; ')}.`);
}

function drawTrace(first, second, drivers, bounds) {
  const {reference, cuts} = state.event.telemetry;
  const n = reference.length - 1;
  const gap = traceGap(first, second);
  const x = i => i / n * 1000;
  const laps = [first, second];
  const lineClass = i => `chart-${i ? 'secondary' : 'primary'}`;
  // ticks: [text, y in viewBox units], placed at the same height as the value they label.
  const strip = (height, body, label, ticks) => `
    <div class="trace-row">
      <div class="trace-ticks">${ticks.map(([t, y]) => `<small style="top:${(100 * y / height).toFixed(1)}%">${t}</small>`).join('')}</div>
      <div class="trace-plot"><span class="trace-title">${label}</span>
      <svg viewBox="0 0 1000 ${height}" preserveAspectRatio="none" aria-hidden="true">
        ${cuts.map(c => `<line class="trace-cut" x1="${x(c)}" x2="${x(c)}" y1="0" y2="${height}"/>`).join('')}
        ${bounds && (bounds[0] > 0 || bounds[1] < n) ? `<rect class="trace-focus" x="${x(bounds[0])}" width="${x(bounds[1]) - x(bounds[0])}" y="0" height="${height}"/>` : ''}
        ${body}
        <line class="trace-cursor" x1="0" x2="0" y1="0" y2="${height}"/>
      </svg></div>
    </div>`;

  // 1. Cumulative gap, shaded by who is ahead at each point.
  const span = Math.max(.05, ...gap.map(Math.abs));
  const gy = v => 60 - v / span * 54;
  const ahead = (sign, cls) => {
    const pts = gap.map((v, i) => [x(i), gy(sign * v > 0 ? v : 0)]);
    return `<path class="${cls}" d="M0 60 ${pts.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')} L1000 60 Z"/>`;
  };
  const gapBody = `${ahead(1, 'trace-behind')}${ahead(-1, 'trace-ahead')}
    <line class="trace-zero" x1="0" x2="1000" y1="60" y2="60"/>
    <path class="trace-gap" d="${path(gap.map((v, i) => [x(i), gy(v)]))}"/>`;

  // 2. Speed.
  const speeds = laps.flatMap(l => l.samples.map(p => p[2]));
  const low = Math.floor(Math.min(...speeds) / 50) * 50;
  const high = Math.ceil(Math.max(...speeds) / 50) * 50;
  const sy = v => 96 - (v - low) / (high - low) * 90;
  const speedBody = laps.map((l, i) => `<path class="${lineClass(i)}" d="${path(l.samples.map((p, j) => [x(j), sy(p[2])]))}"/>`).join('');

  // 3. Throttle, 4. brake (one band per driver).
  const ty = v => 46 - v / 100 * 42;
  const throttleBody = laps.map((l, i) => `<path class="${lineClass(i)}" d="${path(l.samples.map((p, j) => [x(j), ty(p[3])]))}"/>`).join('');
  const brakeBody = laps.map((l, i) => l.samples.map((p, j) => p[4] && j < n
    ? `<rect class="trace-brake brake-${i}" x="${x(j)}" width="${x(1) + .5}" y="${i ? 15 : 2}" height="11"/>` : '').join('')).join('');

  $('traceChart').innerHTML =
    strip(120, gapBody, L('时间差', 'Gap'), [[`+${span.toFixed(2)}s`, gy(span)], ['0', gy(0)], [`−${span.toFixed(2)}s`, gy(-span)]]) +
    strip(100, speedBody, L('车速 km/h', 'Speed km/h'), [[`${high}`, sy(high)], [`${(low + high) / 2}`, sy((low + high) / 2)], [`${low}`, sy(low)]]) +
    strip(50, throttleBody, L('油门', 'Throttle'), [['100%', ty(100)], ['0', ty(0)]]) +
    strip(28, brakeBody, L('制动', 'Brake'), [[drivers[0].code, 7.5], [drivers[1].code, 20.5]]);
  $('traceLegend').innerHTML =
    `<span class="driver-primary">━ ${drivers[0].code}</span><span class="driver-secondary">┄ ${drivers[1].code}</span>` +
    `<span><i class="swatch behind"></i>${L(`${drivers[0].code} 落后`, `${drivers[0].code} behind`)}</span><span><i class="swatch ahead"></i>${L(`${drivers[0].code} 领先`, `${drivers[0].code} ahead`)}</span>`;
  $('traceSummary').textContent = traceSummary(gap, drivers, state.bends, cuts);
  traceState.count = n;
  traceState.gap = gap;
  $('traceChart').onpointermove = event => {
    const rect = $('traceChart').querySelector('svg').getBoundingClientRect();
    const index = Math.round(clamp((event.clientX - rect.left) / rect.width, 0, 1) * n);
    if (!$('positionTelemetry').hidden) setDistance(index);
    else traceCursor(index);
  };
  traceCursor(state.at || 0);
}

function traceCursor(index) {
  if (!traceState.count) return;
  const position = index / traceState.count * 1000;
  for (const line of $('traceChart').querySelectorAll('.trace-cursor')) {
    line.setAttribute('x1', position);
    line.setAttribute('x2', position);
  }
  const value = traceState.gap[index];
  const drivers = pair();
  $('traceReadout').textContent = `${Math.round(100 * index / traceState.count)}% · ` +
    (Math.abs(value) < .0005 ? L('持平', 'Level') : L(`${drivers[value > 0 ? 1 : 0].code} 领先 ${Math.abs(value).toFixed(3)} 秒`, `${drivers[value > 0 ? 1 : 0].code} ahead by ${Math.abs(value).toFixed(3)} s`));
}

function miniSectors(first, second, drivers, reference) {
  // The lap cut into equal mini-sectors on the map, each coloured by who gained time there.
  const {cuts} = state.event.telemetry;
  const segments = traceSegments(traceGap(first, second), state.bends, cuts);
  const wins = [0, 0];
  const svg = segments.map(s => {
    const winner = Math.abs(s.change) < .002 ? null : s.change > 0 ? 1 : 0;
    if (winner !== null) wins[winner]++;
    const who = winner === null ? L('持平', 'Even') : L(`${drivers[winner].code} 快 ${Math.abs(s.change).toFixed(3)} 秒`, `${drivers[winner].code} faster by ${Math.abs(s.change).toFixed(3)} s`);
    return `<path class="track-segment mini-segment winner-${winner ?? 'tie'}" data-mini="${Math.round((s.a + s.b) / 2)}"
      d="${path(reference.slice(s.a, s.b + 1))}"><title>${Math.round(100 * s.a / (reference.length - 1))}–${Math.round(100 * s.b / (reference.length - 1))}% · ${who}</title></path>`;
  }).join('');
  return {svg, caption: L(`${drivers[0].code} 赢 ${wins[0]} 段，${drivers[1].code} 赢 ${wins[1]} 段`, `${drivers[0].code} wins ${wins[0]} mini-sectors, ${drivers[1].code} ${wins[1]}`)};
}
