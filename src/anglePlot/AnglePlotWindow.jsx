import { useEffect, useRef, useState, useCallback } from 'react';
import { X, RotateCcw, RefreshCw, Loader2, GripHorizontal, ZoomIn, ZoomOut, Maximize, Maximize2, Minimize2, Lock, Unlock, AlertTriangle, Eye, EyeOff, Minus, Square } from 'lucide-react';
import AnglePlotPanel from './AnglePlotPanel.jsx';
import { generateVisibleAnglePoints } from './visibleAnglePointGenerator.js';
import { generateAngleRegion } from './generateAngleRegion.js';
import { RENDERER_MODE } from './rendererSelection.js';
import { parseAngleStep, displayScaleForStep } from './angleStep.js';
import { RENDER_DEBOUNCE_MS, MAX_BACKGROUND_EXACT_RENDER_MS } from './renderSamplingPolicy.js';
import { truncateSequenceText } from '../sequences/sequenceGraphConfig.js';
import { graphCache, buildGraphCacheKey } from './graphCache.js';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from './graphHasher.js';
import { fetchRemoteExactGraph, uploadRemoteExactGraph } from './remoteGraphRepository.js';
import { fetchLocalExactGraph, saveLocalExactGraph } from './localGraphDatabaseClient.js';
import { primeExactGraphCache } from './exactGraphCaching.js';
import {
  requestExactComputation, isExactComputationRunning, updateBackgroundJobPriority,
  getBackgroundJobState, JOB_PRIORITY,
} from './backgroundExactWorker.js';
import { GRAPH_STATUS } from './graphStatus.js';
import { graphParamsFromSequence } from './graph.js';

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
// Instant preview, silent background exact upgrade (graph.js/graphCache.js/
// backgroundExactWorker.js)
// -----------------------------------------------------------------------
// Every row is generated in up to two phases, never gated by a cost
// estimate: first, the viewport-scoped adaptive sampler
// (visibleAnglePointGenerator.js) runs (or a previous adaptive/exact result
// is reused from GraphCache), so the user always sees *something* as fast
// as this app has ever shown one. Immediately after that preview is on
// screen, a full-domain exact brute-force sweep (generateAngleRegion.js) for
// the same graph is kicked off in the background (deduped by content hash
// across rows via backgroundExactWorker.js, so identical rows never pay for
// two sweeps) and, when it finishes, silently replaces that row's
// points/renderInfo with the exact result — no visible reload, no change to
// the row's order/color/visibility/selection. Background sweeps are also
// bounded to at most MAX_CONCURRENT_BACKGROUND_JOBS running at once (see
// backgroundExactWorker.js) — everything else waits in a priority queue,
// ordered by jobPriorityForSequence below (visible, then selected, then
// freshly-plotted, then hidden), so a page with many plotted graphs never
// tries to brute-force all of them simultaneously. Because the exact sweep
// always covers the whole domain, its cached result does not depend on the
// viewport and survives any amount of panning/zooming (see
// handleViewChange's own skip for EXACT rows); the adaptive path keeps
// regenerating (debounced, RENDER_DEBOUNCE_MS) on every zoom/pan/resize/
// step/sequence change exactly as before, since what's tractable to compute
// there depends on what's on screen. A "Plot Valid Angle Region" /
// "Generate/Refresh Plot" click forces an immediate regenerate instead of
// waiting out the debounce.
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

// Maps a row's current state to the background exact job queue's priority
// (backgroundExactWorker.js's JOB_PRIORITY) for its brute-force sweep: a
// graph currently on screen is worth computing before one that's merely
// selected for the main canvas but hidden from the plot, which in turn
// beats a graph that was never plotted before this exact request but is
// otherwise hidden/unselected (a fresh, explicit "Plot" click deserves
// more urgency than some other, older hidden graph's re-request) — and any
// other hidden, non-selected, previously-requested graph is lowest.
// `everRequestedIds` is a session-lifetime Set (see everRequestedExactIdsRef
// below), not per-hash, so replotting the *same* row under a *different*
// hash later still correctly reads as HIDDEN rather than NEWLY_PLOTTED
// again.
const jobPriorityForSequence = (seq, activeSequenceId, everRequestedIds) => {
  if (seq.visible) return JOB_PRIORITY.VISIBLE;
  if (seq.id === activeSequenceId) return JOB_PRIORITY.SELECTED;
  if (!everRequestedIds.has(seq.id)) return JOB_PRIORITY.NEWLY_PLOTTED;
  return JOB_PRIORITY.HIDDEN;
};

