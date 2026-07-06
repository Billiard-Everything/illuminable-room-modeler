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
- Ray simulator from a selected vertex and angle.
- Code unfolder for whitespace-separated integer bounce-block counts.
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

## Project Notes

See `PROJECT_WORKING_NOTES.md` for the read-only project walkthrough, math notes,
algorithm pseudocode, limitations, and conjecture context.
