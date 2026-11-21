'use strict';

// Build a lab race in the browser from OpenF1 (2023 onwards): the same rules as
// data-tools/build_dataset.py (outlier laps, neutralisations, pace model, telemetry alignment),
// ported line for line so an imported race reads exactly like a bundled one.
const OPENF1 = 'https://api.openf1.org/v1/';
const BINS = 180;
const DRY = ['HARD', 'MEDIUM', 'SOFT'];

const isoTime = value => Date.parse(value) / 1000;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const roundTo = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

function bisectLeft(xs, x) {
  let low = 0;
  let high = xs.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (xs[mid] < x) low = mid + 1; else high = mid;
  }
  return low;
}

function interp(xs, ys, x) {
  const right = bisectLeft(xs, x);
  if (right === 0) return ys[0];
  if (right >= xs.length) return ys.at(-1);
  const left = right - 1;
  return ys[left] + (x - xs[left]) / (xs[right] - xs[left]) * (ys[right] - ys[left]);
}

function neutralPeriods(messages) {
  // Full-course messages only; a clear sector cannot end a neutralisation.
  let start = null;
  let stopped = false;
  let resumed = false;
  const periods = [];
  for (const row of [...messages].sort((a, b) => isoTime(a.date) - isoTime(b.date))) {
    const msg = (row.message || '').toUpperCase();
    const flag = row.flag;
    const when = isoTime(row.date);
    const red = flag === 'RED' || msg === 'SESSION ABORTED' || msg.startsWith('RED FLAG - RACE SUSPENDED');
    const deployed = ['SAFETY CAR DEPLOYED', 'VIRTUAL SAFETY CAR DEPLOYED', 'VSC DEPLOYED'].includes(msg);
    const formation = msg === 'EXTRA FORMATION LAP';
    if (red || deployed || formation) {
      start = start ?? when;
      if (red || formation) {
        stopped = true;
        resumed = formation;
      }
      continue;
    }
    if (start === null) continue;
    if (stopped && msg === 'SESSION STARTED') resumed = true;
    const ordinaryGreen = row.scope === 'Track' && ['GREEN', 'CLEAR'].includes(flag) && !stopped;
    const restart = stopped && resumed && ['STANDING START', 'ROLLING START'].includes(msg);
    if (ordinaryGreen || restart || msg === 'OVERTAKE ENABLED') {
      periods.push([start, when]);
      start = null;
      stopped = resumed = false;
    }
  }
  if (start !== null) periods.push([start, Infinity]);
  return periods;
}

function raceRows(source) {
  const periods = neutralPeriods(source.race_control);
  const stints = {};
  const stops = {};
  const laps = {};
  const list = (table, key) => (table[key] ??= []);
  for (const s of [...source.stints].sort((a, b) => a.stint_number - b.stint_number)) {
    list(stints, s.driver_number).push({start: s.lap_start, end: s.lap_end, compound: s.compound, age: s.tyre_age_at_start, number: s.stint_number});
  }
  for (const p of source.pit) (stops[p.driver_number] ??= {})[p.lap_number] = p.lane_duration || p.pit_duration;
  for (const row of [...source.laps].sort((a, b) => a.lap_number - b.lap_number)) {
    const driver = row.driver_number;
    const number = row.lap_number;
    const duration = row.lap_duration;
    const own = stints[driver] || [];
    const pits = stops[driver] || {};
    const stint = [...own].reverse().find(s => s.start <= number && number <= s.end) || null;
    const start = row.date_start ? isoTime(row.date_start) : null;
    const neutralized = Boolean(start && duration && periods.some(([begin, end]) => start < end && start + duration > begin));
    const later = own.slice(1).map(s => s.start);
    let reason = null;
    if (!duration || !start || ![1, 2, 3].every(i => row[`duration_sector_${i}`])) reason = '缺失计时';
    else if (number === 1) reason = '发车圈';
    else if (number in pits || later.includes(number + 1)) reason = '进站圈';
    else if (row.is_pit_out_lap || later.includes(number)) reason = '出站圈';
    else if (neutralized) reason = '全场减速';
    const age = stint && stint.age != null ? stint.age + number - stint.start + 1 : null;
    list(laps, driver).push({
      lap: number, time: duration ?? null, compound: stint ? stint.compound : null, age, excluded: reason, neutralized,
      sectors: [1, 2, 3].map(i => row[`duration_sector_${i}`] ?? null),
    });
  }
  return {laps, stints, stops};
}

