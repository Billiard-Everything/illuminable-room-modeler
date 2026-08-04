// useLocalGraphDatabase: all the state management for the Graph Database
// browser — search/sort inputs, the current results page, the selected
// graph's detail (metadata + notes, fetched once on selection), and every
// librarian action (rename, favorite, tags, notes, delete, load, duplicate).
// Mirrors useGraphLibrary.js's own split of concerns: this file owns state,
// GraphDatabasePanel.jsx/GraphDatabaseCard.jsx own rendering, and every
// actual network call goes through localGraphDatabaseClient.js.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchLocalGraphLibraryPage, fetchLocalGraphDetails,
  updateLocalGraphMetadata, deleteLocalGraph,
} from '../anglePlot/localGraphDatabaseClient.js';
import { graphCache } from '../anglePlot/graphCache.js';
import { LOCAL_GRAPH_SORT } from './localGraphDatabaseConstants.js';

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 30;
// A deliberate user click ("Load Graph"/"Duplicate") deserves more patience
// than AnglePlotWindow.jsx's own 600ms render-pipeline gate — see
// remoteGraphRepository.js's own identical reasoning for its LIBRARY_TIMEOUT_MS.
const LOAD_GRAPH_TIMEOUT_MS = 8000;

/**
 * @param {object} args
 * @param {boolean} args.isOpen - only fetches while the panel is actually open.
 * @param {(graph: object, geometry: {points: Array, durationMs: number|null}) => void} args.onLoadGraph
 *   Called once a graph's geometry is available (from GraphCache or a fresh
 *   fetch) after "Load Graph" or "Duplicate" — see GraphDatabasePanel.jsx
 *   and App.jsx's handleLoadGraphFromDatabase for what happens next.
 */
