import { X, Library, Search, RefreshCw, Loader2, AlertTriangle, Download } from 'lucide-react';
import { useGraphLibrary } from './useGraphLibrary.js';
import GraphLibraryCard from './GraphLibraryCard.jsx';
import { GRAPH_SORT, GRAPH_SORT_LABELS } from './graphLibraryConstants.js';

// GraphLibraryPanel: the "file explorer" for the shared graph library —
// browse/search/sort/filter every previously-computed graph's metadata,
// preview one, and load it into the existing plotting system. Modeled on
// GraphSetupWindow.jsx's own centered-modal shell (same backdrop/card/
// header conventions) since both are "manage/browse many graphs at once"
// experiences, unlike AnglePlotWindow's own movable floating-panel style,
// which is built for coexisting with active plotting instead.
//
// This component owns no data-fetching or business logic itself — all of
// that lives in useGraphLibrary.js (state management) and
// remoteGraphRepository.js (the actual API calls). This file is rendering
// only: search/filter/sort controls, the results list, and the selected
// graph's detail pane with its "Load Graph" button.
//
// `onLoadGraph(graph, geometry)` is called once geometry is available
// (from GraphCache or a fresh download — see useGraphLibrary's own
// loadSelectedGraph) and is the *only* way this component's world touches
// the rest of the app: App.jsx's implementation is what actually creates a
// new sequence row and inserts the graph into the existing plotting
// pipeline (see exactGraphCaching.js) — this panel never reaches into
// `sequences` state directly.
export default function GraphLibraryPanel({ isOpen, onClose, onLoadGraph }) {
  const {
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
  } = useGraphLibrary({ isOpen, onLoadGraph });

  if (!isOpen) return null;

  const hasActiveQuery = Boolean(
    searchText.trim() || angleAFilter !== '' || angleBFilter !== '' || baseLengthFilter !== ''
    || onlyExactGraphs || algorithmVersionFilter !== '' || createdAfter || createdBefore,
  );

  const fieldClass = 'bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50';

  return (
    <div
      className="fixed inset-0 z-[82] flex items-center justify-center bg-black/55 p-4"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-library-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-5xl max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#151c24] shadow-[0_24px_80px_rgba(0,0,0,0.62)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4 shrink-0">
          <div>
            <h2 id="graph-library-title" className="flex items-center gap-2 text-sm font-bold text-cyan-100">
              <Library className="h-4 w-4" /> Graph Library
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Browse, search, and instantly reuse graphs already computed and shared to the library.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Graph Library"
            title="Close Graph Library"
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-red-200"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Search + sort. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3 shrink-0">
          <label className="flex-1 min-w-[220px] flex items-center gap-1.5 bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 focus-within:border-cyan-300/50">
            <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search by code sequence or graph hash…"
              aria-label="Search by code sequence or graph hash"
              className="w-full bg-transparent text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600"
            />
          </label>
          <input type="number" value={angleAFilter} onChange={(e) => setAngleAFilter(e.target.value)} placeholder="Angle A" aria-label="Filter by Angle A" className={`w-20 ${fieldClass}`} />
          <input type="number" value={angleBFilter} onChange={(e) => setAngleBFilter(e.target.value)} placeholder="Angle B" aria-label="Filter by Angle B" className={`w-20 ${fieldClass}`} />
          <input type="number" value={baseLengthFilter} onChange={(e) => setBaseLengthFilter(e.target.value)} placeholder="Base Length" aria-label="Filter by Base Length" className={`w-24 ${fieldClass}`} />
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort graphs by" className={fieldClass}>
            {Object.values(GRAPH_SORT).map((value) => (
              <option key={value} value={value}>{GRAPH_SORT_LABELS[value]}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={refresh}
            title="Refresh"
            aria-label="Refresh"
            className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-cyan-200"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Filters — deliberately its own row so future filters (tags,
            favorites, permission scopes) each just add one more control
            here without needing to touch the search/sort row above. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-white/10 px-4 py-2 text-[11px] text-slate-400 shrink-0">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={onlyExactGraphs} onChange={(e) => setOnlyExactGraphs(e.target.checked)} className="accent-cyan-400" />
            Exact Graphs Only
          </label>
          <label className="flex items-center gap-1.5 text-slate-600 cursor-not-allowed" title="Requires user accounts — not implemented yet, this filter is reserved for a future phase.">
            <input type="checkbox" disabled className="accent-cyan-400" />
            My Graphs
          </label>
          <label className="flex items-center gap-1.5">
            Algorithm Version
            <input type="number" value={algorithmVersionFilter} onChange={(e) => setAlgorithmVersionFilter(e.target.value)} className="w-14 bg-[#0b1016] border border-white/10 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none" />
          </label>
          <label className="flex items-center gap-1.5">
            After
            <input type="date" value={createdAfter} onChange={(e) => setCreatedAfter(e.target.value)} className="bg-[#0b1016] border border-white/10 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none" />
          </label>
          <label className="flex items-center gap-1.5">
            Before
            <input type="date" value={createdBefore} onChange={(e) => setCreatedBefore(e.target.value)} className="bg-[#0b1016] border border-white/10 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-100 outline-none" />
          </label>
        </div>

        {/* List (left) + detail/preview pane (right). */}
        <div className="flex min-h-0 flex-1">
          <div className="w-1/2 min-h-0 overflow-y-auto custom-scrollbar border-r border-white/10 p-3 space-y-1.5">
            {loading && graphs.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading graphs…
              </div>
            )}
            {error && (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-xs text-amber-300">
                <AlertTriangle className="w-5 h-5" />
                <span>Couldn&rsquo;t reach the shared graph library.</span>
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded-md border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-500/20"
                >
                  Retry
                </button>
              </div>
            )}
            {!loading && !error && graphs.length === 0 && (
              <div className="py-10 text-center text-xs text-slate-500 leading-relaxed px-4">
                {hasActiveQuery
                  ? 'No graphs match your search.'
                  : 'The shared graph library is empty. Plot and compute a graph to add the first one.'}
              </div>
            )}
            {graphs.map((graph) => (
              <GraphLibraryCard
                key={graph.hash}
                graph={graph}
                isSelected={selectedGraph?.hash === graph.hash}
                onSelect={selectGraph}
              />
            ))}
            {hasMore && !error && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loading}
                className="w-full rounded-md border border-white/10 bg-[#0b1016] py-1.5 text-[11px] font-bold text-slate-300 transition-colors hover:bg-[#172230] disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Load More'}
              </button>
            )}
          </div>

          <div className="w-1/2 min-h-0 overflow-y-auto custom-scrollbar p-4">
            {!selectedGraph ? (
              <div className="flex h-full items-center justify-center text-center text-xs text-slate-500 px-6">
                Select a graph on the left to see its details.
              </div>
            ) : (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-200 mb-3">Graph Details</h3>
                <dl className="space-y-2.5 text-xs">
                  <div>
                    <dt className="text-slate-500 mb-0.5">Code Sequence</dt>
                    <dd className="text-slate-100 font-mono break-all">{selectedGraph.params.sequenceText || '(empty)'}</dd>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><dt className="text-slate-500">Angle A</dt><dd className="text-slate-100 font-mono">{selectedGraph.params.angleA}</dd></div>
                    <div><dt className="text-slate-500">Angle B</dt><dd className="text-slate-100 font-mono">{selectedGraph.params.angleB}</dd></div>
                    <div><dt className="text-slate-500">Base Length</dt><dd className="text-slate-100 font-mono">{selectedGraph.params.baseLength}</dd></div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><dt className="text-slate-500">Algorithm Version</dt><dd className="text-slate-100 font-mono">{selectedGraph.algorithmVersion}</dd></div>
                    <div><dt className="text-slate-500">Point Count</dt><dd className="text-slate-100 font-mono">{selectedGraph.pointCount.toLocaleString()}</dd></div>
                  </div>
                  <div>
                    <dt className="text-slate-500">Created</dt>
                    <dd className="text-slate-100 font-mono">{new Date(selectedGraph.createdAt).toLocaleString()}</dd>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><dt className="text-slate-500">Download Count</dt><dd className="text-slate-100 font-mono">{selectedGraph.downloadCount}</dd></div>
                    <div><dt className="text-slate-500">Exact Graph</dt><dd className="text-slate-100 font-mono">{selectedGraph.hasExactGeometry ? 'Yes' : 'No'}</dd></div>
                  </div>
                  <div>
                    <dt className="text-slate-500">Owner</dt>
                    <dd className="text-slate-100 font-mono">{selectedGraph.ownerUserId ?? 'Unowned'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Hash</dt>
                    <dd className="text-slate-600 font-mono text-[10px] break-all">{selectedGraph.hash}</dd>
                  </div>
                </dl>

                {loadError && (
                  <p className="mt-3 text-[11px] text-red-300">Couldn&rsquo;t load this graph&rsquo;s geometry. The shared library may be unavailable right now — try again.</p>
                )}

                <button
                  type="button"
                  onClick={loadSelectedGraph}
                  disabled={!selectedGraph.hasExactGeometry || loadingSelected}
                  title={!selectedGraph.hasExactGeometry ? 'This graph has no computed geometry yet' : 'Load this graph into the plot'}
                  className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md border border-cyan-300/40 bg-cyan-500/20 px-3 py-2 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {loadingSelected ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  {loadingSelected ? 'Loading…' : 'Load Graph'}
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
