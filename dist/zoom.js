'use strict';

// Map-style zoom for the track: zoom anywhere under the pointer, pan freely, smooth motion.
// Wheel or trackpad pinch zooms at the pointer; at full view a downward scroll passes to the page.
// Touch: pinch and drag. Double-click / double-tap zooms in there (Shift zooms out).
// Keyboard on the focused map: + − 0 and arrow keys. A minimap shows where you are once zoomed.
// In replay the camera can follow a car.
const ZOOM_MIN = 1;
const ZOOM_MAX = 24;
const mapZoom = {
  svg: null, base: null, glyphs: [], markers: [], follow: null, frame: null,
  view: {k: 1, cx: 0, cy: 0},
  goal: {k: 1, cx: 0, cy: 0},
};

function zoomAttach(view, drivers, replaying) {
  const svg = $('trackMap').querySelector('svg');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('aria-roledescription', L('可缩放赛道图', 'zoomable track map'));
  const centre = {k: 1, cx: view[0] + view[2] / 2, cy: view[1] + view[3] / 2};
  if (mapZoom.frame !== null) cancelAnimationFrame(mapZoom.frame);
  Object.assign(mapZoom, {
    svg, base: view, frame: null, view: {...centre}, goal: {...centre},
    glyphs: [...svg.querySelectorAll('.glyph')].map(g => [g, Number(g.dataset.s)]),
    markers: [...svg.querySelectorAll('.track-marker')].map(m => [m, Number(m.getAttribute('r'))]),
  });
  buildMinimap(svg, view);
  const follow = $('zoomFollow');
  $('zoomFollowWrap').hidden = !replaying;
  if (replaying) {
    const keep = mapZoom.follow;
    follow.replaceChildren(option('', L('不跟随', 'Off')), ...drivers.map((d, i) => option(i, d.code)));
    follow.value = keep ?? '';
  } else {
    mapZoom.follow = null;
  }
  bindZoomGestures(svg);
  render();
}

function buildMinimap(svg, view) {
  $('trackMap').querySelector('.minimap')?.remove();
  const road = svg.querySelector('.track-road')?.getAttribute('d');
  if (!road) return;
  const mini = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mini.setAttribute('class', 'minimap');
  mini.setAttribute('viewBox', view.join(' '));
  mini.setAttribute('aria-hidden', 'true');
  mini.innerHTML = `<path class="minimap-road" d="${road}"/><rect class="minimap-view"/>`;
  mini.addEventListener('pointerdown', event => {
    event.preventDefault();
    const point = svgPoint(mini, event.clientX, event.clientY);
    if (!point) return;
    if (mapZoom.follow !== null) setFollow(null);
    mapZoom.goal.cx = point[0];
    mapZoom.goal.cy = point[1];
    animate();
  });
  $('trackMap').append(mini);
  mapZoom.minimap = mini;
}

function limit(state) {
  // Any point of the circuit can be brought to the centre: the centre may go right up to the edge.
  const {base} = mapZoom;
  state.k = clamp(state.k, ZOOM_MIN, ZOOM_MAX);
  state.cx = clamp(state.cx, base[0], base[0] + base[2]);
  state.cy = clamp(state.cy, base[1], base[1] + base[3]);
  if (state.k <= ZOOM_MIN + 1e-3) {
    state.cx = base[0] + base[2] / 2;
    state.cy = base[1] + base[3] / 2;
  }
  return state;
}

function render() {
  const {svg, base, view} = mapZoom;
  if (!svg) return;
  const w = base[2] / view.k;
  const h = base[3] / view.k;
  svg.setAttribute('viewBox', `${view.cx - w / 2} ${view.cy - h / 2} ${w} ${h}`);
  // Cars, bend numbers, gates and cursors keep their on-screen size.
  for (const [glyph, scale] of mapZoom.glyphs) glyph.setAttribute('transform', `scale(${scale / view.k})`);
  for (const [marker, r] of mapZoom.markers) marker.setAttribute('r', r / view.k);
  const zoomed = mapZoom.goal.k > 1.001;
  svg.classList.toggle('zoomed', zoomed);
  if (mapZoom.minimap) {
    mapZoom.minimap.classList.toggle('visible', zoomed);
    const rect = mapZoom.minimap.querySelector('.minimap-view');
    rect.setAttribute('x', view.cx - w / 2);
    rect.setAttribute('y', view.cy - h / 2);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
  }
  const k = mapZoom.goal.k;
  $('zoomLevel').value = `${k < 9.95 ? k.toFixed(1) : Math.round(k)}×`;
  $('zoomOut').disabled = k <= ZOOM_MIN + 1e-3;
  $('zoomIn').disabled = k >= ZOOM_MAX - 1e-3;
  $('zoomReset').disabled = k <= ZOOM_MIN + 1e-3;
}

function animate(instant = false) {
  limit(mapZoom.goal);
  if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Object.assign(mapZoom.view, mapZoom.goal);
    render();
    return;
  }
  if (mapZoom.frame !== null) return;
  const step = () => {
    const {view, goal} = mapZoom;
    // Ease zoom in log space so each step feels the same at any scale.
    const logK = Math.log(view.k) + (Math.log(goal.k) - Math.log(view.k)) * .28;
    view.k = Math.exp(logK);
    view.cx += (goal.cx - view.cx) * .28;
    view.cy += (goal.cy - view.cy) * .28;
    const done = Math.abs(Math.log(goal.k / view.k)) < .002
      && Math.hypot(goal.cx - view.cx, goal.cy - view.cy) < mapZoom.base[2] / goal.k / 2000;
    if (done) Object.assign(view, goal);
    render();
    mapZoom.frame = done ? null : requestAnimationFrame(step);
  };
  mapZoom.frame = requestAnimationFrame(step);
}

