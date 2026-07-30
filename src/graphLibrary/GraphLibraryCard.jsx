import { CheckCircle2, Circle, Download } from 'lucide-react';
import { truncateSequenceText } from '../sequences/sequenceGraphConfig.js';

// One row in the Graph Library's list — metadata only, exactly what the
// browse/search API already returns (never geometry, see
// GraphLibraryPanel.jsx's own comment on why). A pure, presentational
// component: all interaction is a single `onSelect` callback.
export default function GraphLibraryCard({ graph, isSelected, onSelect }) {
  const { params, algorithmVersion, createdAt, downloadCount, hasExactGeometry, ownerUserId, pointCount } = graph;

  return (
    <button
      type="button"
      onClick={() => onSelect(graph)}
      aria-pressed={isSelected}
      className={`w-full text-left rounded-md border px-2.5 py-2 transition-colors ${
        isSelected ? 'border-cyan-300/50 bg-cyan-400/10' : 'border-white/10 bg-[#0b1016] hover:border-white/20'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        {hasExactGeometry ? (
          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" aria-label="Exact graph" />
        ) : (
          <Circle className="w-3 h-3 text-slate-600 shrink-0" aria-label="Not yet exact" />
        )}
        <span className="text-[11px] font-mono text-slate-200 truncate flex-1" title={params.sequenceText}>
          {truncateSequenceText(params.sequenceText, 24)}
        </span>
        {downloadCount > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-slate-500 shrink-0" title={`Downloaded ${downloadCount} time${downloadCount === 1 ? '' : 's'}`}>
            <Download className="w-2.5 h-2.5" /> {downloadCount}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-mono text-slate-500">
        <span>A {params.angleA}</span>
        <span>B {params.angleB}</span>
        <span>Len {params.baseLength}</span>
        <span>Alg v{algorithmVersion}</span>
        <span>{pointCount.toLocaleString()} pts</span>
        {ownerUserId && <span>Owner {ownerUserId}</span>}
        <span className="text-slate-600 ml-auto">{new Date(createdAt).toLocaleDateString()}</span>
      </div>
    </button>
  );
}
