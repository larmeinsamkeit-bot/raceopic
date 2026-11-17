'use strict';

// Zoom and pan for the track map.
// Buttons; trackpad pinch or Ctrl/⌘ + wheel; two-finger pinch and one-finger drag on touch;
// drag with a mouse once zoomed; double-click to zoom in. In replay the camera can follow a car.
const ZOOM_MIN = 1;
const ZOOM_MAX = 16;
const mapZoom = {svg: null, base: null, k: 1, cx: 0, cy: 0, glyphs: [], markers: [], follow: null};

function zoomAttach(view, drivers, replaying) {
  const svg = $('trackMap').querySelector('svg');
  Object.assign(mapZoom, {
    svg, base: view, k: 1, cx: view[0] + view[2] / 2, cy: view[1] + view[3] / 2,
    glyphs: [...svg.querySelectorAll('.glyph')].map(g => [g, Number(g.dataset.s)]),
    markers: [...svg.querySelectorAll('.track-marker')].map(m => [m, Number(m.getAttribute('r'))]),
  });
  const follow = $('zoomFollow');
  $('zoomFollowWrap').hidden = !replaying;
  if (replaying) {
    const keep = mapZoom.follow;
    follow.replaceChildren(option('', '不跟随'), ...drivers.map((d, i) => option(i, d.code)));
    follow.value = keep ?? '';
  } else {
    mapZoom.follow = null;
  }
  bindZoomGestures(svg);
  zoomApply();
}

function zoomApply() {
  const {svg, base, k} = mapZoom;
  if (!svg) return;
  const w = base[2] / k;
  const h = base[3] / k;
  mapZoom.cx = clamp(mapZoom.cx, base[0] + w / 2, base[0] + base[2] - w / 2);
  mapZoom.cy = clamp(mapZoom.cy, base[1] + h / 2, base[1] + base[3] - h / 2);
  svg.setAttribute('viewBox', `${mapZoom.cx - w / 2} ${mapZoom.cy - h / 2} ${w} ${h}`);
  // Cars, bend numbers, gates and cursors keep their on-screen size.
  for (const [glyph, scale] of mapZoom.glyphs) glyph.setAttribute('transform', `scale(${scale / k})`);
  for (const [marker, r] of mapZoom.markers) marker.setAttribute('r', r / k);
  svg.classList.toggle('zoomed', k > 1.001);
  $('zoomLevel').value = `${k < 9.95 ? k.toFixed(1) : Math.round(k)}×`;
  $('zoomOut').disabled = k <= ZOOM_MIN + 1e-3;
  $('zoomIn').disabled = k >= ZOOM_MAX - 1e-3;
  $('zoomReset').disabled = k <= ZOOM_MIN + 1e-3;
}

function zoomBy(factor, anchor) {
  const before = mapZoom.k;
  const after = clamp(before * factor, ZOOM_MIN, ZOOM_MAX);
  if (after === before) return;
  if (anchor && mapZoom.follow === null) {
    // Keep the point under the pointer still while scaling.
    mapZoom.cx = anchor[0] + (mapZoom.cx - anchor[0]) * before / after;
    mapZoom.cy = anchor[1] + (mapZoom.cy - anchor[1]) * before / after;
  }
  mapZoom.k = after;
  zoomApply();
}

function svgPoint(svg, clientX, clientY) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  return [point.x, point.y];
}

function zoomFollow(index, point) {
  if (mapZoom.follow !== index || !mapZoom.svg) return;
  mapZoom.cx = point[0];
  mapZoom.cy = point[1];
  zoomApply();
}

function setFollow(value) {
  mapZoom.follow = value === '' || value === null ? null : Number(value);
  $('zoomFollow').value = mapZoom.follow ?? '';
  if (mapZoom.follow !== null && mapZoom.k < 3) zoomBy(4 / mapZoom.k);
  if (mapZoom.follow !== null && typeof replay !== 'undefined' && replay.laps) updateReplay(replay.time);
}

function bindZoomGestures(svg) {
  const pointers = new Map();
  let pan = null;
  let pinch = null;
  let dragged = false;

  svg.addEventListener('wheel', event => {
    // Trackpad pinch arrives as a wheel event with ctrlKey; plain scrolling still scrolls the page.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    // A mouse notch is ~100 px, a trackpad pinch step a few px: cap each step at about 1.6×.
    const delta = clamp(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, -50, 50);
    zoomBy(Math.exp(-delta * .01), svgPoint(svg, event.clientX, event.clientY));
  }, {passive: false});

  svg.addEventListener('dblclick', event => {
    event.preventDefault();
    zoomBy(2, svgPoint(svg, event.clientX, event.clientY));
  });

  svg.addEventListener('pointerdown', event => {
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {distance: Math.hypot(a[0] - b[0], a[1] - b[1]), k: mapZoom.k};
      pan = null;
    } else if (pointers.size === 1 && mapZoom.k > 1.001) {
      pan = {x: event.clientX, y: event.clientY};
    }
  });

  svg.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const anchor = svgPoint(svg, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      zoomBy(pinch.k * distance / pinch.distance / mapZoom.k, anchor);
      dragged = true;
    } else if (pan) {
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (!dragged && Math.hypot(dx, dy) < 4) return;
      if (!dragged) svg.setPointerCapture(event.pointerId);
      dragged = true;
      if (mapZoom.follow !== null) setFollow(null);
      const units = 1 / svg.getScreenCTM().a;
      mapZoom.cx -= dx * units;
      mapZoom.cy -= dy * units;
      pan = {x: event.clientX, y: event.clientY};
      zoomApply();
    }
  });

  const release = event => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) pan = null;
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

function bindZoom() {
  $('zoomIn').onclick = () => zoomBy(1.6);
  $('zoomOut').onclick = () => zoomBy(1 / 1.6);
  $('zoomReset').onclick = () => {
    setFollow(null);
    mapZoom.k = 1;
    zoomApply();
  };
  $('zoomFollow').onchange = event => setFollow(event.target.value);
}
