import { useState } from 'react';
import { X, Database, Search, RefreshCw, Loader2, AlertTriangle, Download, Star, Trash2, Copy } from 'lucide-react';
import { useLocalGraphDatabase } from './useLocalGraphDatabase.js';
import GraphDatabaseCard from './GraphDatabaseCard.jsx';
import { LOCAL_GRAPH_SORT, LOCAL_GRAPH_SORT_LABELS } from './localGraphDatabaseConstants.js';

// GraphDatabasePanel: the "true graph database browser" for the local,
// file-based GraphDatabase (server/graphDatabase/**) — search/sort/rename/
// delete/duplicate/favorite/tag/annotate every graph ever permanently
// cached on this machine, and load one back into the plotting system
// instantly (no recomputation — the whole point of a permanent,
// content-addressed cache). Modeled on GraphLibraryPanel.jsx's own
// centered-modal, list+detail shell, but for a genuinely different store:
// this one supports mutation (rename/delete/favorite/tags/notes) because
// it's a single-user local library, unlike the read-only, multi-user
// PostgreSQL-backed Graph Library sitting right next to it in the sidebar
// (you can't rename or delete a graph another user shared — see this
// panel's own non-goal there).
//
// This component owns no data-fetching or business logic itself — all of
// that lives in useLocalGraphDatabase.js (state management) and
// localGraphDatabaseClient.js (the actual API calls). This file is
// rendering only.
//
// `onLoadGraph(graph, geometry)` is the only way this component's world
// touches the rest of the app — see App.jsx's handleLoadGraphFromDatabase,
// which mirrors handleLoadGraphFromLibrary's own "insert a new row" logic.
export default function GraphDatabasePanel({ isOpen, onClose, onLoadGraph }) {
  const {
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
  } = useLocalGraphDatabase({ isOpen, onLoadGraph });

  // Local, draft-only editing state for the detail pane's title/tags/notes
  // fields — mirrors this app's own established "draft vs. applied" pattern
  // (sequenceGraphConfig.js) so mid-typing keystrokes never fire a network
  // request; a save only happens on blur/Enter/an explicit button.
  const [titleDraft, setTitleDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [confirmingDeleteHash, setConfirmingDeleteHash] = useState(null);

  // Resets the title/tags drafts (React's documented "adjust state during
  // render" pattern — see AnglePlotPanel.jsx's own identical comment on why
  // an effect is wrong here: the reset must land before this render's own
  // paint, not one render late) whenever a *different* graph is selected.
  // Keyed on hash, not the whole object, so a live metadata echo from this
  // same panel's own rename/tag actions (which mutates selectedGraph in
  // place without changing its hash — see useLocalGraphDatabase.js's
  // applyMetadataUpdate) never clobbers an in-progress edit.
  const [resetKey, setResetKey] = useState(selectedGraph?.hash ?? null);
  if ((selectedGraph?.hash ?? null) !== resetKey) {
    setResetKey(selectedGraph?.hash ?? null);
    setTitleDraft(selectedGraph?.title ?? '');
    setTagsDraft((selectedGraph?.tags ?? []).join(', '));
    setConfirmingDeleteHash(null);
  }

  // notesDraft resets separately, keyed on selectedDetails' own object
  // identity rather than its .notes text: notes only becomes available
  // one render after selection (once fetchLocalGraphDetails resolves), and
  // a successful updateNotes save also replaces selectedDetails with a new
  // object (see useLocalGraphDatabase.js's saveMetadata) — comparing by
  // identity catches both "a new graph was selected" and "this graph's
  // notes just saved" without needing two separate keys, and never
  // clobbers an in-progress edit the moment nothing has actually changed.
  const [notesResetKey, setNotesResetKey] = useState(selectedDetails);
  if (selectedDetails !== notesResetKey) {
    setNotesResetKey(selectedDetails);
    setNotesDraft(selectedDetails?.notes ?? '');
  }

  if (!isOpen) return null;

  const hasActiveQuery = Boolean(searchText.trim() || angleAFilter !== '' || angleBFilter !== '' || baseLengthFilter !== '' || favoritesOnly);
  const fieldClass = 'bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/50';

  const commitTitle = () => {
    if (!selectedGraph || titleDraft === selectedGraph.title) return;
    renameGraph(selectedGraph.hash, titleDraft);
  };
  const commitTags = () => {
    if (!selectedGraph) return;
    const parsed = tagsDraft.split(',').map((t) => t.trim()).filter(Boolean);
    updateTags(selectedGraph.hash, parsed);
  };
  const commitNotes = () => {
    if (!selectedGraph || notesDraft === (selectedDetails?.notes ?? '')) return;
    updateNotes(selectedGraph.hash, notesDraft);
  };

  const handleDelete = async (graph) => {
    if (confirmingDeleteHash !== graph.hash) {
      setConfirmingDeleteHash(graph.hash);
      return;
    }
    await removeGraph(graph.hash);
    setConfirmingDeleteHash(null);
  };

  return (
    <div
      className="fixed inset-0 z-[83] flex items-center justify-center bg-black/55 p-4"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-database-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-full max-w-5xl max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#151c24] shadow-[0_24px_80px_rgba(0,0,0,0.62)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4 shrink-0">
          <div>
            <h2 id="graph-database-title" className="flex items-center gap-2 text-sm font-bold text-cyan-100">
              <Database className="h-4 w-4" /> Graph Database
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Every graph ever permanently cached on this machine — search, sort, rename, tag, favorite, annotate, or load instantly with no recomputation.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Graph Database"
            title="Close Graph Database"
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
              placeholder="Search by title, code, tags, notes, owner, or hash…"
              aria-label="Search by title, code, tags, notes, owner, or hash"
              className="w-full bg-transparent text-xs font-mono text-slate-100 outline-none placeholder:text-slate-600"
            />
          </label>
          <input type="number" value={angleAFilter} onChange={(e) => setAngleAFilter(e.target.value)} placeholder="Angle A" aria-label="Filter by Angle A" className={`w-20 ${fieldClass}`} />
          <input type="number" value={angleBFilter} onChange={(e) => setAngleBFilter(e.target.value)} placeholder="Angle B" aria-label="Filter by Angle B" className={`w-20 ${fieldClass}`} />
          <input type="number" value={baseLengthFilter} onChange={(e) => setBaseLengthFilter(e.target.value)} placeholder="Base Length" aria-label="Filter by Base Length" className={`w-24 ${fieldClass}`} />
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <input type="checkbox" checked={favoritesOnly} onChange={(e) => setFavoritesOnly(e.target.checked)} className="accent-amber-400" />
            <Star className="w-3.5 h-3.5" /> Favorites
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort graphs by" className={fieldClass}>
            {Object.values(LOCAL_GRAPH_SORT).map((value) => (
              <option key={value} value={value}>{LOCAL_GRAPH_SORT_LABELS[value]}</option>
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

        {/* Grid (left) + detail pane (right). */}
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
                <span>Couldn&rsquo;t reach the local Graph Database.</span>
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
                  : 'Nothing has been permanently cached yet. Plot and fully compute a graph to add the first one.'}
              </div>
            )}
            {graphs.map((graph) => (
              <GraphDatabaseCard
                key={graph.hash}
                graph={graph}
                isSelected={selectedGraph?.hash === graph.hash}
                onSelect={selectGraph}
                onOpen={duplicateGraph}
                onToggleFavorite={toggleFavorite}
                onDuplicate={duplicateGraph}
                onDelete={handleDelete}
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

                <label className="block mb-3">
                  <span className="text-[11px] text-slate-500">Title</span>
                  <input
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    placeholder="(untitled)"
                    aria-label="Graph title"
                    className="mt-1 w-full bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs font-bold text-slate-100 outline-none focus:border-cyan-300/50 placeholder:text-slate-600 placeholder:font-normal"
                  />
                </label>

                <dl className="space-y-2.5 text-xs">
                  <div>
                    <dt className="text-slate-500 mb-0.5">Code Sequence</dt>
                    <dd className="text-slate-100 font-mono break-all">{selectedGraph.codeSequence || '(empty)'}</dd>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div><dt className="text-slate-500">Angle A</dt><dd className="text-slate-100 font-mono">{selectedGraph.angleA}</dd></div>
                    <div><dt className="text-slate-500">Angle B</dt><dd className="text-slate-100 font-mono">{selectedGraph.angleB}</dd></div>
                    <div><dt className="text-slate-500">Angle Step</dt><dd className="text-slate-100 font-mono">{selectedGraph.angleStep}</dd></div>
                    <div><dt className="text-slate-500">Base Length</dt><dd className="text-slate-100 font-mono">{selectedGraph.baseLength}</dd></div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><dt className="text-slate-500">Point Count</dt><dd className="text-slate-100 font-mono">{selectedGraph.pointCount.toLocaleString()}</dd></div>
                    <div><dt className="text-slate-500">Compute Time</dt><dd className="text-slate-100 font-mono">{selectedGraph.computeTimeMs != null ? `${Math.round(selectedGraph.computeTimeMs)} ms` : '—'}</dd></div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><dt className="text-slate-500">Created</dt><dd className="text-slate-100 font-mono">{new Date(selectedGraph.createdAt).toLocaleString()}</dd></div>
                    <div><dt className="text-slate-500">Modified</dt><dd className="text-slate-100 font-mono">{new Date(selectedGraph.modifiedAt).toLocaleString()}</dd></div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><dt className="text-slate-500">Owner</dt><dd className="text-slate-100 font-mono">{selectedGraph.author || '—'}</dd></div>
                    <div><dt className="text-slate-500">Visibility</dt><dd className="text-slate-100 font-mono capitalize">{selectedGraph.visibility}</dd></div>
                  </div>
                  <div>
                    <dt className="text-slate-500">Hash</dt>
                    <dd className="text-slate-600 font-mono text-[10px] break-all">{selectedGraph.hash}</dd>
                  </div>
                </dl>

                <label className="block mt-3">
                  <span className="text-[11px] text-slate-500">Tags (comma-separated)</span>
                  <input
                    type="text"
                    value={tagsDraft}
                    onChange={(e) => setTagsDraft(e.target.value)}
                    onBlur={commitTags}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    placeholder="e.g. favorites, homework, chapter-3"
                    aria-label="Graph tags, comma-separated"
                    className="mt-1 w-full bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs font-mono text-slate-100 outline-none focus:border-cyan-300/50 placeholder:text-slate-600"
                  />
                </label>

                <label className="block mt-3">
                  <span className="text-[11px] text-slate-500">Notes</span>
                  <textarea
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    onBlur={commitNotes}
                    rows={4}
                    placeholder="Free-form notes about this graph…"
                    aria-label="Graph notes"
                    className="mt-1 w-full bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-300/50 placeholder:text-slate-600 resize-y"
                  />
                </label>

                {metadataError && (
                  <p className="mt-2 text-[11px] text-red-300">Couldn&rsquo;t save that change — the local Graph Database may be unavailable right now.</p>
                )}
                {savingMetadata && (
                  <p className="mt-2 flex items-center gap-1 text-[11px] text-slate-500"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</p>
                )}

                {detailsError && (
                  <p className="mt-3 text-[11px] text-red-300">Couldn&rsquo;t load this graph&rsquo;s geometry. It may be unavailable right now — try again.</p>
                )}

                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleFavorite(selectedGraph)}
                    aria-pressed={selectedGraph.favorite}
                    aria-label={selectedGraph.favorite ? 'Unfavorite this graph' : 'Favorite this graph'}
                    title={selectedGraph.favorite ? 'Unfavorite' : 'Favorite'}
                    className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                      selectedGraph.favorite
                        ? 'border-amber-400/40 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
                        : 'border-white/10 bg-[#0b1016] text-slate-300 hover:bg-[#172230]'
                    }`}
                  >
                    <Star className="w-3.5 h-3.5" fill={selectedGraph.favorite ? 'currentColor' : 'none'} />
                  </button>
                  <button
                    type="button"
                    onClick={() => duplicateGraph(selectedGraph)}
                    aria-label="Duplicate this graph into a new graph"
                    title="Duplicate into a new graph"
                    className="flex items-center justify-center gap-1.5 rounded-md border border-white/10 bg-[#0b1016] px-3 py-2 text-xs font-bold text-slate-300 transition-colors hover:bg-[#172230]"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(selectedGraph)}
                    disabled={deleting}
                    title={confirmingDeleteHash === selectedGraph.hash ? 'Click again to confirm delete' : 'Delete'}
                    className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-bold transition-colors disabled:opacity-40 ${
                      confirmingDeleteHash === selectedGraph.hash
                        ? 'border-red-400/50 bg-red-500/25 text-red-100 hover:bg-red-500/35'
                        : 'border-white/10 bg-[#0b1016] text-slate-300 hover:bg-[#172230]'
                    }`}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> {confirmingDeleteHash === selectedGraph.hash ? 'Confirm Delete' : 'Delete'}
                  </button>
                  <button
                    type="button"
                    onClick={loadSelectedGraph}
                    disabled={loadingDetails}
                    title="Load this graph into the plot"
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-md border border-cyan-300/40 bg-cyan-500/20 px-3 py-2 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {loadingDetails ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    {loadingDetails ? 'Loading…' : 'Load Graph'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
