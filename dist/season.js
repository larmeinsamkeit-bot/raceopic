'use strict';

const $ = id => document.getElementById(id);
const API = 'https://api.jolpi.ca/ergast/f1/2026/';
const OPENF1 = 'https://api.openf1.org/v1/';
const CACHE = 'raceopic-season-2026-v1';
const INTERVAL = 15 * 60 * 1000;
const sessions = {
  FirstPractice: L('第一次练习', 'Practice 1'), SecondPractice: L('第二次练习', 'Practice 2'), ThirdPractice: L('第三次练习', 'Practice 3'),
  SprintQualifying: L('冲刺排位', 'Sprint qualifying'), Sprint: L('冲刺赛', 'Sprint'), Qualifying: L('排位赛', 'Qualifying'), Race: L('正赛', 'Race'),
};
const resultLabels = {results: L('正赛', 'Race'), qualifying: L('排位', 'Qualifying'), sprint: L('冲刺', 'Sprint')};
const classes = {results: 'Results', qualifying: 'QualifyingResults', sprint: 'SprintResults'};
const archiveLabels = {laps: L('逐圈计时', 'Laps'), stints: L('轮胎', 'Stints'), pit: L('进站', 'Pit stops'), weather: L('天气', 'Weather'), race_control: L('赛会消息', 'Race control')};
const time = new Intl.DateTimeFormat(L('zh-CN', 'en-GB'), {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
const num = new Intl.NumberFormat(L('zh-CN', 'en-GB'), {maximumFractionDigits: 2});
const state = {data: null, round: null, result: 'results', archiveType: 'laps', archiveIndex: [], labRounds: new Set(), archiveToken: 0, archives: new Map(), checked: 0};

function safe(value) {
  return String(value ?? '—').replace(/[&<>"']/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]);
}

async function json(url, empty404 = false) {
  const reply = await fetch(url, {signal: AbortSignal.timeout(11000)});
  if (empty404 && reply.status === 404) return [];
  if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
  return reply.json();
}

function stamp(date, t) { return Date.parse(`${date}T${t || '00:00:00Z'}`); }
function dateLabel(date, t) { return t ? time.format(stamp(date, t)) : date; }
function roundsWithPoints() { return Object.keys(state.data.snapshots).map(Number).sort((a, b) => a - b); }
function latest() { return roundsWithPoints().at(-1); }
function raceSelected() { return state.data.rounds.find(r => r.round === (state.round ?? latest())) || state.data.rounds[0]; }
function roundLabel(race) { return `R${String(race.round).padStart(2, '0')} · ${race.name}`; }
function resultTypes(race) { return ['results', 'qualifying', ...(race.sessions.Sprint ? ['sprint'] : [])]; }

function tableRows(kind, rows, previous) {
  const baseline = new Map(previous.map(row => [row.id, row]));
  $(`${kind}Count`).textContent = `${rows.length} ${kind === 'driver' ? L('位车手', 'drivers') : L('支车队', 'teams')}`;
  $(`${kind}Board`).innerHTML = rows.map(row => {
    const before = baseline.get(row.id);
    const move = before?.rank != null && row.rank != null ? before.rank - row.rank : 0;
    const gained = row.points - (before?.points ?? 0);
    const rank = move ? `<small class="${move > 0 ? 'gain' : 'loss'}">${move > 0 ? '↑' : '↓'}${Math.abs(move)}</small>` : '';
    const subline = [row.code, row.team].filter(Boolean).map(safe).join(' · ');
    const delta = gained ? `${gained > 0 ? '+' : ''}${num.format(gained)}` : '—';
    return `<tr class="${row.rank === 1 ? 'leader' : ''}"><th scope="row">${safe(row.rank)}${rank}</th>
      <td>${safe(row.name)}${subline ? `<small>${subline}</small>` : ''}</td>
      <td class="numeric ${gained > 0 ? 'gain' : gained < 0 ? 'loss' : ''}">${delta}</td>
      <td class="numeric points">${num.format(row.points)}</td></tr>`;
  }).join('') || `<tr><td colspan="4">${L('暂无积分记录', 'No points yet')}</td></tr>`;
}

function render() {
  const race = raceSelected();
  const {rounds, snapshots} = state.data;
  const done = roundsWithPoints();
  const next = rounds.find(row => row.round > latest());
  const asOf = done.filter(n => n <= race.round).at(-1);
  const selected = snapshots[asOf];
  const previous = snapshots[done.filter(n => n < asOf).at(-1)];
  $('roundSelect').replaceChildren(new Option(L('跟随最新已结算轮次', 'Latest completed round'), ''), ...rounds.map(r => new Option(roundLabel(r), r.round)));
  $('roundSelect').value = state.round ?? '';
  $('calendarTitle').textContent = roundLabel(race);
  $('roundMeta').textContent = `${race.circuit} · ${dateLabel(race.date, race.time)}`;
  $('calendarNext').textContent = next ? `${L('下一站', 'Next:')} ${next.name} · ${dateLabel(next.date, next.time)}` : L('赛季已结算', 'Season complete');
  $('previousRound').disabled = race === rounds[0];
  $('nextRound').disabled = race === rounds.at(-1);
  $('calendarProgress').max = rounds.length;
  $('calendarProgress').value = done.length;
  $('calendarProgress').setAttribute('aria-valuetext', L(`已结算 ${done.length} / ${rounds.length} 轮`, `${done.length} of ${rounds.length} rounds complete`));
  $('lastUpdated').textContent = L(`数据核对于 ${time.format(new Date(state.data.updated))} · 已结算 ${done.length}/${rounds.length} 轮`, `Checked ${time.format(new Date(state.data.updated))} · ${done.length}/${rounds.length} rounds complete`);
  const programme = Object.entries(race.sessions).sort(([, a], [, b]) => stamp(a.date, a.time) - stamp(b.date, b.time));
  $('sessionSchedule').innerHTML = programme.map(([key, date]) =>
    `<div><strong>${sessions[key]}</strong><span>${safe(dateLabel(date.date, date.time))}</span></div>`).join('');
  $('boardNotice').textContent = !selected ? L('此轮暂无积分记录。', 'No standings for this round yet.') : asOf === race.round ?
    L(`第 ${asOf} 轮结束后 · 本轮列为较上一轮的积分变化`, `After round ${asOf} · the round column is the change since the previous round`) :
    L(`第 ${race.round} 轮尚未结算，当前显示截至第 ${asOf} 轮的积分。`, `Round ${race.round} is not complete; showing standings after round ${asOf}.`);
  tableRows('driver', selected?.drivers ?? [], previous?.drivers ?? []);
  tableRows('team', selected?.teams ?? [], previous?.teams ?? []);
  renderResults(race);
  void renderArchive(race);
}

function buttons(target, keys, current, label, select) {
  target.replaceChildren(...keys.map(key => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label(key);
    button.setAttribute('aria-pressed', key === current);
    button.onclick = () => select(key);
    return button;
  }));
}

function renderResults(race) {
  const choices = resultTypes(race);
  if (!choices.includes(state.result)) state.result = 'results';
  buttons($('resultModes'), choices, state.result, key => resultLabels[key], key => {
    state.result = key;
    renderResults(race);
  });
  const rows = state.data.snapshots[race.round]?.results[state.result] || [];
  $('resultEmpty').hidden = Boolean(rows.length);
  $('resultScroll').hidden = !rows.length;
  $('resultEmpty').textContent = rows.length ? '' : L('此轮暂未归档这类成绩。', 'No results of this type for this round yet.');
  if (!rows.length) return;
  const qualifying = state.result === 'qualifying';
  const headers = qualifying ? [L('排名', 'Pos'), L('车手', 'Driver'), 'Q1', 'Q2', 'Q3'] : [L('排名', 'Pos'), L('车手', 'Driver'), L('发车位', 'Grid'), L('完成圈', 'Laps'), L('成绩 / 状态', 'Time / status'), L('积分', 'Points')];
  $('resultHead').innerHTML = `<tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr>`;
  $('resultRows').innerHTML = rows.map(row => {
    const values = qualifying ? [row.q1, row.q2, row.q3] :
      [Number(row.grid) === 0 && row.grid != null ? L('维修区/未排位', 'Pit lane / no grid') : row.grid, row.laps, row.time || row.status, row.points];
    return `<tr><th scope="row">${safe(row.rank)}</th><td>${safe(row.name)}<small>${safe(row.team)}</small></td>
      ${values.map(value => `<td>${safe(value)}</td>`).join('')}</tr>`;
  }).join('');
}

const columns = {
  laps: [[L('车手', 'Driver'), 'driver_number'], [L('圈数', 'Lap'), 'lap_number'], [L('圈速 s', 'Lap time s'), 'lap_duration'], ['S1 s', 'duration_sector_1'], ['S2 s', 'duration_sector_2'], ['S3 s', 'duration_sector_3']],
  stints: [[L('车手', 'Driver'), 'driver_number'], [L('配方', 'Compound'), 'compound'], [L('起始圈', 'First lap'), 'lap_start'], [L('结束圈', 'Last lap'), 'lap_end'], [L('起始胎龄', 'Age at start'), 'tyre_age_at_start']],
  pit: [[L('车手', 'Driver'), 'driver_number'], [L('进站圈', 'Lap'), 'lap_number'], [L('维修区 s', 'Pit lane s'), 'lane_duration'], [L('停留 s', 'Stationary s'), 'stop_duration']],
  weather: [[L('时间', 'Time'), 'date'], [L('气温 °C', 'Air °C'), 'air_temperature'], [L('赛道 °C', 'Track °C'), 'track_temperature'], [L('湿度 %', 'Humidity %'), 'humidity'], [L('降雨', 'Rain'), 'rainfall'], [L('风速 m/s', 'Wind m/s'), 'wind_speed']],
  race_control: [[L('时间', 'Time'), 'date'], [L('圈数', 'Lap'), 'lap_number'], [L('分类', 'Category'), 'category'], [L('赛会消息', 'Message'), 'message']],
};

async function renderArchive(race) {
  const token = ++state.archiveToken;
  const entry = state.archiveIndex.find(row => Math.abs(Date.parse(race.date) - Date.parse(row.date)) <= 86400000);
  $('archiveDownload').hidden = $('archiveContent').hidden = true;
  $('archiveLab').hidden = !state.labRounds.has(race.round);
  $('archiveLab').href = `index.html?round=${race.round}#track`;
  $('archiveTitle').textContent = `${race.name} · ${L('正赛档案', 'race archive')}`;
  const settled = Boolean(state.data.snapshots[race.round]);
  $('archiveStatus').textContent = entry || settled ? L('正在读取本站档案…', 'Loading the race archive…') : L('本站正赛详细数据待发布。', 'Detailed race data is not published yet.');
  if (!entry && !settled) return;
  try {
    const url = entry ? `season-2026/${entry.key}.json` : null;
    if (!state.archives.has(race.round)) {
      const request = url ? json(url) : getNewArchive(race);
      state.archives.set(race.round, request);
      request.catch(() => state.archives.delete(race.round));
    }
    const data = await state.archives.get(race.round);
    if (token !== state.archiveToken) return;
    state.archive = data;
    $('archiveContent').hidden = $('archiveDownload').hidden = false;
    const filename = `raceopic-2026-r${race.round}-openf1.json`;
    $('archiveDownload').href = url || '#roundArchive';
    $('archiveDownload').onclick = url ? null : event => { event.preventDefault(); saveJson(data, filename); };
    $('archiveDownload').download = filename;
    $('archiveStatus').textContent = L(`${data.drivers.length} 位车手 · ${num.format(data.laps.length)} 条逐圈记录。可下载本站完整归档。`, `${data.drivers.length} drivers · ${num.format(data.laps.length)} laps. The full archive can be downloaded.`);
    $('archiveDriver').replaceChildren(new Option(L('全部车手', 'All drivers'), ''), ...state.archive.drivers.map(d =>
      new Option(`${d.name_acronym} · ${d.last_name}`, d.driver_number)));
    renderArchiveRows();
  } catch {
    if (token === state.archiveToken) $('archiveStatus').textContent = L('本站详细数据暂不可用，可稍后刷新重试。', 'Detailed data is unavailable right now; try again later.');
  }
}

async function getNewArchive(race) {
  const cacheKey = `raceopic-2026-openf1-r${race.round}`;
  try {
    const saved = JSON.parse(localStorage.getItem(cacheKey));
    if (saved?.laps?.length && saved?.drivers?.length) return saved;
  } catch { /* The public archive can still be requested without browser storage. */ }
  const races = await json(`${OPENF1}sessions?year=2026&session_name=Race`);
  const at = stamp(race.date, race.time);
  const nearest = races.reduce((best, current) => !best ||
    Math.abs(Date.parse(current.date_start) - at) < Math.abs(Date.parse(best.date_start) - at) ? current : best, null);
  if (!nearest || Math.abs(Date.parse(nearest.date_start) - at) > 86400000) throw new Error('No matching historical session');
  const kinds = ['drivers', 'laps', ...Object.keys(archiveLabels).filter(key => key !== 'laps')];
  const get = kind => json(`${OPENF1}${kind}?session_key=${nearest.session_key}`, true);
  const first = await Promise.all(kinds.slice(0, 3).map(get));
  const last = await Promise.all(kinds.slice(3).map(get));
  const feeds = [...first, ...last];
  const data = {source: 'OpenF1', session: nearest, ...Object.fromEntries(kinds.map((kind, i) => [kind, feeds[i]]))};
  if (!data.drivers.length || !data.laps.length) throw new Error('Timing still pending');
  try { localStorage.setItem(cacheKey, JSON.stringify(data)); }
  catch { /* The current round remains available and downloadable. */ }
  return data;
}

function saveJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], {type: 'application/json'}));
  const download = document.createElement('a');
  download.href = url;
  download.download = filename;
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderArchiveRows() {
  const data = state.archive;
  const key = state.archiveType;
  buttons($('archiveModes'), Object.keys(archiveLabels), key, k => `${archiveLabels[k]} · ${num.format(data[k].length)}`, picked => {
    state.archiveType = picked;
    renderArchiveRows();
  });
  const filtered = ['laps', 'stints', 'pit'].includes(key);
  $('archiveDriverFilter').hidden = !filtered;
  const driver = filtered ? Number($('archiveDriver').value) : 0;
  const items = data[key].filter(row => !driver || driver === row.driver_number);
  const codes = new Map(data.drivers.map(d => [d.driver_number, d.name_acronym]));
  const fields = columns[key];
  const value = (row, field) => {
    if (field === 'date') return row[field] ? time.format(new Date(row[field])) : null;
    if (field === 'driver_number') return codes.get(row[field]) ?? row[field];
    if (field === 'rainfall') return row[field] == null ? null : row[field] ? L('有', 'yes') : L('无', 'no');
    if (field === 'lane_duration') return row[field] ?? row.pit_duration;
    return row[field];
  };
  $('archivePreview').innerHTML = `<table class="sports-table archive-table"><caption>${L(`预览 ${Math.min(12, items.length)} / ${num.format(items.length)} 条`, `Showing ${Math.min(12, items.length)} of ${num.format(items.length)}`)}</caption>
    <thead><tr>${fields.map(([label]) => `<th scope="col">${label}</th>`).join('')}</tr></thead>
    <tbody>${items.slice(0, 12).map(row => `<tr>${fields.map(([, field]) => `<td>${safe(value(row, field))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

async function api(path = '') { return (await json(`${API}${path}?limit=100`)).MRData; }
function fullName(driver) { return `${driver.givenName} ${driver.familyName}`; }

function convertRace(raw) {
  return {
    round: Number(raw.round), name: raw.raceName, date: raw.date, time: raw.time,
    circuit: raw.Circuit.circuitName, country: raw.Circuit.Location.country,
    sessions: {...Object.fromEntries(Object.keys(sessions).filter(key => raw[key]).map(key => [key, raw[key]])),
      Race: {date: raw.date, time: raw.time}},
  };
}

function convertStandings(driver, team, results) {
  return {
    drivers: driver.DriverStandings.map(row => ({
      id: row.Driver.driverId, name: fullName(row.Driver), code: row.Driver.code, rank: row.position ? Number(row.position) : null,
      points: Number(row.points ?? 0), team: row.Constructors.map(t => t.name).join(' / '),
    })),
    teams: team.ConstructorStandings.map(row => ({
      id: row.Constructor.constructorId, name: row.Constructor.name,
      rank: row.position ? Number(row.position) : null, points: Number(row.points ?? 0),
    })),
    results,
  };
}

async function fetchResults(race) {
  const entries = await Promise.all(resultTypes(race).map(async type => {
    const data = await api(`${race.round}/${type}/`);
    const rows = data.RaceTable.Races[0]?.[classes[type]] || [];
    return [type, rows.map(row => ({
      rank: row.positionText ?? row.position, name: fullName(row.Driver), team: row.Constructor.name,
      grid: row.grid, laps: row.laps, time: row.Time?.time, status: row.status,
      points: row.points, q1: row.Q1, q2: row.Q2, q3: row.Q3,
    }))];
  }));
  return Object.fromEntries(entries);
}

async function fetchStandings(prefix = '') {
  const entries = await Promise.all(['driverstandings', 'constructorstandings'].map(k => api(`${prefix}${k}/`)));
  return entries.map(entry => entry.StandingsTable.StandingsLists[0]);
}

async function refreshResults(race, previous = {}) {
  try {
    const remote = await fetchResults(race);
    return {...previous, ...Object.fromEntries(Object.entries(remote).filter(([, rows]) => rows.length))};
  } catch (error) {
    if (previous.results?.length) return previous;
    throw error;
  }
}

async function refresh(manual = false) {
  if (state.refreshing || (!manual && Date.now() - state.checked < INTERVAL)) return;
  state.refreshing = true;
  state.checked = Date.now();
  const button = $('syncSeason');
  button.disabled = true;
  button.textContent = L('正在检查…', 'Checking…');
  try {
    const [calendar, [drivers, teams]] = await Promise.all([api(), fetchStandings()]);
    const rounds = calendar.RaceTable.Races.map(convertRace);
    const newest = Number(drivers?.round);
    if (!rounds.length || !newest || newest !== Number(teams?.round) || newest < latest()) throw new Error('Incomplete or older data');
    const snapshots = {...state.data.snapshots};
    for (const race of rounds.filter(row => row.round <= newest)) {
      const number = race.round;
      if (snapshots[number] && number < newest) continue;
      const [driver, team] = number === newest ? [drivers, teams] : await fetchStandings(`${number}/`);
      if (Number(driver?.round) !== number || Number(team?.round) !== number) break;
      const results = await refreshResults(race, snapshots[number]?.results);
      if (!results.results?.length) break;
      const snapshot = convertStandings(driver, team, results);
      if (!snapshot.drivers.length || !snapshot.teams.length) break;
      snapshots[number] = snapshot;
    }
    if (!snapshots[newest]) throw new Error('Results unavailable');
    state.checked = Date.now();
    state.data = {...state.data, rounds, snapshots, updated: new Date(state.checked).toISOString()};
    try { localStorage.setItem(CACHE, JSON.stringify({data: state.data, checked: state.checked})); }
    catch { /* Storage is optional; the published archive remains available. */ }
    render();
    button.textContent = L('已核对 · 再次刷新', 'Up to date · check again');
  } catch {
    button.textContent = L('↻ 暂用已保存数据 · 重试', '↻ Using saved data · retry');
  } finally {
    button.disabled = state.refreshing = false;
  }
}

function navigate(step) {
  const rounds = state.data.rounds;
  const next = rounds[rounds.indexOf(raceSelected()) + step];
  if (next) {
    state.round = next.round;
    render();
  }
}

async function start() {
  try {
    const [data, archive, lab] = await Promise.all([
      json('season-2026.json'), json('archive-2026.json').catch(() => []),
      json('lab-2026/index.json?v=season-lab').catch(() => []),
    ]);
    state.data = data;
    state.archiveIndex = archive;
    state.labRounds = new Set(lab.map(entry => entry.round));
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE));
      if (saved?.data?.year === 2026 && Date.parse(saved.data.updated) >= Date.parse(data.updated)) {
        state.data = saved.data;
        state.checked = saved.checked;
      }
    } catch { /* Use the site's saved archive. */ }
    $('seasonLoading').hidden = true;
    $('seasonContent').hidden = false;
    $('roundSelect').onchange = event => { state.round = Number(event.target.value) || null; render(); };
    $('previousRound').onclick = () => navigate(-1);
    $('nextRound').onclick = () => navigate(1);
    $('syncSeason').onclick = () => refresh(true);
    $('downloadSeason').onclick = () => saveJson(state.data, 'raceopic-2026-championship.json');
    $('archiveDriver').onchange = renderArchiveRows;
    render();
    void refresh();
    setInterval(() => { if (!document.hidden) void refresh(); }, INTERVAL);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  } catch {
    $('seasonLoading').textContent = L('赛季档案暂时无法读取，请刷新页面重试。', 'Season data failed to load. Please reload the page.');
  }
}

start();
