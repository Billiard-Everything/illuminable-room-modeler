# Link to the Github Repository & the website
- Repo: https://github.com/Arthur7Li/illuminable-room-modeler
- Website: https://billiard-everything.github.io/illuminable-room-modeler/

# Unfolder

A React/Vite workbench for visualizing finite unfolded triangle poolshots. The app
builds a triangular room, reflects copies of it across sides, and displays either
a direct ray unfolding or a code-driven unfolding sequence.

This project is exploratory. It helps inspect finite unfoldings related to the
invisible-point conjecture documented in `PROJECT_WORKING_NOTES.md`; it is not a
proof-grade exact arithmetic validator.

## Features

- Dark interactive SVG viewer with pan, zoom, fit-to-screen, labels, and side
  annotations.
- Triangle input by coordinates or by two angles plus base length.
- Editable Angle A/B step size for fine or coarse number-stepper perturbations.
- Ray simulator from a selected vertex and angle.
- Code unfolder for whitespace-separated integer bounce-block counts.
- Graph Setup dialog for configuring every plotted graph's angles, A/B spinner
  increment, angle step, sequence code, color, and visibility without moving
  between sidebar sections.
- Constrained mode that rejects angle edits before they invalidate the current code-mode shot.
- Ghost mode that allows invalid shots, ghosts the unfolding, and colors the shot vector green/red by validity.
- Finite-poolshot tower validation with formal blue/red vertex roles, an all-vertex y-at-line check, and numeric fan bounds from the code blocks.
- Local stable-region search for symbolic `x` and `y` angle perturbations.
- Adjustable display precision, defaulting to 12 decimals for coordinate and angle readouts.
- Generated side sequence, parsed symbolic sequence, and vertex coordinate logs.

## Development

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

Math regression tests:

```bash
npm test
```

Full local CI check:

```bash
npm run ci
```

## Project Notes

See `PROJECT_WORKING_NOTES.md` for the read-only project walkthrough, math notes,
algorithm pseudocode, limitations, and conjecture context.
