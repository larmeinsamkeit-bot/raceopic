'use strict';

const replay = {frame: null, lastTick: null, time: 0};
const REPLAY_SLIDER_STEPS = 1000;

function findReplayBends(reference) {
  // Measure the change of heading over a short window, then keep spaced turns.
  const candidates = reference.slice(7, -7).map((point, offset) => {
    const index = offset + 7;
    const before = reference[index - 4];
    const after = reference[index + 4];
    const a = Math.atan2(point[1] - before[1], point[0] - before[0]);
    const b = Math.atan2(after[1] - point[1], after[0] - point[0]);
    return {index, angle: Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)))};
  }).sort((a, b) => b.angle - a.angle);
  const bends = [];
  for (const {index, angle} of candidates) {
    if (angle < .55 || bends.length === 5) break;
    if (bends.every(bend => Math.abs(bend - index) >= 15)) bends.push(index);
  }
  return bends.sort((a, b) => a - b);
}

function replayColours(drivers) {
  const fallback = ['#00e0c4', '#d2dce1'];
  if (drivers[0].team === drivers[1].team) return fallback;
  return drivers.map((driver, index) =>
    /^[\da-f]{6}$/i.test(driver.teamColour || '') ? `#${driver.teamColour}` : fallback[index]);
}

function replayMap(laps, drivers, reference, min, max, scale) {
  const colours = replayColours(drivers);
  const tracks = laps.map(({samples}, i) =>
    `<path class="replay-route car-${i}" style="--car:${colours[i]}" d="${path(samples.slice(min, max + 1))}"/>`).join('');
  const bends = state.bends.map((bend, i) => {
    if (bend < min || bend > max) return '';
    const [x, y] = reference[bend];
    return `<g class="replay-bend" data-bend="${bend}" transform="translate(${x} ${y})"><g class="glyph" data-s="${scale}">
      <title>${L(`弯区 ${i + 1}`, `Corner ${i + 1}`)}</title><circle class="bend-hit" r="34"/><circle r="18"/><text y="1">${i + 1}</text>
    </g></g>`;
  }).join('');
  const cars = drivers.map(({code}, i) =>
    `<g class="replay-car car-${i}" style="--car:${colours[i]}">
      <path class="replay-tail" id="replayTail${i}"/>
      <g id="replayDot${i}"><g class="glyph" data-s="${scale}" transform="scale(${scale})">
        <circle r="${i ? 12 : 17}"/><text y="${i ? 43 : -22}">${code}</text>
      </g></g>
    </g>`).join('');
  return tracks + bends + cars;
}

function sampleAtTime(samples, elapsed, min, max) {
  let low = min;
  let high = max;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (samples[mid][5] <= elapsed) low = mid;
    else high = mid - 1;
  }
  const a = samples[low];
  const b = samples[Math.min(low + 1, max)];
  const fraction = b[5] > a[5] ? clamp((elapsed - a[5]) / (b[5] - a[5]), 0, 1) : 0;
  const interpolated = a.slice(0, 4).map((value, i) => value + fraction * (b[i] - value));
  // Position follows the same Catmull-Rom curve the route is drawn with, so the car stays on the line when zoomed.
  const p0 = samples[Math.max(min, low - 1)];
  const p3 = samples[Math.min(max, low + 2)];
  const t = fraction;
  for (const axis of [0, 1]) {
    interpolated[axis] = .5 * (2 * a[axis] + (-p0[axis] + b[axis]) * t
      + (2 * p0[axis] - 5 * a[axis] + 4 * b[axis] - p3[axis]) * t * t
      + (-p0[axis] + 3 * a[axis] - 3 * b[axis] + p3[axis]) * t * t * t);
  }
  return {index: low, point: interpolated, brake: (fraction < .5 ? a : b)[4]};
}

function stopReplay() {
  if (replay.frame !== null) cancelAnimationFrame(replay.frame);
  replay.frame = replay.lastTick = null;
  $('replayPlay').textContent = L('▶ 播放', '▶ Play');
}

