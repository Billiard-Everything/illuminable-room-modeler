# Codebase Commentary

This file exists because not every project file can safely contain native
comments. JSON files do not permit comments, `package-lock.json` is generated,
and SVG assets are better treated as opaque browser assets. The source files now
carry inline comments for the important implementation choices; this file gives
the cross-file architecture map.

## Active Files

### `index.html`

- Provides the browser document shell for Vite.
- The `div#root` element is the only DOM node React attaches to.
- The module script points at `src/main.jsx`, which bootstraps the React app.
- This file should stay minimal because the application is entirely client-side.

### `src/main.jsx`

- Imports React's `StrictMode` to catch side effects while developing.
- Imports `createRoot` from React DOM because this is a React 18+ style app.
- Imports `src/index.css` before rendering so Tailwind utilities and global reset
  rules are available to every component.
- Imports `App` as the single top-level component.
- Calls `createRoot(document.getElementById('root')).render(...)` to mount the
  workbench into the HTML shell.

### `src/index.css`

- Imports Tailwind v4 through `@import "tailwindcss"`.
- Defines the dark app-wide typography and background defaults.
- Forces `html`, `body`, and `#root` to fill the viewport; this is essential
  because the SVG canvas measures its parent container.
- Hides page-level overflow because the app has its own sidebar scroll area.
- Normalizes button/input/textarea font inheritance so controls match the app.

### `src/App.jsx`

- Contains the full workbench UI and geometry logic.
- Uses React state for mode, triangle input, code input, ray input, pan/zoom, and
  label display state.
- Stores an editable Angle A/B increment separately from the angle values; that
  increment only affects the browser number stepper, not the math directly.
- Uses `useMemo` for derived geometry that can grow with the number of reflected
  triangles.
- Builds the base triangle either from coordinates or from two angles and a base
  length.
- Implements two simulation paths:
  - ray mode: fixed ray through reflected triangles;
  - code mode: integer-code parser plus heuristic reflection chain.
- Uses the line from first physical `A` to final reflected physical `A` as the
  code-mode shot line; the validator evaluates that line at each vertex x
  coordinate.
- Validates every physical `A`, `B`, and `C` occurrence by finite-poolshot tower
  tests adapted from the paper's unfolding philosophy, without using its
  periodic-code classification machinery:
  - `A0` is formal blue and `B0` is formal black;
  - each recorded reflection edge propagates opposite formal colors across the
    tower side;
  - the final reflected `AB` side colors the terminal side of the tower;
  - physical `C` occurrences are tracked by triangle id plus vertex index, not by
    their changing coordinates;
  - every numeric code block must satisfy `count * actualSymbolAngle < 180deg`,
    because the block represents one finite fan;
  - every non-endpoint blue vertex must satisfy `vertex.y > lineY(vertex.x)`;
  - every non-endpoint red vertex must satisfy `vertex.y < lineY(vertex.x)`;
  - the epsilon input is applied directly as a y-coordinate tolerance.
- Supports Constrained mode, which validates a proposed angle edit before
  committing it to React state and rejects edits that fail the tower test or
  reinterpret the same number string as a different finite code path.
- Supports Ghost mode, which allows invalid geometry, ghosts the unfolding, and
  colors the shot vector green for valid or red for invalid.
- Searches a bounded local symbolic `x`/`y` angle region using progressively
  finer grid steps and the same all-vertex line validator as the live view.
- Formats visible numeric readouts through one display-precision setting,
  defaulting to 12 decimals and clamping at 15 useful browser-number decimals.
- Displays first/final shot endpoint occurrences with formal colors while
  ignoring those endpoint coordinates as obstruction contributors.
- Renders geometry in mathematical coordinates inside a flipped SVG group.
- Renders labels and validator markers in screen space so text remains readable
  independent of zoom.
- Opens `GraphSetupWindow` as an additive editor over the existing sequence-row
  state; it does not duplicate the unfolding or plotting data model.