function solve(matrix, targets) {
  const size = targets.length;
  const augmented = matrix.map((row, i) => [...row, targets[i]]);
  for (let i = 0; i < size; i++) {
    let pivot = i;
    for (let k = i + 1; k < size; k++) if (Math.abs(augmented[k][i]) > Math.abs(augmented[pivot][i])) pivot = k;
    if (Math.abs(augmented[pivot][i]) < 1e-9) return null;
    [augmented[i], augmented[pivot]] = [augmented[pivot], augmented[i]];
    const div = augmented[i][i];
    augmented[i] = augmented[i].map(v => v / div);
    for (let k = 0; k < size; k++) {
      if (k !== i && augmented[k][i]) {
        const scale = augmented[k][i];
        augmented[k] = augmented[k].map((a, j) => a - scale * augmented[i][j]);
      }
    }
  }
  return augmented.map(row => row.at(-1));
}

function fitPace(laps) {
  // Race lap trend and per-compound tyre slope; driver offsets absorb pace differences.
  const raceLaps = Math.max(...Object.values(laps).flat().map(r => r.lap));
  const samples = [];
  const ages = {};
  for (const driver of Object.keys(laps).sort()) {
    const usable = laps[driver].filter(r => !r.excluded && DRY.includes(r.compound) && r.age != null);
    if (usable.length < 12) continue;
    const midpoint = median(usable.map(r => r.time));
    for (const row of usable) {
      if (Math.abs(row.time - midpoint) <= 8) {
        samples.push([driver, row]);
        (ages[row.compound] ??= []).push(row.age);
      }
    }
  }
  const compounds = DRY.filter(c => (ages[c] || []).length >= 25);
  const used = samples.filter(([, row]) => compounds.includes(row.compound));
  if (used.length < 120 || compounds.length < 2) return null;
  const drivers = [...new Set(used.map(([d]) => d))].sort();
  const size = drivers.length + 2 * compounds.length;
  const features = used.map(([driver, row]) => {
    const compound = compounds.indexOf(row.compound);
    const values = [[drivers.indexOf(driver), 1], [drivers.length, row.lap / raceLaps],
      [drivers.length + compounds.length + compound, row.age / raceLaps]];
    if (compound) values.push([drivers.length + compound, 1]);
    return [values, row.time];
  });
  let weights = features.map(() => 1);
  let coefficients;
  let residuals;
  for (let round = 0; round < 6; round++) {
    const matrix = Array.from({length: size}, () => new Array(size).fill(0));
    const targets = new Array(size).fill(0);
    features.forEach(([values, y], n) => {
      const w = weights[n];
      for (const [i, a] of values) {
        targets[i] += w * a * y;
        for (const [j, b] of values) matrix[i][j] += w * a * b;
      }
    });
    coefficients = solve(matrix, targets);
    if (!coefficients) return null;
    residuals = features.map(([values, y]) => Math.abs(y - values.reduce((sum, [i, v]) => sum + coefficients[i] * v, 0)));
    const cutoff = Math.max(.35, 1.5 * median(residuals));
    weights = residuals.map(r => Math.min(1, cutoff / Math.max(.0001, r)));
  }
  const offsets = [0, ...coefficients.slice(drivers.length + 1, drivers.length + compounds.length)];
  const slopes = coefficients.slice(-compounds.length).map(c => c / raceLaps);
  return {
    count: used.length, drivers: drivers.length, medianError: roundTo(median(residuals), 3),
    compounds: Object.fromEntries(compounds.map((c, i) => [c, {offset: roundTo(offsets[i], 5), slope: roundTo(slopes[i], 6), maxAge: Math.max(...ages[c])}])),
  };
}

