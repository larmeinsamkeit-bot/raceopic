'use strict';

const $ = id => document.getElementById(id);
const option = (value, text) => new Option(text, value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const signed = (value, decimals = 3) => `${value > 0 ? '+' : ''}${value.toFixed(decimals)}`;
const tyres = {
  SOFT: ['S', L('软胎', 'soft')], MEDIUM: ['M', L('中性胎', 'medium')], HARD: ['H', L('硬胎', 'hard')],
  INTERMEDIATE: ['I', L('半雨胎', 'intermediate')], WET: ['W', L('全雨胎', 'wet')],
};
// English for the outlier-lap reasons stored in the data.
const EXCLUDED_EN = {'发车圈': 'start lap', '进站圈': 'in-lap', '出站圈': 'out-lap', '缺失计时': 'no timing', '全场减速': 'safety car', '慢圈': 'slow lap'};
const state = {event: null, mode: 'dominance', sector: null, bend: null, bends: [], at: 0, stops: []};
const events = new Map();
const seasonLab = new Map();
const pastIndex = new Map();
let eventRequest = 0;
// Comparison state shared through the address bar: race, drivers, qualifying laps and map mode.
const MODE_PARAM = {dominance: 'dominance', miniMode: 'mini', lines: 'lines', replayMode: 'replay'};
let pendingUrl = new URLSearchParams(location.search);

function writeUrl() {
  if (pendingUrl || !state.event) return;
  const drivers = pair();
  const query = new URLSearchParams({race: state.event.id, a: drivers[0].code, b: drivers[1].code});
  for (const [index, key] of ['qa', 'qb'].entries()) {
    const lap = selectedTelemetry()[index];
    if (lap && $(index ? 'qualiB' : 'qualiA').selectedIndex > 0) query.set(key, lap.lap);
  }
  if (state.mode !== 'dominance') query.set('mode', MODE_PARAM[state.mode]);
  history.replaceState(null, '', `${location.pathname}?${query}${location.hash}`);
}

function restoreDrivers() {
  if (!pendingUrl) return;
  const byCode = code => state.event.drivers.find(d => d.code === code?.toUpperCase());
  const [a, b] = [byCode(pendingUrl.get('a')), byCode(pendingUrl.get('b'))];
  if (a) $('driverA').value = a.id;
  if (b && (!a || b.id !== a.id)) $('driverB').value = b.id;
}

function restoreLaps() {
  if (!pendingUrl) return;
  for (const [index, key] of ['qa', 'qb'].entries()) {
    const lap = Number(pendingUrl.get(key));
    const laps = state.event.telemetry.laps[pair()[index].id] || [];
    const at = laps.findIndex(row => row.lap === lap);
    if (at >= 0) $(index ? 'qualiB' : 'qualiA').value = at;
  }
}

// Keyboard access for a chart cursor: arrows move one step (Shift: ten), Home / End jump to the ends.
function keyCursor(element, label, get, set, min, max) {
  element.tabIndex = 0;
  element.setAttribute('role', 'group');
  element.setAttribute('aria-roledescription', L('可用方向键移动的图表', 'chart, use arrow keys'));
  if (label) element.setAttribute('aria-label', label);
  element.onkeydown = event => {
    const step = event.shiftKey ? 10 : 1;
    const moves = {ArrowRight: get() + step, ArrowLeft: get() - step, ArrowUp: get() + step, ArrowDown: get() - step, Home: min, End: max};
    if (!(event.key in moves)) return;
    event.preventDefault();
    set(clamp(moves[event.key], min, max));
  };
}

async function readEventData(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function lapTime(seconds) {
  if (seconds == null) return '—';
  const ms = Math.round(seconds * 1000);
  return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * fraction;
  const lo = Math.floor(at);
  return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo);
}

function pair() {
  return ['driverA', 'driverB'].map(id => state.event.drivers.find(d => d.id === Number($(id).value)));
}

function optionGroup(label, options) {
  const group = document.createElement('optgroup');
  group.label = label;
  group.append(...options);
  return group;
}

async function setEvent() {
  const request = ++eventRequest;
  const id = $('race').value;
  stopReplay();
  $('eventStatus').textContent = L('正在载入分站…', 'Loading race…');
  for (const field of ['driverA', 'driverB', 'export']) $(field).disabled = true;
  try {
    if (!events.has(id)) {
      // Every race is fetched only when picked; the page itself loads two small indexes.
      const url = seasonLab.has(id)
        ? `lab-2026/r${String(seasonLab.get(id).round).padStart(2, '0')}.json?v=season-lab`
        : `past/${encodeURIComponent(id)}.json?v=past`;
      const event = await readEventData(url);
      if (event.id !== id) throw new Error('Race data does not match the requested event');
      events.set(id, event);
    }
    if (request !== eventRequest) return;
    state.event = events.get(id);
    renderEvent();
    $('eventStatus').textContent = '';
  } catch (error) {
    if (request !== eventRequest) return;
    $('eventStatus').textContent = L('该站数据加载失败。请尝试重新选择或刷新。', 'This race failed to load. Pick it again or reload the page.');
    if (!state.event) throw error;
    $('race').value = state.event.id;
  } finally {
    if (request === eventRequest && state.event) {
      for (const field of ['driverA', 'driverB', 'export']) $(field).disabled = false;
    }
  }
}

function renderEvent() {
  state.bends = findReplayBends(state.event.telemetry.reference);
  const hasTelemetry = driver => Boolean(state.event.telemetry.laps[driver.id]?.length);
  const trackDrivers = state.event.drivers.filter(hasTelemetry);
  const paceDrivers = state.event.drivers.filter(driver => !hasTelemetry(driver));
  const driverOption = d => option(d.id, `${d.code} · ${d.surname}${d.laps.length ? '' : L('（仅排位）', ' (qualifying only)')}`);
  // Default to the first two drivers with telemetry who ran most of the race, so a pair always compares.
  const ranFar = d => d.laps.length >= .9 * state.event.totalLaps;
  const defaults = [...trackDrivers.filter(ranFar), ...trackDrivers.filter(d => !ranFar(d))].slice(0, 2);
  for (const [index, id] of ['driverA', 'driverB'].entries()) {
    const groups = [optionGroup(L('有排位遥测', 'With qualifying telemetry'), trackDrivers.map(driverOption))];
    if (paceDrivers.length) groups.push(optionGroup(L('仅正赛数据', 'Race data only'), paceDrivers.map(driverOption)));
    $(id).replaceChildren(...groups);
    if (defaults[index]) $(id).value = defaults[index].id;
    else $(id).selectedIndex = index;
  }
  restoreDrivers();
  $('coverage').textContent = L(`正赛 ${state.event.sourceLaps.toLocaleString()} 条 · 遥测 ${trackDrivers.length}/${state.event.drivers.length} 位`,
    `${state.event.sourceLaps.toLocaleString()} race laps · telemetry ${trackDrivers.length}/${state.event.drivers.length} drivers`);
  $('circuit').textContent = state.event.circuit;
  changePair();
}

function changePair() {
  const drivers = pair();
  for (const [index, suffix] of ['A', 'B'].entries()) {
    const driver = drivers[index];
    $(`telemetry${suffix}`).textContent = driver.code;
    const laps = state.event.telemetry.laps[driver.id] || [];
    $(`quali${suffix}`).replaceChildren(...laps.map((lap, i) =>
      option(i, L(`第 ${lap.lap} 圈 · ${lapTime(lap.time)}`, `Lap ${lap.lap} · ${lapTime(lap.time)}`))));
    $(`quali${suffix}`).disabled = !laps.length;
  }
  restoreLaps();
  state.sector = null;
  state.bend = null;
  state.at = 0;
  renderTrack();
  renderPace();
  renderStints();
  renderRaceReplay();
  setupStrategy();
}

function selectedTelemetry() {
  return pair().map((d, i) => state.event.telemetry.laps[d.id]?.[Number($(i ? 'qualiB' : 'qualiA').value)]);
}

function path(points, x = p => p[0], y = p => p[1]) {
  // Catmull-Rom through the samples, so corners stay round when the map is zoomed in.
  const q = points.map(p => [x(p), y(p)]);
  if (q.length < 3) return q.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
  const f = n => n.toFixed(2);
  let d = `M${f(q[0][0])} ${f(q[0][1])}`;
  for (let i = 0; i < q.length - 1; i++) {
    const p0 = q[Math.max(0, i - 1)];
    const p1 = q[i];
    const p2 = q[i + 1];
    const p3 = q[Math.min(q.length - 1, i + 2)];
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ` +
      `${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

function activeBounds() {
  const {reference, cuts} = state.event.telemetry;
  if (state.bend !== null) return [state.bend - 6, state.bend + 6];
  const intervals = [0, ...cuts, reference.length - 1];
  return state.sector === null ? [0, reference.length - 1] :
    [intervals[state.sector], intervals[state.sector + 1]];
}

function renderTrack() {
  stopReplay();
  const drivers = pair();
  const [first, second] = selectedTelemetry();
  const replaying = state.mode === 'replayMode';
  $('trackUnavailable').hidden = Boolean(first && second);
  $('trackContent').hidden = !first || !second;
  $('replayControls').hidden = $('replayTelemetry').hidden = !replaying;
  $('positionTelemetry').hidden = replaying;
  $('telemetryNote').textContent = '';
  if (!first || !second) return;
  const {reference, cuts} = state.event.telemetry;
  const marks = [0, ...cuts, reference.length - 1];
  const [min, max] = activeBounds();
  const indices = [0, 1, 2];
  const sectors = indices.map(i => {
    const delta = first.sectors[i] - second.sectors[i];
    const winner = Math.abs(delta) < .0005 ? null : delta < 0 ? 0 : 1;
    return {delta, winner};
  });
  const focused = state.sector !== null || state.bend !== null;
  $('focusCaption').textContent = state.bend !== null ? L(`弯区 ${state.bends.indexOf(state.bend) + 1}`, `Corner ${state.bends.indexOf(state.bend) + 1}`) :
    state.sector !== null ? L(`第 ${state.sector + 1} 计时段`, `Sector ${state.sector + 1}`) : L('全赛道', 'Full lap');
  $('wholeTrack').hidden = !focused;
  $('sectorCards').replaceChildren(...sectors.map(({delta, winner}, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sector-card winner-${winner ?? 'tie'}`;
    button.setAttribute('aria-pressed', state.sector === index);
    button.innerHTML = `<span>S${index + 1}</span><strong>${winner === null ? L('持平', 'Even') : drivers[winner].code}</strong><small>${Math.abs(delta).toFixed(3)} ${L('秒', 's')}</small>`;
    button.onclick = () => focusSector(state.sector === index ? null : index);
    return button;
  }));

  const focusPoints = [...reference.slice(min, max + 1),
    ...first.samples.slice(min, max + 1), ...second.samples.slice(min, max + 1)];
  const xs = focusPoints.map(p => p[0]);
  const ys = focusPoints.map(p => p[1]);
  const padding = replaying ? 70 : focused ? 46 : 78;
  const view = [Math.min(...xs) - padding, Math.min(...ys) - padding,
    Math.max(...xs) - Math.min(...xs) + 2 * padding,
    Math.max(...ys) - Math.min(...ys) + 2 * padding];
  const raceLines = [first, second].map((lap, i) =>
    `<path class="track-line track-line-${i}" d="${path(lap.samples.slice(min, max + 1))}"/>`).join('');
  const dominance = sectors.map(({winner}, i) => {
    const points = reference.slice(marks[i], marks[i + 1] + 1);
    return `<path class="track-segment winner-${winner ?? 'tie'}" data-sector="${i}" d="${path(points)}"><title>${L(`第 ${i + 1} 计时段`, `Sector ${i + 1}`)}</title></path>`;
  }).join('');
  const pins = marks.slice(0, 3).map((index, i) => {
    const [x, y] = reference[index];
    return `<g transform="translate(${x} ${y})"><g class="glyph" data-s="1"><circle class="track-gate" r="8"/><text class="track-gate-label" x="14" y="-14">${i ? 'S' + (i + 1) : L('起终点', 'Start/finish')}</text></g></g>`;
  }).join('');
  const glyphScale = Math.max(view[2], view[3]) / 900;
  const mini = state.mode === 'miniMode' ? miniSectors(first, second, drivers, reference) : null;
  const overlay = replaying ? replayMap([first, second], drivers, reference, min, max, glyphScale) :
    state.mode === 'dominance' ? dominance : mini ? mini.svg : raceLines;
  const trackLabel = replaying ? L('双车遥测动画', 'two-car telemetry replay') : state.mode === 'dominance' ? L('按分段计时优势着色', 'coloured by sector advantage')
    : mini ? L(`${TRACE_SEGMENTS} 个迷你分段的优势`, `advantage in ${TRACE_SEGMENTS} mini-sectors`) : L('双车行车线', 'both racing lines');
  const cursors = replaying ? '' : `<circle id="trackCursorA" class="track-marker marker-a" r="9"/>
    <circle id="trackCursorB" class="track-marker marker-b" r="9"/>`;
  $('trackMap').innerHTML = `<svg viewBox="${view.join(' ')}" role="img" aria-label="${L('赛道图，', 'Track map, ')}${trackLabel}">
    <path class="track-road" d="${path(reference)}"/>${pins}${overlay}${cursors}
  </svg>`;
  $('trackMap').querySelectorAll('[data-sector]').forEach(segment => {
    segment.addEventListener('click', () => {
      const sector = Number(segment.dataset.sector);
      focusSector(state.sector === sector ? null : sector);
    });
  });
  $('trackMap').querySelectorAll('[data-mini]').forEach(segment => {
    segment.addEventListener('click', () => setDistance(Number(segment.dataset.mini)));
  });
  $('trackMap').querySelectorAll('[data-bend]').forEach(pin => {
    pin.onclick = () => {
      const bend = Number(pin.dataset.bend);
      focusReplayBend(state.bend === bend ? null : bend);
    };
  });
  $('mapHint').textContent = replaying ? L('两圈从同一计时起点开始。在赛道任意位置滚动、双指或双击即可放大，放大后可拖动；点击编号查看弯区。', 'Both laps start from the same timing line. Scroll, pinch or double-click anywhere on the track to zoom, then drag; click a number to inspect that corner.') : mini
    ? L(`${mini.caption}。悬停查看每段差距，点击跳到该位置；灰色为差距不到 0.002 秒。`, `${mini.caption}. Hover for each margin, click to jump there; grey means under 0.002 s.`)
    : state.mode === 'dominance'
    ? L('颜色显示该段用时更短的车手。在赛道任意位置滚动、双指或双击即可放大；点击赛段聚焦该段。', 'Colour shows who was faster in each sector. Scroll, pinch or double-click anywhere to zoom; click a sector to focus it.')
    : L('青绿实线与银灰虚线为定位采样轨迹。在赛道任意位置滚动、双指或双击即可放大比较走线。', 'Teal solid and silver dashed lines are the sampled positions. Scroll, pinch or double-click anywhere to zoom in and compare lines.');
  $('telemetryNote').textContent =
    `${state.event.telemetrySource ?? 'OpenF1'} · ${drivers[0].code} / ${drivers[1].code} ` + L(`定位记录 ${first.positionSamples} / ${second.positionSamples}，车载读取记录 ${first.carSamples} / ${second.carSamples}。位置与速度均经过插值对齐。`,
      `position samples ${first.positionSamples} / ${second.positionSamples}, car samples ${first.carSamples} / ${second.carSamples}. Position and speed are interpolated to a common distance.`);
  zoomAttach(view, drivers, replaying);
  drawTrace(first, second, drivers, [min, max]);
  writeUrl();
  if (replaying) {
    setupReplay([first, second], drivers, min, max);
    return;
  }
  drawSpeed(first, second, min, max);
  $('distance').min = min;
  $('distance').max = max;
  setDistance(clamp(state.at, min, max));
}

function focusSector(sector) {
  state.bend = null;
  state.sector = sector;
  const [min, max] = activeBounds();
  state.at = Math.round((min + max) / 2);
  renderTrack();
}

function focusReplayBend(bend) {
  state.sector = null;
  state.bend = bend;
  renderTrack();
}

function drawSpeed(first, second, min, max) {
  const traces = [first, second].map(lap => lap.samples.slice(min, max + 1));
  const speeds = traces.flat().map(p => p[2]);
  const low = Math.floor(Math.min(...speeds) / 25) * 25;
  const high = Math.max(low + 25, Math.ceil(Math.max(...speeds) / 25) * 25);
  const x = i => 34 + i / (max - min) * 306;
  const y = v => 105 - (v - low) / (high - low) * 88;
  const axis = [low, (low + high) / 2, high].map(v =>
    `<line x1="34" x2="340" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/><text x="2" y="${y(v) + 3}" class="chart-label">${Math.round(v)}</text>`).join('');
  const lines = traces.map((points, i) =>
    `<path class="chart-${i ? 'secondary' : 'primary'}" d="${path(points.map((p, j) => [x(j), y(p[2])]))}"/>`).join('');
  $('speedChart').innerHTML = `<svg viewBox="0 0 346 112" role="img" aria-label="${L('沿赛道距离对齐的速度折线图', 'Speed along the lap')}" preserveAspectRatio="none">
    ${axis}${lines}<line id="speedCursor" class="chart-cursor" y1="10" y2="106" stroke-dasharray="4 3"/>
  </svg>`;
  $('speedChart').onpointermove = e => {
    const rect = $('speedChart').getBoundingClientRect();
    const relative = ((e.clientX - rect.left) / rect.width * 346 - 34) / 306;
    setDistance(Math.round(min + clamp(relative, 0, 1) * (max - min)));
  };
}

function setDistance(index) {
  state.at = index;
  $('distance').value = index;
  const {reference} = state.event.telemetry;
  const [first, second] = selectedTelemetry();
  const samples = [first.samples[index], second.samples[index]];
  const [min, max] = activeBounds();
  const percent = Math.round(100 * index / (reference.length - 1));
  $('progress').value = `${percent}%`;
  $('distance').setAttribute('aria-valuetext', L(`全赛道 ${percent}%`, `${percent}% of the lap`));
  for (const [i, suffix] of ['A', 'B'].entries()) {
    const marker = $(`trackCursor${suffix}`);
    const showBoth = state.mode === 'lines';
    const [x, y] = showBoth ? samples[i] : reference[index];
    marker.setAttribute('cx', x);
    marker.setAttribute('cy', y);
    marker.style.display = !showBoth && i === 1 ? 'none' : '';
  }
  const cursor = 34 + (index - min) / (max - min) * 306;
  $('speedCursor').setAttribute('x1', cursor);
  $('speedCursor').setAttribute('x2', cursor);
  traceCursor(index);
  $('readout').innerHTML = pair().map((d, i) => {
    const [, , speed, throttle, brake] = samples[i];
    return `<div class="driver-${i ? 'secondary' : 'primary'}"><span>${d.code}</span><strong>${Math.round(speed)} <small>km/h</small></strong><span>${L(`油门 ${throttle}% · 制动${brake ? '中' : '未触发'}`, `throttle ${throttle}% · ${brake ? 'braking' : 'no brake'}`)}</span></div>`;
  }).join('');
}

function noPairReason(drivers, rows) {
  // Say why nothing could be paired, and what to try instead.
  const total = state.event.totalLaps;
  const missing = drivers.find(d => !d.laps.length);
  if (missing) return L(`${missing.code} 没有正赛圈速记录，请换一位车手`, `${missing.code} has no race laps; pick another driver`);
  const short = drivers.find(d => d.laps.length < .5 * total);
  if (short) return L(`${short.code} 只完成 ${short.laps.length} / ${total} 圈，可能提前退赛，请换一位车手`, `${short.code} completed only ${short.laps.length} / ${total} laps, likely retired; pick another driver`);
  if ($('sameTyre').checked) return L('两人没有使用相同配方的同一圈，取消「仅比较相同配方」即可', 'No lap with both on the same compound; untick “Same compound only”');
  if ($('clean').checked && rows.every(list => list.length)) return L('两人的有效圈没有重叠，取消「排除异常圈」可查看全部', 'Their clean laps never overlap; untick “Exclude outlier laps” to see all');
  return L('这组车手没有可配对的圈，请换一位车手', 'These two share no comparable laps; pick another driver');
}

function renderPace() {
  const drivers = pair();
  const rows = drivers.map(d => d.laps.filter(r => r.time != null && (!$('clean').checked || !r.excluded)));
  const second = new Map(rows[1].map(r => [r.lap, r]));
  const matches = rows[0].flatMap(a => {
    const b = second.get(a.lap);
    return b && (!$('sameTyre').checked || (a.compound && a.compound === b.compound)) ? [a.time - b.time] : [];
  }).sort((a, b) => a - b);
  const best = rows.flatMap((list, i) => list.map(r => ({...r, code: drivers[i].code})))
    .reduce((a, b) => !a || b.time < a.time ? b : a, null);
  $('fastest').textContent = lapTime(best?.time);
  $('fastestDriver').textContent = best ? L(`${best.code} · 第 ${best.lap} 圈`, `${best.code} · lap ${best.lap}`) : L('无样本', 'No laps');
  const middle = quantile(matches, .5);
  $('gap').textContent = middle === null ? '—' : `${signed(middle)} s`;
  $('gapDriver').textContent = middle === null ? noPairReason(drivers, rows) :
    Math.abs(middle) < .0005 ? L('两位车手接近', 'Level on pace') : L(`${drivers[middle < 0 ? 0 : 1].code} 的配对圈较快`, `${drivers[middle < 0 ? 0 : 1].code} was faster on paired laps`);
  $('spread').textContent = matches.length ? `${signed(quantile(matches, .25), 2)} ～ ${signed(quantile(matches, .75), 2)} s` : '—';
  $('samples').textContent = matches.length;
  $('sampleNote').textContent = L(`当前可见 ${rows[0].length} / ${rows[1].length} 圈`, `${rows[0].length} / ${rows[1].length} laps shown`);
  $('paceA').textContent = `━ ${drivers[0].code}`;
  $('paceB').textContent = `┄ ${drivers[1].code}`;
  drawPace(rows, drivers);
  renderWeather();
  renderDeg();
  renderStory();
}

function drawPace(rows, drivers) {
  const times = rows.flat().map(r => r.time);
  if (!times.length) {
    $('chart').textContent = L('没有符合筛选条件的圈速。', 'No laps match the filters.');
    $('chart').onpointermove = null;
    return;
  }
  const sorted = [...times].sort((a, b) => a - b);
  const low = Math.floor(sorted[0] - .2);
  // Keep one slow lap (SC restart, traffic) from flattening the whole race; it is pinned to the top edge.
  const high = Math.ceil(Math.min(sorted[sorted.length - 1], quantile(sorted, .9) + 2) + .2);
  const n = state.event.totalLaps;
  const x = lap => 38 + (lap - 1) / (n - 1) * 642;
  const y = time => 198 - (Math.min(time, high) - low) / (high - low) * 175;
  let grid = '';
  for (let i = 0; i < 5; i++) {
    const value = low + (high - low) * i / 4;
    grid += `<line class="chart-grid" x1="38" x2="680" y1="${y(value)}" y2="${y(value)}" stroke-dasharray="3 5"/>
      <text x="1" y="${y(value) + 3}" class="chart-label">${value.toFixed(1)}</text>`;
  }
  for (const lap of [1, 10, 20, 30, 40, n]) {
    grid += `<text x="${x(lap)}" y="221" class="chart-label" text-anchor="middle">${lap}</text>`;
  }
  const lines = rows.map((list, i) => {
    let previous = -2;
    const trace = list.map(r => {
      const cmd = r.lap === previous + 1 ? 'L' : 'M';
      previous = r.lap;
      return `${cmd}${x(r.lap)},${y(r.time)}`;
    }).join(' ');
    return `<path class="chart-${i ? 'secondary' : 'primary'}" d="${trace}"/>`;
  }).join('');
  $('chart').innerHTML = `<svg viewBox="0 0 700 230" preserveAspectRatio="none" role="img" aria-label="${L('两位车手的正赛逐圈圈速', 'Race lap times of both drivers')}">
    ${grid}${lines}<line id="paceCursor" class="chart-cursor" y1="14" y2="200" opacity="0" stroke-dasharray="3 3"/>
  </svg>`;
  drawDelta(rows, drivers, x);
  $('tooltip').textContent = L('在图上移动或轻触，查看单圈数据。', 'Move over or tap the chart for a lap.');
  const showLap = lap => {
    state.paceLap = lap;
    $('paceCursor').setAttribute('x1', x(lap));
    $('paceCursor').setAttribute('x2', x(lap));
    $('paceCursor').setAttribute('opacity', 1);
    $('tooltip').textContent = L(`第 ${lap} 圈 · `, `Lap ${lap} · `) + drivers.map((d, i) => {
      const found = rows[i].find(r => r.lap === lap);
      const original = d.laps.find(r => r.lap === lap);
      const tyre = tyres[found?.compound]?.[0];
      return `${d.code} ${found ? lapTime(found.time) + (tyre ? `  ${tyre}${found.age ?? ''}` : '') : (original?.excluded ? L(original.excluded, EXCLUDED_EN[original.excluded] || 'excluded') : L('缺少数据', 'no data'))}`;
    }).join(' / ');
  };
  $('chart').onpointermove = e => {
    const rect = $('chart').getBoundingClientRect();
    const fraction = ((e.clientX - rect.left) / rect.width * 700 - 38) / 642;
    showLap(clamp(Math.round(fraction * (n - 1)) + 1, 1, n));
  };
  keyCursor($('chart'), L('逐圈圈速图，用方向键逐圈查看', 'Lap time chart, use arrow keys to step through laps'),
    () => state.paceLap ?? 0, showLap, 1, n);
}

function drawDelta(rows, drivers, x) {
  const second = new Map(rows[1].map(r => [r.lap, r]));
  const pairs = rows[0].flatMap(a => second.has(a.lap) ? [[a.lap, a.time - second.get(a.lap).time]] : []);
  const wins = [pairs.filter(([, d]) => d < 0).length, pairs.filter(([, d]) => d > 0).length];
  $('deltaLegend').innerHTML = drivers.map((d, i) =>
    `<span><i style="background:var(--${i ? 'silver' : 'petronas'})"></i>${L(`${d.code} 较快 ${wins[i]} 圈`, `${d.code} faster on ${wins[i]} laps`)}</span>`).join('');
  const width = Math.max(3, 642 / state.event.totalLaps * .62);
  const bars = pairs.map(([lap, delta]) => {
    const h = Math.max(1.5, Math.min(Math.abs(delta), 2) / 2 * 40);
    const y = delta > 0 ? 45 - h : 45;
    return `<rect x="${x(lap) - width / 2}" y="${y}" width="${width}" height="${h}" rx="1" fill="var(--${delta > 0 ? 'silver' : 'petronas'})"><title>${L(`第 ${lap} 圈`, `Lap ${lap}`)} · ${signed(delta)} s</title></rect>`;
  }).join('');
  $('deltaChart').innerHTML = `<svg viewBox="0 0 700 90" preserveAspectRatio="none" role="img" aria-label="${L(`每圈圈速差：向上为 ${drivers[1].code} 较快，向下为 ${drivers[0].code} 较快`, `Per-lap gap: up means ${drivers[1].code} faster, down means ${drivers[0].code} faster`)}">
    <line x1="38" x2="680" y1="45" y2="45" stroke="var(--line-strong)" vector-effect="non-scaling-stroke"/>
    <text x="1" y="12" class="chart-label">+2s</text><text x="1" y="88" class="chart-label">−2s</text>${bars}</svg>`;
}

function renderStints() {
  const display = pair().map(driver => {
    const phases = driver.stints.map(stint => {
      const length = stint.end - stint.start + 1;
      const [abbr, label] = tyres[stint.compound] || ['?', L('未知配方', 'unknown compound')];
      return `<span class="tyre-block tyre-${abbr}" style="flex:${length}" title="${label} · ${L(`第 ${stint.start}–${stint.end} 圈`, `laps ${stint.start}–${stint.end}`)}">${abbr} · ${length}</span>`;
    }).join('');
    const lane = Object.entries(driver.pit).filter(([, time]) => time != null)
      .map(([lap, time]) => `L${lap} · ${time.toFixed(1)} ${L('秒', 's')}`).join(' / ');
    return `<div class="stint"><div class="stint-title"><strong>${driver.code}</strong><span>${driver.team}</span></div><div class="stint-bar tyre-bar">
      ${phases}</div><p class="panel-note">${L('维修区用时', 'Pit lane')} · ${lane || L('无可用记录', 'no record')}</p></div>`;
  });
  $('stints').innerHTML = display.join('');
  $('stintNote').textContent = L('S 软胎 · M 中性胎 · H 硬胎 · I 半雨胎 · W 全雨胎。条带数字为每段完成圈数。', 'S soft · M medium · H hard · I intermediate · W wet. Numbers are laps completed on each set.');
}

function setupStrategy() {
  const [driver] = pair();
  const model = state.event.paceModel;
  state.stops = [];
  if (model) {
    for (let i = 1; i < driver.stints.length; i++) {
      const before = driver.stints[i - 1];
      const after = driver.stints[i];
      const left = model.compounds[before.compound];
      const right = model.compounds[after.compound];
      const baseline = after.start - 1;
      const neutralized = driver.laps.some(lap => (lap.lap === baseline || lap.lap === baseline + 1) && lap.neutralized);
      if (!left || !right || before.age == null || after.age == null ||
          before.end !== baseline || neutralized || !Object.hasOwn(driver.pit, baseline)) continue;
      const min = Math.max(baseline - 6, before.start + 1, after.end + after.age - right.maxAge);
      const max = Math.min(baseline + 6, after.end - 2, before.start + left.maxAge - before.age - 1);
      if (min > baseline || max < baseline || min >= max) continue;
      state.stops.push({baseline, min, max, before, after, left, right});
    }
  }
  $('strategyUnavailable').hidden = Boolean(state.stops.length);
  $('strategyControls').hidden = !state.stops.length;
  if (!state.stops.length) {
    $('strategyUnavailable').textContent = state.event.wet
      ? L('本站出现雨胎使用。干地模型无法可靠估算这一场的进站时机。', 'Wet tyres were used in this race, so the dry-race model cannot estimate stop timing reliably.')
      : L('该车手没有具备足够配方样本的正常比赛停站。可更换车手或赛事。', 'This driver has no normal stop with enough compound data. Try another driver or race.');
    return;
  }
  $('stop').replaceChildren(...state.stops.map((stop, i) =>
    option(i, `${L(`第 ${stop.baseline} 圈`, `Lap ${stop.baseline}`)} · ${tyres[stop.before.compound][0]} → ${tyres[stop.after.compound][0]}`)));
  selectStop();
}

function selectStop() {
  const stop = state.stops[Number($('stop').value)];
  $('pit').min = stop.min;
  $('pit').max = stop.max;
  $('pit').value = stop.baseline;
  simulate();
}

function simulate() {
  const stop = state.stops[Number($('stop').value)];
  const pit = Number($('pit').value);
  const {paceModel: model} = state.event;
  const duration = (fit, age, n) => n * fit.offset + fit.slope * (n * age + n * (n + 1) / 2);
  const cost = split => duration(stop.left, stop.before.age, split - stop.before.start + 1)
    + duration(stop.right, stop.after.age, stop.after.end - split);
  const delta = cost(pit) - cost(stop.baseline);
  $('pitLabel').value = pit;
  $('simDelta').textContent = `${signed(Math.abs(delta) < .005 ? 0 : delta, 2)} s`;
  $('simTag').textContent = pit === stop.baseline ? L('实际进站圈', 'Actual stop lap') :
    Math.abs(delta) < .005 ? L('估算接近', 'About the same') : delta < 0 ? L('估算更快', 'Estimated faster') : L('估算更慢', 'Estimated slower');
  $('simDescription').textContent =
    L(`拟合 ${model.drivers} 位车手的 ${model.count.toLocaleString()} 个有效圈，单圈拟合绝对误差中位数 ${model.medianError.toFixed(2)} 秒。允许的圈数受已观察胎龄限制。`,
      `Fitted on ${model.count.toLocaleString()} clean laps from ${model.drivers} drivers; median absolute lap error ${model.medianError.toFixed(2)} s. Stop laps are limited to tyre ages seen in the race.`);
}

function exportCsv() {
  const {raceKey, year, id} = state.event;
  const lines = ['source,season,session_key,driver,lap,lap_seconds,sector_1,sector_2,sector_3,compound,tyre_age,exclusion'];
  for (const driver of pair()) {
    for (const lap of driver.laps) {
      lines.push(['OpenF1', year, raceKey, driver.code, lap.lap, lap.time, ...lap.sectors,
        lap.compound, lap.age, lap.excluded].join(','));
    }
  }
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = `raceopic-${year}-${id}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function init() {
  try {
    const [season, legacy] = await Promise.all([
      readEventData('lab-2026/index.json?v=season-lab'), readEventData('past/index.json?v=past'),
    ]);
    const current = season.sort((a, b) => b.round - a.round);
    current.forEach(entry => seasonLab.set(entry.id, entry));
    const past = legacy.filter(event => event.year < 2026).sort((a, b) => b.raceKey - a.raceKey);
    past.forEach(event => pastIndex.set(event.id, event));
    $('race').replaceChildren(
      optionGroup(L('2026 赛季 · 已完赛', '2026 season · completed'), current.map(event => option(event.id, `R${String(event.round).padStart(2, '0')} · ${gpName(event.name)}`))),
      optionGroup(L('往季精选', 'Earlier seasons'), past.map(event => option(event.id, `${event.year} ${gpName(event.name)}`))),
    );
    const requestedRound = Number(pendingUrl.get('round'));
    const requested = current.find(event => event.round === requestedRound)?.id ?? pendingUrl.get('race');
    if (seasonLab.has(requested) || pastIndex.has(requested)) $('race').value = requested;
    const requestedMode = Object.keys(MODE_PARAM).find(key => MODE_PARAM[key] === pendingUrl.get('mode'));
    if (requestedMode) {
      state.mode = requestedMode;
      for (const id of Object.keys(MODE_PARAM)) $(id).setAttribute('aria-pressed', id === requestedMode);
    }
    $('race').onchange = () => {
      pendingUrl = null;
      setEvent();
    };
    for (const id of ['driverA', 'driverB']) {
      $(id).onchange = () => {
        const other = $(id === 'driverA' ? 'driverB' : 'driverA');
        if ($(id).value === other.value) other.selectedIndex = ($(id).selectedIndex + 1) % other.length;
        changePair();
      };
    }
    const modes = Object.keys(MODE_PARAM);
    for (const mode of modes) {
      $(mode).onclick = () => {
        if (state.mode === mode) return;
        state.mode = mode;
        state.bend = null;
        for (const id of modes) $(id).setAttribute('aria-pressed', mode === id);
        renderTrack();
      };
    }
    for (const id of ['qualiA', 'qualiB']) $(id).onchange = renderTrack;
    for (const id of ['clean', 'sameTyre']) $(id).onchange = renderPace;
    $('distance').oninput = e => setDistance(Number(e.target.value));
    $('wholeTrack').onclick = () => focusSector(null);
    $('stop').onchange = selectStop;
    $('pit').oninput = simulate;
    $('reset').onclick = selectStop;
    $('export').onclick = exportCsv;
    bindReplay();
    bindZoom();
    bindRaceReplay();
    await setEvent();
    pendingUrl = null;
    writeUrl();
    $('copyLink').onclick = async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        $('copyLink').textContent = L('已复制链接', 'Link copied');
      } catch {
        $('copyLink').textContent = L('请从地址栏复制', 'Copy it from the address bar');
      }
      setTimeout(() => { $('copyLink').textContent = L('复制当前对比链接', 'Copy link to this comparison'); }, 2000);
    };
    $('loading').hidden = true;
    $('dashboard').hidden = false;
    $('export').disabled = false;
  } catch (error) {
    console.error(error);
    $('loading').textContent = L('赛事数据未能加载。请刷新页面重试。', 'Race data failed to load. Please reload the page.');
  }
}

init();
