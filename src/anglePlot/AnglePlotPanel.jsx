import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { formatAngleDegrees } from './AnglePair.js';
import { MIN_CELL_SIZE_PX, MAX_CELL_SIZE_PX, MIN_VISIBLE_GRID_STEPS, ABSOLUTE_MAX_ZOOM_PX_PER_DEGREE } from './renderSamplingPolicy.js';
import { findPointsNearScreenPosition } from './multiSeriesHover.js';

// AnglePlotPanel: draws the scatter of every visible sequence's valid
// (A, B) region and owns all zoom/pan/hover interaction for the graph.
// Implemented with a plain <canvas> instead of SVG because a single
// region can already contain on the order of 10^5 points (the full
// permitted A/B grid at a fine step) — rendering that many individual SVG
// DOM nodes would be far slower than letting the canvas rasterize them
// directly, and that only gets more true with several such regions drawn
// at once. No charting library exists in this project (checked
// package.json before writing this), so this is the "lightweight custom
// panel" option rather than adding a dependency.
//
// Multi-sequence overlap rendering
// -----------------------------------
// Each series in `series` is drawn with its own color at partial opacity
// (OVERLAP_ALPHA below) rather than fully opaque, so two overlapping
// regions blend into a visibly distinct combined color instead of the
// later series completely hiding the earlier one — no point position is
// ever offset to "separate" colors, only the paint's alpha channel
// changes, so the plotted shapes stay mathematically exact. Draw order is
// the order `series` arrives in (stable — AnglePlotWindow builds it from
// the sequence row list's own order), so which series reads as "on top"
// at a given pixel is deterministic and reproducible, not a render-timing
// accident. Hover (see findPointsNearScreenPosition) is what actually
// disambiguates an overlapped point — it reports every series present at
// that spot, not just whichever one is visually on top.

// Zoom/pan model mirrors the main triangle canvas in App.jsx: `zoom` is
// screen pixels per degree (the same value is used for both axes so the
// A/B region is never stretched into a misleading shape), and `pan` is the
// (A, B) point currently centered in the viewport.
const MIN_ZOOM = 2;
const WHEEL_ZOOM_FACTOR = 1.15;
const POINT_HIT_RADIUS_PX = 7;
// How close two different series' points must be on screen to be treated
// as "the same spot" for one combined hover, once the nearest point under
// the cursor is found (see findPointsNearScreenPosition's doc comment).
const HOVER_MERGE_RADIUS_PX = 4;
// Individual-point marker radius used in POINTS mode (see pickRenderMode
// below) — the "normal" size at that zoom level. DENSE and OCCUPANCY modes
// compute their own, smaller marker size instead (see the draw effect):
// this fixed radius is only right when points are sparse enough to draw as
// distinguishable individual dots in the first place.
const POINT_RADIUS_PX = 2.4;
// Softens OCCUPANCY mode's small filled squares into a smooth-edged blob
// instead of a jagged pixel staircase. Deliberately not applied to POINTS/
// DENSE mode — at those zoom levels the individual samples are still
// meaningful to look at, so they stay crisp; OCCUPANCY only exists once
// samples are sub-pixel-dense anyway, where the exact boundary shape is no
// longer meaningfully visible point-by-point regardless of blur.
//
// Only applied once cells are at least OCCUPANCY_BLUR_MIN_CELL_PX wide, and
// scaled down (never up) from there. At the low end of OCCUPANCY mode, cells
// are already close to a single device pixel — a fixed 2.5px blur applied
// there doesn't smooth a staircase (there isn't one visible yet), it just
// spreads each real, distinct point's mark several pixels past its own
// footprint. With many real points near each other, those spread marks stack
// into one shapeless blob that hides the actual (often thin/curved) region
// boundary instead of revealing it — exactly the zoomed-out blurriness this
// LOD mode exists to avoid. Scaling blur to the cell size keeps it doing
// only the smoothing job it's for.
const OCCUPANCY_BLUR_PX = 2.5;
const OCCUPANCY_BLUR_MIN_CELL_PX = 4;
// Series are drawn semi-transparent so overlapping regions from different
// sequences blend into a visibly distinct combined color instead of the
// topmost series fully hiding the ones under it.
const OVERLAP_ALPHA = 0.72;