function rawCapture({lap, location, car}) {
  const start = isoTime(lap.date_start);
  const duration = lap.lap_duration;
  // Keyed by time like the Python dict: a later row at the same instant replaces an earlier one.
  const byTime = (rows, keep, value) => {
    const map = new Map();
    for (const row of rows) if (keep(row)) map.set(isoTime(row.date) - start, value(row));
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  };
  const positions = byTime(location, row => row.x != null && row.y != null && (row.x || row.y), row => [row.x, row.y]);
  const carRows = byTime(car, row => row.speed != null && row.throttle != null, row => row);
  if (!positions.length || !carRows.length) return null;
  if ([positions, carRows].some(rows => rows[0][0] > .35 || rows.at(-1)[0] < duration - .35)) return null;
  const xs = positions.map(([t]) => t);
  const trimmed = positions.filter(([t]) => t > 0 && t < duration).map(([t, p]) => [t, ...p]);
  const ends = [0, duration].map(t => [t, interp(xs, positions.map(([, p]) => p[0]), t), interp(xs, positions.map(([, p]) => p[1]), t)]);
  const points = [ends[0], ...trimmed, ends[1]];
  if (points.length < 100 || Math.max(...points.slice(1).map((p, i) => p[0] - points[i][0])) > 1.4) return null;
  return [lap, points, carRows];
}

function distanceAlong(points) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + Math.hypot(points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]));
  }
  return distances;
}

function alignTrace(points, center, distances) {
  // Project onto nearby reference segments, keeping the lap traversal monotonic.
  const aligned = [];
  let last = -1;
  const total = points.at(-1)[0];
  for (const [time, x, y] of points) {
    const estimate = time / total;
    let nearest = null;
    for (let i = 0; i < center.length - 1; i++) {
      if (Math.abs(distances[i] - estimate) > .16) continue;
      const a = center[i];
      const b = center[i + 1];
      const dx = b[1] - a[1];
      const dy = b[2] - a[2];
      const divisor = dx * dx + dy * dy;
      if (!divisor) continue;
      const fraction = Math.max(0, Math.min(1, ((x - a[1]) * dx + (y - a[2]) * dy) / divisor));
      const error = Math.hypot(a[1] + fraction * dx - x, a[2] + fraction * dy - y);
      const progress = distances[i] + fraction * (distances[i + 1] - distances[i]);
      if (nearest === null || error < nearest[0]) nearest = [error, progress];
    }
    if (nearest && nearest[1] > last + .00001) {
      last = nearest[1];
      aligned.push([last, time, x, y]);
    }
  }
  if (!aligned.length || aligned[0][0] > .035 || aligned.at(-1)[0] < .965) return [];
  return aligned;
}