### `src/sequences/GraphSetupWindow.jsx`

- Provides a responsive, theme-compatible dialog for editing every graph's
  angles, A/B spinner increment, angle step, sequence draft, color, and
  visibility in one place.
- Delegates every mutation to `App.jsx`, preserving the current sequence
  validation, active-row selection, and AnglePlotWindow generation pipeline.

### `vite.config.js`

- Enables the React Vite plugin for JSX transformation and fast refresh.
- Enables the Tailwind Vite plugin for Tailwind v4 CSS processing.
- No custom build output, base path, proxy, or server config is needed.

### `eslint.config.js`

- Uses ESLint flat config.
- Applies recommended JavaScript rules.
- Applies React Hooks rules to catch stale dependencies and invalid hook usage.
- Applies Vite React Refresh rules to keep hot reload behavior safe.
- Ignores `dist` because it is generated build output.

### `package.json`

- Declares this as a private Vite app.
- `"type": "module"` enables ESM syntax in config and source files.
- `dev` starts Vite.
- `build` produces the static `dist` folder.
- `lint` runs ESLint over the project.
- `test` runs the Node math regression suite.
- `ci` runs tests, lint, and production build in the same order as CI.
- `preview` serves the production build locally.
- Runtime dependencies are React, React DOM, Tailwind, Tailwind's Vite plugin,
  and `lucide-react` icons.
- Dev dependencies are Vite, the React Vite plugin, ESLint, React ESLint plugins,
  browser globals, and React type packages.

### `package-lock.json`

- Generated by npm.
- Should not be hand-edited.
- Locks exact dependency versions so installs are reproducible.

### `public/favicon.svg` and `public/icons.svg`

- Static browser assets copied by Vite into the built app.
- They are not part of the geometry algorithm.
- Edit only if branding/icons need to change.

### `PROJECT_WORKING_NOTES.md`

- Long-form mathematical and algorithmic documentation.
- Explains the invisible-point conjecture context, unfolding math, parser,
  validator limitations, and pseudocode.

### `README.md`

- Short project-facing entry point for setup commands and high-level purpose.

### `.github/workflows/ci.yml`

- Runs on pushes to every branch and on pull requests.
- Installs with `npm ci`, then runs `npm test`, `npm run lint`, and
  `npm run build`.
- Keeps math regressions separate from the main-branch Pages deployment.

## Core Geometry Decisions

- Reflection is done by reflecting the opposite vertex across a side line; the
  two side vertices remain fixed.
- Ray mode keeps the ray fixed and unfolds triangles, which avoids accumulating
  direction-reflection state.
- Code mode currently uses a heuristic edge sequence rather than a proof-grade
  legal-code validator.
- The colored shot vector is endpoint-defined: first physical `A` to final
  physical `A`, currently corresponding to symbolic `z/A` in the default
  mapping.
- The current tower validator deliberately uses the direct y-at-line predicate
  requested for this iteration. Vertical shot lines are rejected for now because
  `lineY(x)` is undefined there.

## Color Semantics

- Green dashed vector: currently valid code-mode shot vector.
- Red dashed vector: currently invalid code-mode shot vector.
- Green endpoint circles: first and final shot vertices.
- Blue markers: formal blue tower vertices.
- Red markers: formal black tower vertices, rendered red for contrast.
- Yellow markers: vertices that the tower side-color propagation could not classify.
- Red rings/labels: vertices violating the strict blue-above/red-below line condition.
- Muted multicolor triangles: reflected triangle chain.
- Ghosted triangles: invalid Ghost geometry that is being inspected but would be
  rejected by Constrained mode.

## Technical Debt Boundaries

- The app is still floating-point and exploratory.
- The code parser is not a canonical billiards code validator.
- The direct y-at-line predicate is strict but not proof-grade exact arithmetic.
- A future proof backend should receive structured points/code data rather than
  reading rendered SVG state.
