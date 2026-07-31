import { Star, Copy, Trash2 } from 'lucide-react';
import { truncateSequenceText } from '../sequences/sequenceGraphConfig.js';

// One card in the Graph Database browser's grid — metadata only (never
// geometry, matching graphDatabase.js's own "listGraphs/searchGraphs never
// return points" rule). A pure, presentational component: selecting is one
// callback, and Favorite/Duplicate/Delete are three quick-action buttons
// that stop propagation so they never also select the card underneath them
// — heavier editing (rename, tags, notes) lives in the detail pane instead
// of cluttering every card in the grid (see GraphDatabasePanel.jsx).
export default function GraphDatabaseCard({ graph, isSelected, onSelect, onOpen, onToggleFavorite, onDuplicate, onDelete }) {
  const {
    title, codeSequence, angleA, angleB, angleStep, graphColorHex, pointCount, createdAt, modifiedAt, tags, favorite,
  } = graph;
  const displayTitle = title || truncateSequenceText(codeSequence, 28);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(graph)}
      onDoubleClick={() => onOpen(graph)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(graph); } }}
      aria-pressed={isSelected}
      title="Click to view details, double-click to open instantly"
      className={`w-full text-left rounded-md border px-2.5 py-2 cursor-pointer transition-colors ${
        isSelected ? 'border-cyan-300/50 bg-cyan-400/10' : 'border-white/10 bg-[#0b1016] hover:border-white/20'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0 border border-black/30"
          style={{ backgroundColor: graphColorHex || '#64748b' }}
          aria-hidden="true"
        />
        <span className="text-[11px] font-bold text-slate-100 truncate flex-1" title={displayTitle}>
          {displayTitle}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(graph); }}
          aria-label={favorite ? `Unfavorite ${displayTitle}` : `Favorite ${displayTitle}`}
          aria-pressed={favorite}
          title={favorite ? 'Unfavorite' : 'Favorite'}
          className={`shrink-0 rounded p-0.5 transition-colors ${favorite ? 'text-amber-300' : 'text-slate-600 hover:text-amber-300'}`}
        >
          <Star className="w-3.5 h-3.5" fill={favorite ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDuplicate(graph); }}
          aria-label={`Duplicate ${displayTitle} into a new graph`}
          title="Duplicate into a new graph"
          className="shrink-0 rounded p-0.5 text-slate-500 hover:text-cyan-200 transition-colors"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(graph); }}
          aria-label={`Delete ${displayTitle}`}
          title="Delete"
          className="shrink-0 rounded p-0.5 text-slate-500 hover:text-red-300 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="font-mono text-[10px] text-slate-500 truncate mb-1" title={codeSequence}>
        {truncateSequenceText(codeSequence, 40)}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-mono text-slate-500">
        <span>A {angleA}</span>
        <span>B {angleB}</span>
        <span>Step {angleStep}</span>
        <span>{pointCount.toLocaleString()} pts</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9.5px] text-slate-600 mt-0.5">
        <span title="Created">Created {new Date(createdAt).toLocaleDateString()}</span>
        {modifiedAt !== createdAt && <span title="Last modified">Modified {new Date(modifiedAt).toLocaleDateString()}</span>}
      </div>

      {tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {tags.map((tag) => (
            <span key={tag} className="rounded bg-white/5 px-1.5 py-0.5 text-[9.5px] text-slate-400">{tag}</span>
          ))}
        </div>
      )}
    </div>
  );
}