function buildTelemetry(raw) {
  const available = Object.values(raw).flat();
  if (!available.length) throw new Error('No complete telemetry available');
  const [referenceLap, center] = available.reduce((best, r) => (r[0].lap_duration < best[0].lap_duration ? r : best));
  const cumulative = distanceAlong(center);
  if (!cumulative.at(-1)) throw new Error('Invalid reference position trace');
  const distances = cumulative.map(d => d / cumulative.at(-1));
  const centerTimes = center.map(p => p[0]);
  const first = referenceLap.duration_sector_1;
  const second = first + referenceLap.duration_sector_2;
  const cuts = [first, second].map(t => Math.round(interp(centerTimes, distances, t) * BINS));
  const cx = center.map(p => p[1]);
  const cy = center.map(p => p[2]);
  const [minX, maxX, minY, maxY] = [Math.min(...cx), Math.max(...cx), Math.min(...cy), Math.max(...cy)];
  const scale = Math.max(maxX - minX, maxY - minY);
  const mx = (maxX + minX) / 2;
  const my = (maxY + minY) / 2;
  const xy = (x, y) => [roundTo((x - mx) * 1000 / scale, 2), roundTo((my - y) * 1000 / scale, 2)];
  const positions = Array.from({length: BINS + 1}, (_, i) => i / BINS);
  const reference = positions.map(f => xy(interp(distances, cx, f), interp(distances, cy, f)));
  const result = {};
  for (const [driver, captures] of Object.entries(raw)) {
    for (const [lap, points, car] of [...captures].sort((a, b) => a[0].lap_duration - b[0].lap_duration)) {
      const aligned = alignTrace(points, center, distances);
      if (!aligned.length) continue;
      const progress = aligned.map(a => a[0]);
      const times = aligned.map(a => a[1]);
      const xx = aligned.map(a => a[2]);
      const yy = aligned.map(a => a[3]);
      const carTimes = car.map(([t]) => t);
      const carRows = car.map(([, row]) => row);
      const speed = carRows.map(r => r.speed);
      const throttle = carRows.map(r => r.throttle);
      const samples = positions.map(fraction => {
        const time = interp(progress, times, fraction);
        const elapsed = fraction === 0 ? 0 : fraction === 1 ? lap.lap_duration : time;
        let index = Math.min(carTimes.length - 1, bisectLeft(carTimes, time));
        if (index && Math.abs(carTimes[index - 1] - time) < Math.abs(carTimes[index] - time)) index -= 1;
        return [...xy(interp(progress, xx, fraction), interp(progress, yy, fraction)),
          roundTo(interp(carTimes, speed, time), 1), Math.round(interp(carTimes, throttle, time)),
          Boolean(carRows[index].brake), roundTo(elapsed, 3)];
      });
      (result[driver] ??= []).push({
        lap: lap.lap_number, time: lap.lap_duration, samples,
        sectors: [1, 2, 3].map(i => lap[`duration_sector_${i}`]),
        positionSamples: points.length, carSamples: carTimes.filter(t => t >= 0 && t <= lap.lap_duration).length,
      });
    }
  }
  if (Object.keys(result).length < 2) throw new Error('Need at least two aligned drivers');
  return {reference, cuts, laps: result};
}

function lapWeather(laps, weather) {
  const samples = weather.filter(w => w.date && w.track_temperature != null)
    .map(w => [isoTime(w.date), w]).sort((a, b) => a[0] - b[0]);
  if (!samples.length) return [];
  const times = samples.map(([t]) => t);
  const starts = {};
  for (const lap of laps) if (lap.date_start && lap.lap_number) (starts[lap.lap_number] ??= []).push(isoTime(lap.date_start));
  return Object.keys(starts).map(Number).sort((a, b) => a - b).map(number => {
    const moment = median(starts[number]);
    const i = bisectLeft(times, moment);
    const nearest = [i - 1, i].filter(j => j >= 0 && j < samples.length).sort((a, b) => Math.abs(times[a] - moment) - Math.abs(times[b] - moment))[0];
    const w = samples[nearest][1];
    return {lap: number, track: w.track_temperature, air: w.air_temperature ?? null, rain: Boolean(w.rainfall)};
  });
}

