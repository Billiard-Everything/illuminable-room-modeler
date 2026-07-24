import { Copy, Eye, EyeOff, Plus, ScatterChart, Trash2, X } from 'lucide-react';
import { isExactModeStep, parseAngleStep } from '../anglePlot/angleStep.js';

// GraphSetupWindow is an additive editor for the existing sequence rows. It
// deliberately owns no graph or geometry state: every field delegates to the
// same App.jsx row handlers used by the sidebar and AnglePlotWindow. Keeping
// this as a view-only layer prevents a second configuration model from
// drifting away from the renderer or the unfolding validator.
export default function GraphSetupWindow({
  sequences,
  activeSequenceId,
  onAdd,
  onDuplicate,
  onRemove,
  onSelect,
  onToggleVisible,
  onColorChange,
  onAngleChange,
  onAngleIncrementChange,
  onAngleStepChange,
  onDraftChange,
  onApplyDraft,
  onCancelDraft,
  onClose,
  onOpenPlot,
}) {
  const handleKeyDown = (event, id, anglesIncomplete) => {
    // Keep the same commit/cancel semantics as the sidebar's sequence input.
    if (anglesIncomplete) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onApplyDraft(id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancelDraft(id);
      event.currentTarget.blur();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-setup-title"
        onMouseDown={event => event.stopPropagation()}
        className="flex w-full max-w-4xl max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#151c24] shadow-[0_24px_80px_rgba(0,0,0,0.62)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <h2 id="graph-setup-title" className="flex items-center gap-2 text-sm font-bold text-cyan-100">
              <ScatterChart className="h-4 w-4" /> Graph Setup
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Configure each plotted graph in one place. The selected graph remains the unfolding shown on the main canvas.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Graph Setup"
            title="Close Graph Setup"
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-red-200"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar">
          <div className="grid gap-3 md:grid-cols-2">
            {sequences.map((row) => {
              const isActive = row.id === activeSequenceId;
              const anglesIncomplete = row.angleA === '' || row.angleB === '';
              const parsedStep = parseAngleStep(row.angleStepInput);
              const modeLabel = parsedStep.valid
                ? (isExactModeStep(parsedStep.scale, parsedStep.stepUnits) ? 'Exact' : 'Adaptive')
                : 'Invalid step';

              return (
                <article
                  key={row.id}
                  className={`rounded-lg border p-3 transition-colors ${isActive ? 'border-cyan-300/55 bg-cyan-400/10' : 'border-white/10 bg-[#0b1016]'}`}
                >
                  <div className="mb-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect(row.id)}
                      className={`min-w-0 flex-1 truncate text-left text-sm font-bold ${isActive ? 'text-cyan-100' : 'text-slate-200'}`}
                      title={`Make ${row.label} the active unfolding`}
                    >
                      {row.label}{isActive ? ' — active' : ''}
                    </button>
                    <input
                      type="color"
                      value={row.color}
                      onChange={event => onColorChange(row.id, event.target.value)}
                      aria-label={`${row.label} graph color`}
                      title={`Choose ${row.label}'s graph color`}
                      className="h-5 w-5 shrink-0 cursor-pointer appearance-none overflow-hidden rounded-full border border-black/30 bg-transparent p-0"
                    />
                    <button
                      type="button"
                      onClick={() => onToggleVisible(row.id)}
                      aria-pressed={row.visible}
                      aria-label={`${row.visible ? 'Hide' : 'Show'} ${row.label} in the graph`}
                      title={row.visible ? 'Visible in plot' : 'Hidden from plot'}
                      className="rounded p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-cyan-100"
                    >
                      {row.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDuplicate(row.id)}
                      aria-label={`Duplicate ${row.label}`}
                      title={`Duplicate ${row.label}`}
                      className="rounded p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-cyan-100"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(row.id)}
                      aria-label={`Delete ${row.label}`}
                      title={`Delete ${row.label}`}
                      className="rounded p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-red-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Angle A</span>
                      <input
                        type="number"
                        step={row.angleIncrementInput || 'any'}
                        value={row.angleA}
                        onFocus={() => onSelect(row.id)}
                        onChange={event => onAngleChange(row.id, 'a', event.target.value)}
                        placeholder="e.g. 15"
                        className="w-full rounded-md border border-white/10 bg-[#080b0f] px-2 py-1.5 font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/60"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Angle B</span>
                      <input
                        type="number"
                        step={row.angleIncrementInput || 'any'}
                        value={row.angleB}
                        onFocus={() => onSelect(row.id)}
                        onChange={event => onAngleChange(row.id, 'b', event.target.value)}
                        placeholder="e.g. 50"
                        className="w-full rounded-md border border-white/10 bg-[#080b0f] px-2 py-1.5 font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/60"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Angle Step</span>
                      <input
                        type="number"
                        min="0"
                        value={row.angleStepInput}
                        onChange={event => onAngleStepChange(row.id, event.target.value)}
                        placeholder="0.1"
                        className="w-full rounded-md border border-white/10 bg-[#080b0f] px-2 py-1.5 font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/60"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Angle Increment</span>
                      <input
                        type="number"
                        min="0"
                        value={row.angleIncrementInput}
                        onChange={event => onAngleIncrementChange(row.id, event.target.value)}
                        placeholder="0.1"
                        title="Changes this graph's Angle A and Angle B spinner-arrow increment only."
                        className="w-full rounded-md border border-white/10 bg-[#080b0f] px-2 py-1.5 font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/60"
                      />
                    </label>
                  </div>
                  <div className={`mt-1 text-[10px] ${parsedStep.valid ? 'text-slate-500' : 'text-red-300'}`}>
                    {parsedStep.valid ? `${modeLabel} sampling` : parsedStep.error}
                  </div>

                  <label className="mt-3 block">
                    <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Sequence Code</span>
                    <input
                      type="text"
                      value={row.draftSequenceText}
                      readOnly={anglesIncomplete}
                      onFocus={() => onSelect(row.id)}
                      onChange={event => onDraftChange(row.id, event.target.value)}
                      onKeyDown={event => handleKeyDown(event, row.id, anglesIncomplete)}
                      onBlur={() => { if (!anglesIncomplete) onApplyDraft(row.id); }}
                      placeholder={anglesIncomplete ? 'Set Angle A and B first' : 'e.g. 3 1 7 2 6'}
                      aria-disabled={anglesIncomplete}
                      title={anglesIncomplete ? 'Set both angles before entering the sequence code.' : 'Press Enter to apply or Escape to discard changes.'}
                      className={`w-full rounded-md border px-2 py-1.5 font-mono text-xs outline-none placeholder:text-slate-600 ${anglesIncomplete ? 'cursor-not-allowed border-white/5 bg-black/20 text-slate-600' : 'border-white/10 bg-[#080b0f] text-slate-100 focus:border-cyan-300/60'}`}
                    />
                  </label>
                  {anglesIncomplete && <p className="mt-1 text-[10px] text-amber-300">Set Angle A and Angle B to enable this graph’s code.</p>}
                  {row.validationError && <p className="mt-1 text-[10px] text-red-300">{row.validationError}</p>}
                </article>
              );
            })}
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={onAdd}
            className="graph-setup-add-button flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold shadow-sm transition-colors"
          >
            <Plus className="h-4 w-4" /> Add Graph
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-white/10 bg-[#0b1016] px-3 py-1.5 text-xs font-bold text-slate-300 transition-colors hover:bg-[#172230]">
              Close
            </button>
            <button type="button" onClick={onOpenPlot} className="flex items-center gap-1.5 rounded-md border border-cyan-300/45 bg-cyan-500/20 px-3 py-1.5 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-500/30">
              <ScatterChart className="h-4 w-4" /> Open / Refresh Plot
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