export const useLocalGraphDatabase = ({ isOpen, onLoadGraph }) => {
  // --- Search / sort inputs --------------------------------------------
  const [searchText, setSearchText] = useState('');
  const [angleAFilter, setAngleAFilter] = useState('');
  const [angleBFilter, setAngleBFilter] = useState('');
  const [baseLengthFilter, setBaseLengthFilter] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sort, setSort] = useState(LOCAL_GRAPH_SORT.NEWEST);

  // --- Results page ---------------------------------------------------------
  const [graphs, setGraphs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  // --- Selection / detail (metadata + notes + geometry, fetched together) --
  const [selectedGraph, setSelectedGraph] = useState(null);
  const [selectedDetails, setSelectedDetails] = useState(null); // {points, durationMs, notes}
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState(false);

  // --- Librarian action state (rename/favorite/tags/notes/delete) ----------
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Guards against a slow, superseded fetch overwriting a newer one's
  // results — same requestId pattern useGraphLibrary.js/AnglePlotWindow.jsx
  // already establish elsewhere in this codebase.
  const requestIdRef = useRef(0);
  const detailsRequestIdRef = useRef(0);

  const buildQuery = useCallback(() => {
    const search = {};
    const trimmed = searchText.trim();
    // `text` searches across title/code/tags/notes/owner/hash all at once
    // (see graphDatabase.js's own searchGraphs comment) — the one search
    // box's whole point, as opposed to the separate Angle A/B/Base Length
    // number filters below, which stay exact-field.
    if (trimmed) search.text = trimmed;
    if (angleAFilter !== '') search.angleA = angleAFilter;
    if (angleBFilter !== '') search.angleB = angleBFilter;
    if (baseLengthFilter !== '') search.baseLength = baseLengthFilter;
    if (favoritesOnly) search.favorite = true;
    return search;
  }, [searchText, angleAFilter, angleBFilter, baseLengthFilter, favoritesOnly]);

  const runFetch = useCallback(async (nextOffset, append) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(false);
    const search = buildQuery();
    const result = await fetchLocalGraphLibraryPage({ sort, limit: PAGE_SIZE, offset: nextOffset, search });
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
  }, [isOpen, sort, searchText, angleAFilter, angleBFilter, baseLengthFilter, favoritesOnly]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return;
    runFetch(offset + PAGE_SIZE, true);
  }, [loading, hasMore, offset, runFetch]);

  const refresh = useCallback(() => runFetch(0, false), [runFetch]);

  // Selecting a card fetches its notes+geometry once (see
  // fetchLocalGraphDetails's own comment on why this differs from
  // fetchLocalExactGraph) — "Load Graph"/"Duplicate" then reuse whatever
  // this already fetched instead of asking again.
  const selectGraph = useCallback((graph) => {
    setSelectedGraph(graph);
    setSelectedDetails(null);
    setDetailsError(false);
    setMetadataError(false);
    const requestId = ++detailsRequestIdRef.current;
    setLoadingDetails(true);
    fetchLocalGraphDetails(graph.hash, { timeoutMs: LOAD_GRAPH_TIMEOUT_MS }).then((details) => {
      if (requestId !== detailsRequestIdRef.current) return;
      setLoadingDetails(false);
      if (!details) { setDetailsError(true); return; }
      setSelectedDetails(details);
    });
  }, []);

  // Shared by "Load Graph" (the selected card's own detail-pane button) and
  // "Duplicate" (a one-click action directly on any card, selected or not,
  // or a double-click to "instantly open") — both ultimately do the same
  // thing: hand this graph's metadata + geometry to onLoadGraph, which
  // always inserts a brand new row (see App.jsx's handleLoadGraphFromDatabase)
  // — "Duplicate" is simply the quick, no-selection-required way to reach
  // that same action. `closePanel` distinguishes the two intents for
  // onLoadGraph's own third argument: the explicit "Load Graph" button
  // means "I'm done browsing," so it closes the panel; a quick "Duplicate"
  // click is meant to be repeatable while still browsing, so it doesn't.
  const loadGraphIntoSession = useCallback(async (graph, details, closePanel) => {
    // GraphCache reuse (this feature's own "avoid duplicate fetches"): if
    // this exact hash was already plotted/loaded this session, GraphCache
    // already has it — see AnglePlotWindow.jsx's own STEP 2 for the
    // identical rule this mirrors.
    const cached = graphCache.get(graph.hash);
    if (cached) {
      onLoadGraph(graph, { points: cached.points, durationMs: cached.renderInfo?.durationMs ?? null }, { closePanel });
      return true;
    }
    if (details) {
      onLoadGraph(graph, { points: details.points, durationMs: details.durationMs }, { closePanel });
      return true;
    }
    const fetched = await fetchLocalGraphDetails(graph.hash, { timeoutMs: LOAD_GRAPH_TIMEOUT_MS });
    if (!fetched) return false;
    onLoadGraph(graph, { points: fetched.points, durationMs: fetched.durationMs }, { closePanel });
    return true;
  }, [onLoadGraph]);

  const loadSelectedGraph = useCallback(async () => {
    if (!selectedGraph) return;
    setDetailsError(false);
    const ok = await loadGraphIntoSession(selectedGraph, selectedDetails, true);
    if (!ok) setDetailsError(true);
  }, [selectedGraph, selectedDetails, loadGraphIntoSession]);

  // "Duplicate" on any card in the list, independent of selection — always
  // fetches fresh (a duplicated card is rarely the one already selected,
  // so there's usually nothing cached to reuse here beyond GraphCache).
  const duplicateGraph = useCallback((graph) => loadGraphIntoSession(graph, null, false), [loadGraphIntoSession]);

  // Applies a successful metadata update to both the results list and the
  // selected-graph detail state, so the UI reflects it immediately without
  // needing a full refresh — a rename/favorite-toggle/tag-edit is a small,
  // local change, not a reason to re-run the whole search.
  const applyMetadataUpdate = useCallback((hash, updatedMetadata) => {
    setGraphs((prev) => prev.map((g) => (g.hash === hash ? { ...g, ...updatedMetadata } : g)));
    setSelectedGraph((prev) => (prev?.hash === hash ? { ...prev, ...updatedMetadata } : prev));
  }, []);

  const saveMetadata = useCallback(async (hash, updates) => {
    setSavingMetadata(true);
    setMetadataError(false);
    const result = await updateLocalGraphMetadata(hash, updates);
    setSavingMetadata(false);
    if (!result.ok) { setMetadataError(true); return false; }
    applyMetadataUpdate(hash, result.metadata);
    if (updates.notes !== undefined) setSelectedDetails((prev) => (prev ? { ...prev, notes: updates.notes } : prev));
    return true;
  }, [applyMetadataUpdate]);

  const renameGraph = useCallback((hash, title) => saveMetadata(hash, { title }), [saveMetadata]);
  const toggleFavorite = useCallback((graph) => saveMetadata(graph.hash, { favorite: !graph.favorite }), [saveMetadata]);
  const updateTags = useCallback((hash, tags) => saveMetadata(hash, { tags }), [saveMetadata]);
  const updateNotes = useCallback((hash, notes) => saveMetadata(hash, { notes }), [saveMetadata]);

  const removeGraph = useCallback(async (hash) => {
    setDeleting(true);
    const ok = await deleteLocalGraph(hash);
    setDeleting(false);
    if (!ok) return false;
    setGraphs((prev) => prev.filter((g) => g.hash !== hash));
    setSelectedGraph((prev) => (prev?.hash === hash ? null : prev));
    setSelectedDetails((prev) => (selectedGraph?.hash === hash ? null : prev));
    return true;
  }, [selectedGraph]);

  return {
    searchText, setSearchText,
    angleAFilter, setAngleAFilter,
    angleBFilter, setAngleBFilter,
    baseLengthFilter, setBaseLengthFilter,
    favoritesOnly, setFavoritesOnly,
    sort, setSort,
    graphs, loading, error, hasMore, loadMore, refresh,
    selectedGraph, selectedDetails, loadingDetails, detailsError, selectGraph,
    loadSelectedGraph, duplicateGraph,
    savingMetadata, metadataError, renameGraph, toggleFavorite, updateTags, updateNotes,
    deleting, removeGraph,
  };
};