function buildEvent(id, source, telemetry, name) {
  const {laps, stints, stops} = raceRows(source);
  const roster = new Map(source.drivers.map(r => [r.driver_number, r]));
  const drivers = source.drivers_selected.filter(d => roster.has(d) && ((laps[d] || []).length || telemetry.laps[String(d)])).map(d => {
    const r = roster.get(d);
    return {id: d, code: r.name_acronym, name: r.full_name, surname: r.last_name, team: r.team_name,
      teamColour: r.team_colour ?? null, laps: laps[d] || [], stints: stints[d] || [], pit: stops[d] || {}};
  });
  const wet = Object.values(stints).flat().some(s => ['INTERMEDIATE', 'WET'].includes(s.compound));
  return {
    id, wet, name, year: source.race.year, circuit: source.race.circuit_short_name,
    raceKey: source.race.session_key, qualiKey: source.quali.session_key,
    date: (source.race.date_start || '').slice(0, 10) || null,
    totalLaps: Math.max(...Object.values(laps).flat().map(r => r.lap)),
    sourceLaps: Object.values(laps).reduce((sum, rows) => sum + rows.length, 0),
    drivers, telemetry, paceModel: wet ? null : fitPace(laps),
  };
}

// ---- Fetching from OpenF1 -------------------------------------------------------------------

