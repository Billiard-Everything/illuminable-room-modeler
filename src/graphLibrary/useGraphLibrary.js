// useGraphLibrary: all the state management for the Graph Library panel —
// search/sort/filter inputs, the current results page, loading/error
// state, the selected graph, and the "Load Graph" action's own async
// state. Deliberately separate from GraphLibraryPanel.jsx (the rendering)
// and remoteGraphRepository.js (the actual fetch calls), per this
// feature's own "separate UI / API calls / state management / rendering"
// requirement.
//
// Every network call goes through remoteGraphRepository.js — this hook
// builds query objects and reacts to results, never constructs a URL or
// touches `fetch` itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGraphLibraryPage, fetchRemoteExactGraph } from '../anglePlot/remoteGraphRepository.js';
import { graphCache } from '../anglePlot/graphCache.js';
import { GRAPH_SORT, looksLikeGraphHash } from './graphLibraryConstants.js';

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 30;
// A deliberate user click ("Load Graph") deserves more patience than
// AnglePlotWindow.jsx's own 600ms render-pipeline gate — see
// remoteGraphRepository.js's own comment on why that timeout is so short.
const LOAD_GRAPH_TIMEOUT_MS = 8000;

/**
 * @param {object} args
 * @param {boolean} args.isOpen - only fetches while the panel is actually open.
 * @param {(graph: object, geometry: {points: Array, durationMs: number|null}) => void} args.onLoadGraph
 *   Called once a graph's geometry is available (from GraphCache or a
 *   fresh download) after the user presses "Load Graph" — see
 *   GraphLibraryPanel.jsx and App.jsx's handleLoadGraphFromLibrary for what
 *   happens next (inserting it into the existing plotting system).
 */
export const useGraphLibrary = ({ isOpen, onLoadGraph }) => {
  // --- Search / sort / filter inputs --------------------------------------
  const [searchText, setSearchText] = useState('');
  const [angleAFilter, setAngleAFilter] = useState('');
  const [angleBFilter, setAngleBFilter] = useState('');
  const [baseLengthFilter, setBaseLengthFilter] = useState('');
  const [sort, setSort] = useState(GRAPH_SORT.NEWEST);
  const [onlyExactGraphs, setOnlyExactGraphs] = useState(false);
  const [algorithmVersionFilter, setAlgorithmVersionFilter] = useState('');
  const [createdAfter, setCreatedAfter] = useState('');
  const [createdBefore, setCreatedBefore] = useState('');

  // --- Results page ---------------------------------------------------------
  const [graphs, setGraphs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  // --- Selection / load-graph action ---------------------------------------
  const [selectedGraph, setSelectedGraph] = useState(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Guards against a slow, superseded fetch overwriting a newer one's
  // results — the same requestId pattern AnglePlotWindow.jsx's own job
  // scheduling already establishes elsewhere in this codebase.
  const requestIdRef = useRef(0);

  const buildQuery = useCallback(() => {
    const search = {};
    const trimmed = searchText.trim();
    if (trimmed) {
      if (looksLikeGraphHash(trimmed)) search.hash = trimmed;
      else search.code = trimmed;
    }
    if (angleAFilter !== '') search.angleA = angleAFilter;
    if (angleBFilter !== '') search.angleB = angleBFilter;
    if (baseLengthFilter !== '') search.baseLength = baseLengthFilter;

    const filters = {};
    if (onlyExactGraphs) filters.onlyExactGraphs = true;
    if (algorithmVersionFilter !== '') filters.algorithmVersion = algorithmVersionFilter;
    if (createdAfter) filters.createdAfter = createdAfter;
    if (createdBefore) filters.createdBefore = createdBefore;

    return { search, filters };
  }, [searchText, angleAFilter, angleBFilter, baseLengthFilter, onlyExactGraphs, algorithmVersionFilter, createdAfter, createdBefore]);

  const runFetch = useCallback(async (nextOffset, append) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(false);
    const { search, filters } = buildQuery();
    const result = await fetchGraphLibraryPage({ sort, limit: PAGE_SIZE, offset: nextOffset, search, filters });
    if (requestId !== requestIdRef.current) return; // superseded by a newer request while this one was in flight
    setLoading(false);
    if (result.error) {
      setError(true);
      if (!append) setGraphs([]);
      return;
    }
    setGraphs((prev) => (append ? [...prev, ...result.graphs] : result.graphs));
    setHasMore(result.graphs.length === PAGE_SIZE);
    setOffset(nextOffset);
  }, [sort, buildQuery]);

  // Debounced re-fetch (fresh, offset 0) whenever the query changes, and an
  // immediate fetch the moment the panel opens.
  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = setTimeout(() => { runFetch(0, false); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sort, searchText, angleAFilter, angleBFilter, baseLengthFilter, onlyExactGraphs, algorithmVersionFilter, createdAfter, createdBefore]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return;
    runFetch(offset + PAGE_SIZE, true);
  }, [loading, hasMore, offset, runFetch]);

  const refresh = useCallback(() => runFetch(0, false), [runFetch]);

  const selectGraph = useCallback((graph) => {
    setSelectedGraph(graph);
    setLoadError(false);
  }, []);

  const loadSelectedGraph = useCallback(async () => {
    if (!selectedGraph) return;
    // Local-cache reuse (this feature's own "avoid duplicate downloads"):
    // if this exact graph was already plotted (or already loaded) this
    // session, GraphCache already has it under this same hash — see
    // AnglePlotWindow.jsx's own STEP 2 for the identical rule this mirrors.
    const cached = graphCache.get(selectedGraph.hash);
    if (cached) {
      onLoadGraph(selectedGraph, { points: cached.points, durationMs: cached.renderInfo?.durationMs ?? null });
      return;
    }
    setLoadingSelected(true);
    setLoadError(false);
    const geometry = await fetchRemoteExactGraph(selectedGraph.hash, { timeoutMs: LOAD_GRAPH_TIMEOUT_MS });
    setLoadingSelected(false);
    if (!geometry) {
      setLoadError(true);
      return;
    }
    onLoadGraph(selectedGraph, geometry);
  }, [selectedGraph, onLoadGraph]);

  return {
    searchText, setSearchText,
    angleAFilter, setAngleAFilter,
    angleBFilter, setAngleBFilter,
    baseLengthFilter, setBaseLengthFilter,
    sort, setSort,
    onlyExactGraphs, setOnlyExactGraphs,
    algorithmVersionFilter, setAlgorithmVersionFilter,
    createdAfter, setCreatedAfter,
    createdBefore, setCreatedBefore,
    graphs, loading, error, hasMore, loadMore, refresh,
    selectedGraph, selectGraph,
    loadingSelected, loadError, loadSelectedGraph,
  };
};