function zoomBy(factor, anchor, instant = false) {
  const {goal} = mapZoom;
  const before = goal.k;
  const after = clamp(before * factor, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(after - before) < 1e-6) return false;
  if (anchor && mapZoom.follow === null) {
    // Keep the point under the pointer still while scaling.
    goal.cx = anchor[0] + (goal.cx - anchor[0]) * before / after;
    goal.cy = anchor[1] + (goal.cy - anchor[1]) * before / after;
  }
  goal.k = after;
  animate(instant);
  return true;
}

function panBy(dx, dy, instant = true) {
  if (mapZoom.follow !== null) setFollow(null);
  mapZoom.goal.cx += dx;
  mapZoom.goal.cy += dy;
  animate(instant);
}

function svgPoint(svg, clientX, clientY) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  return [point.x, point.y];
}

function zoomFollow(index, point) {
  if (mapZoom.follow !== index || !mapZoom.svg) return;
  mapZoom.goal.cx = point[0];
  mapZoom.goal.cy = point[1];
  limit(mapZoom.goal);
  mapZoom.view.cx = mapZoom.goal.cx;
  mapZoom.view.cy = mapZoom.goal.cy;
  if (mapZoom.frame === null) render();
}

function setFollow(value) {
  mapZoom.follow = value === '' || value === null ? null : Number(value);
  $('zoomFollow').value = mapZoom.follow ?? '';
  if (mapZoom.follow !== null && mapZoom.goal.k < 3) {
    mapZoom.goal.k = 4;
    animate();
  }
  if (mapZoom.follow !== null && typeof replay !== 'undefined' && replay.laps) updateReplay(replay.time);
}

function bindZoomGestures(svg) {
  const pointers = new Map();
  let pan = null;
  let pinch = null;
  let dragged = false;
  let lastTap = null;

  svg.addEventListener('wheel', event => {
    const delta = clamp(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, -60, 60);
    // At full view, scrolling down is not a zoom: let the page scroll.
    if (delta > 0 && mapZoom.goal.k <= ZOOM_MIN + 1e-3) return;
    event.preventDefault();
    const anchor = svgPoint(svg, event.clientX, event.clientY);
    // Trackpad pinch sends ctrlKey with small deltas; a mouse notch is ~100 px. Both feel even.
    zoomBy(Math.exp(-delta * (event.ctrlKey ? .02 : .006)), anchor);
  }, {passive: false});

  svg.addEventListener('dblclick', event => {
    event.preventDefault();
    zoomBy(event.shiftKey ? .5 : 2.2, svgPoint(svg, event.clientX, event.clientY));
  });

  svg.addEventListener('keydown', event => {
    const step = mapZoom.base[2] / mapZoom.goal.k * .12;
    const keys = {
      '+': () => zoomBy(1.6), '=': () => zoomBy(1.6), '-': () => zoomBy(1 / 1.6), '_': () => zoomBy(1 / 1.6),
      '0': () => resetZoom(),
      ArrowLeft: () => panBy(-step, 0, false), ArrowRight: () => panBy(step, 0, false),
      ArrowUp: () => panBy(0, -step, false), ArrowDown: () => panBy(0, step, false),
    };
    if (keys[event.key]) {
      event.preventDefault();
      keys[event.key]();
    }
  });

  svg.addEventListener('pointerdown', event => {
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {distance: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]};
      pan = null;
    } else if (pointers.size === 1) {
      pan = {x: event.clientX, y: event.clientY};
    }
  });

  svg.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    const units = 1 / (svg.getScreenCTM()?.a || 1);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      // Two fingers both zoom (spread) and pan (move together).
      panBy(-(mid[0] - pinch.mid[0]) * units, -(mid[1] - pinch.mid[1]) * units);
      zoomBy(distance / pinch.distance, svgPoint(svg, mid[0], mid[1]), true);
      pinch = {distance, mid};
      dragged = true;
    } else if (pan && mapZoom.goal.k > 1.001) {
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (!dragged && Math.hypot(dx, dy) < 4) return;
      if (!dragged) svg.setPointerCapture(event.pointerId);
      dragged = true;
      panBy(-dx * units, -dy * units);
      pan = {x: event.clientX, y: event.clientY};
    }
  });

  const release = event => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) pan = null;
    // Double-tap on touch zooms in at the tap.
    if (event.type === 'pointerup' && event.pointerType === 'touch' && !dragged) {
      const now = performance.now();
      if (lastTap && now - lastTap.time < 300 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) {
        zoomBy(2.2, svgPoint(svg, event.clientX, event.clientY));
        lastTap = null;
      } else {
        lastTap = {time: now, x: event.clientX, y: event.clientY};
      }
    }
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  // A drag should not also count as a click on a sector or bend.
  svg.addEventListener('click', event => {
    if (dragged) {
      event.stopPropagation();
      event.preventDefault();
      dragged = false;
    }
  }, true);
}

function resetZoom() {
  setFollow(null);
  mapZoom.goal.k = 1;
  animate();
}

function bindZoom() {
  $('zoomIn').onclick = () => zoomBy(1.6);
  $('zoomOut').onclick = () => zoomBy(1 / 1.6);
  $('zoomReset').onclick = resetZoom;
  $('zoomFollow').onchange = event => setFollow(event.target.value);
}