let lastRequest = 0;
async function openf1(endpoint, query, onRetry) {
  // OpenF1's free tier allows a few requests a second and a few dozen a minute.
  const address = `${OPENF1}${endpoint}?${query}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastRequest + 450 - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastRequest = Date.now();
    let response;
    try {
      response = await fetch(address, {signal: AbortSignal.timeout(30000)});
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    if (response.status === 404) return [];
    if (response.ok) {
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error(`OpenF1 ${endpoint}: unexpected reply`);
      return data;
    }
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 5) throw new Error(`OpenF1 ${endpoint}: HTTP ${response.status}`);
    const pause = response.status === 429 ? Math.max(Number(response.headers.get('Retry-After')) || 0, 10 * (attempt + 1)) : 3 * (attempt + 1);
    onRetry?.(pause);
    await new Promise(resolve => setTimeout(resolve, pause * 1000));
  }
  return [];
}

const params = object => new URLSearchParams(object).toString();
const windowQuery = (base, start, end) => `${params(base)}&date>${encodeURIComponent(start)}&date<${encodeURIComponent(end)}`;

async function listOpenF1Races(year) {
  const [sessions, meetings] = await Promise.all([
    openf1('sessions', params({year, session_name: 'Race'})),
    openf1('meetings', params({year})),
  ]);
  const names = new Map(meetings.map(m => [m.meeting_key, m.meeting_name]));
  const now = Date.now();
  return sessions.filter(s => s.session_type === 'Race' && Date.parse(s.date_end || s.date_start) < now)
    .map(s => ({key: s.session_key, meeting: s.meeting_key, name: names.get(s.meeting_key) || `${s.country_name} Grand Prix`,
      circuit: s.circuit_short_name, date: (s.date_start || '').slice(0, 10)}))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function completeLap(lap) {
  return lap.date_start && lap.lap_duration && !lap.is_pit_out_lap && [1, 2, 3].every(i => lap[`duration_sector_${i}`]);
}

async function importOpenF1Race(race, {telemetryDrivers = 6, progress = () => {}} = {}) {
  // ~20 requests: the race timing feeds, then one qualifying lap of position and car data
  // for each of the fastest qualifiers.
  const say = (done, total, text) => progress(done / total, text);
  const total = 8 + 2 * telemetryDrivers;
  let done = 0;
  const retry = pause => progress(done / total, L(`OpenF1 请求过于频繁，${pause} 秒后重试…`, `OpenF1 rate limit, retrying in ${pause} s…`));
  const step = async (label, endpoint, query) => {
    say(done, total, label);
    const rows = await openf1(endpoint, query, retry);
    done += 1;
    return rows;
  };
  const sessions = await step(L('读取分站信息', 'Reading the weekend'), 'sessions', params({meeting_key: race.meeting}));
  const raceSession = sessions.find(s => s.session_key === race.key);
  const quali = sessions.find(s => s.session_name === 'Qualifying');
  if (!raceSession || !quali) throw new Error(L('OpenF1 没有这一站的正赛或排位赛', 'OpenF1 has no race or qualifying for this weekend'));
  const query = params({session_key: race.key});
  const source = {race: raceSession, quali};
  for (const [key, label] of [['laps', L('正赛圈速', 'race laps')], ['stints', L('轮胎', 'tyres')], ['pit', L('进站', 'pit stops')],
    ['race_control', L('赛事控制', 'race control')], ['drivers', L('车手', 'drivers')], ['weather', L('天气', 'weather')]]) {
    source[key] = await step(L(`读取${label}`, `Reading ${label}`), key, query);
  }
  if (!source.laps.length) throw new Error(L('OpenF1 没有这场正赛的圈速', 'OpenF1 has no lap timing for this race'));
  const qualiQuery = {session_key: quali.session_key};
  const qualiLaps = await step(L('读取排位圈速', 'Reading qualifying laps'), 'laps', params(qualiQuery));
  // The fastest qualifiers carry telemetry; every finisher keeps full race timing.
  const fastest = new Map();
  for (const lap of qualiLaps.filter(completeLap)) {
    const best = fastest.get(lap.driver_number);
    if (!best || lap.lap_duration < best.lap_duration) fastest.set(lap.driver_number, lap);
  }
  const picks = [...fastest.values()].sort((a, b) => a.lap_duration - b.lap_duration).slice(0, telemetryDrivers);
  const raw = {};
  for (const lap of picks) {
    const start = new Date(Date.parse(lap.date_start) - 2000).toISOString();
    const end = new Date(Date.parse(lap.date_start) + lap.lap_duration * 1000 + 2000).toISOString();
    const base = {...qualiQuery, driver_number: lap.driver_number};
    const code = source.drivers.find(d => d.driver_number === lap.driver_number)?.name_acronym || lap.driver_number;
    const location = await step(L(`读取 ${code} 排位圈位置`, `Reading ${code}'s qualifying lap`), 'location', windowQuery(base, start, end));
    const car = await step(L(`读取 ${code} 车载数据`, `Reading ${code}'s car data`), 'car_data', windowQuery(base, start, end));
    const capture = location.length > 100 && car.length > 100 ? rawCapture({lap, location, car}) : null;
    if (capture) raw[String(lap.driver_number)] = [capture];
  }
  say(total, total, L('整理数据', 'Building the race'));
  const telemetry = buildTelemetry(raw);
  // Running order: laps completed, then total race time.
  const order = Object.entries(source.laps.reduce((acc, lap) => {
    const entry = (acc[lap.driver_number] ??= {laps: 0, time: 0});
    entry.laps = Math.max(entry.laps, lap.lap_number);
    entry.time += lap.lap_duration || 0;
    return acc;
  }, {})).sort(([, a], [, b]) => b.laps - a.laps || a.time - b.time).map(([d]) => Number(d));
  source.drivers_selected = [...order, ...source.drivers.map(d => d.driver_number).filter(d => !order.includes(d))];
  const event = buildEvent(`openf1-${race.key}`, source, telemetry, race.name);
  event.weather = lapWeather(source.laps, source.weather);
  event.imported = true;
  event.telemetrySource = 'OpenF1';
  return event;
}

// ---- Saved in this browser (IndexedDB) -------------------------------------------------------

function raceStore(mode, work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('raceopic', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('races', {keyPath: 'id'});
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction('races', mode);
      const request = work(transaction.objectStore('races'));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

const savedRaces = {
  list: () => raceStore('readonly', store => store.getAll()).then(rows => rows.map(({event, ...entry}) => entry)).catch(() => []),
  get: id => raceStore('readonly', store => store.get(id)).then(row => row?.event),
  put: event => raceStore('readwrite', store => store.put({
    id: event.id, name: event.name, year: event.year, circuit: event.circuit, date: event.date, wet: event.wet, event,
  })),
  remove: id => raceStore('readwrite', store => store.delete(id)),
};

if (typeof module !== 'undefined') module.exports = {raceRows, fitPace, rawCapture, buildTelemetry, lapWeather, buildEvent, neutralPeriods};
