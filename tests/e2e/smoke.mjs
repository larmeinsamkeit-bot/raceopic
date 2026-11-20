// End-to-end smoke test of the static site in a real browser.
// Serves dist/ itself, then checks every race, the lab views, shareable URLs, both languages,
// the season page and the phone layout. Exits non-zero on the first failed check.
//   node tests/e2e/smoke.mjs            (needs the `playwright` package and its Chromium)
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const root = fileURLToPath(new URL('../../dist/', import.meta.url));
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml'};

const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(root, path || 'index.html'));
    response.writeHead(200, {'content-type': types[extname(path)] || 'application/octet-stream'});
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const errors = [];
const watch = page => {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return page;
};
const loaded = page => page.waitForFunction(() => !document.getElementById('eventStatus')?.textContent, null, {timeout: 20000});

try {
  const page = watch(await browser.newPage({viewport: {width: 1440, height: 1000}, locale: 'zh-CN'}));

  // Every race loads with a comparison, telemetry and its own URL.
  await page.goto(base + 'index.html');
  await page.waitForSelector('#dashboard:not([hidden])', {timeout: 20000});
  const races = await page.$$eval('#race option', options => options.map(o => o.value));
  check(races.length >= 20, `race list has ${races.length} races`);
  for (const id of races) {
    await page.selectOption('#race', id);
    await loaded(page);
    const state = await page.evaluate(() => ({
      gap: document.getElementById('gap').textContent.trim(),
      track: !document.getElementById('trackContent').hidden,
      trace: document.querySelectorAll('#traceChart svg').length,
      story: document.querySelectorAll('#storyChart path').length,
      url: location.search,
    }));
    check(state.gap !== '—' && state.track && state.trace === 4 && state.story > 0 && state.url.includes(`race=${id}`),
      `${id}: gap ${state.gap}, map, trace and race story render`);
  }

  // The trace's final gap matches the two qualifying lap times.
  await page.goto(base + 'index.html?race=2026-r06&a=RUS&b=ANT');
  await loaded(page);
  const summary = await page.textContent('#traceSummary');
  const times = await page.$$eval('#qualiA option:checked, #qualiB option:checked', o => o.map(x => x.textContent.split('·')[1].trim()));
  const seconds = t => t.split(':').reduce((m, s) => m * 60 + Number(s), 0);
  const expected = Math.abs(seconds(times[0]) - seconds(times[1])).toFixed(3);
  check(summary.includes(expected), `trace lap gap ${expected} s appears in the summary`);

  // Charts move their cursor from the keyboard.
  await page.focus('#traceChart');
  await page.keyboard.press('End');
  check((await page.textContent('#traceReadout')).startsWith('100%'), 'trace cursor reaches the end of the lap with End');
  await page.focus('#chart');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  check(/第 11 圈|Lap 11/.test(await page.textContent('#tooltip')), 'pace chart steps ten laps with Shift+Arrow');
  await page.focus('#storyChart');
  await page.keyboard.press('Home');
  check(/第 1 圈|Lap 1 /.test(await page.textContent('#storyReadout')), 'race story cursor jumps to lap 1 with Home');

  // Map views, zoom and follow.
  for (const mode of ['miniMode', 'lines', 'replayMode', 'dominance']) {
    await page.click(`#${mode}`);
    check(await page.$eval(`#${mode}`, b => b.getAttribute('aria-pressed')) === 'true', `${mode} view opens`);
  }
  const svg = await page.$('#trackMap svg');
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(600);
  check(parseFloat(await page.textContent('#zoomLevel')) > 1.5, 'wheel zooms the map at the pointer');
  await page.click('#replayMode');
  await page.selectOption('#zoomFollow', '0');
  await page.click('#replayPlay');
  await page.waitForTimeout(800);
  await page.click('#replayPlay');
  check(parseFloat(await page.textContent('#replayClock')) > 0, 'replay plays and the camera can follow');

  // A shared URL restores the comparison.
  await page.goto(base + 'index.html?race=brazil&a=VER&b=LEC&mode=replay');
  await loaded(page);
  const restored = await page.evaluate(() => [document.getElementById('race').value,
    document.getElementById('driverA').selectedOptions[0].textContent, document.getElementById('driverB').selectedOptions[0].textContent,
    document.getElementById('replayMode').getAttribute('aria-pressed')]);
  check(restored[0] === 'brazil' && restored[1].startsWith('VER') && restored[2].startsWith('LEC') && restored[3] === 'true',
    `shared URL restores ${restored.join(' / ')}`);

  // Season page: standings, teammates, forecasts.
  await page.goto(base + 'season.html');
  await page.waitForSelector('#seasonContent:not([hidden])', {timeout: 20000});
  await page.waitForTimeout(1500);
  check(await page.$$eval('#driverBoard tr', r => r.length) >= 20, 'driver standings render');
  check(await page.isVisible('#teammates') && await page.$$eval('.tm-bar', r => r.length) > 10, 'teammate head-to-head renders');
  check(await page.isVisible('#prediction') && await page.$$eval('#forecastPicker button', b => b.length) >= 3, 'forecasts and race picker render');

  // English: no Chinese left on either page except the language toggle.
  const english = watch(await browser.newPage({viewport: {width: 1440, height: 1000}, locale: 'en-US'}));
  for (const url of ['index.html?race=2026-r06&mode=replay', 'season.html']) {
    await english.goto(base + url);
    await english.waitForTimeout(3000);
    const leftover = await english.evaluate(() => document.body.innerText.split('\n')
      .filter(line => /[一-鿿]/.test(line) && line.trim() !== '中文'));
    check(leftover.length === 0, `English ${url} has no Chinese text${leftover.length ? `: ${leftover.slice(0, 3).join(' | ')}` : ''}`);
  }

  // Phone width: no sideways scroll.
  const phone = watch(await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}));
  for (const url of ['index.html?race=brazil&mode=replay', 'season.html']) {
    await phone.goto(base + url);
    await phone.waitForTimeout(2500);
    const width = await phone.evaluate(() => document.documentElement.scrollWidth);
    check(width <= 390, `${url} fits a 390 px phone (scroll width ${width})`);
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