// The view "Reset View" restores — a fixed overview of the whole permitted
// triangle, independent of whatever is currently plotted. Also used as the
// very first view before any generation has completed.
const DEFAULT_ZOOM = 6;
const DEFAULT_PAN = { a: 45, b: 45 };

// zoomLevel is always *derived* from `zoom` (zoom / DEFAULT_ZOOM), never
// stored independently, so it can never disagree with the actual visible
// bounds. Exported for diagnostics/tests.
export const MIN_ZOOM_LEVEL = MIN_ZOOM / DEFAULT_ZOOM;

// Mirrors the light/dark values the main triangle canvas already uses
// (THEME_PALETTES in App.jsx) so the two canvases stay visually consistent
// instead of this one always rendering dark regardless of the app's theme
// toggle.
const CANVAS_PALETTES = {
  light: { background: '#f8fafc', gridLine: 'rgba(15,23,42,0.08)', gridAxis: 'rgba(8,145,178,0.45)', tickText: '#64748b' },
  dark: { background: '#070b10', gridLine: 'rgba(255,255,255,0.08)', gridAxis: 'rgba(56,189,248,0.45)', tickText: '#64748b' },
};

const niceGridStepDegrees = (zoom) => {
  // Finer grid spacing as the user zooms in, mirroring the main canvas's tiering.
  if (zoom > 220) return 1;
  if (zoom > 90) return 2;
  if (zoom > 35) return 5;
  return 10;
};

// The maximum zoom (px/degree) this panel allows, tied to the *finest*
// visible sequence's Angle Step rather than an arbitrary pixel constant:
// zooming in further than MIN_VISIBLE_GRID_STEPS worth of the finest step
// across the viewport cannot reveal any additional real detail for any
// series (every point on screen would already be adjacent grid points for
// the series that has the most detail), so there is nothing gained by
// allowing it. Falls back to the absolute sanity ceiling when no visible
// series has a valid step yet.
const getMaxZoomPxPerDegree = (finestUserStepDegrees, viewportWidthPx) => {
  if (!Number.isFinite(finestUserStepDegrees) || finestUserStepDegrees <= 0) return ABSOLUTE_MAX_ZOOM_PX_PER_DEGREE;
  const minVisibleWidth = finestUserStepDegrees * MIN_VISIBLE_GRID_STEPS;
  const dynamicMax = Math.max(viewportWidthPx, 1) / Math.max(minVisibleWidth, 1e-12);
  return Math.min(dynamicMax, ABSOLUTE_MAX_ZOOM_PX_PER_DEGREE);
};

const computeFitView = (allPoints, currentPoint, width, height, maxZoom) => {
  const all = currentPoint ? [...allPoints, currentPoint] : allPoints;
  if (all.length === 0) return { zoom: DEFAULT_ZOOM, pan: DEFAULT_PAN };
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  all.forEach((p) => {
    if (p.a < minA) minA = p.a;
    if (p.a > maxA) maxA = p.a;
    if (p.b < minB) minB = p.b;
    if (p.b > maxB) maxB = p.b;
  });
  const spanA = Math.max(maxA - minA, 1);
  const spanB = Math.max(maxB - minB, 1);
  const padding = 60; // px of breathing room around the data
  const zoom = Math.min(
    Math.max((width - padding) / spanA, MIN_ZOOM),
    Math.max((height - padding) / spanB, MIN_ZOOM),
    maxZoom
  );
  return { zoom, pan: { a: (minA + maxA) / 2, b: (minB + maxB) / 2 } };
};

// Level-of-detail mode, chosen per-series from how many screen pixels
// separate adjacent sampled grid points (see pickRenderMode): plenty of
// room draws individually-distinguishable circles; a tight-but-not-
// subpixel spacing draws touching/slightly-overlapping markers sized to
// the gap so the region reads as continuous; sub-pixel spacing switches to
// filled rectangles ("occupancy cells") sized to the sampling cell so the
// region reads as a solid raster instead of a sparse dot lattice with
// visible gaps. Each series can be in a different mode at the same time
// (e.g. one exact-mode series at POINTS while an adaptive one is DENSE).
const RENDER_MODE = { POINTS: 'points', DENSE: 'dense', OCCUPANCY: 'occupancy' };
const pickRenderMode = (projectedSpacingPx) => {
  if (projectedSpacingPx >= 6) return RENDER_MODE.POINTS;
  if (projectedSpacingPx >= 2) return RENDER_MODE.DENSE;
  return RENDER_MODE.OCCUPANCY;
};

