import { useEffect, useRef, useState, useCallback } from 'react';
import { X, RotateCcw, RefreshCw, Loader2, GripHorizontal, ZoomIn, ZoomOut, Maximize, Maximize2, Minimize2, Lock, Unlock, AlertTriangle, Eye, EyeOff, Minus, Square } from 'lucide-react';
import AnglePlotPanel from './AnglePlotPanel.jsx';
import { generateVisibleAnglePoints } from './visibleAnglePointGenerator.js';
import { generateAngleRegion } from './generateAngleRegion.js';
import { chooseRenderer, RENDERER_MODE } from './rendererSelection.js';
import { parseAngleStep, displayScaleForStep } from './angleStep.js';
import { RENDER_DEBOUNCE_MS } from './renderSamplingPolicy.js';
import { truncateSequenceText } from '../sequences/sequenceGraphConfig.js';
import { graphCache, buildGraphCacheKey } from './graphCache.js';

// AnglePlotWindow: the pop-up "Valid Angle A-B Region" graph. This project
// is a browser React app, not a desktop toolkit, so there is no native OS
// window to reuse — the closest equivalent that still satisfies "drag by a
// title bar", "resize", and "does not block the rest of the program" is a
// non-modal, absolutely-positioned panel with its own draggable title bar
// and a manual resize grip, which is what this component implements.
//
// "Fix" button semantics
// -----------------------
// The main app already has an unrelated "Fix" button (App.jsx's
// isZoomLocked) that only disables mouse-wheel zoom on the *main triangle
// canvas*. This is a separate, independently-scoped lock for *this* plot
// window's own view, and — per this feature's spec — is intentionally more
// complete: while locked it disables wheel-zoom, drag-to-pan, and the Zoom
// In/Zoom Out/Fit buttons all together, not just the wheel. The two don't
// interact or share state; they just happen to share a name because they
// serve the same purpose ("stop the view from moving") in two different
// views.
//
// Hybrid rendering: brute force or adaptive, chosen automatically
// -----------------------------------------------------------------
// Every row's Angle Step is routed through rendererSelection.js's
// chooseRenderer, which estimates the full-domain brute-force cost
// (generateAngleRegion.js's exact sweep) from the step alone and picks it
// only when that estimate is cheap enough (default ~6s); otherwise this
// falls back to visibleAnglePointGenerator.js's visible-region, zoom-scaled
// adaptive sampling — automatically, with no user-facing mode toggle. (An
// earlier version of this feature always used brute force above a fixed
// step threshold regardless of cost, which was measurably slow even at
// this feature's own default 0.1 step; a later version removed brute force
// entirely. This reintroduces it, but gated by an actual cost estimate
// instead of a step-size threshold, so it is never chosen for a
// configuration expensive enough to repeat that regression.) Because brute
// force always sweeps the whole domain, its cached result does not depend
// on the viewport and survives any amount of panning/zooming; the adaptive
// path keeps regenerating (debounced, RENDER_DEBOUNCE_MS) on every
// zoom/pan/resize/step/sequence change exactly as before, since what's
// tractable to compute there depends on what's on screen. A "Plot Valid
// Angle Region" / "Generate/Refresh Plot" click forces an immediate
// regenerate instead of waiting out the debounce, for either renderer.
//
// Multi-sequence job management
// -------------------------------
// Every visible row gets its own independent generation job, keyed by
// sequence id: its own debounce timer, its own cancellable task, and its
// own monotonically increasing request id so a slow superseded render for
// *that row* can never overwrite a newer one for *that same row* (the
// original single-sequence requestId guard, just multiplied per row).
// Hiding a row cancels its in-flight job but *keeps* its last computed
// points (`results[id]`) untouched — nothing is deleted, and the stale
// in-flight completion is discarded via the same requestId bump used for
// edits, so it can never "reappear" and silently overwrite newer state.
// Only deleting a row actually drops its cached result.
//
// This project has no Web Worker infrastructure (see
// visibleAnglePointGenerator.js's module comment — every render here is a
// time-sliced async loop on the one JS thread, not a real background
// thread), so "background processing"
// for multiple rows means: keep each row's own chunked/yielding loop, and
// bound how many of those chunked loops interleave at once
// (MAX_CONCURRENT_SEQUENCE_JOBS) so adding many visible rows doesn't have
// them all fighting over the same per-frame time budget at once. Extra
// requests queue and start as soon as a slot frees.

const DEFAULT_SIZE = { width: 640, height: 480 };
const MIN_SIZE = { width: 380, height: 320 };

// How many sequence rows may have an in-flight generation task running at
// once. Kept small: each task already time-slices itself to stay
// responsive, but every additional *simultaneous* task means each one gets
// a smaller share of the per-frame budget before the browser needs to
// paint, so a handful of rows all mid-render at once would make all of
// them feel slower rather than any one of them faster.
const MAX_CONCURRENT_SEQUENCE_JOBS = 2;

