'use strict';

// Whole-race replay rebuilt from lap timing: every car on the map with a live order, gaps and tyres.
// Within a lap a car follows the speed profile of a qualifying lap (slow in corners, fast on
// straights), stretched to that lap's actual time. It is a reconstruction, not GPS.
const raceReplay = {frame: null, last: null, time: 0, total: 0, rate: 60, cars: [], board: 0};

function raceProfile(event) {
  // Fraction of lap time elapsed at each reference point, from the first qualifying lap with telemetry.
  const lap = Object.values(event.telemetry.laps).find(list => list.length)?.[0];
  if (!lap) return null;
  const clock = lapClock(lap);
  return clock.map(t => t / clock.at(-1));
}

function raceCars(event) {
  const total = event.totalLaps;
  const field = [];
  for (let lap = 1; lap <= total; lap++) {
    const times = event.drivers.map(d => d.laps.find(r => r.lap === lap)?.time).filter(t => t != null).sort((a, b) => a - b);
    field.push(times.length ? times[times.length >> 1] : null);
  }
  return event.drivers.filter(d => d.laps.length).map(driver => {
    const byLap = new Map(driver.laps.map(r => [r.lap, r.time]));
    const last = Math.max(...driver.laps.map(r => r.lap));
    const ends = [];
    let sum = 0;
    for (let lap = 1; lap <= last; lap++) {
      const time = byLap.get(lap) ?? field[lap - 1];
      if (time == null) break;
      sum += time;
      ends.push(sum);
    }
    const colour = /^[\da-f]{6}$/i.test(driver.teamColour || '') ? `#${driver.teamColour}` : '#90a1a4';
    return {driver, ends, colour, finished: ends.length >= total, pits: new Set(Object.keys(driver.pit || {}).map(Number))};
  });
}

function carState(car, time) {
  // Laps done and fraction of the current lap at race time `time`.
  const ends = car.ends;
  if (!ends.length) return null;
  if (time >= ends.at(-1)) return {done: ends.length, fraction: 0, out: !car.finished, over: true};
  let low = 0;
  let high = ends.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ends[mid] > time) high = mid; else low = mid + 1;
  }
  const start = low ? ends[low - 1] : 0;
  return {done: low, fraction: (time - start) / (ends[low] - start), out: false, over: false};
}

function profileIndex(profile, fraction) {
  // Reference position (fractional index) reached after `fraction` of the lap time.
  let low = 0;
  let high = profile.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (profile[mid] < fraction) low = mid + 1; else high = mid;
  }
  if (low === 0) return 0;
  const a = profile[low - 1];
  const b = profile[low];
  return low - 1 + (b > a ? (fraction - a) / (b - a) : 0);
}

function renderRaceReplay() {
  stopRaceReplay();
  const event = state.event;
  const profile = raceProfile(event);
  const block = $('raceReplay');
  if (!profile) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const {reference} = event.telemetry;
  raceReplay.profile = profile;
  raceReplay.reference = reference;
  raceReplay.cars = raceCars(event);
  raceReplay.total = Math.max(...raceReplay.cars.map(c => c.ends.at(-1) || 0));
  raceReplay.time = 0;
  const xs = reference.map(p => p[0]);
  const ys = reference.map(p => p[1]);
  const pad = 60;
  const view = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad];
  const scale = Math.max(view[2], view[3]) / 900;
  const pairIds = pair().map(d => d.id);
  raceReplay.pairIds = pairIds;
  const cars = raceReplay.cars.map((car, i) => {
    const focus = pairIds.includes(car.driver.id);
    return `<g class="rr-car${focus ? ' rr-focus' : ''}" id="rrCar${i}"><g transform="scale(${scale})">
      <circle r="${focus ? 15 : 11}" fill="${car.colour}"/>${focus ? `<text y="-22">${car.driver.code}</text>` : ''}</g>
      <title>${car.driver.code}</title></g>`;
  }).join('');
  $('rrMap').innerHTML = `<svg viewBox="${view.join(' ')}" role="img" aria-label="${L('全场车辆在赛道上的位置（由圈速重建）', 'Every car on the track, rebuilt from lap times')}">
    <path class="track-road" d="${path(reference)}"/>${cars}</svg>`;
  raceReplay.nodes = raceReplay.cars.map((_, i) => $(`rrCar${i}`));
  $('rrTime').max = 1000;
  $('rrNote').textContent = (raceReplay.cars.length < 15
    ? L(`本站只收录 ${raceReplay.cars.length} 位精选车手。`, `This race holds only ${raceReplay.cars.length} selected drivers. `) : '') +
    L('位置由每圈圈速按排位圈的速度分布重建，并非 GPS；第一圈与进站圈的位置较粗略，差距不含赛后罚时。',
      'Positions are rebuilt from each lap time using a qualifying lap\'s speed profile, not GPS; the first lap and pit laps are approximate, and gaps exclude post-race time penalties.');
  drawRaceReplay(0, true);
}

