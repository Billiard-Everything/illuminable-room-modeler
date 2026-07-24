import { useEffect, useRef, useState, useCallback } from 'react';
import { X, RotateCcw, RefreshCw, Loader2, GripHorizontal, ZoomIn, ZoomOut, Maximize, Lock, Unlock, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import AnglePlotPanel from './AnglePlotPanel.jsx';
import { generateAngleRegion } from './generateAngleRegion.js';
import { generateVisibleAnglePoints } from './visibleAnglePointGenerator.js';
import { parseAngleStep, displayScaleForStep, isExactModeStep, estimateAngleGridIterations, MAX_ANGLE_GRID_ITERATIONS } from './angleStep.js';
import { RENDER_DEBOUNCE_MS } from './renderSamplingPolicy.js';
import { truncateSequenceText } from '../sequences/sequenceGraphConfig.js';

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
// Exact vs. adaptive rendering
// ------------------------------
// Two generation strategies, switched automatically per *row* on that
// row's own Angle Step (see isExactModeStep / EXACT_MODE_STEP_THRESHOLD in
// angleStep.js) — one visible sequence can render in exact mode while
// another renders in adaptive mode at the same time:
//
// - Exact mode (Angle Step >= 0.1): generateAngleRegion.js's full-domain
//   exact sweep. Generated once (mount, refresh, or that row's own
//   sequence/step change) and then reused as-is while the user zooms/pans
//   — zoom and pan never trigger regeneration for an exact-mode row.
//   Guarded by the same MAX_ANGLE_GRID_ITERATIONS safety dialog the
//   original single-sequence version of this feature used, tracked
//   per row so one row's confirmation doesn't block another's.
//
// - Adaptive mode (Angle Step < 0.1): visibleAnglePointGenerator.js's
//   visible-region, zoom-scaled cell sampling. Regenerates (debounced,
//   RENDER_DEBOUNCE_MS) on every zoom/pan/resize/step/sequence change for
//   that row, since what's tractable to compute depends on what's on
//   screen.
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
// This project has no Web Worker infrastructure (see generateAngleRegion.js's
// module comment — every render here is a time-sliced async loop on the
// one JS thread, not a real background thread), so "background processing"
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

const emptyRowResult = () => ({ points: [], status: 'idle', mode: null, renderInfo: null, progress: null, error: null });

export default function AnglePlotWindow({ sequences, activeSequenceId, angleParams, baseLength, buildValidateCandidateForSequence, refreshToken, onClose, onShowAll, onHideAll, theme }) {
  const [pos, setPos] = useState({ x: 96, y: 72 });
  const [size, setSize] = useState(DEFAULT_SIZE);
  const dragOffset = useRef(null);
  const resizeStart = useRef(null);

  // Per-sequence-id render results/status. Never cleared on hide, only on delete.
  const [results, setResults] = useState({});
  const [isViewLocked, setIsViewLocked] = useState(false);
  // Array of { id, label, scale, stepUnits, stepDegrees, estimatedIterations } — one entry per row currently blocked on an oversized exact sweep.
  const [pendingLargeExactSweeps, setPendingLargeExactSweeps] = useState([]);
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
  useEffect(() => {
    sequencesRef.current = sequences;
    buildValidateCandidateForSequenceRef.current = buildValidateCandidateForSequence;
    resultsRef.current = results;
  }, [sequences, buildValidateCandidateForSequence, results]);

  const debounceTimersRef = useRef({}); // id -> timeout handle
  const jobTaskRef = useRef({}); // id -> { promise, cancel }
  const jobRequestIdRef = useRef({}); // id -> number, bumped on every (re)start or cancel
  const runningIdsRef = useRef(new Set());
  const pendingQueueRef = useRef([]); // [{ seq, viewState }]
  const lastViewStateRef = useRef(null);
  const prevSequenceSnapshotRef = useRef({}); // id -> { sequenceText, angleStepInput, visible }
  const lastRefreshTokenRef = useRef(refreshToken);

  const setRowResult = useCallback((id, patch) => {
    setResults((prev) => ({ ...prev, [id]: { ...(prev[id] || emptyRowResult()), ...patch } }));
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
    const exactMode = isExactModeStep(parsed.scale, parsed.stepUnits);
    const startedAt = performance.now();
    setRowResult(seq.id, { status: 'running', error: null, progress: exactMode ? { mode: 'exact', tested: 0, total: 0, found: 0 } : { mode: 'adaptive', cellsChecked: 0, found: 0 } });

    if (exactMode) {
      const estimatedIterations = estimateAngleGridIterations(parsed.scale, parsed.stepUnits, undefined);
      if (estimatedIterations > BigInt(MAX_ANGLE_GRID_ITERATIONS)) {
        setPendingLargeExactSweeps((list) => [...list.filter((p) => p.id !== seq.id), { id: seq.id, label: seq.label, ...parsed, estimatedIterations }]);
        setRowResult(seq.id, { status: 'idle', progress: null });
        finishSlot();
        return;
      }
      const task = generateAngleRegion({
        validateCandidate, baseLength, scale: parsed.scale, stepUnits: parsed.stepUnits,
        onProgress: (p) => {
          if (jobRequestIdRef.current[seq.id] !== requestId) return;
          setRowResult(seq.id, { progress: { mode: 'exact', ...p } });
        },
      });
      jobTaskRef.current[seq.id] = task;
      task.promise.then((resultPoints) => {
        if (jobRequestIdRef.current[seq.id] === requestId) {
          setRowResult(seq.id, {
            points: resultPoints, status: 'done', mode: 'exact',
            renderInfo: { mode: 'exact', userStepDegrees: parsed.stepDegrees, gridStepDegrees: parsed.stepDegrees, displayScale: displayScaleForStep(parsed.scale), pointCount: resultPoints.length, durationMs: performance.now() - startedAt },
          });
        }
        finishSlot();
      });
      return;
    }

    if (!viewState) {
      // No viewport reported yet (panel hasn't mounted/measured). This row
      // will be picked up by the next handleViewChange call once it does.
      finishSlot();
      return;
    }
    const task = generateVisibleAnglePoints({
      validateCandidate, baseLength, scale: parsed.scale, stepUnits: parsed.stepUnits,
      viewBounds: viewState.bounds, viewportSize: viewState.viewportSize, zoomLevel: viewState.zoomLevel,
      excludePoint: seq.id === activeSequenceId ? currentPoint : undefined,
      onProgress: (p) => {
        if (jobRequestIdRef.current[seq.id] !== requestId) return;
        setRowResult(seq.id, { progress: { mode: 'adaptive', ...p } });
      },
    });
    jobTaskRef.current[seq.id] = task;
    task.promise.then((result) => {
      if (jobRequestIdRef.current[seq.id] === requestId) {
        setRowResult(seq.id, {
          points: result.points, status: 'done', mode: 'adaptive',
          renderInfo: { mode: 'adaptive', zoomLevel: viewState.zoomLevel, userStepDegrees: parsed.stepDegrees, gridStepDegrees: result.effectiveStepDegrees, requestedStepDegrees: result.requestedStepDegrees, displayScale: displayScaleForStep(parsed.scale), pointCount: result.points.length, durationMs: performance.now() - startedAt, budgetLimited: result.budgetLimited, timeLimited: result.timeLimited },
        });
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

  const confirmLargeExactSweep = useCallback((id) => {
    const pending = pendingLargeExactSweeps.find((p) => p.id === id);
    const seq = sequences.find((s) => s.id === id);
    if (!pending || !seq) return;
    setPendingLargeExactSweeps((list) => list.filter((p) => p.id !== id));
    // Re-run the job start directly at exact mode, bypassing the size guard
    // this once (mirrors the original single-sequence "Generate Anyway").
    runningIdsRef.current.delete(id); // was never actually added to the running set for this attempt
    pendingQueueRef.current = pendingQueueRef.current.filter((job) => job.seq.id !== id);
    const requestId = (jobRequestIdRef.current[id] = (jobRequestIdRef.current[id] || 0) + 1);
    runningIdsRef.current.add(id);
    const startedAt = performance.now();
    setRowResult(id, { status: 'running', progress: { mode: 'exact', tested: 0, total: 0, found: 0 } });
    const validateCandidate = buildValidateCandidateForSequenceRef.current(seq.sequenceText, { a: seq.angleA, b: seq.angleB, length: baseLength });
    const task = generateAngleRegion({
      validateCandidate, baseLength, scale: pending.scale, stepUnits: pending.stepUnits,
      onProgress: (p) => {
        if (jobRequestIdRef.current[id] !== requestId) return;
        setRowResult(id, { progress: { mode: 'exact', ...p } });
      },
    });
    jobTaskRef.current[id] = task;
    task.promise.then((resultPoints) => {
      if (jobRequestIdRef.current[id] === requestId) {
        setRowResult(id, {
          points: resultPoints, status: 'done', mode: 'exact',
          renderInfo: { mode: 'exact', userStepDegrees: pending.stepDegrees, gridStepDegrees: pending.stepDegrees, displayScale: displayScaleForStep(pending.scale), pointCount: resultPoints.length, durationMs: performance.now() - startedAt },
        });
      }
      runningIdsRef.current.delete(id);
      tryStartNextQueuedJob();
    });
  }, [pendingLargeExactSweeps, sequences, baseLength, setRowResult, tryStartNextQueuedJob]);

  const dismissLargeExactSweep = useCallback((id) => setPendingLargeExactSweeps((list) => list.filter((p) => p.id !== id)), []);

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
  // synchronously, which starts a real generateAngleRegion task and stores
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

        if (isForcedRefresh || isNew || contentChanged || (justBecameVisible && !hasCachedResult)) {
          scheduleRenderForSequence(seq, lastViewStateRef.current, { immediate: isForcedRefresh || isNew || contentChanged });
        }
        // justBecameVisible with a valid cached result and no content change: reuse the cache, no job scheduled.
      }
      prevSequenceSnapshotRef.current = nextSnapshot;
    }, 0);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequences, refreshToken]);

  // Cancel every outstanding job on unmount so a closed window never calls setState after it stops existing.
  useEffect(() => () => {
    Object.keys(jobTaskRef.current).forEach((id) => jobTaskRef.current[id]?.cancel());
    Object.values(debounceTimersRef.current).forEach((t) => clearTimeout(t));
  }, []);

  // AnglePlotPanel reports every zoom/pan/resize here, undebounced. Every
  // currently visible adaptive-mode row gets a debounced re-render; exact-
  // mode rows are untouched since their dataset doesn't depend on the
  // viewport (AnglePlotPanel redraws their existing points at the new
  // zoom/pan on its own).
  const handleViewChange = useCallback((viewState) => {
    lastViewStateRef.current = viewState;
    for (const seq of sequencesRef.current) {
      if (!seq.visible) continue;
      const parsed = parseAngleStep(seq.angleStepInput);
      if (parsed.valid && !isExactModeStep(parsed.scale, parsed.stepUnits)) {
        scheduleRenderForSequence(seq, viewState);
      }
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
    e.stopPropagation();
    resizeStart.current = { startX: e.clientX, startY: e.clientY, startWidth: size.width, startHeight: size.height };
  };

  const viewButtonClass = "flex items-center gap-1.5 bg-[#101820]/95 hover:bg-[#172230] disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 px-2.5 py-1.5 rounded-md text-[11px] font-bold";

  // Build the drawable series list (visible rows only) and the aggregate status line.
  const visibleSequences = sequences.filter((s) => s.visible);
  const series = visibleSequences.map((seq) => {
    const result = results[seq.id] || emptyRowResult();
    return {
      id: seq.id, label: seq.label, color: seq.color, sequenceText: seq.sequenceText,
      angleStepInput: seq.angleStepInput, points: result.points || [],
      gridStepDegrees: result.renderInfo?.gridStepDegrees, displayScale: result.renderInfo?.displayScale ?? 1,
      mode: result.mode, status: result.status,
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
      if (p?.mode === 'exact') return `Calculating… ${(p.tested || 0).toLocaleString()}/${(p.total || 0).toLocaleString()}`;
      return `Calculating… ${(p?.cellsChecked || 0).toLocaleString()} checked`;
    }
    if (result.status === 'idle') return 'Waiting to generate…';
    return `${(result.points.length || 0).toLocaleString()} points · ${result.mode === 'exact' ? 'Exact' : 'Adaptive'}`;
  };

  return (
    <div
      className="fixed z-50 flex flex-col bg-[#10151c] border border-white/10 rounded-lg shadow-[0_20px_60px_rgba(0,0,0,0.55)] overflow-hidden select-none"
      style={{ left: pos.x, top: pos.y, width: size.width, height: size.height }}
    >
      {/* Title bar: the "normal title bar" this pop-up is dragged by. */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 bg-[#0c1117] border-b border-white/10 cursor-move shrink-0 select-none"
        onMouseDown={handleTitleMouseDown}
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal className="w-3.5 h-3.5 text-slate-600 shrink-0" />
          <span className="text-xs font-bold text-slate-200 truncate">Valid Angle A&ndash;B Region</span>
        </div>
        <button type="button" onClick={onClose} title="Close" className="text-slate-500 hover:text-red-300 shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

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
        <button
          type="button"
          onClick={onClose}
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

      {pendingLargeExactSweeps.map((pending) => (
        <div key={pending.id} className="flex flex-col gap-1.5 px-3 py-2 border-b border-amber-400/30 bg-amber-500/10 text-[11px] text-amber-100 shrink-0">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {pending.label}: step {pending.stepDegrees} would require testing an estimated {pending.estimatedIterations.toLocaleString()} angle
              combinations in exact mode, over the {MAX_ANGLE_GRID_ITERATIONS.toLocaleString()}-combination safety limit.
            </span>
          </div>
          <div className="flex gap-2 pl-5">
            <button type="button" onClick={() => confirmLargeExactSweep(pending.id)} className="bg-amber-400/20 hover:bg-amber-400/30 text-amber-100 px-2.5 py-1 rounded-md font-bold">
              Generate Anyway
            </button>
            <button type="button" onClick={() => dismissLargeExactSweep(pending.id)} className="bg-[#101820]/95 hover:bg-[#172230] text-slate-200 px-2.5 py-1 rounded-md font-bold">
              Cancel (use a larger step)
            </button>
          </div>
        </div>
      ))}

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
          theme={theme}
          isLocked={isViewLocked}
          onViewChange={handleViewChange}
        />
      </div>

      {/* Resize grip. */}
      <div
        className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize"
        onMouseDown={handleResizeMouseDown}
        title="Drag to resize"
      >
        <svg viewBox="0 0 16 16" className="w-full h-full text-slate-600">
          <path d="M14 2 L2 14 M14 8 L8 14 M14 14 L14 14" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </div>
    </div>
  );
}