const emptyRowResult = () => ({ points: [], status: 'idle', renderInfo: null, progress: null, error: null });

export default function AnglePlotWindow({ sequences, activeSequenceId, angleParams, baseLength, buildValidateCandidateForSequence, refreshToken, onClose, onShowAll, onHideAll, onEditGraphs, onRowStatusChange, forceGenerateRequest }) {
  const [pos, setPos] = useState({ x: 96, y: 72 });
  const [size, setSize] = useState(DEFAULT_SIZE);
  const dragOffset = useRef(null);
  const resizeStart = useRef(null);
  // Minimized collapses the whole window down to just its title bar (like a
  // normal OS window minimize) without closing it or losing any state —
  // every job/result/view setting below is untouched and reappears exactly
  // as it was on restore.
  const [isMinimized, setIsMinimized] = useState(false);
  // Maximized fills the available viewport (minus a small margin) instead
  // of the window's normal draggable/resizable box. `preMaximizeRef` holds
  // the pos/size to restore exactly on un-maximize, so toggling it off
  // never leaves the window at a different spot/size than before.
  const [isMaximized, setIsMaximized] = useState(false);
  const preMaximizeRef = useRef(null);
  const MAXIMIZE_MARGIN = 12;
  const toggleMaximize = () => {
    if (isMaximized) {
      if (preMaximizeRef.current) {
        setPos(preMaximizeRef.current.pos);
        setSize(preMaximizeRef.current.size);
      }
      setIsMaximized(false);
    } else {
      preMaximizeRef.current = { pos, size };
      setIsMinimized(false);
      setPos({ x: MAXIMIZE_MARGIN, y: MAXIMIZE_MARGIN });
      setSize({ width: window.innerWidth - MAXIMIZE_MARGIN * 2, height: window.innerHeight - MAXIMIZE_MARGIN * 2 });
      setIsMaximized(true);
    }
  };
  // Keeps the maximized window filling the viewport if the browser window
  // itself is resized, instead of leaving it sized to the old viewport.
  useEffect(() => {
    if (!isMaximized) return undefined;
    const handleResize = () => {
      setSize({ width: window.innerWidth - MAXIMIZE_MARGIN * 2, height: window.innerHeight - MAXIMIZE_MARGIN * 2 });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMaximized]);
  // Closing this window unmounts it, which discards `results` (every
  // row's generated points) entirely — unlike minimizing, which keeps
  // everything and just hides the body. Confirmed once before actually
  // calling onClose, so that isn't lost by an accidental click.
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const requestClose = () => setShowCloseConfirm(true);

  // Per-sequence-id render results/status. Never cleared on hide, only on delete.
  const [results, setResults] = useState({});
  const [isViewLocked, setIsViewLocked] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const panelRef = useRef(null);

  const currentPoint = { a: Number(angleParams.a), b: Number(angleParams.b) };

  // Live refs so job-scheduling callbacks always see the latest props
  // without needing them in dependency arrays (which would otherwise
  // re-fire effects on every parent render, since `sequences` and the
  // validator factory are new references each render — see
  // AnglePlotPanel's onViewChangeRef comment for the same pattern already
  // established in this module). Synced in an effect (not inline during
  // render) so render itself stays a pure read.
  const sequencesRef = useRef(sequences);
  const buildValidateCandidateForSequenceRef = useRef(buildValidateCandidateForSequence);
  const resultsRef = useRef(results);
  const onRowStatusChangeRef = useRef(onRowStatusChange);
  useEffect(() => {
    sequencesRef.current = sequences;
    buildValidateCandidateForSequenceRef.current = buildValidateCandidateForSequence;
    resultsRef.current = results;
    onRowStatusChangeRef.current = onRowStatusChange;
  }, [sequences, buildValidateCandidateForSequence, results, onRowStatusChange]);

  const debounceTimersRef = useRef({}); // id -> timeout handle
  const jobTaskRef = useRef({}); // id -> { promise, cancel }
  const jobRequestIdRef = useRef({}); // id -> number, bumped on every (re)start or cancel
  const runningIdsRef = useRef(new Set());
  const pendingQueueRef = useRef([]); // [{ seq, viewState }]
  const lastViewStateRef = useRef(null);
  const prevSequenceSnapshotRef = useRef({}); // id -> { sequenceText, angleStepInput, visible }
  const lastRefreshTokenRef = useRef(refreshToken);
  // Deliberately initialized to null (never to forceGenerateRequest's
  // current token) even though this window can mount with a
  // forceGenerateRequest already set — clicking a row's "Plot Valid Angle
  // Region" button for the first time opens this window AND sets
  // forceGenerateRequest in the same click, so on that first mount the prop
  // already carries the token the effect below is supposed to detect as
  // new. Seeding the ref from the prop would make that initial token look
  // already-seen, and the effect would skip scheduling the very job the
  // click was meant to start.
  const lastForceGenerateTokenRef = useRef(null);

  // Mirrors each row's plot lifecycle out to App.jsx so a graph's card can
  // show "Not plotted / Calculating.../Plotted/Error" even while this
  // window itself is minimized or the card is scrolled off-screen in the
  // sidebar — this window is the only place `results` actually lives.
  const setRowResult = useCallback((id, patch) => {
    setResults((prev) => {
      const next = { ...(prev[id] || emptyRowResult()), ...patch };
      onRowStatusChangeRef.current?.(id, next);
      return { ...prev, [id]: next };
    });
  }, []);

  // Cancels a row's in-flight/queued job (if any) without touching its
  // cached points. Bumping the request id makes any already-in-flight
  // `.then` a no-op for the results write (still runs onDone to free the
  // concurrency slot) — this is what lets a hidden or deleted row's stale
  // completion never overwrite newer state.
  const cancelSequenceJob = useCallback((id) => {
    if (debounceTimersRef.current[id]) {
      clearTimeout(debounceTimersRef.current[id]);
      delete debounceTimersRef.current[id];
    }
    jobTaskRef.current[id]?.cancel();
    jobRequestIdRef.current[id] = (jobRequestIdRef.current[id] || 0) + 1;
    pendingQueueRef.current = pendingQueueRef.current.filter((job) => job.seq.id !== id);
    runningIdsRef.current.delete(id);
  }, []);

  // `startSequenceJob` closes over baseLength/activeSequenceId/currentPoint
  // and so gets a new identity whenever those change; `tryStartNextQueuedJob`
  // needs to always call the *current* one without itself needing to change
  // identity every time (it's called from cancelSequenceJob/finishSlot,
  // which do want a stable reference) — so it's read through a ref, same
  // pattern as sequencesRef/buildValidateCandidateForSequenceRef above.
  const startSequenceJobRef = useRef(null);

  const tryStartNextQueuedJob = useCallback(() => {
    while (runningIdsRef.current.size < MAX_CONCURRENT_SEQUENCE_JOBS && pendingQueueRef.current.length > 0) {
      const job = pendingQueueRef.current.shift();
      startSequenceJobRef.current(job.seq, job.viewState);
    }
  }, []);

  const startSequenceJob = useCallback((seq, viewState) => {
    runningIdsRef.current.add(seq.id);
    const requestId = (jobRequestIdRef.current[seq.id] = (jobRequestIdRef.current[seq.id] || 0) + 1);
    const parsed = parseAngleStep(seq.angleStepInput);

    const finishSlot = () => {
      runningIdsRef.current.delete(seq.id);
      tryStartNextQueuedJob();
    };

    if (!parsed.valid) {
      setRowResult(seq.id, { status: 'invalid', error: parsed.error, points: [] });
      finishSlot();
      return;
    }

    const validateCandidate = buildValidateCandidateForSequenceRef.current(seq.sequenceText, { a: seq.angleA, b: seq.angleB, length: baseLength });
    const startedAt = performance.now();
    setRowResult(seq.id, { status: 'running', error: null, progress: { cellsChecked: 0, found: 0 } });

    if (!viewState) {
      // No viewport reported yet (panel hasn't mounted/measured). This row
      // will be picked up by the next handleViewChange call once it does.
      finishSlot();
      return;
    }

    const excludePoint = seq.id === activeSequenceId ? currentPoint : undefined;

    // RendererSelection (see rendererSelection.js) is the one place that
    // decides brute-force vs. adaptive, purely from the Angle Step's
    // estimated full-domain cost — never by timing an actual run. Brute
    // force always sweeps the whole 0-90 domain (see generateAngleRegion.js),
    // so unlike the adaptive path its result does not depend on the current
    // viewport at all: the cache key below omits viewBounds/viewportSize for
    // it, which is what lets a "cheap" graph's cached result survive any
    // amount of panning/zooming instead of recomputing per view.
    const decision = chooseRenderer({ scale: parsed.scale, stepUnits: parsed.stepUnits });
    const useBruteForce = decision.mode === RENDERER_MODE.BRUTE_FORCE;

    // GraphCache (see graphCache.js): every input that can change the
    // chosen generator's output is folded into one deterministic key. A hit
    // reuses the exact previously computed geometry — regardless of which
    // renderer originally produced it — with no recomputation at all; a
    // miss runs whichever generator was just chosen, unchanged, and stores
    // its result for next time.
    const cacheKey = buildGraphCacheKey({
      sequenceText: seq.sequenceText, angleA: seq.angleA, angleB: seq.angleB,
      angleStepInput: seq.angleStepInput, baseLength, excludePoint,
      ...(useBruteForce ? {} : { viewBounds: viewState.bounds, viewportSize: viewState.viewportSize }),
    });
    const cached = graphCache.get(cacheKey);
    if (cached) {
      if (import.meta.env.DEV) console.log(`Renderer: Cache Hit — ${seq.label} (${cached.renderInfo.pointCount} points reused)`);
      setRowResult(seq.id, { points: cached.points, status: 'done', renderInfo: { ...cached.renderInfo, fromCache: true } });
      finishSlot();
      return;
    }
    if (import.meta.env.DEV) {
      const costLabel = `estimated cost ${decision.estimatedSeconds.toFixed(2)}s for ~${decision.estimatedIterations.toLocaleString()} candidates`;
      console.log(useBruteForce
        ? `Renderer: Brute Force (${costLabel}) — ${seq.label}`
        : `Renderer: Adaptive (${costLabel}) — ${seq.label}`);
    }

    // Both generators return the same { promise, cancel } shape and are
    // driven identically from here on; only their progress/result shapes
    // differ, normalized below so the rest of this function (and the row
    // status UI) never needs to know which one actually ran.
    // generateAngleRegion's onProgress carries `timeLimited` only on its
    // final ({done: true}) call (see its own module comment on the
    // MAX_ADAPTIVE_RENDER_MS backstop) — captured here since the resolved
    // promise itself is just a plain points array with nowhere else to
    // carry that flag.
    let bruteForceTimeLimited = false;
    const task = useBruteForce
      ? generateAngleRegion({
          validateCandidate, baseLength, scale: parsed.scale, stepUnits: parsed.stepUnits,
          onProgress: (p) => {
            if (p.timeLimited) bruteForceTimeLimited = true;
            if (jobRequestIdRef.current[seq.id] !== requestId) return;
            setRowResult(seq.id, { progress: { cellsChecked: p.tested, found: p.found } });
          },
        })
      : generateVisibleAnglePoints({
          validateCandidate, baseLength, scale: parsed.scale, stepUnits: parsed.stepUnits,
          viewBounds: viewState.bounds, viewportSize: viewState.viewportSize, zoomLevel: viewState.zoomLevel,
          excludePoint,
          onProgress: (p) => {
            if (jobRequestIdRef.current[seq.id] !== requestId) return;
            setRowResult(seq.id, { progress: p });
          },
        });
    jobTaskRef.current[seq.id] = task;
    task.promise.then((result) => {
      if (jobRequestIdRef.current[seq.id] === requestId) {
        // generateAngleRegion resolves to a plain points array (exact sweep,
        // no stride/budget concept); generateVisibleAnglePoints resolves to
        // a richer object. Normalized into one renderInfo shape either way.
        // `renderer` records which one actually ran — an exact brute-force
        // result never needs refinement, while an adaptive one is a
        // viewport-scoped approximation that could be refined toward the
        // full-resolution grid later; a future background-refinement stage
        // (see rendererSelection.js's own extension-point comment) can
        // branch on this without needing any other change here.
        const points = useBruteForce ? result : result.points;
        const renderInfo = useBruteForce
          ? { renderer: RENDERER_MODE.BRUTE_FORCE, zoomLevel: viewState?.zoomLevel, userStepDegrees: parsed.stepDegrees, gridStepDegrees: parsed.stepDegrees, requestedStepDegrees: parsed.stepDegrees, displayScale: displayScaleForStep(parsed.scale), pointCount: points.length, durationMs: performance.now() - startedAt, budgetLimited: false, timeLimited: bruteForceTimeLimited }
          : { renderer: RENDERER_MODE.ADAPTIVE, zoomLevel: viewState.zoomLevel, userStepDegrees: parsed.stepDegrees, gridStepDegrees: result.effectiveStepDegrees, requestedStepDegrees: result.requestedStepDegrees, displayScale: displayScaleForStep(parsed.scale), pointCount: points.length, durationMs: performance.now() - startedAt, budgetLimited: result.budgetLimited, timeLimited: result.timeLimited };
        // A genuinely cancelled/superseded job never reaches here at all —
        // the requestId check above already guards this whole block — so
        // anything that does is a real, finished computation worth caching
        // (including a timeLimited one: it deterministically hit the same
        // wall-clock cap for this exact key, so reusing it instead of
        // re-paying that same cost again is the right tradeoff).
        graphCache.set(cacheKey, { points, renderInfo });
        setRowResult(seq.id, { points, status: 'done', renderInfo });
      }
      finishSlot();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseLength, activeSequenceId, currentPoint.a, currentPoint.b, setRowResult, tryStartNextQueuedJob]);
  useEffect(() => {
    startSequenceJobRef.current = startSequenceJob;
  }, [startSequenceJob]);

  const enqueueSequenceJob = useCallback((seq, viewState) => {
    pendingQueueRef.current = pendingQueueRef.current.filter((job) => job.seq.id !== seq.id);
    pendingQueueRef.current.push({ seq, viewState });
    if (!runningIdsRef.current.has(seq.id)) tryStartNextQueuedJob();
  }, [tryStartNextQueuedJob]);

  const scheduleRenderForSequence = useCallback((seq, viewState, { immediate = false } = {}) => {
    if (debounceTimersRef.current[seq.id]) {
      clearTimeout(debounceTimersRef.current[seq.id]);
      delete debounceTimersRef.current[seq.id];
    }
    if (immediate) {
      enqueueSequenceJob(seq, viewState);
    } else {
      debounceTimersRef.current[seq.id] = setTimeout(() => {
        delete debounceTimersRef.current[seq.id];
        enqueueSequenceJob(seq, viewState);
      }, RENDER_DEBOUNCE_MS);
    }
  }, [enqueueSequenceJob]);

  // Diffs the incoming `sequences` prop against the last snapshot this
  // effect saw, and schedules a render only for rows whose sequence text,
  // Angle Step, or visibility actually changed (or that are brand new) —
  // this is the "don't regenerate every graph if only one row changed"
  // requirement. `refreshToken` bumps (mount, or the parent's
  // Generate/Refresh Plot button) force an immediate re-render of every
  // currently visible row, matching the original single-sequence behavior.
  //
  // The whole body runs inside a setTimeout(fn, 0), exactly like the
  // original single-sequence version's mount effect — not for a debounce
  // (RENDER_DEBOUNCE_MS handles that separately), but so React StrictMode's
  // development-only mount -> cleanup -> mount replay never gets a chance
  // to actually *start* a real generation task on the first (throwaway)
  // pass. Without this, that first pass calls scheduleRenderForSequence
  // synchronously, which starts a real generation task and stores
  // it in jobTaskRef; StrictMode's immediate replay-cleanup then cancels
  // that very task after only its first chunk, and the "result" that
  // resolves is an incomplete, near-empty point set — reproducible locally
  // by removing this deferral and watching a fresh exact-mode sweep finish
  // instantly with 0 points. Deferring past the synchronous double-invoke
  // window means the throwaway pass's cleanup only clears a pending
  // timeout (a no-op it was always safe to run twice), and the real task
  // only ever starts once, on the surviving pass.
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const prevSnapshot = prevSequenceSnapshotRef.current;
      const currentIds = new Set(sequences.map((s) => s.id));
      for (const id of Object.keys(prevSnapshot)) {
        if (!currentIds.has(id)) {
          cancelSequenceJob(id);
          setResults((r) => {
            if (!(id in r)) return r;
            const next = { ...r };
            delete next[id];
            return next;
          });
        }
      }

      const isForcedRefresh = refreshToken !== lastRefreshTokenRef.current;
      lastRefreshTokenRef.current = refreshToken;

      const nextSnapshot = {};
      for (const seq of sequences) {
        const prevEntry = prevSnapshot[seq.id];
        nextSnapshot[seq.id] = { sequenceText: seq.sequenceText, angleStepInput: seq.angleStepInput, visible: seq.visible, angleA: seq.angleA, angleB: seq.angleB };

        if (!seq.visible) {
          cancelSequenceJob(seq.id);
          continue;
        }

        const isNew = !prevEntry;
        const contentChanged = !isNew && (prevEntry.sequenceText !== seq.sequenceText || prevEntry.angleStepInput !== seq.angleStepInput || prevEntry.angleA !== seq.angleA || prevEntry.angleB !== seq.angleB);
        const justBecameVisible = !isNew && !prevEntry.visible;
        const hasCachedResult = !!resultsRef.current[seq.id] && resultsRef.current[seq.id].status === 'done';

        // `isNew` deliberately does NOT trigger a schedule on its own: every
        // graph now has its own "Plot Valid Angle Region" button (see
        // forceGenerateRequest below), so simply mounting this window (or a
        // brand-new row appearing in `sequences`) must never auto-compute
        // anything — otherwise clicking Plot on one card would also kick
        // off every *other* visible-but-never-plotted card the first time
        // the window opens, which is exactly the "recalculates graphs you
        // didn't ask for" behavior this feature must avoid. A row only
        // starts computing when its own button is pressed, its already-
        // tracked content changes, or an explicit global refresh happens.
        if (isForcedRefresh || contentChanged || (justBecameVisible && !hasCachedResult)) {
          scheduleRenderForSequence(seq, lastViewStateRef.current, { immediate: isForcedRefresh || contentChanged });
        }
        // justBecameVisible with a valid cached result and no content change: reuse the cache, no job scheduled.
      }
      prevSequenceSnapshotRef.current = nextSnapshot;
    }, 0);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequences, refreshToken]);

  // Per-graph "Plot Valid Angle Region" button (in each sequence card, not
  // just this window's own toolbar): forces exactly that one row to
  // (re)generate now, regardless of whether its inputs changed since last
  // time — replotting the same graph should still work, and still checks
  // the cache first via startSequenceJob's own cache lookup. Every other
  // row's job/results are untouched.
  useEffect(() => {
    if (!forceGenerateRequest || forceGenerateRequest.token === lastForceGenerateTokenRef.current) return;
    lastForceGenerateTokenRef.current = forceGenerateRequest.token;
    const seq = sequences.find((s) => s.id === forceGenerateRequest.id);
    if (!seq) return;
    scheduleRenderForSequence(seq, lastViewStateRef.current, { immediate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceGenerateRequest, sequences]);

  // Cancel every outstanding job on unmount so a closed window never calls setState after it stops existing.
  useEffect(() => () => {
    Object.keys(jobTaskRef.current).forEach((id) => jobTaskRef.current[id]?.cancel());
    Object.values(debounceTimersRef.current).forEach((t) => clearTimeout(t));
  }, []);

  // AnglePlotPanel reports every zoom/pan/resize here, undebounced. Every
  // currently visible row gets a debounced re-render, since the adaptive
  // sampler's stride and sampled cells both depend on the current viewport.
  const handleViewChange = useCallback((viewState) => {
    lastViewStateRef.current = viewState;
    for (const seq of sequencesRef.current) {
      if (!seq.visible) continue;
      const parsed = parseAngleStep(seq.angleStepInput);
      if (!parsed.valid) continue;
      // Brute-force rows (rendererSelection.js) always sweep the whole
      // domain, so their result never depends on the viewport — scheduling
      // a re-render for one here would only ever re-hit the same GraphCache
      // entry, so skipping it avoids that pointless work on every pan/zoom.
      if (chooseRenderer({ scale: parsed.scale, stepUnits: parsed.stepUnits }).mode === RENDERER_MODE.BRUTE_FORCE) continue;
      scheduleRenderForSequence(seq, viewState);
    }
  }, [scheduleRenderForSequence]);

  const runGeneration = useCallback(() => {
    for (const seq of sequences) {
      if (seq.visible) scheduleRenderForSequence(seq, lastViewStateRef.current, { immediate: true });
    }
  }, [sequences, scheduleRenderForSequence]);

  // --- Title-bar drag -------------------------------------------------
  const handleTitleMouseDown = (e) => {
    if (e.button !== 0) return;
    // A maximized window fills the viewport by definition — dragging it
    // would be meaningless until it's restored to its normal size first.
    if (isMaximized) return;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  };
  useEffect(() => {
    const handleMove = (e) => {
      if (dragOffset.current) {
        setPos({
          x: Math.max(0, e.clientX - dragOffset.current.x),
          y: Math.max(0, e.clientY - dragOffset.current.y),
        });
      }
      if (resizeStart.current) {
        const { startX, startY, startWidth, startHeight } = resizeStart.current;
        setSize({
          width: Math.max(MIN_SIZE.width, startWidth + (e.clientX - startX)),
          height: Math.max(MIN_SIZE.height, startHeight + (e.clientY - startY)),
        });
      }
    };
    const handleUp = () => {
      dragOffset.current = null;
      resizeStart.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [pos]);

  // --- Corner resize ----------------------------------------------------
  const handleResizeMouseDown = (e) => {
    if (e.button !== 0) return;
    // Same reasoning as the title-bar drag guard above.
    if (isMaximized) return;
    e.stopPropagation();
    resizeStart.current = { startX: e.clientX, startY: e.clientY, startWidth: size.width, startHeight: size.height };
  };

  const viewButtonClass = "flex items-center gap-1.5 bg-[#101820]/95 hover:bg-[#172230] disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 px-2.5 py-1.5 rounded-md text-[11px] font-bold";

  // Build the drawable series list (visible rows only) and the aggregate status line.
  const visibleSequences = sequences.filter((s) => s.visible);
  // The active graph draws last (on top) whenever series overlap, and
  // stays on top until a different graph becomes active — everything else
  // keeps its existing relative order, only the active one moves to the
  // end of the draw order.
  const orderedVisibleSequences = visibleSequences.some((s) => s.id === activeSequenceId)
    ? [...visibleSequences.filter((s) => s.id !== activeSequenceId), ...visibleSequences.filter((s) => s.id === activeSequenceId)]
    : visibleSequences;
  const series = orderedVisibleSequences.map((seq) => {
    const result = results[seq.id] || emptyRowResult();
    return {
      id: seq.id, label: seq.label, color: seq.color, sequenceText: seq.sequenceText,
      angleStepInput: seq.angleStepInput, points: result.points || [],
      gridStepDegrees: result.renderInfo?.gridStepDegrees, displayScale: result.renderInfo?.displayScale ?? 1,
      status: result.status,
    };
  });
  const totalPoints = series.reduce((sum, s) => sum + s.points.length, 0);
  const calculatingCount = visibleSequences.filter((seq) => (results[seq.id] || emptyRowResult()).status === 'running').length;
  const summaryLine = visibleSequences.length === 0
    ? 'No visible graphs'
    : `${visibleSequences.length} visible graph${visibleSequences.length === 1 ? '' : 's'} · ${totalPoints.toLocaleString()} total displayed point${totalPoints === 1 ? '' : 's'}${calculatingCount > 0 ? ` · ${calculatingCount} calculating` : ''}`;

  const rowStatusText = (seq) => {
    if (!seq.visible) return 'Hidden';
    const parsed = parseAngleStep(seq.angleStepInput);
    if (!parsed.valid) return `Invalid: ${parsed.error}`;
    const result = results[seq.id] || emptyRowResult();
    if (result.status === 'invalid') return `Invalid: ${result.error}`;
    if (result.status === 'running') {
      const p = result.progress;
      return `Calculating… ${(p?.cellsChecked || 0).toLocaleString()} checked`;
    }
    if (result.status === 'idle') return 'Waiting to generate…';
    return `${(result.points.length || 0).toLocaleString()} points`;
  };

  return (
    <div
      className="fixed z-50 flex flex-col bg-[#10151c] border border-white/10 rounded-lg shadow-[0_20px_60px_rgba(0,0,0,0.55)] overflow-hidden select-none"
      style={{ left: pos.x, top: pos.y, width: size.width, height: isMinimized ? undefined : size.height }}
    >
      {/* Title bar: the "normal title bar" this pop-up is dragged by. */}
      <div
        className={`flex items-center justify-between gap-2 px-3 py-2 bg-[#0c1117] border-b border-white/10 shrink-0 select-none ${isMaximized ? '' : 'cursor-move'}`}
        onMouseDown={handleTitleMouseDown}
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal className="w-3.5 h-3.5 text-slate-600 shrink-0" />
          <span className="text-xs font-bold text-slate-200 truncate">Valid Angle A&ndash;B Region</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setIsMinimized((m) => !m); }}
            onMouseDown={(e) => e.stopPropagation()}
            title={isMinimized ? 'Restore' : 'Minimize'}
            className="text-slate-500 hover:text-cyan-200"
          >
            {isMinimized ? <Square className="w-3.5 h-3.5" /> : <Minus className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleMaximize(); }}
            onMouseDown={(e) => e.stopPropagation()}
            title={isMaximized ? 'Restore' : 'Maximize'}
            className="text-slate-500 hover:text-cyan-200"
          >
            {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button type="button" onClick={requestClose} title="Close" className="text-slate-500 hover:text-red-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isMinimized ? null : (
      <>
      {/* Controls. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <button
          type="button"
          onClick={runGeneration}
          title="Immediately regenerate every visible sequence using the current view and its own Angle Step, without waiting for the debounce delay."
          className="flex items-center gap-1.5 bg-[#101820]/95 hover:bg-[#172230] disabled:opacity-50 text-slate-200 px-2.5 py-1.5 rounded-md text-[11px] font-bold"
        >
          {calculatingCount > 0 ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Generate/Refresh Plot
        </button>
        <button type="button" onClick={() => panelRef.current?.zoomIn()} disabled={isViewLocked} className={viewButtonClass} title="Zoom in around the center of the current view.">
          <ZoomIn className="w-3.5 h-3.5" />
          Zoom In
        </button>
        <button type="button" onClick={() => panelRef.current?.zoomOut()} disabled={isViewLocked} className={viewButtonClass} title="Zoom out around the center of the current view.">
          <ZoomOut className="w-3.5 h-3.5" />
          Zoom Out
        </button>
        <button type="button" onClick={() => panelRef.current?.fitToPoints()} disabled={isViewLocked} className={viewButtonClass} title="Fit the view to every currently visible sequence's points (or the whole default view when none are visible).">
          <Maximize className="w-3.5 h-3.5" />
          Fit
        </button>
        <button type="button" onClick={() => panelRef.current?.resetToDefaultView()} disabled={isViewLocked} className={viewButtonClass} title="Restore the original default view.">
          <RotateCcw className="w-3.5 h-3.5" />
          Reset View
        </button>
        <button
          type="button"
          onClick={() => setIsViewLocked((locked) => !locked)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-bold ${isViewLocked ? 'bg-cyan-500/20 border border-cyan-400/40 text-cyan-200' : 'bg-[#101820]/95 hover:bg-[#172230] text-slate-200 border border-transparent'}`}
          aria-pressed={isViewLocked}
          title={isViewLocked ? 'View is locked: wheel-zoom, drag-to-pan, and the view buttons are disabled. Click to unlock.' : 'Lock this view: disables wheel-zoom, drag-to-pan, and the view buttons above.'}
        >
          {isViewLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
          {isViewLocked ? 'Unfix View' : 'Fix View'}
        </button>
        <button type="button" onClick={onShowAll} title="Show every sequence in this graph." className={viewButtonClass}>
          <Eye className="w-3.5 h-3.5" />
          Show All
        </button>
        <button type="button" onClick={onHideAll} title="Hide every sequence from this graph." className={viewButtonClass}>
          <EyeOff className="w-3.5 h-3.5" />
          Hide All
        </button>
        <button type="button" onClick={onEditGraphs} title="Open Graph Setup to configure every graph's angles, step, code, color, and visibility." className={viewButtonClass}>
          Edit Graphs
        </button>
        <button
          type="button"
          onClick={requestClose}
          className="flex items-center gap-1.5 bg-[#101820]/95 hover:bg-[#172230] text-slate-200 px-2.5 py-1.5 rounded-md text-[11px] font-bold"
        >
          Close
        </button>
      </div>

      {/* Status: aggregate summary across every visible row. Its own
          always-mounted, single-line row so its length can never change
          this row's height (see the original single-sequence version's
          comment on this same layout choice — the same infinite-resize-
          loop risk applies here). */}
      <div className="px-3 py-1.5 border-b border-white/10 shrink-0 text-[11px] font-mono text-slate-400 whitespace-nowrap overflow-x-auto">
        {summaryLine}
      </div>
      <div className="h-1 bg-[#0c1117] shrink-0 overflow-hidden">
        {calculatingCount > 0 && <div className="h-full w-1/3 bg-cyan-400/70 animate-pulse" />}
      </div>

      {/* Legend: compact wrapping strip (not a side panel) so it never eats
          into the graph's own space at this window's minimum size. */}
      <div className="border-b border-white/10 shrink-0">
        <button
          type="button"
          onClick={() => setLegendCollapsed((c) => !c)}
          className="w-full flex items-center justify-between px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-200"
        >
          <span>Legend ({sequences.length})</span>
          <span>{legendCollapsed ? 'Show' : 'Hide'}</span>
        </button>
        {/* Fixed height (not max-height): a row's chip text length changes
            constantly (e.g. "Calculating... 22,790/201,601" vs "59 points
            - Exact"), and if that were allowed to resize this box, it
            would shrink/grow the graph canvas below it, fire its
            ResizeObserver, and re-trigger adaptive-mode rows purely
            because their own status text changed length — the exact
            "genuine infinite loop, observed live during testing" this
            window's status-line comment already documents for a
            variable-height element above the canvas. A fixed height
            (scrolling internally instead of reflowing) keeps the canvas
            container's size independent of anything drawn inside here. */}
        {!legendCollapsed && (
          <div className="flex flex-wrap content-start gap-1.5 px-3 pb-2 h-24 overflow-y-auto custom-scrollbar">
            {sequences.map((seq) => (
              <div
                key={seq.id}
                title={`${seq.label}: ${seq.sequenceText || '(empty)'} · Step ${seq.angleStepInput} · ${seq.id === activeSequenceId ? 'active in main view · ' : ''}${rowStatusText(seq)}`}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-mono ${seq.visible ? 'border-white/10 bg-[#0b1016] text-slate-300' : 'border-white/10 bg-[#0b1016] text-slate-600'}`}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: seq.color, opacity: seq.visible ? 1 : 0.4 }} />
                <span className="font-bold shrink-0">{seq.label}{seq.id === activeSequenceId ? ' •' : ''}</span>
                <span className="text-slate-500">&ldquo;{truncateSequenceText(seq.sequenceText, 16)}&rdquo;</span>
                <span className="text-slate-500">step {seq.angleStepInput}</span>
                <span className="text-slate-600">{rowStatusText(seq)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Graph. */}
      <div className="flex-1 min-h-0 min-w-0 p-3">
        <AnglePlotPanel
          ref={panelRef}
          series={series}
          currentPoint={currentPoint}
          isLocked={isViewLocked}
          onViewChange={handleViewChange}
        />
      </div>

      {/* Resize grip — hidden while maximized, since the window can't be
          resized until it's restored. */}
      {!isMaximized && (
        <div
          className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize"
          onMouseDown={handleResizeMouseDown}
          title="Drag to resize"
        >
          <svg viewBox="0 0 16 16" className="w-full h-full text-slate-600">
            <path d="M14 2 L2 14 M14 8 L8 14 M14 14 L14 14" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
      )}
      </>
      )}

      {/* Close confirmation: closing unmounts this window, which discards
          every row's generated points — minimizing does not, so the
          dialog steers toward that instead of losing plotted work to a
          stray click. */}
      {showCloseConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div role="alertdialog" aria-modal="true" aria-labelledby="close-confirm-title" className="w-full max-w-xs bg-[#151c24] border border-amber-400/30 rounded-lg shadow-[0_20px_60px_rgba(0,0,0,0.55)] p-4">
            <h3 id="close-confirm-title" className="text-sm font-bold text-amber-200 mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" /> Close this graph window?
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              Closing does not save your plotted graphs — every visible sequence's points will be discarded, and you'll need to regenerate them next time. To keep them, minimize this window instead of closing it.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => setShowCloseConfirm(false)}
                className="bg-[#0b1016] hover:bg-[#172230] border border-white/10 text-slate-300 px-3 py-1.5 rounded-md text-[11px] font-bold transition-colors"
              >
                No, keep it open
              </button>
              <button
                type="button"
                onClick={() => { setShowCloseConfirm(false); onClose(); }}
                className="bg-red-500/20 hover:bg-red-500/30 border border-red-400/40 text-red-100 px-3 py-1.5 rounded-md text-[11px] font-bold transition-colors"
              >
                Yes, close it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