function drawRaceReplay(time, board) {
  raceReplay.time = time;
  const {cars, profile, reference} = raceReplay;
  const states = cars.map(car => carState(car, time));
  for (const [i, car] of cars.entries()) {
    const s = states[i];
    const node = raceReplay.nodes[i];
    if (!s || s.out) {
      node.style.display = 'none';
      continue;
    }
    node.style.display = '';
    const at = profileIndex(profile, s.fraction);
    const k = Math.min(reference.length - 2, Math.floor(at));
    const f = at - k;
    const x = reference[k][0] + f * (reference[k + 1][0] - reference[k][0]);
    const y = reference[k][1] + f * (reference[k + 1][1] - reference[k][1]);
    node.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  }
  const leaderLaps = Math.max(...states.map(s => s ? s.done : 0));
  const lap = Math.min(state.event.totalLaps, leaderLaps + (states.every(s => !s || s.over) ? 0 : 1));
  $('rrClock').textContent = L(`第 ${lap} / ${state.event.totalLaps} 圈`, `Lap ${lap} / ${state.event.totalLaps}`);
  $('rrTime').value = Math.round(1000 * time / raceReplay.total);
  if (board || performance.now() - raceReplay.board > 250) {
    raceReplay.board = performance.now();
    drawRaceBoard(states);
  }
}

function drawRaceBoard(states) {
  const {cars} = raceReplay;
  const rows = cars.map((car, i) => ({car, s: states[i]})).filter(r => r.s)
    .sort((a, b) => (b.s.out ? -1 : b.s.done + b.s.fraction) - (a.s.out ? -1 : a.s.done + a.s.fraction)
      || (a.s.over && b.s.over ? a.car.ends.at(-1) - b.car.ends.at(-1) : 0));
  const leader = rows.find(r => !r.s.out);
  const firstAt = lap => Math.min(...cars.map(c => c.ends[lap - 1]).filter(t => t != null));
  const html = rows.map(({car, s}, i) => {
    let gap = '';
    if (s.out) gap = L('退赛', 'OUT');
    else if (i === 0) gap = L('领先', 'Leader');
    else if (leader && leader.s.done + leader.s.fraction - (s.done + s.fraction) >= 1) {
      gap = L(`+${Math.floor(leader.s.done + leader.s.fraction - (s.done + s.fraction))} 圈`, `+${Math.floor(leader.s.done + leader.s.fraction - (s.done + s.fraction))} lap`);
    } else if (s.done >= 1) gap = `+${(car.ends[s.done - 1] - firstAt(s.done)).toFixed(1)}`;
    const lap = Math.min(s.done + 1, car.ends.length);
    const stint = car.driver.stints.find(st => lap >= st.start && lap <= st.end) || car.driver.stints.at(-1);
    const abbr = stint ? (tyres[stint.compound]?.[0] ?? '?') : '';
    const age = stint ? stint.age + Math.max(0, lap - stint.start) : '';
    const pit = car.pits.has(lap) && !s.over ? `<span class="rr-pit">${L('进站', 'PIT')}</span>` : '';
    const focus = raceReplay.pairIds.includes(car.driver.id) ? ' rr-focus' : '';
    return `<li class="rr-row${focus}${s.out ? ' rr-out' : ''}"><span class="rr-pos">${i + 1}</span>
      <span class="rr-swatch" style="background:${car.colour}"></span><strong>${car.driver.code}</strong>${pit}
      <span class="rr-gap">${gap}</span>${abbr ? `<span class="tyre-chip tyre-${abbr}" title="${tyres[stint.compound]?.[1] ?? ''}">${abbr}</span><span class="rr-age">${age}</span>` : '<span></span><span></span>'}</li>`;
  }).join('');
  $('rrBoard').innerHTML = html;
}

function tickRaceReplay(now) {
  const step = raceReplay.last === null ? 0 : Math.min(100, now - raceReplay.last) / 1000 * raceReplay.rate;
  raceReplay.last = now;
  const time = Math.min(raceReplay.total, raceReplay.time + step);
  drawRaceReplay(time, false);
  if (time < raceReplay.total) raceReplay.frame = requestAnimationFrame(tickRaceReplay);
  else {
    stopRaceReplay();
    drawRaceReplay(time, true);
  }
}

function stopRaceReplay() {
  if (raceReplay.frame !== null) cancelAnimationFrame(raceReplay.frame);
  raceReplay.frame = raceReplay.last = null;
  if ($('rrPlay')) $('rrPlay').textContent = L('▶ 播放', '▶ Play');
}

function bindRaceReplay() {
  $('rrPlay').onclick = () => {
    if (raceReplay.frame !== null) {
      stopRaceReplay();
      return;
    }
    if (raceReplay.time >= raceReplay.total) drawRaceReplay(0, true);
    $('rrPlay').textContent = L('Ⅱ 暂停', 'Ⅱ Pause');
    raceReplay.frame = requestAnimationFrame(tickRaceReplay);
  };
  $('rrRate').onchange = event => { raceReplay.rate = Number(event.target.value); };
  $('rrTime').oninput = event => {
    stopRaceReplay();
    drawRaceReplay(raceReplay.total * Number(event.target.value) / 1000, true);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRaceReplay();
  });
}