function setupReplay(laps, drivers, min, max) {
  const colours = replayColours(drivers);
  replay.laps = laps;
  replay.min = min;
  replay.max = max;
  replay.start = Math.min(...laps.map(lap => lap.samples[min][5]));
  replay.end = Math.max(...laps.map(lap => lap.samples[max][5]));
  replay.windowed = min !== 0 || max !== laps[0].samples.length - 1;
  replay.dots = laps.map((_, i) => $(`replayDot${i}`));
  replay.tails = laps.map((_, i) => $(`replayTail${i}`));
  $('replayTime').max = REPLAY_SLIDER_STEPS;
  $('replayReadout').innerHTML = drivers.map((d, i) =>
    `<div class="replay-readout" style="--car:${colours[i]}"><span><b>${d.code}</b> · ${d.team}</span>
      <strong id="replaySpeed${i}"></strong><span id="replayStatus${i}"></span></div>`).join('');
  replay.speedLabels = laps.map((_, i) => $(`replaySpeed${i}`));
  replay.statusLabels = laps.map((_, i) => $(`replayStatus${i}`));
  const bend = $('replayBend');
  bend.replaceChildren(option('', L('选择弯区', 'Pick a corner')), ...state.bends.map((index, i) => option(index, L(`弯区 ${i + 1}`, `Corner ${i + 1}`))));
  bend.value = state.bend ?? '';
  $('bendMetrics').innerHTML = state.bend === null ? '' :
    `<table class="bend-metrics"><caption>${L('弯区速度', 'Corner speed')} · km/h</caption>
      <thead><tr><th scope="col">${L('车手', 'Driver')}</th><th scope="col">${L('进弯', 'Entry')}</th><th scope="col">${L('最低', 'Minimum')}</th><th scope="col">${L('出弯', 'Exit')}</th></tr></thead>
      <tbody>${laps.map(({samples}, i) => {
        const speeds = samples.slice(min, max + 1).map(point => point[2]);
        return `<tr><th scope="row">${drivers[i].code}</th><td>${Math.round(speeds[0])}</td>
          <td>${Math.round(Math.min(...speeds))}</td><td>${Math.round(speeds.at(-1))}</td></tr>`;
      }).join('')}</tbody></table>`;
  updateReplay(replay.start);
}

function updateReplay(elapsed) {
  replay.time = elapsed;
  $('replayTime').value = Math.round(REPLAY_SLIDER_STEPS * (elapsed - replay.start) / (replay.end - replay.start));
  $('replayTime').setAttribute('aria-valuetext', `${elapsed.toFixed(1)} ${L('秒', 's')}`);
  $('replayClock').textContent = `${elapsed.toFixed(1)} / ${replay.end.toFixed(1)} ${L('秒', 's')}`;
  const {min, max} = replay;
  for (const [i, {samples, time}] of replay.laps.entries()) {
    const {index, point, brake} = sampleAtTime(samples, elapsed, min, max);
    const waiting = elapsed < samples[min][5];
    const passed = elapsed >= samples[max][5];
    replay.dots[i].setAttribute('transform', `translate(${point[0]} ${point[1]})`);
    if (!waiting) zoomFollow(i, point);
    replay.dots[i].style.display = waiting ? 'none' : '';
    replay.tails[i].setAttribute('d', waiting ? '' : path([...samples.slice(Math.max(min, index - 7), index + 1), point]));
    replay.speedLabels[i].textContent = waiting ? '—' : `${Math.round(point[2])} km/h`;
    replay.statusLabels[i].textContent = waiting ? L('尚未进入范围', 'Not in range yet')
      : passed ? (replay.windowed ? L('已通过范围', 'Through the range') : `${L('完成', 'Finished')} · ${lapTime(time)}`)
      : L(`油门 ${Math.round(point[3])}% · ${brake ? '制动中' : '未制动'}`, `throttle ${Math.round(point[3])}% · ${brake ? 'braking' : 'no brake'}`);
  }
}

function tickReplay(now) {
  const rate = Number($('replayRate').value);
  const change = replay.lastTick === null ? 0 : Math.min(100, now - replay.lastTick) / 1000 * rate;
  replay.lastTick = now;
  const time = Math.min(replay.end, replay.time + change);
  updateReplay(time);
  if (time < replay.end) {
    replay.frame = requestAnimationFrame(tickReplay);
  } else {
    stopReplay();
    $('replayPlay').textContent = L('▶ 重播', '▶ Replay');
  }
}

function bindReplay() {
  $('replayPlay').onclick = () => {
    if (replay.frame !== null) {
      stopReplay();
      return;
    }
    if (replay.time >= replay.end) updateReplay(replay.start);
    $('replayPlay').textContent = L('Ⅱ 暂停', 'Ⅱ Pause');
    replay.frame = requestAnimationFrame(tickReplay);
  };
  $('replayReset').onclick = () => {
    stopReplay();
    updateReplay(replay.start);
  };
  $('replayTime').oninput = event => {
    stopReplay();
    const step = Number(event.target.value);
    updateReplay(step === REPLAY_SLIDER_STEPS ? replay.end : replay.start + (replay.end - replay.start) * step / REPLAY_SLIDER_STEPS);
  };
  $('replayBend').onchange = event => focusReplayBend(event.target.value ? Number(event.target.value) : null);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && replay.frame !== null) stopReplay();
  });
}