// How long to wait, after this window's own state (position, size,
// minimize/maximize, view lock, or the shared panel's zoom/pan) last
// changed, before reporting it upward via onWorkspaceStateChange — kept
// separate from RENDER_DEBOUNCE_MS since this drives workspace
// persistence, not rendering, and can tolerate a slightly longer delay to
// keep autosave writes infrequent even during continuous dragging/zooming.
const WORKSPACE_REPORT_DEBOUNCE_MS = 600;

export default function AnglePlotWindow({
  sequences, activeSequenceId, angleParams, baseLength, buildValidateCandidateForSequence, refreshToken,
  onClose, onShowAll, onHideAll, onEditGraphs, onRowStatusChange, forceGenerateRequest,
  // All optional, all defaulting to this window's original hardcoded
  // defaults — a caller that never passes these (there was only one
  // caller before workspace persistence existed) sees exactly the same
  // opening state as before. See App.jsx's workspace restore for the one
  // caller that does pass a previously saved state.
  initialPos, initialSize, initialIsMinimized, initialIsMaximized, initialIsViewLocked, initialLegendCollapsed,
  initialPanelZoom, initialPanelPan,
  onWorkspaceStateChange,
}) {
  const [pos, setPos] = useState(() => initialPos ?? { x: 96, y: 72 });
  const [size, setSize] = useState(() => initialSize ?? DEFAULT_SIZE);
  const dragOffset = useRef(null);
  const resizeStart = useRef(null);
  // Minimized collapses the whole window down to just its title bar (like a
  // normal OS window minimize) without closing it or losing any state —
  // every job/result/view setting below is untouched and reappears exactly
  // as it was on restore.
  const [isMinimized, setIsMinimized] = useState(() => initialIsMinimized ?? false);
  // Maximized fills the available viewport (minus a small margin) instead
  // of the window's normal draggable/resizable box. `preMaximizeRef` holds
  // the pos/size to restore exactly on un-maximize, so toggling it off
  // never leaves the window at a different spot/size than before.
  const [isMaximized, setIsMaximized] = useState(() => initialIsMaximized ?? false);
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
  const [isViewLocked, setIsViewLocked] = useState(() => initialIsViewLocked ?? false);
  const [legendCollapsed, setLegendCollapsed] = useState(() => initialLegendCollapsed ?? false);
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
  const onWorkspaceStateChangeRef = useRef(onWorkspaceStateChange);
  useEffect(() => {
    sequencesRef.current = sequences;
    buildValidateCandidateForSequenceRef.current = buildValidateCandidateForSequence;
    resultsRef.current = results;
    onRowStatusChangeRef.current = onRowStatusChange;
    onWorkspaceStateChangeRef.current = onWorkspaceStateChange;
  }, [sequences, buildValidateCandidateForSequence, results, onRowStatusChange, onWorkspaceStateChange]);

  // Workspace persistence (see App.jsx's WorkspaceManager integration):
  // reports this window's own position/size/minimize/maximize/view-lock
  // state, plus the shared panel's zoom/pan (captured via handleViewChange
  // below — the panel itself owns that state, this window only mirrors
  // it), debounced so continuous dragging/zooming doesn't trigger a write
  // on every frame. panelViewRef starts from whatever was last restored,
  // so a workspace save that happens before the panel ever reports its own
  // view change (e.g. the window opens but nothing is dragged/zoomed) still
  // reports the correct, previously-restored view instead of some default.
  const panelViewRef = useRef({ panelZoom: initialPanelZoom, panelPan: initialPanelPan });
  const workspaceReportTimeoutRef = useRef(null);
  const scheduleWorkspaceReport = useCallback(() => {
    if (!onWorkspaceStateChangeRef.current) return;
    if (workspaceReportTimeoutRef.current) clearTimeout(workspaceReportTimeoutRef.current);
    workspaceReportTimeoutRef.current = setTimeout(() => {
      workspaceReportTimeoutRef.current = null;
      onWorkspaceStateChangeRef.current?.({
        pos, size, isMinimized, isMaximized, isViewLocked, legendCollapsed,
        panelZoom: panelViewRef.current.panelZoom, panelPan: panelViewRef.current.panelPan,
      });
    }, WORKSPACE_REPORT_DEBOUNCE_MS);
  }, [pos, size, isMinimized, isMaximized, isViewLocked, legendCollapsed]);
  useEffect(() => {
    scheduleWorkspaceReport();
  }, [scheduleWorkspaceReport]);
  useEffect(() => () => {
    if (workspaceReportTimeoutRef.current) clearTimeout(workspaceReportTimeoutRef.current);
  }, []);

  const debounceTimersRef = useRef({}); // id -> timeout handle
  const jobTaskRef = useRef({}); // id -> { promise, cancel }
  const jobRequestIdRef = useRef({}); // id -> number, bumped on every (re)start or cancel
  const runningIdsRef = useRef(new Set());
  // id -> unsubscribe function for that row's currently-pending background
  // exact job listener, and id -> the hash it's listening to (the latter
  // purely so stopListeningForBackgroundExact below can log whether this
  // row's unsubscribe was the one that actually cancelled the job, vs. one
  // of several subscribers on a still-wanted job). See
  // backgroundExactWorker.js's own module comment: since its last
  // subscriber's unsubscribe now cancels the underlying computation and
  // evicts it from the registry, calling this for a row that's being
  // edited/deleted/unmounted is what satisfies "an outdated computation
  // must immediately stop" — a job with other subscribers still keeps
  // running for them, untouched.
  const backgroundUnsubscribersRef = useRef({});
  const backgroundJobHashRef = useRef({});
  // Row ids that have ever made a background-exact request this session —
  // purely for jobPriorityForSequence's NEWLY_PLOTTED tier (see its own
  // comment above). Never cleared on delete: a deleted row's id isn't
  // reused, so a stale entry is inert, not a correctness risk.
  const everRequestedExactIdsRef = useRef(new Set());
  // Exact hashes already confirmed absent from BOTH the permanent local
  // GraphDatabase (localGraphDatabaseClient.js) and the shared PostgreSQL
  // library (remoteGraphRepository.js) this session — checked at most once
  // per hash so a row still on PREVIEW status doesn't re-query either one
  // on every pan/zoom-driven re-render (handleViewChange keeps
  // rescheduling non-EXACT rows exactly as before). A hash that later gets
  // saved by this same session's own background-exact completion never
  // needs this invalidated: that save's own local GraphCache.set happens
  // first, so any row sharing that hash hits GraphCache (STEP 2) before
  // ever reaching this set's check again.
  const remoteMissesRef = useRef(new Set());
  // Exact hashes this session has already attempted to upload — set the
  // moment an upload is attempted (not once it succeeds), so a hash shared
  // by several rows only ever triggers one upload call between them, even
  // though each row's own onResult callback fires when their shared
  // background job completes (see startBackgroundExact below).
  const uploadAttemptedHashesRef = useRef(new Set());
  const stopListeningForBackgroundExact = useCallback((id, label) => {
    const previousHash = backgroundJobHashRef.current[id];
    const unsubscribe = backgroundUnsubscribersRef.current[id];
    delete backgroundUnsubscribersRef.current[id];
    delete backgroundJobHashRef.current[id];
    if (!unsubscribe) return;
    const wasRunning = previousHash ? isExactComputationRunning(previousHash) : false;
    unsubscribe();
    if (import.meta.env.DEV && wasRunning && previousHash && !isExactComputationRunning(previousHash)) {
      console.log(`Renderer: Background Exact cancelled (superseded) — ${label}`);
    }
  }, []);
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

  // Instant preview + silent background exact upgrade, now backed by a
  // shared PostgreSQL library (Phase 5)
  // -----------------------------------------------------------------------
  // STEP 1/2 (see the module's own architecture doc above the imports):
  // every request first checks GraphCache for this graph's EXACT (viewport-
  // independent) entry. A hit is used immediately and nothing is computed
  // at all — not adaptive, not a background job, not even a network call —
  // since the full, permanent answer already exists locally.
  // STEP 2b (new): on a local (browser) GraphCache miss, ask the two
  // server-side stores — the permanent local GraphDatabase
  // (localGraphDatabaseClient.js's fetchLocalExactGraph, the file-based
  // points.json cache) and the shared PostgreSQL library
  // (remoteGraphRepository.js's fetchRemoteExactGraph, never SQL directly —
  // see server/repositories/graphRepository.js for the only module that
  // executes any) — CONCURRENTLY (Promise.all), so a miss on both waits for
  // only the slower of the two, not their sum. Either one resolving is
  // enough: its points are written into GraphCache (so a replot, or a
  // different row sharing this hash, never asks again) and displayed
  // immediately, skipping adaptive and brute-force entirely — the whole
  // point of a permanent, content-addressed hash (requirement: a hash that
  // already has cached points must never be recomputed). A miss, timeout,
  // or any failure (API not running, database/disk unavailable) from
  // either check is indistinguishable from "not found" — see each client's
  // own comment — and simply falls through to STEP 3 exactly as if this
  // feature didn't exist, which is what keeps either store being
  // unavailable from ever breaking plotting. remoteMissesRef bounds this to
  // at most one check of each store per hash per session, so a row still on
  // PREVIEW status doesn't re-ask on every pan/zoom-driven re-render.
  // STEP 3: on a local *and* remote miss, the existing viewport-scoped
  // adaptive path runs exactly as before (own cache key, own generator, own
  // progress reporting) so the user sees *something* as fast as this app
  // has ever shown one, regardless of how expensive the exact sweep (or the
  // network round trip) would be.
  // STEP 4: once that preview is on screen, a background exact computation
  // is requested (backgroundExactWorker.js) — deduped by hash, so N rows
  // (or N re-renders of the same row) sharing one hash only ever pay for
  // one sweep between them. It reports no progress and never touches this
  // row's `status`/`progress` fields (those already read "done" from the
  // preview) — only `points`/`renderInfo` are swapped, silently, when it
  // resolves, which is what makes the exact result feel like a seamless
  // upgrade rather than a second visible loading cycle. See
  // backgroundExactWorker.isExactComputationRunning(hash) for how a future
  // "still refining…" indicator would read the in-between COMPUTING state
  // without this needing to push it into per-row state at all. When that
  // sweep finishes as a genuine, complete result (never cancelled — a
  // cancelled job's subscribers are already empty by the time it settles,
  // see backgroundExactWorker.js — and never timeLimited, since a sweep
  // truncated by MAX_BACKGROUND_EXACT_RENDER_MS is not the true exact
  // geometry for this permanent hash), it's uploaded to the shared library
  // the same way a download failure is handled: fire, log, never block or
  // break plotting if it fails.
  const startSequenceJob = useCallback(async (seq, viewState) => {
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

    // A graph's exact identity never depends on the viewport or on which
    // row happens to be active — see graphHasher.js's own comment on why
    // `excludePoint` (a display-only concern), like zoom/pan, is
    // deliberately excluded here even though the adaptive/preview cache key
    // below still includes it. This is also the permanent identifier a
    // future PostgreSQL-backed cache would look a graph up by (see
    // server/repositories/graphRepository.js), so every exact-identity hash
    // in this file goes through hashGraph, never a one-off computation.
    const exactHash = hashGraph(graphParamsFromSequence(seq, baseLength));

    // STEP 2: an exact hit is final and needs nothing further — no
    // adaptive preview, no background job, no further cache writes.
    const cachedExact = graphCache.get(exactHash);
    if (cachedExact) {
      if (import.meta.env.DEV) console.log(`Renderer: Cache Hit (exact) — ${seq.label} (${cachedExact.renderInfo.pointCount} points reused)`);
      setRowResult(seq.id, { points: cachedExact.points, status: 'done', renderInfo: { ...cachedExact.renderInfo, fromCache: true } });
      finishSlot();
      return;
    }

    // STEP 2b: no local (browser) exact entry — ask the permanent local
    // GraphDatabase and the shared PostgreSQL library concurrently before
    // falling back to adaptive/brute-force (see this function's own module
    // comment). Bounded to one check of each per hash per session via
    // remoteMissesRef; any failure (down, unreachable, timed out) is
    // indistinguishable from "not found" here, by each client's own design,
    // so this always safely falls through to STEP 3.
    if (!remoteMissesRef.current.has(exactHash)) {
      const [localResult, remoteResult] = await Promise.all([
        fetchLocalExactGraph(exactHash),
        fetchRemoteExactGraph(exactHash),
      ]);
      // This row may have been edited (or deleted/hidden) while the network
      // call was in flight — jobRequestIdRef's usual staleness guard (see
      // the adaptive task's own `.then` below) applies here too; a newer
      // invocation for this row already owns finishing it.
      if (jobRequestIdRef.current[seq.id] !== requestId) {
        finishSlot();
        return;
      }
      // Local (the permanent points.json cache) wins on a double hit — it's
      // this feature's own primary cache, and preferring it costs nothing
      // since both checks already ran concurrently.
      const cacheHit = localResult || remoteResult;
      if (cacheHit) {
        // primeExactGraphCache (exactGraphCaching.js) builds renderInfo and
        // writes GraphCache in one call — the same helper the Graph
        // Library's "Load Graph" action uses, so a cache-sourced graph's
        // cache entry has one shape regardless of which of the
        // ever-diverging call sites (or, now, which store) populated it.
        const renderInfo = primeExactGraphCache(exactHash, seq.angleStepInput, cacheHit);
        const source = localResult ? 'local GraphDatabase' : 'PostgreSQL';
        if (import.meta.env.DEV) console.log(`Renderer: Cache Hit (${source}) — ${seq.label} (${cacheHit.points.length} points reused)`);
        setRowResult(seq.id, { points: cacheHit.points, status: 'done', renderInfo: { ...renderInfo, fromCache: true } });
        finishSlot();
        return;
      }
      remoteMissesRef.current.add(exactHash);
    }

    if (!viewState) {
      // No viewport reported yet (panel hasn't mounted/measured). This row
      // will be picked up by the next handleViewChange call once it does.
      finishSlot();
      return;
    }

    const excludePoint = seq.id === activeSequenceId ? currentPoint : undefined;

    // Kicks off (or joins) the background exact sweep for this graph once
    // a preview is already showing — shared by both the preview-cache-hit
    // path and the freshly-computed-preview path below so neither has to
    // duplicate this.
    const startBackgroundExact = () => {
      // Priority reflects this row's *current* state (visible/selected),
      // read fresh via sequencesRef rather than the closed-over `seq` —
      // this callback can run well after startSequenceJob was first
      // invoked (e.g. after a slow adaptive preview), by which time the
      // row's visibility or selection could have changed.
      const currentSeq = sequencesRef.current.find((s) => s.id === seq.id) ?? seq;
      const priority = jobPriorityForSequence(currentSeq, activeSequenceId, everRequestedExactIdsRef.current);
      everRequestedExactIdsRef.current.add(seq.id);

      // This row can be re-scheduled for reasons that never actually change
      // its exact hash — e.g. a view/fit change re-running the *adaptive*
      // preview after the panel auto-fits to a fresh (but content-identical)
      // result — and each of those still reaches this same point. If the
      // row is already subscribed to this exact hash's job, there is
      // nothing stale to cancel: unsubscribing and immediately
      // resubscribing here would needlessly cancel-and-restart an already-
      // correct, still-running (or still-queued) computation for no reason,
      // discarding whatever progress it had made. Its priority can still
      // have changed, though (e.g. the row just became visible), so that
      // gets refreshed either way. Only when the hash has genuinely changed
      // is the previous subscription actually stale.
      if (backgroundJobHashRef.current[seq.id] === exactHash) {
        updateBackgroundJobPriority(exactHash, priority);
        return;
      }
      // A previous background job this row was subscribed to (e.g. a
      // still-in-flight sweep for whatever this row's *last* configuration
      // was) is no longer relevant to this row once it's been replotted
      // under a new hash — stop listening to it, which cancels it outright
      // (or drops it from the queue if it hadn't started yet) if this row
      // was its only remaining subscriber (see backgroundExactWorker.js and
      // stopListeningForBackgroundExact above).
      stopListeningForBackgroundExact(seq.id, seq.label);
      const existedAlready = isExactComputationRunning(exactHash);
      const bgStartedAt = performance.now();
      let bgTimeLimited = false;
      const unsubscribe = requestExactComputation(
        exactHash,
        () => generateAngleRegion({
          validateCandidate, baseLength, scale: parsed.scale, stepUnits: parsed.stepUnits,
          maxRenderMs: MAX_BACKGROUND_EXACT_RENDER_MS,
          onProgress: (p) => { if (p.timeLimited) bgTimeLimited = true; },
        }),
        (points, error) => {
          if (error) {
            if (import.meta.env.DEV) console.warn(`Renderer: Background Exact failed — ${seq.label}`, error);
            return;
          }
          const renderInfo = {
            renderer: RENDERER_MODE.BRUTE_FORCE, graphStatus: GRAPH_STATUS.EXACT,
            userStepDegrees: parsed.stepDegrees, gridStepDegrees: parsed.stepDegrees, requestedStepDegrees: parsed.stepDegrees,
            displayScale: displayScaleForStep(parsed.scale), pointCount: points.length,
            durationMs: performance.now() - bgStartedAt, budgetLimited: false, timeLimited: bgTimeLimited,
          };
          // This callback only ever runs for a job that reached a genuine
          // finish, not a cancelled one: if this row was the *only*
          // subscriber, editing/deleting it already cancelled and evicted
          // the job via stopListeningForBackgroundExact above, and a
          // cancelled job's subscriber set is empty by the time it settles
          // (see backgroundExactWorker.js), so this simply never fires for
          // it. Reaching here means either this row is still current, or a
          // *different* still-live row shares this exact hash — either way
          // the cache write below is safe and useful.
          graphCache.set(exactHash, { points, renderInfo });
          if (import.meta.env.DEV) console.log(`Renderer: Background Exact complete — ${seq.label} (${points.length} points, ${renderInfo.durationMs.toFixed(0)}ms)`);
          // Save to the permanent local GraphDatabase AND upload to the
          // shared PostgreSQL library — but only once per hash per session
          // (uploadAttemptedHashesRef; a hash shared by several rows would
          // otherwise fire one save/upload attempt per subscriber, since
          // each gets its own onResult call for the same completed job —
          // see backgroundExactWorker.js), and only for a genuinely
          // complete sweep: `bgTimeLimited` means
          // MAX_BACKGROUND_EXACT_RENDER_MS cut this sweep short before it
          // covered the whole domain, so it is not the true exact geometry
          // for this permanent hash — persisting it would store a wrong
          // answer under a hash nothing can ever correct later. This is the
          // point this feature's own permanent cache is written: once
          // brute-force finishes (uncancelled, untruncated), its points
          // become the permanent cached version for this hash, so any
          // future request for it (this session or a later one) hits STEP
          // 2b instead of recomputing. Both calls are fire-and-forget from
          // this call site's perspective: neither ever throws or blocks the
          // UI (see localGraphDatabaseClient.js/remoteGraphRepository.js's
          // own comments), so a failed or slow save/upload can never affect
          // this row's already-displayed result.
          // Read fresh row state (title/color/notes/tags/favorite/
          // visibility can all have changed while this sweep was running)
          // for both the metadata save below and the display guard further
          // down — falls back to the closed-over `seq` if the row was
          // deleted in the meantime, matching startBackgroundExact's own
          // fresh-read pattern above.
          const currentSeqForSave = sequencesRef.current.find((s) => s.id === seq.id) ?? seq;
          if (!bgTimeLimited && !uploadAttemptedHashesRef.current.has(exactHash)) {
            uploadAttemptedHashesRef.current.add(exactHash);
            const graphParams = graphParamsFromSequence(seq, baseLength);
            // The row's own richer metadata (title/color/notes/tags/
            // favorite/visibility) rides along to the local GraphDatabase
            // only — the PostgreSQL shared-library schema has no room for
            // it (see localGraphDatabaseClient.js's own comment), so
            // uploadRemoteExactGraph keeps its existing params/points-only
            // call unchanged.
            saveLocalExactGraph(graphParams, GRAPH_HASH_ALGORITHM_VERSION, points, renderInfo.durationMs, {
              title: currentSeqForSave.title, graphColorHex: currentSeqForSave.color, notes: currentSeqForSave.notes,
              tags: currentSeqForSave.tags, favorite: currentSeqForSave.favorite, visibility: currentSeqForSave.visibility,
            });
            uploadRemoteExactGraph(graphParams, GRAPH_HASH_ALGORITHM_VERSION, points, renderInfo.durationMs);
          }
          // Still guard the *display* update on this row's own current
          // params, since a shared job's result is only this row's to show
          // when it's actually still the row that asked for it.
          const currentSeq = sequencesRef.current.find((s) => s.id === seq.id);
          if (!currentSeq) return;
          const currentHash = hashGraph(graphParamsFromSequence(currentSeq, baseLength));
          if (currentHash !== exactHash) return;
          setRowResult(seq.id, { points, status: 'done', renderInfo });
        },
        priority,
      );
      backgroundUnsubscribersRef.current[seq.id] = unsubscribe;
      backgroundJobHashRef.current[seq.id] = exactHash;
      if (import.meta.env.DEV) {
        // getBackgroundJobState is read *after* requestExactComputation, so
        // it reflects whatever the queue actually did with this request —
        // 'running' if a slot was free, 'queued' if both were already busy
        // with higher-or-equal priority work.
        const state = getBackgroundJobState(exactHash);
        console.log(existedAlready
          ? `Renderer: Background Exact joined (${state}) — ${seq.label}`
          : `Renderer: Background Exact ${state} — ${seq.label}`);
      }
    };

    // STEP 3: the existing adaptive, viewport-scoped preview path —
    // unchanged from before this feature, including its own cache key and
    // generator call.
    const previewCacheKey = buildGraphCacheKey({
      sequenceText: seq.sequenceText, angleA: seq.angleA, angleB: seq.angleB,
      angleStepInput: seq.angleStepInput, baseLength, excludePoint,
      viewBounds: viewState.bounds, viewportSize: viewState.viewportSize,
    });
    const cachedPreview = graphCache.get(previewCacheKey);
    if (cachedPreview) {
      if (import.meta.env.DEV) console.log(`Renderer: Cache Hit (preview) — ${seq.label} (${cachedPreview.renderInfo.pointCount} points reused)`);
      setRowResult(seq.id, { points: cachedPreview.points, status: 'done', renderInfo: { ...cachedPreview.renderInfo, fromCache: true } });
      finishSlot();
      startBackgroundExact();
      return;
    }
    if (import.meta.env.DEV) console.log(`Renderer: Adaptive — ${seq.label}`);

    const task = generateVisibleAnglePoints({
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
        const renderInfo = {
          renderer: RENDERER_MODE.ADAPTIVE, graphStatus: GRAPH_STATUS.PREVIEW,
          zoomLevel: viewState.zoomLevel, userStepDegrees: parsed.stepDegrees, gridStepDegrees: result.effectiveStepDegrees,
          requestedStepDegrees: result.requestedStepDegrees, displayScale: displayScaleForStep(parsed.scale),
          pointCount: result.points.length, durationMs: performance.now() - startedAt,
          budgetLimited: result.budgetLimited, timeLimited: result.timeLimited,
        };
        // A genuinely cancelled/superseded job never reaches here at all —
        // the requestId check above already guards this whole block.
        graphCache.set(previewCacheKey, { points: result.points, renderInfo });
        setRowResult(seq.id, { points: result.points, status: 'done', renderInfo });
        finishSlot();
        startBackgroundExact();
      } else {
        finishSlot();
      }
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
          // Unlike hiding a row (which keeps listening so an exact upgrade
          // still lands once it's shown again — see this effect's own
          // module comment), a deleted row is gone for good: stop listening
          // for its background exact job so a later-arriving result never
          // calls setResults for an id that no longer exists — and, if this
          // row was the job's last subscriber, this cancels the underlying
          // computation outright (see stopListeningForBackgroundExact and
          // backgroundExactWorker.js), satisfying "deleting a graph cancels
          // its brute-force computation."
          stopListeningForBackgroundExact(id, id);
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

  // Cancel every outstanding job on unmount so a closed window never calls
  // setState after it stops existing. Background exact jobs are stopped via
  // stopListeningForBackgroundExact, same as a row deletion: a hash with no
  // other subscriber left anywhere is cancelled outright (see
  // backgroundExactWorker.js); one still shared with another still-open
  // window/row is merely left running for that other subscriber.
  useEffect(() => () => {
    Object.keys(jobTaskRef.current).forEach((id) => jobTaskRef.current[id]?.cancel());
    Object.values(debounceTimersRef.current).forEach((t) => clearTimeout(t));
    Object.keys(backgroundUnsubscribersRef.current).forEach((id) => stopListeningForBackgroundExact(id, id));
  }, [stopListeningForBackgroundExact]);

  // AnglePlotPanel reports every zoom/pan/resize here, undebounced. Every
  // currently visible row gets a debounced re-render, since the adaptive
  // sampler's stride and sampled cells both depend on the current viewport.
  const handleViewChange = useCallback((viewState) => {
    lastViewStateRef.current = viewState;
    // Workspace persistence: AnglePlotPanel's onViewChange reports its own
    // raw zoom/pan alongside the derived zoomLevel/bounds it always has, so
    // this can just take them directly instead of reconstructing anything.
    panelViewRef.current = { panelZoom: viewState.zoom, panelPan: viewState.pan };
    scheduleWorkspaceReport();
    for (const seq of sequencesRef.current) {
      if (!seq.visible) continue;
      const parsed = parseAngleStep(seq.angleStepInput);
      if (!parsed.valid) continue;
      // An EXACT row's geometry is the full-domain brute-force sweep, which
      // never depends on the viewport — scheduling an adaptive re-render for
      // one here would only ever recompute a worse (preview) approximation
      // of an answer this row already has permanently, so skip it. A row
      // still on PREVIEW keeps re-rendering on every pan/zoom exactly as
      // before, since what's tractable to compute there depends on what's
      // currently on screen.
      if (resultsRef.current[seq.id]?.renderInfo?.graphStatus === GRAPH_STATUS.EXACT) continue;
      scheduleRenderForSequence(seq, viewState);
    }
  }, [scheduleRenderForSequence, scheduleWorkspaceReport]);

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
          initialZoom={initialPanelZoom}
          initialPan={initialPanelPan}
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