// forwardRef exposes imperative view controls (zoomIn/zoomOut/fitToPoints/
// resetToDefaultView) to AnglePlotWindow's toolbar buttons, since "multiply
// whatever the current zoom happens to be" can't be expressed as a plain
// prop the way a one-shot "reset to X" signal can.
//
// `onViewChange` is called (undebounced) every time zoom, pan, or the
// measured canvas size changes, reporting the current world bounds,
// zoomLevel, and viewport pixel size. AnglePlotWindow owns the actual
// debounce/regeneration decision per row — this panel stays a "dumb"
// reporter of its own viewport state so that policy lives in exactly one
// place.
//
// `series` is `{ id, label, color, points, gridStepDegrees, displayScale }[]`
// — one entry per currently *visible* sequence row, already generated by
// AnglePlotWindow. `gridStepDegrees` (per series) picks that series' own
// level-of-detail draw mode; it is never used to decide what to generate
// (that's AnglePlotWindow's job).
const AnglePlotPanel = forwardRef(function AnglePlotPanel({ series, currentPoint, theme, isLocked, onViewChange }, ref) {
  const palette = CANVAS_PALETTES[theme] || CANVAS_PALETTES.dark;
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ width: 600, height: 420 });
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [pan, setPan] = useState(DEFAULT_PAN);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const [hoverMatches, setHoverMatches] = useState([]);
  const [pinnedMatches, setPinnedMatches] = useState([]);

  // Track the container's actual pixel size so the canvas drawing buffer
  // (not just its CSS box) stays sharp after the window is resized.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const allPoints = series.flatMap((s) => s.points);
  const finestUserStepDegrees = series.reduce((min, s) => {
    const step = Number(s.angleStepInput);
    return Number.isFinite(step) && step > 0 && step < min ? step : min;
  }, Infinity);
  const displayScale = series.reduce((max, s) => Math.max(max, s.displayScale || 0), 1);

  const maxZoom = getMaxZoomPxPerDegree(Number.isFinite(finestUserStepDegrees) ? finestUserStepDegrees : undefined, size.width);
  const clampZoom = useCallback((value) => Math.max(MIN_ZOOM, Math.min(value, maxZoom)), [maxZoom]);

  // Fit the viewport to every generated point (across every visible
  // series) plus the currently selected A/B pair on mount, and again any
  // time the panel's real measured size changes (the initial size is a
  // placeholder until ResizeObserver reports the actual box). This adjusts
  // state during render (React's documented pattern for "reset state when
  // a value changes") rather than in a useEffect, because the reset must
  // happen before the first paint at this size and must not cascade
  // through an extra render cycle. Explicit re-fits after that go through
  // the fitToPoints() imperative method below (the "Fit" button), which
  // does not touch this signature.
  const sizeSignature = `${size.width}x${size.height}`;
  const [appliedSizeSignature, setAppliedSizeSignature] = useState(null);
  if (sizeSignature !== appliedSizeSignature) {
    setAppliedSizeSignature(sizeSignature);
    const fit = computeFitView(allPoints, currentPoint, size.width, size.height, maxZoom);
    setZoom(fit.zoom);
    setPan(fit.pan);
  }

  const toScreenX = useCallback((a) => size.width / 2 + (a - pan.a) * zoom, [size.width, pan.a, zoom]);
  const toScreenY = useCallback((b) => size.height / 2 - (b - pan.b) * zoom, [size.height, pan.b, zoom]);
  const toDataA = useCallback((x) => pan.a + (x - size.width / 2) / zoom, [size.width, pan.a, zoom]);
  const toDataB = useCallback((y) => pan.b - (y - size.height / 2) / zoom, [size.height, pan.b, zoom]);

  // Imperative view controls used by AnglePlotWindow's Zoom In / Zoom Out /
  // Fit / Reset View buttons. Locking the view (the "Fix" button) disables
  // all four here too, as a second line of defense beyond the toolbar
  // buttons themselves being disabled while locked.
  useImperativeHandle(ref, () => ({
    zoomIn: () => { if (!isLocked) setZoom((z) => clampZoom(z * WHEEL_ZOOM_FACTOR)); },
    zoomOut: () => { if (!isLocked) setZoom((z) => clampZoom(z / WHEEL_ZOOM_FACTOR)); },
    fitToPoints: () => {
      if (isLocked) return;
      // Empty-graph state: nothing visible to fit to, fall back to the default overview instead of erroring.
      const fit = computeFitView(allPoints, currentPoint, size.width, size.height, maxZoom);
      setZoom(fit.zoom);
      setPan(fit.pan);
    },
    resetToDefaultView: () => {
      if (isLocked) return;
      setZoom(DEFAULT_ZOOM);
      setPan(DEFAULT_PAN);
    },
    // The data-space rectangle currently visible in the canvas, used by
    // AnglePlotWindow's adaptive renderer so it only ever considers points
    // that could actually be seen right now.
    getViewBounds: () => ({
      minA: toDataA(0),
      maxA: toDataA(size.width),
      minB: toDataB(size.height),
      maxB: toDataB(0),
    }),
  }), [isLocked, allPoints, currentPoint, size, maxZoom, clampZoom, toDataA, toDataB]);

  // Report every zoom/pan/size change (including the very first one, once
  // the real measured canvas size is known) so AnglePlotWindow can debounce
  // a regeneration around it. This effect only *reports* — it never itself
  // decides whether/when to regenerate, keeping that policy in one place.
  //
  // `onViewChange` is read through a ref (updated every render, below)
  // rather than listed in this effect's own dependency array, for the same
  // reason AnglePlotWindow reads several of its own callbacks through refs
  // — the parent rebuilds this callback on nearly every render, and
  // depending on its identity directly would re-fire this effect, call it
  // again, land a state update back in the parent, and repeat forever.
  // Depending only on the actual viewport numbers below breaks that cycle.
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    onViewChangeRef.current?.({
      bounds: { minA: toDataA(0), maxA: toDataA(size.width), minB: toDataB(size.height), maxB: toDataB(0) },
      zoomLevel: zoom / DEFAULT_ZOOM,
      viewportSize: { width: size.width, height: size.height },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pan.a, pan.b, size.width, size.height]);

  // Redraw whenever the data, viewport, or hover/pin state changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    // Background
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, size.width, size.height);

    // Grid lines + tick labels, precise enough to represent the current step.
    const step = niceGridStepDegrees(zoom);
    const minA = toDataA(0);
    const maxA = toDataA(size.width);
    const minB = toDataB(size.height);
    const maxB = toDataB(0);
    ctx.font = '10px monospace';
    ctx.textBaseline = 'top';
    for (let a = Math.ceil(minA / step) * step; a <= maxA; a += step) {
      const x = toScreenX(a);
      ctx.strokeStyle = Math.abs(a) < 1e-9 ? palette.gridAxis : palette.gridLine;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
      ctx.stroke();
      ctx.fillStyle = palette.tickText;
      ctx.fillText(formatAngleDegrees(a, displayScale), x + 2, size.height - 14);
    }
    ctx.textBaseline = 'middle';
    for (let b = Math.ceil(minB / step) * step; b <= maxB; b += step) {
      const y = toScreenY(b);
      ctx.strokeStyle = Math.abs(b) < 1e-9 ? palette.gridAxis : palette.gridLine;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
      ctx.stroke();
      ctx.fillStyle = palette.tickText;
      ctx.fillText(formatAngleDegrees(b, displayScale), 4, y - 12);
    }

    // Every visible sequence's region, in row order (stable z-order — see
    // the module comment above for why overlap uses alpha blending instead
    // of offsetting point positions). `orangeRadius` tracks whatever marker
    // size the *last-drawn* series used, so the currentPoint marker (drawn
    // after the loop) stays visually "the same size as a data point"
    // instead of one fixed size that only made sense for POINTS mode.
    let orangeRadius = POINT_RADIUS_PX;
    for (const s of series) {
      if (s.points.length === 0) continue;
      const projectedSpacingPx = Number.isFinite(s.gridStepDegrees) && s.gridStepDegrees > 0 ? s.gridStepDegrees * zoom : Infinity;
      const mode = pickRenderMode(projectedSpacingPx);
      ctx.save();
      ctx.globalAlpha = OVERLAP_ALPHA;
      ctx.fillStyle = s.color;
      if (mode === RENDER_MODE.OCCUPANCY) {
        // Filled squares sized to the sampling cell (with a hair of
        // overlap so pixel rounding never leaves a one-pixel crack between
        // neighbors), not large circles over a coarse grid — a solid
        // raster built only from cells that actually contain a real valid
        // point. Blurred afterward (see OCCUPANCY_BLUR_PX) so the hard
        // grid-aligned edges of that raster read as one smooth region
        // instead of a jagged pixel staircase.
        const cellPx = Math.min(MAX_CELL_SIZE_PX, Math.max(MIN_CELL_SIZE_PX, projectedSpacingPx));
        const half = cellPx / 2 + 0.5;
        orangeRadius = Math.max(1, cellPx / 2);
        const blurPx = cellPx >= OCCUPANCY_BLUR_MIN_CELL_PX ? Math.min(OCCUPANCY_BLUR_PX, cellPx * 0.4) : 0;
        if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`;
        s.points.forEach((p) => {
          const x = toScreenX(p.a);
          const y = toScreenY(p.b);
          if (x < -half || x > size.width + half || y < -half || y > size.height + half) return;
          ctx.fillRect(x - half, y - half, cellPx + 1, cellPx + 1);
        });
      } else if (mode === RENDER_MODE.DENSE) {
        // Markers sized to touch/slightly overlap their neighbors instead
        // of leaving the fixed small POINTS-mode radius floating in
        // visible gaps.
        const radius = Math.min(MAX_CELL_SIZE_PX / 2, Math.max(MIN_CELL_SIZE_PX / 2, projectedSpacingPx / 2 + 0.5));
        orangeRadius = radius;
        s.points.forEach((p) => {
          const x = toScreenX(p.a);
          const y = toScreenY(p.b);
          if (x < -radius - 5 || x > size.width + radius + 5 || y < -radius - 5 || y > size.height + radius + 5) return;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        });
      } else {
        orangeRadius = POINT_RADIUS_PX;
        s.points.forEach((p) => {
          const x = toScreenX(p.a);
          const y = toScreenY(p.b);
          if (x < -5 || x > size.width + 5 || y < -5 || y > size.height + 5) return;
          ctx.beginPath();
          ctx.arc(x, y, POINT_RADIUS_PX, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      ctx.restore();
    }

    // Currently committed A/B pair for the active sequence: sized to match
    // whatever the last-drawn series used for its own points (orangeRadius
    // above), always drawn sharp (no blur — ctx.filter was already reset
    // by ctx.restore() above) and after every series so it's never hidden
    // inside a region — only its fixed orange fill sets it apart.
    if (currentPoint) {
      const x = toScreenX(currentPoint.a);
      const y = toScreenY(currentPoint.b);
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.arc(x, y, orangeRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hovered/pinned marker ring(s) — one ring per matched series so an
    // overlapped hover visibly shows more than one outline.
    const activeMatches = pinnedMatches.length > 0 ? pinnedMatches : hoverMatches;
    if (activeMatches.length > 0) {
      ctx.lineWidth = 1.5;
      activeMatches.forEach((match, idx) => {
        const x = toScreenX(match.a);
        const y = toScreenY(match.b);
        ctx.strokeStyle = palette.tickText;
        ctx.beginPath();
        ctx.arc(x, y, 6 + idx * 2.5, 0, Math.PI * 2);
        ctx.stroke();
      });
    }
  }, [series, currentPoint, size, zoom, pan, hoverMatches, pinnedMatches, toScreenX, toScreenY, toDataA, toDataB, palette, displayScale]);

  // Every plotted series (real data + the currentPoint pseudo-series) is
  // searched together so a hover over an overlapped spot reports every
  // sequence present there, not just whichever one happened to draw last.
  const hitTestSeries = [
    ...series.map((s) => ({ id: s.id, label: s.label, color: s.color, points: s.points })),
    ...(currentPoint ? [{ id: '__current__', label: 'Current (active)', color: '#f97316', points: [currentPoint] }] : []),
  ];

  const findMatchesAt = useCallback((screenX, screenY) => (
    findPointsNearScreenPosition(hitTestSeries, toScreenX, toScreenY, screenX, screenY, POINT_HIT_RADIUS_PX, HOVER_MERGE_RADIUS_PX)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [series, currentPoint, toScreenX, toScreenY]);

  // The wheel listener is attached natively (not via React's onWheel prop)
  // because React registers wheel handlers as passive by default, which
  // silently ignores preventDefault() and lets the page scroll underneath
  // the plot. The main triangle canvas in App.jsx hits the same issue and
  // fixes it the same way — see its "passive:false is required" comment.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const handleWheel = (e) => {
      e.preventDefault();
      // Locking the view disables mouse-wheel zoom entirely.
      if (isLocked) return;
      const direction = e.deltaY > 0 ? -1 : 1;
      setZoom((prev) => clampZoom(prev * (direction > 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR)));
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [isLocked, clampZoom]);

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    // Locking the view disables drag-to-pan entirely.
    if (isLocked) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    if (isDragging) {
      const dx = (e.clientX - dragStart.current.x) / zoom;
      const dy = (e.clientY - dragStart.current.y) / zoom;
      setPan((prev) => ({ a: prev.a - dx, b: prev.b + dy }));
      dragStart.current = { x: e.clientX, y: e.clientY };
    } else {
      setHoverMatches(findMatchesAt(screenX, screenY));
    }
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleClick = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    setPinnedMatches(findMatchesAt(e.clientX - rect.left, e.clientY - rect.top));
  };

  const tooltipMatches = pinnedMatches.length > 0 ? pinnedMatches : hoverMatches;
  const tooltipAnchor = tooltipMatches[0];

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0">
      <div className="flex-1 min-h-0 min-w-0 flex">
        {/* Rotated y-axis label. */}
        <div className="flex items-center justify-center px-1 shrink-0">
          <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            Angle B (degrees)
          </span>
        </div>
        <div ref={containerRef} className="relative flex-1 min-w-0 min-h-0 border border-white/10 rounded-md overflow-hidden" style={{ cursor: isLocked ? 'not-allowed' : isDragging ? 'grabbing' : 'grab' }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
        >
          <canvas ref={canvasRef} className="block" />
          {series.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-bold uppercase tracking-wider text-slate-600">
              No visible graphs — enable a sequence to plot it here
            </div>
          )}
          {tooltipAnchor && (
            <div
              className="pointer-events-none absolute bg-[#101820]/95 border border-white/10 rounded-md px-2.5 py-1.5 text-[11px] font-mono text-slate-200 shadow-[0_8px_24px_rgba(0,0,0,0.32)] space-y-1.5"
              style={{ left: Math.min(toScreenX(tooltipAnchor.a) + 12, size.width - 190), top: Math.max(toScreenY(tooltipAnchor.b) - 16 - tooltipMatches.length * 44, 4) }}
            >
              {tooltipMatches.length > 1 && (
                <div className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">{tooltipMatches.length} graphs at this point</div>
              )}
              {tooltipMatches.map((match) => {
                const sourceSeries = series.find((s) => s.id === match.id);
                return (
                  <div key={match.id} className="border-t border-white/10 first:border-t-0 pt-1 first:pt-0">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: match.color }} />
                      <span className="font-bold">{match.label}</span>
                    </div>
                    <div>A = {formatAngleDegrees(match.a, sourceSeries?.displayScale || displayScale)}&deg;</div>
                    <div>B = {formatAngleDegrees(match.b, sourceSeries?.displayScale || displayScale)}&deg;</div>
                    <div className="text-slate-400">A+B = {formatAngleDegrees(match.a + match.b, sourceSeries?.displayScale || displayScale)}&deg;</div>
                    {sourceSeries && (
                      <div className="text-slate-500">Step {sourceSeries.angleStepInput}&deg; · {sourceSeries.mode === 'exact' ? 'Exact' : sourceSeries.mode === 'adaptive' ? 'Adaptive' : '—'}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {/* x-axis label. */}
      <div className="text-center pt-1 shrink-0">
        <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Angle A (degrees)</span>
      </div>
    </div>
  );
});

export default AnglePlotPanel;
