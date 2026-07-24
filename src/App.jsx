// React supplies state, refs, effects, and memoization for this client-only tool.
import { useState, useRef, useEffect, useMemo } from 'react';
// Lucide supplies recognizable control/status icons without custom SVG code.
import { Maximize, Zap, Settings2, List, Code2, Compass, ChevronRight, Activity, CheckCircle2, XCircle, ShieldCheck, Eye, EyeOff, Search, AlertTriangle, Sun, Moon, ZoomIn, ZoomOut, Lock, Unlock, ScatterChart, Plus, Copy, Trash2 } from 'lucide-react';
// The angle-region plot pop-up lives in its own module (see src/anglePlot) so
// it can be unit-tested without React and does not bloat this file further.
import AnglePlotWindow from './anglePlot/AnglePlotWindow.jsx';
// The multi-sequence row list (Desmos-style "+ Add Sequence") is a plain
// data model shared between the sidebar row list and the graph pop-up, so
// both stay in sync on id/label/color assignment without duplicating logic.
import { createSequenceRow, isValidHexColor, parseSequenceDraftText } from './sequences/sequenceGraphConfig.js';
// Per-row Angle Step validation/mode reuses the exact same parser the graph
// itself uses, so a row's "Exact"/"Adaptive" badge never disagrees with
// what AnglePlotWindow actually does with that same text.
import { parseAngleStep, isExactModeStep } from './anglePlot/angleStep.js';

// =============================================================================
// App.jsx architecture note
// =============================================================================
// This file intentionally keeps the prototype in one place while the math is
// still evolving. The top-level constants define visual/side conventions. The
// pure helper functions implement Euclidean geometry. The App component then
// proceeds in this order:
// 1. declare user-editable state;
// 2. measure and control the SVG viewport;
// 3. derive the base triangle;
// 4. derive ray-mode or code-mode reflected triangles;
// 5. derive the shot vector and direct blue/black line validator;
// 6. render the sidebar and SVG canvas.
// When this grows further, the clean split points are: geometry helpers, code
// parser/unfolder, shot-line validator, and presentation components.

// Academic color palette: distinct but slightly muted/professional tones.
// The colors intentionally alternate hue families so long unfoldings remain
// visually separable without turning the app into a one-color dark theme.
const COLORS = [
  '#dc2626', '#d97706', '#059669', '#0284c7', '#4f46e5', 
  '#7c3aed', '#c026d3', '#e11d48', '#ea580c', '#65a30d',
  '#0891b2', '#2563eb', '#db2777', '#b45309', '#16a34a'
];

// Theme-specific SVG colors cannot be handled by Tailwind class overrides.
const THEME_PALETTES = {
  light: {
    baseTriangle: '#334155',
    gridAxis: '#94a3b8',
    gridLine: '#d9e2ee',
    canvasLabel: '#1e293b',
    labelHalo: '#f8fafc',
    midpointFill: '#f8fafc',
    midpointStroke: '#475569',
    midpointText: '#0f172a'
  },
  dark: {
    baseTriangle: '#e2e8f0',
    gridAxis: '#334155',
    gridLine: '#182231',
    canvasLabel: '#cbd5e1',
    labelHalo: '#070b10',
    midpointFill: '#0b1016',
    midpointStroke: '#cbd5e1',
    midpointText: '#e2e8f0'
  }
};

// Mapping triangle edges (0, 1, 2) to their standard Side numbers (1, 2, 3)
// Edge 0 (V0-V1) is opposite V2(C) -> Side 3
// Edge 1 (V1-V2) is opposite V0(A) -> Side 1
// Edge 2 (V2-V0) is opposite V1(B) -> Side 2
const EDGE_TO_SIDE = { 0: 3, 1: 1, 2: 2 };

// The locked/preview switch stores a short machine value instead of display text.
const SHOT_MODE_LOCKED = 'locked';

// The preview mode intentionally allows invalid shots so they can be inspected.
const SHOT_MODE_PREVIEW = 'preview';

// The triangle renderer uses the unfolding's cycling color palette.
// The previous mono branch has been removed in favor of the single color-based view.

// The paper's formal blue tower vertices render blue in the viewer.
const TOWER_BLUE_COLOR = '#38bdf8';

// The paper's formal black tower vertices render black in the viewer.
const TOWER_BLACK_COLOR = '#000000';

// Singular shot endpoints render red even though they are ignored by the obstruction test.
const ENDPOINT_VERTEX_COLOR = '#ef4444';

// Formal tower coloring uses stable role names instead of geometry-derived top/bottom names.
const TOWER_BLUE_ROLE = 'blue';

// The formal black role is distinct from red endpoint/error states.
const TOWER_BLACK_ROLE = 'black';

// Uncolored vertices use yellow because the formal tower-color graph failed to classify them.
const BAND_VERTEX_COLOR = '#facc15';

// Valid ghost shots keep the same guide red used by the live shot line.
const VALID_SHOT_COLOR = '#e03030';

// Invalid ghost shots use a lighter, more opaque red to make the mismatch obvious.
const INVALID_SHOT_COLOR = '#ff6b6b';

// Endpoint dots use a darker red to distinguish them from the line itself.
const SHOT_ENDPOINT_FILL_COLOR = '#8b0000';

// Vertices that fall below the guide line are rendered in black.
const SHOT_VERTEX_BELOW_LINE_COLOR = '#000000';

// Vertices above the guide line keep the cyan/blue accent used by the viewer.
const SHOT_VERTEX_ABOVE_LINE_COLOR = '#1ec8f0';

// The default clearance epsilon is a perpendicular-distance tolerance in math units.
const DEFAULT_CLEARANCE_EPSILON = 1e-10;

// Angle A/B number steppers default to one tenth of a degree.
const DEFAULT_ANGLE_INCREMENT = 0.1;

// The Angle Step control itself defaults to changing by one ten-thousandth per native step.
const DEFAULT_ANGLE_STEP_CONTROL_INCREMENT = 0.0001;

// Numeric readouts default to twelve decimal places for precise endpoint/angle inspection.
const DEFAULT_DISPLAY_DECIMALS = 12;

// JavaScript numbers carry about fifteen reliable decimal digits, so the UI clamps there.
const MAX_DISPLAY_DECIMALS = 15;

// Fan central angles must stay strictly below 180 degrees; this guards roundoff at the boundary.
const FAN_ANGLE_TOLERANCE_DEGREES = 1e-9;

// Region search refines the grid by one decimal place at each step.
const REGION_SEARCH_STEPS = [0.1, 0.01, 0.001];

// Region search is local and bounded so the browser cannot be locked by a large valid set.
const REGION_SEARCH_RADIUS_DEGREES = 6;

// Each precision step has its own cap so a coarse run cannot starve later reporting.
const REGION_SEARCH_MAX_VISITS_PER_STEP = 12000;

// The code unfolder uses the same hard cap everywhere to keep live and candidate runs aligned.
const MAX_CODE_TRIANGLES = 3000;

// Empty code-mode data keeps UI consumers simple when there is no active code unfolding.
const EMPTY_CODE_DATA = {
  // No reflected copies exist until a valid code is parsed.
  triangles: [],
  // No parsed runs exist until the user provides numeric tokens.
  parsedSequence: [],
  // No boundary sequence exists until reflections are emitted.
  sideSequence: [],
  // No physical reflection edge sequence exists until reflections are emitted.
  reflectionEdges: [],
  // The default physical-to-symbol map preserves the original x/y/z labels.
  idxToAngle: { 0: 'x', 1: 'y', 2: 'z' },
  // The reverse symbol-to-physical map is useful for candidate searches.
  angleToIdx: { x: 0, y: 1, z: 2 }
};

/** Resolves editable native number-input step text to a safe positive value. */
const resolvePositiveInputStep = (rawValue, fallback) => {
  // Native step attributes require a finite positive number to behave predictably.
  const parsed = Number(rawValue);
  // Invalid typing states retain the documented fallback without rewriting the field.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// ==========================================
// MATHEMATICAL CORE FUNCTIONS (Optimized)
// ==========================================

/**
 * Reflects a point perfectly across a line segment using Linear Algebra (IEEE 754 precision)
 */
const reflectPoint = (p, p1, p2) => {
  // Convert the segment through p1/p2 into implicit line form ax + by + c = 0.
  const a = p2.y - p1.y; 
  // b is the negative x component of the segment direction.
  const b = p1.x - p2.x; 
  // c makes the implicit line pass through both segment endpoints.
  const c = p2.x * p1.y - p1.x * p2.y; 
  
  // The squared normal length is the denominator for projection onto the line normal.
  const denom = a * a + b * b;
  // Degenerate edges cannot define a mirror line; copy the point rather than exploding.
  if (denom === 0) return { ...p }; 
  
  // Twice the signed distance in normal-coordinate units gives the mirror offset.
  const factor = 2 * (a * p.x + b * p.y + c) / denom;
  // Subtract the normal component to land on the reflected point.
  return { x: p.x - a * factor, y: p.y - b * factor };
};

/** Calculates the geometric center of a triangle */
const getCentroid = (tri) => ({
  // Average the three x coordinates.
  x: (tri[0].x + tri[1].x + tri[2].x) / 3,
  // Average the three y coordinates.
  y: (tri[0].y + tri[1].y + tri[2].y) / 3
});

/** Peeks at where a triangle's centroid would end up if it were reflected across a specific edge */
const testCentroid = (tri, edge) => {
  // First endpoint of the candidate mirror edge.
  const p1 = tri[edge];
  // Second endpoint of the candidate mirror edge.
  const p2 = tri[(edge + 1) % 3];
  // Opposite vertex that actually moves under this reflection.
  const p3 = tri[(edge + 2) % 3];
  // Reflect only the opposite vertex, because edge endpoints stay fixed.
  const newP3 = reflectPoint(p3, p1, p2);
  // Return the centroid of the triangle that would result from this reflection.
  return { x: (p1.x + p2.x + newP3.x) / 3, y: (p1.y + p2.y + newP3.y) / 3 };
};

/** Uses Law of Cosines to measure the exact internal radian angle at vertex p2 */
const getAngleAtVertex = (p1, p2, p3) => {
  // Squared distance across the angle, from first adjacent point to second adjacent point.
  const dist13_sq = (p1.x - p3.x)**2 + (p1.y - p3.y)**2;
  // Squared distance from the measured vertex to the first adjacent point.
  const dist12_sq = (p1.x - p2.x)**2 + (p1.y - p2.y)**2;
  // Squared distance from the measured vertex to the second adjacent point.
  const dist23_sq = (p3.x - p2.x)**2 + (p3.y - p2.y)**2;
  // Degenerate sides have no meaningful interior angle.
  if (dist12_sq === 0 || dist23_sq === 0) return 0;
  // Law of cosines, clamped before acos to absorb tiny floating-point drift.
  let cosVal = (dist12_sq + dist23_sq - dist13_sq) / (2 * Math.sqrt(dist12_sq) * Math.sqrt(dist23_sq));
  return Math.acos(Math.max(-1, Math.min(1, cosVal))); 
};

/** Calculates global angular trajectory securely in 360 space */
const getGlobalAngle = (startP, endP) => {
  // Horizontal component of the oriented segment.
  const dx = endP.x - startP.x;
  // Vertical component of the oriented segment.
  const dy = endP.y - startP.y;
  // atan2 is robust for vertical lines and chooses the correct quadrant.
  let angle = Math.atan2(dy, dx) * (180 / Math.PI);
  // Normalize the usual [-180, 180] output to [0, 360).
  if (angle < 0) angle += 360; 
  return angle;
};

/** Builds the base triangle from the same inputs used by the UI controls. */
const buildBaseTriangle = (baseInputMode, baseCoordsInput, angleParams) => {
  // Local `points` is assigned from exactly one input mode.
  let points;
  // Coordinate mode trusts the three user-editable vertices directly.
  if (baseInputMode === 'coords') {
    // Number() converts text inputs while `|| 0` keeps invalid blanks renderable.
    points = baseCoordsInput.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
  } else {
    // Angle mode interprets A and B in degrees and length as side AB.
    const A = Number(angleParams.a) || 0;
    // Angle B is the second physical base angle in degrees.
    const B = Number(angleParams.b) || 0;
    // Base length is the physical length of side AB.
    const L = Number(angleParams.length) || 0;
    // C is determined by the Euclidean triangle angle sum.
    const C = 180 - A - B;

    // Invalid triangles still render a fallback so the UI never goes blank.
    if (A <= 0 || B <= 0 || C <= 0 || L <= 0) {
      // The fallback keeps the same rough scale as the requested base length.
      points = [{ x: 0, y: 0 }, { x: Math.max(L, 1), y: 0 }, { x: Math.max(L, 1) / 2, y: 1 }];
    } else {
      // Convert degrees to radians for Math.sin/cos.
      const radA = A * Math.PI / 180;
      // Convert B for the law-of-sines side calculation.
      const radB = B * Math.PI / 180;
      // Convert C for the law-of-sines denominator.
      const radC = C * Math.PI / 180;
      // Law of sines computes side AC from the chosen base AB.
      const b = L * (Math.sin(radB) / Math.sin(radC));

      // Place A at the origin, B on the x-axis, and C by polar coordinates from A.
      points = [
        // Physical A anchors the shot convention.
        { x: 0, y: 0 },
        // Physical B sets the base scale.
        { x: L, y: 0 },
        // Physical C completes the triangle above the base.
        { x: b * Math.cos(radA), y: b * Math.sin(radA) }
      ];
    }
  }
  // The base triangle uses a neutral color because it is the fixed anchor.
  return { id: 'T0', name: 'T0 (Base)', points, color: '#e2e8f0' };
};

/** Checks whether an angle-input state is complete enough for guarded validation. */
const hasCompleteAngleParams = (angleParams) => {
  // Angle A must parse to a finite number before it can be guarded.
  const A = Number(angleParams.a);
  // Angle B must parse to a finite number before it can be guarded.
  const B = Number(angleParams.b);
  // Base length must parse to a finite number before it can be guarded.
  const L = Number(angleParams.length);
  // Incomplete fields are allowed while the user is typing.
  return Number.isFinite(A) && Number.isFinite(B) && Number.isFinite(L);
};

/** Checks whether numeric angle inputs describe a nondegenerate Euclidean triangle. */
const hasValidAngleTriangle = (angleParams) => {
  // Angle A is parsed once for consistency with `buildBaseTriangle`.
  const A = Number(angleParams.a);
  // Angle B is parsed once for consistency with `buildBaseTriangle`.
  const B = Number(angleParams.b);
  // Base length is parsed once for consistency with `buildBaseTriangle`.
  const L = Number(angleParams.length);
  // The third angle is implicit in the two-input UI.
  const C = 180 - A - B;
  // All side/angle values must be positive for the constructed triangle to matter.
  return A > 0 && B > 0 && C > 0 && L > 0;
};

/** Returns the two physical side indices incident to a physical vertex angle. */
const getEdgesForAngle = (idx) => {
  // Physical A touches edges AB and CA.
  if (idx === 0) return [0, 2];
  // Physical B touches edges AB and BC.
  if (idx === 1) return [0, 1];
  // Physical C touches edges BC and CA.
  return [1, 2];
};

/** Parses and unfolds the integer code against a supplied base triangle. */
const unfoldCodeData = (billiardsCode, baseTriangle, enabled = true) => {
  // Return a fresh copy so consumers cannot mutate the shared empty constant.
  const defaultData = { ...EMPTY_CODE_DATA, triangles: [], parsedSequence: [], sideSequence: [], reflectionEdges: [], idxToAngle: { ...EMPTY_CODE_DATA.idxToAngle }, angleToIdx: { ...EMPTY_CODE_DATA.angleToIdx } };
  // Inactive or empty code mode should behave like an empty unfolding.
  if (!enabled || !billiardsCode.trim()) return defaultData;

  // Parse all whitespace-separated integers and drop malformed tokens.
  const nums = billiardsCode.trim().split(/\s+/).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
  // If every token was malformed, use the same empty default.
  if (nums.length === 0) return defaultData;

  // `angles` stores the symbolic angle assigned to each integer run.
  const angles = [];
  // The symbolic angle alphabet is fixed by the conjecture notation.
  const axes = ['x', 'y', 'z'];
  // Historical code convention: the first block starts at y.
  if (nums.length > 0) angles.push('y');
  // Historical code convention: the second block starts at x.
  if (nums.length > 1) angles.push('x');

  // Derive each later symbolic label from parity and the two previous labels.
  for (let i = 2; i < nums.length; i++) {
    // Parity is read from the previous count.
    const currNum = nums[i - 1];
    // The previous symbolic angle.
    const currAngle = angles[i - 1];
    // The symbolic angle before that.
    const lastAngle = angles[i - 2];

    // Even previous count repeats the label from two positions back.
    if (currNum % 2 === 0) angles.push(lastAngle);
    // Odd previous count picks the only remaining symbolic label.
    else angles.push(axes.find(a => a !== currAngle && a !== lastAngle));
  }

  // Pair each numeric run with its derived symbolic angle for display and unfolding.
  const parsedSequence = nums.map((n, i) => ({ count: n, angle: angles[i] }));

  // Track the largest run attached to each symbolic angle.
  const maxBouncesCode = { x: 0, y: 0, z: 0 };
  // A larger run is heuristically associated with a smaller geometric angle.
  parsedSequence.forEach(step => {
    // Store only the maximum run seen for this symbolic angle.
    if (step.count > maxBouncesCode[step.angle]) {
      // Update the symbol's maximum bounce count.
      maxBouncesCode[step.angle] = step.count;
    }
  });

  // Physical triangle vertices for angle measurement.
  const pts = baseTriangle.points;
  // Compute physical interior angles and retain their vertex indices.
  const actualAngles = [
    // Physical A is measured between CA and AB.
    { idx: 0, rad: getAngleAtVertex(pts[2], pts[0], pts[1]) },
    // Physical B is measured between AB and BC.
    { idx: 1, rad: getAngleAtVertex(pts[0], pts[1], pts[2]) },
    // Physical C is measured between BC and CA.
    { idx: 2, rad: getAngleAtVertex(pts[1], pts[2], pts[0]) }
  ].sort((a, b) => a.rad - b.rad);

  // Sort symbols by their maximum run, descending, then alphabetically for stability.
  const syms = ['x', 'y', 'z'].sort((a, b) => (maxBouncesCode[b] - maxBouncesCode[a]) || a.localeCompare(b));

  // angleToIdx maps symbolic labels to physical vertex indices.
  const angleToIdx = {};
  // idxToAngle maps physical vertex indices back to symbolic labels.
  const idxToAngle = {};
  // Largest-run symbol goes to smallest physical angle.
  angleToIdx[syms[0]] = actualAngles[0].idx; idxToAngle[actualAngles[0].idx] = syms[0];
  // Middle-run symbol goes to middle physical angle.
  angleToIdx[syms[1]] = actualAngles[1].idx; idxToAngle[actualAngles[1].idx] = syms[1];
  // Smallest-run symbol goes to largest physical angle.
  angleToIdx[syms[2]] = actualAngles[2].idx; idxToAngle[actualAngles[2].idx] = syms[2];

  // Reflected triangle copies emitted by the code unfolding.
  const triangles = [];
  // Actual side labels crossed during unfolding, used by the sidebar log.
  const sideSequence = [];
  // Physical edge indices crossed during unfolding, used by formal tower coloring.
  const reflectionEdges = [];
  // Begin from a mutable copy of the base triangle's points.
  let currentTri = [...baseTriangle.points];
  // The centroid gives a coarse notion of current unfolding direction.
  let currentCentroid = getCentroid(currentTri);
  // Start direction points from physical A to the initial centroid.
  let currentDir = { x: currentCentroid.x - currentTri[0].x, y: currentCentroid.y - currentTri[0].y };
  // Last reflected edge prevents immediately choosing the same side twice within a fan.
  let lastEdge = null;
  // Count emitted triangles separately from parsed run count.
  let triCount = 0;

  // Expand every parsed block into repeated side reflections.
  for (let stepIndex = 0; stepIndex < parsedSequence.length; stepIndex++) {
    // Read this parsed count/symbol pair.
    const step = parsedSequence[stepIndex];
    // The fan vertex is the physical corner associated with this symbolic run.
    const fanVertexIdx = angleToIdx[step.angle];
    // The fan point is fixed throughout this count block, even as reflected triangles are emitted.
    const fanPoint = currentTri[fanVertexIdx] ? { ...currentTri[fanVertexIdx] } : null;
    // Convert this symbolic angle to its two physical adjacent edges.
    const edges = getEdgesForAngle(fanVertexIdx);
    // currentEdge will be chosen either by alternation or forwardness.
    let currentEdge;

    // If we are already alternating within this fan, choose the other adjacent edge.
    if (lastEdge !== null && edges.includes(lastEdge)) {
      // Alternate away from the side just reflected.
      currentEdge = edges[0] === lastEdge ? edges[1] : edges[0];
    } else {
      // Otherwise preview the centroid after the first candidate reflection.
      const cA = testCentroid(currentTri, edges[0]);
      // Preview the centroid after the second candidate reflection.
      const cB = testCentroid(currentTri, edges[1]);
      // Dot product compares how much candidate A continues the current direction.
      const dotA = (cA.x - currentCentroid.x) * currentDir.x + (cA.y - currentCentroid.y) * currentDir.y;
      // Dot product compares how much candidate B continues the current direction.
      const dotB = (cB.x - currentCentroid.x) * currentDir.x + (cB.y - currentCentroid.y) * currentDir.y;
      // Pick the more forward candidate.
      currentEdge = dotA > dotB ? edges[0] : edges[1];
    }

    // Emit exactly `count` reflected triangles for this symbolic run.
    for (let i = 0; i < step.count; i++) {
      // Stop immediately once the hard cap is reached.
      if (triCount >= MAX_CODE_TRIANGLES) break;

      // Log the conventional side number corresponding to the reflected edge.
      sideSequence.push(EDGE_TO_SIDE[currentEdge]);
      // Log the physical edge index so the validator can reconstruct tower-color propagation.
      reflectionEdges.push(currentEdge);
      // Edge endpoints remain fixed under reflection.
      const p1 = currentTri[currentEdge];
      // The next edge endpoint wraps around for edge 2.
      const p2 = currentTri[(currentEdge + 1) % 3];
      // The opposite vertex is the only point that moves.
      const p3 = currentTri[(currentEdge + 2) % 3];
      // Mirror that opposite vertex across the chosen side.
      const newP3 = reflectPoint(p3, p1, p2);

      // Build the next triangle in the same physical vertex-index order.
      const nextTri = [];
      // Preserve the first endpoint of the reflected side.
      nextTri[currentEdge] = { ...p1 };
      // Preserve the second endpoint of the reflected side.
      nextTri[(currentEdge + 1) % 3] = { ...p2 };
      // Replace the opposite vertex with its reflected copy.
      nextTri[(currentEdge + 2) % 3] = { ...newP3 };

      // Store the reflected triangle with a stable id and cycling visual color.
      triangles.push({
        // The id is used by labels, violation reports, and endpoint exclusion.
        id: `Code-T${triangles.length + 1}`,
        // The reflected points stay in physical A/B/C index order.
        points: nextTri,
        // Preserve the fan metadata used for code-mode inspection and debugging.
        fanVertexIdx,
        // Keep the original fan point so the unfolded path can be inspected.
        fanPoint,
        // The parsed block index groups triangles emitted by the same count.
        fanRunIndex: stepIndex,
        // The number in the code sequence that produced this fan.
        fanRunCount: step.count,
        // Keep the source symbol for inspection and future UI details.
        fanSymbol: step.angle,
        // Colors cycle so long unfoldings remain visually separable.
        color: COLORS[(triangles.length) % COLORS.length]
      });

      // Update unfolding direction from old centroid to new centroid.
      const nextCentroid = getCentroid(nextTri);
      // Store the newest forward direction for the next non-alternating choice.
      currentDir = { x: nextCentroid.x - currentCentroid.x, y: nextCentroid.y - currentCentroid.y };
      // Move the centroid cursor forward.
      currentCentroid = nextCentroid;
      // Continue from the newly reflected triangle.
      currentTri = nextTri;
      // Remember the side just used.
      lastEdge = currentEdge;
      // Alternate to the other edge in the same fan for the next bounce.
      currentEdge = currentEdge === edges[0] ? edges[1] : edges[0];
      // Increase the safety counter.
      triCount++;
    }
    // Stop outer loop too if the safety cap was hit.
    if (triCount >= MAX_CODE_TRIANGLES) break;
  }

  // Return every code-derived structure consumed by the UI and candidate checks.
  return { triangles, parsedSequence, idxToAngle, angleToIdx, sideSequence, reflectionEdges };
};

/** Returns the complete reflected chain that belongs on the canvas. */
const getRenderableActiveTriangles = (activeTriangles) => {
  // This is the single seam between "triangle gets a polygon" and "its
  // vertices get colored markers" (see the marker loop in the SVG below,
  // which walks [baseTriangle, ...getRenderableActiveTriangles(...)]).
  // Every element returned here is a real reflected triangle emitted by
  // unfoldCodeData, not a look-ahead/preview computed for the *next* count
  // block that hasn't been unfolded yet — so there is no unrendered
  // triangle whose vertex still gets marked. Do not slice/trim this list
  // (e.g. dropping the last triangle) without also removing its markers,
  // or the two loops will disagree and a vertex will render with no
  // matching polygon under it. See tests/math-regression.test.mjs's
  // "rendering includes the final reflected triangle instead of treating
  // it as look-ahead geometry" for the regression this guards against.
  return activeTriangles;
};

/** Builds the endpoint-defined shot line used by code-mode validation. */
const getShotGeometry = (baseTriangle, activeTriangles, labelsMap) => {
  // Physical A is the current source/target vertex convention for the shot.
  const shotVertexIdx = 0;
  // Read the symbolic name of physical A so the UI can say "x/A" when relevant.
  const shotSymbol = labelsMap[shotVertexIdx] || 'A';
  // Use the first physical A as the start of the shot line.
  const startShot = baseTriangle.points[shotVertexIdx] || baseTriangle.points[0];
  // Use the last reflected physical A as the end of the shot line.
  const finalShot = activeTriangles.length > 0 ? activeTriangles[activeTriangles.length - 1].points[shotVertexIdx] : startShot;
  // Store the shot vector's x component once for line-equation tests.
  const lineDx = finalShot.x - startShot.x;
  // Store the shot vector's y component once for line-equation tests.
  const lineDy = finalShot.y - startShot.y;
  // Store shot length so endpoint tolerance can scale with the current shot.
  const lineLength = Math.hypot(lineDx, lineDy);
  // Return the full shot geometry bundle used by validation and rendering.
  return { shotVertexIdx, shotSymbol, startShot, finalShot, lineDx, lineDy, lineLength };
};

/** Returns a positive y-coordinate tolerance for direct line-side checks. */
const getLineYTolerance = (clearanceEpsilon) => {
  // Invalid or negative epsilon values are clamped to the documented default.
  const safeEpsilon = Number.isFinite(clearanceEpsilon) && clearanceEpsilon >= 0 ? clearanceEpsilon : DEFAULT_CLEARANCE_EPSILON;
  // Keep a small floating-point floor so strict greater-than checks survive roundoff.
  return Math.max(1e-12, safeEpsilon);
};

/** Returns a coordinate tolerance for recognizing the two singular shot endpoints. */
const getShotEndpointTolerance = (vectorLength) => {
  // Endpoint matching should absorb reflection roundoff without swallowing real nearby vertices.
  return Math.max(1e-8, vectorLength * 1e-10);
};

/** Checks whether a point is at the start or final endpoint of the visual shot vector. */
const isShotEndpointCoordinate = (point, shotGeometry, endpointTolerance) => {
  // Squared tolerance avoids square roots in the validation loop.
  const toleranceSq = endpointTolerance * endpointTolerance;
  // Squared distance from this point to the shot start endpoint.
  const startDistSq = (point.x - shotGeometry.startShot.x) ** 2 + (point.y - shotGeometry.startShot.y) ** 2;
  // Squared distance from this point to the shot final endpoint.
  const finalDistSq = (point.x - shotGeometry.finalShot.x) ** 2 + (point.y - shotGeometry.finalShot.y) ** 2;
  // Endpoints are colored for display but ignored as obstructions.
  return startDistSq <= toleranceSq || finalDistSq <= toleranceSq;
};

/** Computes the current physical triangle angles in degrees. */
const getPhysicalAngleDegrees = (baseTriangle) => {
  // Read the triangle points in physical A/B/C order.
  const points = baseTriangle.points;
  // Physical A is measured between CA and AB.
  const angleA = getAngleAtVertex(points[2], points[0], points[1]) * 180 / Math.PI;
  // Physical B is measured between AB and BC.
  const angleB = getAngleAtVertex(points[0], points[1], points[2]) * 180 / Math.PI;
  // Physical C is measured between BC and CA.
  const angleC = getAngleAtVertex(points[1], points[2], points[0]) * 180 / Math.PI;
  // Return the physical angle array in the same index order as triangle points.
  return [angleA, angleB, angleC];
};

/** Computes symbolic x/y/z angle values from the current physical triangle and label map. */
const getSymbolAngleDegreesFromTriangle = (baseTriangle, labelsMap) => {
  // Compute physical angle values directly from geometry so coordinate mode also works.
  const physicalAngles = getPhysicalAngleDegrees(baseTriangle);
  // Build the symbolic angle map from the physical-to-symbol label assignment.
  return {
    // Physical vertex 0 contributes its angle to whichever symbol labels it.
    [labelsMap[0]]: physicalAngles[0],
    // Physical vertex 1 contributes its angle to whichever symbol labels it.
    [labelsMap[1]]: physicalAngles[1],
    // Physical vertex 2 contributes its angle to whichever symbol labels it.
    [labelsMap[2]]: physicalAngles[2]
  };
};

/** Checks every numeric code block against the fan central-angle bound. */
const buildFanConstraintValidation = ({ parsedSequence, symbolAngles, toleranceDegrees = FAN_ANGLE_TOLERANCE_DEGREES }) => {
  // No parsed blocks means there are no fan constraints to apply.
  if (!parsedSequence || parsedSequence.length === 0) {
    // Return an empty valid result with stable fields for consumers.
    return { status: 'valid', checked: 0, invalid: 0, maxCentralAngle: 0, maxRatio: 0, violations: [] };
  }
  // Count invalid fan constraints without relying on the visible violation list.
  let invalid = 0;
  // Track the largest fan central angle encountered.
  let maxCentralAngle = 0;
  // Track the largest central-angle-to-180 ratio encountered.
  let maxRatio = 0;
  // Keep only a short list of visible fan failures for the inspector.
  const violations = [];
  // Walk each code number together with its symbolic fan angle.
  parsedSequence.forEach((step, index) => {
    // Read the actual angle attached to this symbolic fan in the candidate triangle.
    const actualAngle = symbolAngles[step.angle];
    // A malformed symbol-angle lookup makes the code interpretation invalid.
    const hasAngle = Number.isFinite(actualAngle);
    // The central angle of the fan is the code number times the actual triangle angle.
    const centralAngle = hasAngle ? step.count * actualAngle : Infinity;
    // Ratio gives a compact "how close to 180" diagnostic.
    const ratio = hasAngle ? centralAngle / 180 : Infinity;
    // Store the largest central angle for the UI.
    maxCentralAngle = Math.max(maxCentralAngle, centralAngle);
    // Store the largest ratio for the UI.
    maxRatio = Math.max(maxRatio, ratio);
    // Poolshot fans must have central angle strictly below 180 degrees.
    const valid = hasAngle && centralAngle < 180 - toleranceDegrees;
    // Valid fans require no violation record.
    if (valid) return;
    // Count this fan as invalid.
    invalid++;
    // Keep the inspector readable by truncating visible fan violations.
    if (violations.length < 12) {
      // Store enough context to identify the exact numeric code block.
      violations.push({ index, step, actualAngle, centralAngle, ratio, expected: `${step.count}${step.angle} < 180deg` });
    }
  });
  // Return fan constraint status and diagnostics.
  return { status: invalid === 0 ? 'valid' : 'invalid', checked: parsedSequence.length, invalid, maxCentralAngle, maxRatio, violations };
};

/** Builds a compact reference for the current code interpretation. */
const buildCodePathReference = (codeData) => ({
  // Preserve the physical-to-symbol assignment chosen for the starting shot.
  idxToAngle: { ...codeData.idxToAngle },
  // Preserve the rendered/reflected side sequence for the starting shot.
  sideSequence: [...(codeData.sideSequence || [])],
  // Preserve physical reflection edges because they drive tower coloring.
  reflectionEdges: [...(codeData.reflectionEdges || [])]
});

/** Validates that a candidate still represents the same parsed code path. */
const buildCodePathConsistencyValidation = ({ candidateCodeData, reference }) => {
  // Without a reference, the candidate is allowed to define its own path.
  if (!reference) return { status: 'valid', violations: [] };
  // Require the physical-to-symbol assignment to stay exactly fixed.
  const sameLabels = haveSameLabelMap(candidateCodeData.idxToAngle, reference.idxToAngle);
  // Require the displayed side sequence to stay exactly fixed.
  const sameSides = haveSameSideSequence(candidateCodeData.sideSequence, reference.sideSequence);
  // Require the physical reflection edge sequence to stay exactly fixed.
  const sameEdges = haveSameSideSequence(candidateCodeData.reflectionEdges || [], reference.reflectionEdges || []);
  // Accumulate user-readable path consistency failures.
  const violations = [];
  // Report a symbol mapping change separately because it changes what the numbers mean.
  if (!sameLabels) violations.push({ expected: 'same symbolic angle mapping', score: 0, triId: 'code', vertexName: 'map', symbol: 'x/y/z', role: 'code-path' });
  // Report a side sequence change because it changes the unfolded shot.
  if (!sameSides) violations.push({ expected: 'same side sequence from code numbers', score: 0, triId: 'code', vertexName: 'sides', symbol: '1/2/3', role: 'code-path' });
  // Report a physical edge sequence change because it changes tower-color propagation.
  if (!sameEdges) violations.push({ expected: 'same physical reflection edges', score: 0, triId: 'code', vertexName: 'edges', symbol: '0/1/2', role: 'code-path' });
  // The path is valid only if every required sequence matches.
  return { status: violations.length === 0 ? 'valid' : 'invalid', violations };
};

/** Builds a stable occurrence key that survives coordinate changes during perturbation. */
const getClearanceOccurrenceKey = (triId, vertexIdx, symbol) => {
  // Triangle id and physical vertex index track C vertices even when coordinates move.
  return `${triId}:${vertexIdx}:${symbol}`;
};

/** Returns the display name for a physical triangle vertex. */
const getPhysicalVertexName = (vertexIdx) => {
  // The first three physical vertices keep their conventional billiards names.
  return ['A', 'B', 'C'][vertexIdx] || `V${vertexIdx}`;
};

/** Returns the opposite formal color role along a tower side. */
const getOppositeTowerRole = (role) => {
  // Blue side endpoints force the adjacent side endpoint to be formal black.
  if (role === TOWER_BLUE_ROLE) return TOWER_BLACK_ROLE;
  // Black side endpoints force the adjacent side endpoint to be formal blue.
  if (role === TOWER_BLACK_ROLE) return TOWER_BLUE_ROLE;
  // Unknown roles cannot propagate a formal tower color.
  return null;
};

/** Returns the requested blue/black UI color for a formal tower role. */
const getTowerRoleColor = (role) => {
  // Formal blue vertices render blue.
  if (role === TOWER_BLUE_ROLE) return TOWER_BLUE_COLOR;
  // Formal black vertices render black in this workbench.
  if (role === TOWER_BLACK_ROLE) return TOWER_BLACK_COLOR;
  // Uncolored vertices render yellow because the tower-color propagation failed.
  return BAND_VERTEX_COLOR;
};

/** Builds a vertex record shared by coloring, validation, and rendering. */
const buildTowerVertexRecord = (tri, vertexIdx, labelsMap, role, source) => {
  // Pull the symbolic label attached to this physical vertex.
  const symbol = labelsMap[vertexIdx] || getPhysicalVertexName(vertexIdx);
  // Build an occurrence key that does not depend on the vertex coordinates.
  const key = getClearanceOccurrenceKey(tri.id, vertexIdx, symbol);
  // Read the current geometric point for coloring and line validation.
  const point = tri.points[vertexIdx];
  // Store the conventional physical name for marker text and violation messages.
  const vertexName = getPhysicalVertexName(vertexIdx);
  // Return every stable identifier and visual datum in one object.
  return { key, triId: tri.id, vertexIdx, vertexName, symbol, point, role, color: getTowerRoleColor(role), source };
};

/** Reads a formal color role from the coloring state. */
const getTowerRoleRecord = (state, tri, vertexIdx, labelsMap) => {
  // Pull the symbolic label attached to this physical vertex.
  const symbol = labelsMap[vertexIdx] || getPhysicalVertexName(vertexIdx);
  // Build the same occurrence key used when the role was assigned.
  const key = getClearanceOccurrenceKey(tri.id, vertexIdx, symbol);
  // Return the existing record when this occurrence has already been colored.
  return state.byOccurrence.get(key) || null;
};

/** Assigns a formal tower color to a single vertex occurrence. */
const setTowerRoleRecord = (state, tri, vertexIdx, labelsMap, role, source) => {
  // Missing points cannot participate in the tower-color graph.
  if (!tri?.points?.[vertexIdx]) return null;
  // Build the new record before checking for conflicts.
  const nextRecord = buildTowerVertexRecord(tri, vertexIdx, labelsMap, role, source);
  // Read any previous assignment for this exact occurrence.
  const previousRecord = state.byOccurrence.get(nextRecord.key);
  // A previous assignment with the same role is already consistent.
  if (previousRecord?.role === role) return previousRecord;
  // A previous assignment with the opposite role means the side sequence is inconsistent.
  if (previousRecord) {
    // Store the conflict for the validator instead of throwing during render.
    state.conflicts.push({ ...nextRecord, expected: previousRecord.role, actual: role, reason: source });
    // Preserve the first role so rendering remains deterministic.
    return previousRecord;
  }
  // Store the new formal role for this occurrence.
  state.byOccurrence.set(nextRecord.key, nextRecord);
  // Return the record so callers can immediately propagate from it.
  return nextRecord;
};

/** Adds a tower-color conflict that is not tied to a pre-existing record. */
const addTowerColorConflict = (state, tri, vertexIdx, labelsMap, expected, actual, reason) => {
  // Build a normal vertex record so the violation renderer has labels and coordinates.
  const record = buildTowerVertexRecord(tri, vertexIdx, labelsMap, actual, reason);
  // Store the expected and actual roles next to the record metadata.
  state.conflicts.push({ ...record, expected, actual, reason });
};

/** Propagates opposite formal colors across the two endpoints of one tower side. */
const propagateTowerEdgeRoles = (state, tri, edge, labelsMap, source) => {
  // The first endpoint of physical edge e is vertex e.
  const firstIdx = edge;
  // The second endpoint of physical edge e wraps around the triangle.
  const secondIdx = (edge + 1) % 3;
  // Read any role already assigned to the first endpoint.
  const firstRecord = getTowerRoleRecord(state, tri, firstIdx, labelsMap);
  // Read any role already assigned to the second endpoint.
  const secondRecord = getTowerRoleRecord(state, tri, secondIdx, labelsMap);
  // If both endpoints are known, they must be opposite formal colors.
  if (firstRecord && secondRecord) {
    // Equal endpoint colors violate the paper's side-color rule.
    if (firstRecord.role === secondRecord.role) addTowerColorConflict(state, tri, secondIdx, labelsMap, getOppositeTowerRole(firstRecord.role), secondRecord.role, source);
    // No propagation is needed when both endpoints are already known.
    return;
  }
  // If the first endpoint is known, the second endpoint gets the opposite role.
  if (firstRecord && !secondRecord) {
    // Assign the second endpoint by the inductive tower-color rule.
    setTowerRoleRecord(state, tri, secondIdx, labelsMap, getOppositeTowerRole(firstRecord.role), source);
    // Propagation for this edge is complete.
    return;
  }
  // If the second endpoint is known, the first endpoint gets the opposite role.
  if (!firstRecord && secondRecord) {
    // Assign the first endpoint by the inductive tower-color rule.
    setTowerRoleRecord(state, tri, firstIdx, labelsMap, getOppositeTowerRole(secondRecord.role), source);
  }
};

/** Copies formal color roles across the shared mirror edge of adjacent triangles. */
const syncTowerEdgeRoles = (state, fromTri, toTri, edge, labelsMap, source) => {
  // Both endpoints of the reflected edge are geometrically shared by the two triangles.
  for (const vertexIdx of [edge, (edge + 1) % 3]) {
    // Read the role on the previous triangle's occurrence.
    const fromRecord = getTowerRoleRecord(state, fromTri, vertexIdx, labelsMap);
    // Read the role on the next triangle's copied occurrence.
    const toRecord = getTowerRoleRecord(state, toTri, vertexIdx, labelsMap);
    // Conflicting shared-edge colors mean the propagation is inconsistent.
    if (fromRecord && toRecord && fromRecord.role !== toRecord.role) addTowerColorConflict(state, toTri, vertexIdx, labelsMap, fromRecord.role, toRecord.role, source);
    // A known previous occurrence colors the copied occurrence in the reflected triangle.
    else if (fromRecord && !toRecord) setTowerRoleRecord(state, toTri, vertexIdx, labelsMap, fromRecord.role, source);
    // A known copied occurrence can also back-fill the previous side occurrence.
    else if (!fromRecord && toRecord) setTowerRoleRecord(state, fromTri, vertexIdx, labelsMap, toRecord.role, source);
  }
};

/** Builds the paper-style formal blue/black coloring for the whole unfolded tower. */
const buildTowerColoring = ({ baseTriangle, activeTriangles, labelsMap, reflectionEdges }) => {
  // The coloring state stores formal roles and any contradictions found while propagating.
  const state = { byOccurrence: new Map(), conflicts: [] };
  // The base plus every reflected copy is the finite tower being tested.
  const allTris = [baseTriangle, ...activeTriangles];
  // A0 is formal blue by the tower-color definition.
  setTowerRoleRecord(state, baseTriangle, 0, labelsMap, TOWER_BLUE_ROLE, 'base A0 is blue');
  // B0 is formal black by the tower-color definition.
  setTowerRoleRecord(state, baseTriangle, 1, labelsMap, TOWER_BLACK_ROLE, 'base B0 is black');
  // The base side AB must have opposite colors at its two endpoints.
  propagateTowerEdgeRoles(state, baseTriangle, 0, labelsMap, 'base side AB');

  // Process each reflection edge in the exact order emitted by the unfolder.
  for (let i = 0; i < activeTriangles.length; i++) {
    // The previous triangle is the one being reflected.
    const previousTri = allTris[i];
    // The next triangle is the reflected mirror image.
    const nextTri = allTris[i + 1];
    // The reflected physical edge was captured during unfolding.
    const edge = reflectionEdges?.[i];
    // Missing edge data means this candidate cannot be validated rigorously.
    if (!Number.isInteger(edge) || edge < 0 || edge > 2) {
      // Store a synthetic conflict so the validator rejects the candidate.
      state.conflicts.push({ triId: nextTri?.id || `Code-T${i + 1}`, vertexName: 'edge', symbol: '?', role: 'missing-edge', expected: 'recorded reflection edge', actual: String(edge), reason: 'missing reflection edge', point: null });
      // Continue so all other available data can still be rendered.
      continue;
    }
    // The side used for reflection also propagates opposite colors within the old triangle.
    propagateTowerEdgeRoles(state, previousTri, edge, labelsMap, `reflection side ${EDGE_TO_SIDE[edge]}`);
    // Shared edge endpoints carry their formal colors into the reflected triangle.
    syncTowerEdgeRoles(state, previousTri, nextTri, edge, labelsMap, `shared reflection side ${EDGE_TO_SIDE[edge]}`);
    // The copied side in the new triangle must also have opposite endpoint colors.
    propagateTowerEdgeRoles(state, nextTri, edge, labelsMap, `reflected side ${EDGE_TO_SIDE[edge]}`);
  }

  // The visual code-mode shot terminates at physical A in the final reflected triangle.
  if (activeTriangles.length > 0) {
    // Read the final reflected triangle once for terminal-side coloring.
    const finalTri = activeTriangles[activeTriangles.length - 1];
    // A singular endpoint at A can touch either side incident to physical A.
    for (const terminalEdge of getEdgesForAngle(0)) {
      // Color terminal-side vertices without letting endpoint coordinates become obstructions.
      propagateTowerEdgeRoles(state, finalTri, terminalEdge, labelsMap, `terminal side ${EDGE_TO_SIDE[terminalEdge]}`);
    }
  }

  // Uncolored occurrences indicate a side sequence that does not define a complete tower strip.
  const uncolored = [];
  // Walk every triangle occurrence, including C vertices, to find missing formal colors.
  for (const tri of allTris) {
    // Every physical A/B/C occurrence should receive a formal color.
    for (let vertexIdx = 0; vertexIdx < 3; vertexIdx++) {
      // Skip malformed triangle points defensively.
      if (!tri.points[vertexIdx]) continue;
      // Build the occurrence record without assigning a role.
      const record = buildTowerVertexRecord(tri, vertexIdx, labelsMap, null, 'uncolored vertex');
      // Missing role records are validator failures rather than silently ignored vertices.
      if (!state.byOccurrence.has(record.key)) uncolored.push(record);
    }
  }

  // Return the formal coloring and any data-quality failures found along the way.
  return { byOccurrence: state.byOccurrence, conflicts: state.conflicts, uncolored };
};

/** Computes the y value of the visual shot line at a point's x coordinate. */
const getShotLineYAtX = (point, shotGeometry) => {
  // A vertical shot line has no single y value for a supplied x coordinate.
  if (Math.abs(shotGeometry.lineDx) < 1e-12) return null;
  // Slope of the visual shot line in mathematical coordinates.
  const slope = shotGeometry.lineDy / shotGeometry.lineDx;
  // Standard point-slope line evaluation at the vertex x coordinate.
  return shotGeometry.startShot.y + slope * (point.x - shotGeometry.startShot.x);
};

/** Validates the unfolded code tower by testing every formal blue/black vertex against the shot line. */
const buildPoolshotTowerValidation = ({ simulatorMode, baseTriangle, activeTriangles, labelsMap, reflectionEdges = [], parsedSequence = [], clearanceEpsilon, extraViolations = [] }) => {
  // The idle state keeps ray mode and empty code mode visually quiet.
  if (simulatorMode !== 'code' || activeTriangles.length === 0) {
    // Return a complete shape so consumers never need null checks.
    return { status: 'idle', checked: 0, violations: [], stats: { blue: 0, red: 0, uncolored: 0, endpoints: 0, invalid: 0, epsilonBand: 0, lineMargin: 0, fanChecked: 0, fanMaxCentralAngle: 0, fanMaxRatio: 0 }, byOccurrence: new Map(), shotGeometry: getShotGeometry(baseTriangle, activeTriangles, labelsMap), lineTolerance: 0 };
  }

  // Build the shot vector once for every direct line calculation.
  const shotGeometry = getShotGeometry(baseTriangle, activeTriangles, labelsMap);
  // Convert the user epsilon into the direct y-coordinate tolerance used below.
  const lineTolerance = getLineYTolerance(clearanceEpsilon);
  // Coordinate endpoint matching excludes singular start/final points from obstruction checks.
  const endpointTolerance = getShotEndpointTolerance(shotGeometry.lineLength);

  // A zero-length vector cannot define a shot line.
  if (shotGeometry.lineLength < 1e-12) {
    // Return an invalid trajectory-level violation for the sidebar.
    return {
      // The vector is invalid because it cannot define a line.
      status: 'invalid',
      // No actual vertices can be checked without a usable vector.
      checked: 0,
      // The synthetic violation explains the failure.
      violations: [{ triId: 'trajectory', symbol: shotGeometry.shotSymbol, vertexName: 'A', expected: 'nonzero shot vector', score: 0, side: 0, point: shotGeometry.startShot, role: 'trajectory' }],
      // Stats remain mostly zero because no point loop ran.
      stats: { blue: 0, red: 0, uncolored: 0, endpoints: 0, invalid: 1, epsilonBand: 0, lineMargin: 0, fanChecked: 0, fanMaxCentralAngle: 0, fanMaxRatio: 0 },
      // Occurrence map stays empty because there are no point classifications.
      byOccurrence: new Map(),
      // The caller still needs the degenerate shot geometry for rendering.
      shotGeometry,
      // The y-line tolerance is exposed for diagnostics.
      lineTolerance
    };
  }

  // A vertical shot line cannot support the requested y_line(x) comparison.
  if (Math.abs(shotGeometry.lineDx) < 1e-12) {
    // Return an invalid trajectory-level violation instead of using a different predicate.
    return {
      // The vector is invalid for this validator because y_line(x) is undefined.
      status: 'invalid',
      // No vertices are checked because the line equation cannot be evaluated by x.
      checked: 0,
      // The synthetic violation explains the failure.
      violations: [{ triId: 'trajectory', symbol: shotGeometry.shotSymbol, vertexName: 'line', expected: 'nonvertical shot line for y-at-x test', score: 0, side: 0, point: shotGeometry.startShot, role: 'trajectory' }],
      // Stats remain mostly zero because no point loop ran.
      stats: { blue: 0, red: 0, uncolored: 0, endpoints: 0, invalid: 1, epsilonBand: 0, lineMargin: 0, fanChecked: 0, fanMaxCentralAngle: 0, fanMaxRatio: 0 },
      // Occurrence map stays empty because there are no point classifications.
      byOccurrence: new Map(),
      // The caller still needs the shot geometry for rendering.
      shotGeometry,
      // The tolerance is still exposed for diagnostics.
      lineTolerance
    };
  }

  // Build formal tower colors from the reflection side sequence.
  const towerColoring = buildTowerColoring({ baseTriangle, activeTriangles, labelsMap, reflectionEdges });
  // Convert the current physical triangle into symbolic x/y/z angle values.
  const symbolAngles = getSymbolAngleDegreesFromTriangle(baseTriangle, labelsMap);
  // Validate every numeric code block as a fan central-angle constraint.
  const fanValidation = buildFanConstraintValidation({ parsedSequence, symbolAngles });
  // Validate the base triangle and every reflected copy.
  const allTris = [baseTriangle, ...activeTriangles];
  // Keep all classifications keyed by occurrence so C vertices are tracked across movement.
  const byOccurrence = new Map();
  // Keep only the first few violations for readable sidebar output.
  const violations = [];
  // Count every A/B/C occurrence inspected.
  let checked = 0;
  // Count formal blue vertices.
  let blue = 0;
  // Count formal black vertices.
  let red = 0;
  // Count vertices that never received a formal tower color.
  let uncolored = 0;
  // Count singular start/final endpoint coordinates ignored by the obstruction test.
  let endpoints = 0;
  // Count invalid classifications without relying on the truncated violation list.
  let invalid = fanValidation.invalid + extraViolations.length;
  // Count vertices that participate in the epsilon overlap band.
  let epsilonBand = 0;
  // Track the smallest absolute valid-side y gap over all checked colored vertices.
  let lineSideMargin = Infinity;
  // Add code-path consistency failures before point-level violations.
  for (const violation of extraViolations) {
    // Keep the inspector readable by truncating visible code-path violations.
    if (violations.length < 12) violations.push({ ...violation, point: null });
  }

  // Add fan central-angle failures before point-level violations.
  for (const violation of fanValidation.violations) {
    // Keep the inspector readable by truncating visible fan violations.
    if (violations.length < 12) {
      // Convert the fan failure into the same visible violation shape.
      violations.push({ triId: `fan-${violation.index + 1}`, symbol: violation.step.angle, vertexName: `${violation.step.count}${violation.step.angle}`, expected: violation.expected, score: violation.centralAngle, side: violation.centralAngle, point: null, role: 'fan-constraint' });
    }
  }

  // Adds a visible violation while keeping the sidebar bounded.
  const addViolation = (classification, expected) => {
    // Count this occurrence as invalid only once.
    if (classification.valid) invalid++;
    // Mark the classification invalid for marker rendering.
    classification.valid = false;
    // Store the human-readable expectation.
    classification.expected = expected;
    // Invalid vertices receive a strong red ring.
    classification.ring = '#7f1d1d';
    // Only keep a short visible list in the inspector.
    if (violations.length < 12) {
      // Preserve enough context to debug the exact offending occurrence.
      violations.push({ triId: classification.triId, symbol: classification.symbol, vertexName: classification.vertexName, expected, score: classification.score, side: classification.score, point: classification.point, role: classification.role });
    }
  };

  // Walk every triangle copy in unfolded order.
  for (const tri of allTris) {
    // Check every physical vertex, not only the symbolic fan endpoints.
    for (let vertexIdx = 0; vertexIdx < 3; vertexIdx++) {
      // Pull the current physical vertex point.
      const point = tri.points[vertexIdx];
      // Skip malformed triangles defensively.
      if (!point) continue;
      // Pull the symbolic label attached to this physical vertex.
      const symbol = labelsMap[vertexIdx] || getPhysicalVertexName(vertexIdx);
      // Occurrence keys do not depend on coordinates, so changed C vertices are still tracked.
      const occurrenceKey = getClearanceOccurrenceKey(tri.id, vertexIdx, symbol);
      // Read the formal tower color assigned by reflection-side propagation.
      const roleRecord = towerColoring.byOccurrence.get(occurrenceKey);
      // Evaluate the drawn shot line at this vertex's x coordinate.
      const lineY = getShotLineYAtX(point, shotGeometry);
      // Score is positive when the vertex is above the drawn shot line.
      const score = point.y - lineY;
      // Shot endpoints are singular endpoints, not interior vertex obstructions.
      const isShotEndpoint = isShotEndpointCoordinate(point, shotGeometry, endpointTolerance);
      // Endpoint vertices render red; all others render their formal tower role.
      const vertexColor = isShotEndpoint ? ENDPOINT_VERTEX_COLOR : getTowerRoleColor(roleRecord?.role);
      // Black and red markers need light label text for legibility.
      const markerTextColor = isShotEndpoint || roleRecord?.role === TOWER_BLACK_ROLE ? '#fff1f2' : '#07111f';
      // Black markers get a light ring so they remain visible on the dark canvas.
      const markerRing = isShotEndpoint ? '#7f1d1d' : roleRecord?.role === TOWER_BLACK_ROLE ? '#f8fafc' : '#0f172a';
      // Build the renderable classification for this occurrence.
      const classification = {
        // Stable occurrence key used by marker rendering.
        key: occurrenceKey,
        // Triangle id shown in the violation list.
        triId: tri.id,
        // Physical vertex index is retained for future debugging.
        vertexIdx,
        // Physical vertex name keeps A/B/C tracking explicit.
        vertexName: getPhysicalVertexName(vertexIdx),
        // Symbolic label is shown beside the physical vertex name.
        symbol,
        // Current point is stored for marker placement.
        point,
        // Formal role comes from the tower-color graph.
        role: roleRecord?.role || 'uncolored',
        // Score is y(vertex) - y_line(vertex.x), matching the requested direct test.
        score,
        // Store the line y value for debugging and future UI details.
        lineY,
        // Endpoint coordinates remain colored but are ignored by the line-side margin.
        isShotEndpoint,
        // Every occurrence starts valid so one failure path counts it exactly once.
        valid: true,
        // The default expectation is the direct color-vs-line predicate.
        expected: 'blue above line and black below line',
        // Vertex fill color follows formal role, not current side of the drawn line.
        color: vertexColor,
        // Marker label color is chosen against the marker fill color.
        textColor: markerTextColor,
        // Valid vertices get a dark low-emphasis ring until a failure path updates them.
        ring: markerRing
      };
      // Store the classification by stable occurrence for marker rendering.
      byOccurrence.set(occurrenceKey, classification);
      // Count this inspected vertex occurrence.
      checked++;
      // Endpoint coordinates are displayed but do not affect validity.
      if (isShotEndpoint) {
        // Count ignored endpoints for diagnostics.
        endpoints++;
        // Skip line-margin and uncolored checks for singular endpoints.
        continue;
      }
      // Count and track blue vertices.
      if (classification.role === TOWER_BLUE_ROLE) {
        // Increment blue total.
        blue++;
        // Blue vertices must sit strictly above the shot line at their x coordinate.
        if (score <= lineTolerance) {
          // Count near-line and wrong-side blue vertices for diagnostics.
          epsilonBand++;
          // Mark this blue vertex as invalid.
          addViolation(classification, 'blue y > line y');
        } else {
          // Store the tightest positive blue clearance.
          lineSideMargin = Math.min(lineSideMargin, score);
        }
      } else if (classification.role === TOWER_BLACK_ROLE) {
        // Increment formal black total.
        red++;
        // Black vertices must sit strictly below the shot line at their x coordinate.
        if (score >= -lineTolerance) {
          // Count near-line and wrong-side black vertices for diagnostics.
          epsilonBand++;
          // Mark this black vertex as invalid.
          addViolation(classification, 'black y < line y');
        } else {
          // Store the tightest positive black clearance below the line.
          lineSideMargin = Math.min(lineSideMargin, -score);
        }
      } else {
        // Count missing formal colors separately from line-side failures.
        uncolored++;
        // Uncolored vertices are invalid because every tower vertex must be classified.
        addViolation(classification, 'formal blue/black tower color');
      }
    }
  }

  // Report tower-color contradictions as validation failures.
  for (const conflict of towerColoring.conflicts) {
    // A conflict at either singular shot endpoint cannot obstruct or invalidate the line.
    if (conflict.point && isShotEndpointCoordinate(conflict.point, shotGeometry, endpointTolerance)) continue;
    // Count each conflict in the invalid total.
    invalid++;
    // Keep the sidebar readable.
    if (violations.length < 12) {
      // Convert the propagation conflict into the same visible violation shape.
      violations.push({ triId: conflict.triId, symbol: conflict.symbol, vertexName: conflict.vertexName, expected: `tower role ${conflict.expected}`, score: 0, side: 0, point: conflict.point, role: conflict.role || 'tower-conflict' });
    }
  }

  // If no colored non-endpoint vertices were checked, report a zero line margin.
  const lineMargin = Number.isFinite(lineSideMargin) ? lineSideMargin : 0;

  // The shot is valid exactly when every direct color-vs-line predicate passed.
  return {
    // Validity is based on the full invalid count.
    status: invalid === 0 ? 'valid' : 'invalid',
    // Checked counts every A/B/C occurrence in the tower.
    checked,
    // Violations hold the first several failures for the inspector.
    violations,
    // Stats expose category totals without rewalking vertices.
    stats: { blue, red, uncolored, endpoints, invalid, epsilonBand, lineMargin, fanChecked: fanValidation.checked, fanMaxCentralAngle: fanValidation.maxCentralAngle, fanMaxRatio: fanValidation.maxRatio },
    // byOccurrence lets rendering and locked edits track physical A/B/C occurrences.
    byOccurrence,
    // shotGeometry keeps all endpoint-vector data in one place.
    shotGeometry,
    // lineTolerance records the exact epsilon used by the direct y-line predicate.
    lineTolerance
  };
};

/** Compares two physical-to-symbol maps for exact current-mapping preservation. */
const haveSameLabelMap = (left, right) => {
  // All three physical vertices must retain their symbolic labels.
  return [0, 1, 2].every(idx => left[idx] === right[idx]);
};

/** Compares two side sequences for exact unfolding preservation. */
const haveSameSideSequence = (left, right) => {
  // A sequence length change means the same code no longer unfolded the same way.
  if (left.length !== right.length) return false;
  // Every side number must match in order.
  return left.every((side, idx) => side === right[idx]);
};

/** Converts the current physical angle inputs into symbolic x/y/z angle values. */
const getSymbolAngleValues = (angleParams, labelsMap) => {
  // Physical A is directly entered in angle mode.
  const physicalA = Number(angleParams.a);
  // Physical B is directly entered in angle mode.
  const physicalB = Number(angleParams.b);
  // Physical C is implicit from the Euclidean angle sum.
  const physicalC = 180 - physicalA - physicalB;
  // Build the reverse map from symbolic labels to physical angle values.
  const bySymbol = {
    // Physical vertex 0 carries this symbol's angle.
    [labelsMap[0]]: physicalA,
    // Physical vertex 1 carries this symbol's angle.
    [labelsMap[1]]: physicalB,
    // Physical vertex 2 carries this symbol's angle.
    [labelsMap[2]]: physicalC
  };
  // Return numeric values in theorem-style x/y/z naming.
  return { x: bySymbol.x, y: bySymbol.y, z: bySymbol.z };
};

/** Converts symbolic x/y/z angle values back into the physical A/B input fields. */
const buildAngleParamsFromSymbolValues = (symbolAngles, labelsMap, length) => {
  // Physical A should receive whichever symbolic angle label is mapped to vertex 0.
  const physicalA = symbolAngles[labelsMap[0]];
  // Physical B should receive whichever symbolic angle label is mapped to vertex 1.
  const physicalB = symbolAngles[labelsMap[1]];
  // Return angle-input state compatible with the existing base-triangle builder.
  return { a: physicalA, b: physicalB, length };
};

/** Runs a bounded local BFS/DFS-style search for a stable symbolic x/y region. */
const findStableRegion = ({ angleParams, labelsMap, billiardsCode, currentCodeData, clearanceEpsilon }) => {
  // Region search only makes sense when the current angle inputs are numeric.
  if (!hasCompleteAngleParams(angleParams) || !hasValidAngleTriangle(angleParams)) {
    // Report a clean failure instead of searching around malformed inputs.
    return { status: 'error', message: 'Angle mode needs positive A, B, and C before region search.', visits: 0 };
  }

  // Read the current symbolic x/y/z values from the physical angle inputs.
  const center = getSymbolAngleValues(angleParams, labelsMap);
  // Guard against missing labels from malformed code data.
  if (![center.x, center.y, center.z].every(Number.isFinite)) {
    // Report a clean failure if x/y/z cannot be recovered.
    return { status: 'error', message: 'Could not map current physical angles to symbolic x/y/z.', visits: 0 };
  }

  // Preserve the current base length while perturbing only symbolic angles.
  const length = Number(angleParams.length);
  // Cache candidate validity by rounded x/y coordinate so repeated BFS hits are cheap.
  const validityCache = new Map();
  // Count every candidate evaluation across precision steps.
  let visits = 0;
  // Remember whether any precision step hit its visit cap.
  let capped = false;
  // Store the best interval bounds found at the latest completed precision.
  let bestBounds = null;
  // Start with a symmetric local search window around the current sample.
  let searchWindow = {
    // Minimum symbolic x to examine at the current precision.
    minX: center.x - REGION_SEARCH_RADIUS_DEGREES,
    // Maximum symbolic x to examine at the current precision.
    maxX: center.x + REGION_SEARCH_RADIUS_DEGREES,
    // Minimum symbolic y to examine at the current precision.
    minY: center.y - REGION_SEARCH_RADIUS_DEGREES,
    // Maximum symbolic y to examine at the current precision.
    maxY: center.y + REGION_SEARCH_RADIUS_DEGREES
  };

  // Evaluates one symbolic x/y grid point with mapping and side-sequence preservation.
  const isCandidateValid = (x, y, precision) => {
    // The cache key includes precision because snapped coordinates differ by step.
    const cacheKey = `${precision}:${x.toFixed(precision)},${y.toFixed(precision)}`;
    // Return cached results when the BFS reaches the same point again.
    if (validityCache.has(cacheKey)) return validityCache.get(cacheKey);
    // Candidate z is determined by the Euclidean angle sum.
    const z = 180 - x - y;
    // Reject non-triangular symbolic angle triples immediately.
    if (x <= 0 || y <= 0 || z <= 0) {
      // Cache the rejection for duplicate grid visits.
      validityCache.set(cacheKey, false);
      // Return the rejection.
      return false;
    }

    // Convert symbolic angles back to physical A/B controls using the current mapping.
    const candidateParams = buildAngleParamsFromSymbolValues({ x, y, z }, labelsMap, length);
    // Build the candidate triangle without mutating React state.
    const candidateTriangle = buildBaseTriangle('angles', [], candidateParams);
    // Unfold the same code against the candidate triangle.
    const candidateCodeData = unfoldCodeData(billiardsCode, candidateTriangle, true);
    // Require the symbolic-to-physical assignment to remain unchanged.
    const sameLabels = haveSameLabelMap(candidateCodeData.idxToAngle, labelsMap);
    // Require the side sequence to remain unchanged so the same code path is being tested.
    const sameSides = haveSameSideSequence(candidateCodeData.sideSequence, currentCodeData.sideSequence);
    // Candidate validity uses the same direct blue/black line validator as the live view.
    const candidateValidation = buildPoolshotTowerValidation({ simulatorMode: 'code', baseTriangle: candidateTriangle, activeTriangles: candidateCodeData.triangles, labelsMap: candidateCodeData.idxToAngle, reflectionEdges: candidateCodeData.reflectionEdges, parsedSequence: candidateCodeData.parsedSequence, clearanceEpsilon });
    // The sample is valid only when mapping, unfolding, and the line test all agree.
    const valid = sameLabels && sameSides && candidateValidation.status === 'valid';
    // Cache the computed result.
    validityCache.set(cacheKey, valid);
    // Return the computed result to the BFS.
    return valid;
  };

  // Run progressively finer local searches.
  for (const step of REGION_SEARCH_STEPS) {
    // Decimal precision needs enough digits to key snapped grid points.
    const precision = Math.max(0, Math.ceil(-Math.log10(step))) + 3;
    // Snap helper prevents floating drift from creating duplicate grid nodes.
    const snap = (value) => Number(value.toFixed(precision));
    // Seed the search at the current symbolic angle pair.
    const queue = [{ x: snap(center.x), y: snap(center.y) }];
    // Track visited nodes at this precision only.
    const seen = new Set();
    // Bounds collect valid samples found at this precision.
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    // Count valid samples found at this precision.
    let validSamples = 0;
    // Count visited nodes at this precision.
    let stepVisits = 0;

    // Search a connected component of valid grid points around the current sample.
    while (queue.length > 0 && stepVisits < REGION_SEARCH_MAX_VISITS_PER_STEP) {
      // Shift gives BFS order; the bounded connected-component result is what matters.
      const node = queue.shift();
      // Build a stable key for this snapped x/y sample.
      const key = `${node.x.toFixed(precision)},${node.y.toFixed(precision)}`;
      // Skip repeated nodes produced by neighboring samples.
      if (seen.has(key)) continue;
      // Mark this grid node visited.
      seen.add(key);
      // Ignore nodes outside the current local search window.
      if (node.x < searchWindow.minX || node.x > searchWindow.maxX || node.y < searchWindow.minY || node.y > searchWindow.maxY) continue;
      // Count this as an evaluated visit.
      stepVisits++;
      // Count this across all precision steps for reporting.
      visits++;
      // Reject invalid samples without expanding their neighbors.
      if (!isCandidateValid(node.x, node.y, precision)) continue;
      // Count this valid sample.
      validSamples++;
      // Expand the valid x interval.
      bounds.minX = Math.min(bounds.minX, node.x);
      // Expand the valid x interval.
      bounds.maxX = Math.max(bounds.maxX, node.x);
      // Expand the valid y interval.
      bounds.minY = Math.min(bounds.minY, node.y);
      // Expand the valid y interval.
      bounds.maxY = Math.max(bounds.maxY, node.y);
      // Push the neighboring grid samples for connected-component exploration.
      queue.push({ x: snap(node.x + step), y: node.y });
      // Push the neighboring grid samples for connected-component exploration.
      queue.push({ x: snap(node.x - step), y: node.y });
      // Push the neighboring grid samples for connected-component exploration.
      queue.push({ x: node.x, y: snap(node.y + step) });
      // Push the neighboring grid samples for connected-component exploration.
      queue.push({ x: node.x, y: snap(node.y - step) });
    }

    // Mark the result as capped if this precision exhausted its visit allowance.
    if (queue.length > 0 && stepVisits >= REGION_SEARCH_MAX_VISITS_PER_STEP) capped = true;
    // Stop immediately if the current center is not valid at this precision.
    if (validSamples === 0) {
      // Return a no-region result with the precision that failed.
      return { status: 'none', message: `No valid connected region found at step ${step}.`, visits, capped };
    }

    // Store the best bounds from this precision.
    bestBounds = { ...bounds, step };
    // Restrict the next search to a narrow expansion around the latest valid component.
    searchWindow = {
      // Permit one coarse margin around the discovered component for boundary refinement.
      minX: bounds.minX - step,
      // Permit one coarse margin around the discovered component for boundary refinement.
      maxX: bounds.maxX + step,
      // Permit one coarse margin around the discovered component for boundary refinement.
      minY: bounds.minY - step,
      // Permit one coarse margin around the discovered component for boundary refinement.
      maxY: bounds.maxY + step
    };
  }

  // If every precision somehow failed to set bounds, report no region.
  if (!bestBounds) {
    // This is defensive because the loop normally returns earlier.
    return { status: 'none', message: 'No stable samples were found.', visits, capped };
  }

  // Convert closed grid sample bounds into open intervals by stepping just outside them.
  const intervals = {
    // Open x interval lower endpoint.
    xMin: bestBounds.minX - bestBounds.step,
    // Open x interval upper endpoint.
    xMax: bestBounds.maxX + bestBounds.step,
    // Open y interval lower endpoint.
    yMin: bestBounds.minY - bestBounds.step,
    // Open y interval upper endpoint.
    yMax: bestBounds.maxY + bestBounds.step
  };

  // Return the final bounded local region estimate.
  return { status: 'found', intervals, step: bestBounds.step, visits, capped };
};


// ==========================================
// MAIN APPLICATION COMPONENT
// ==========================================

export default function App() {
  // --- APP STATE VARIABLES ---
  // Light mode is the default; a saved dark preference is honored after the user chooses it.
  const [theme, setTheme] = useState(() => (
    window.localStorage.getItem('unfolder-theme') === 'dark' ? 'dark' : 'light'
  ));
  // A boolean keeps toggle rendering readable.
  const isDarkTheme = theme === 'dark';
  // SVG presentation attributes need direct palette values.
  const themePalette = THEME_PALETTES[theme];
  // Two modes share the same viewer: geometric ray tracing and code unfolding.
  const [simulatorMode, setSimulatorMode] = useState('code'); 
  // The base triangle can be entered as coordinates or as two angles plus length.
  const [baseInputMode, setBaseInputMode] = useState('angles'); 
  // Base length is the only piece of the old "angleParams" that is still
  // genuinely shared across every row — Angle A/B now live per-row (see
  // `sequences` below) so each row can have its own main-canvas point.
  const [baseTriangleLength, setBaseTriangleLength] = useState(10);
  // Angle increment controls the native number-stepper amount for Angle A and Angle B.
  const [angleIncrementInput, setAngleIncrementInput] = useState(String(DEFAULT_ANGLE_INCREMENT));
  // This separate increment controls the native stepper attached to the Angle Step field itself.
  const [angleStepControlIncrementInput, setAngleStepControlIncrementInput] = useState(String(DEFAULT_ANGLE_STEP_CONTROL_INCREMENT));
  // Coordinate defaults create a right-ish triangle for immediate manual testing.
  const [baseCoordsInput, setBaseCoordsInput] = useState([
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 5 } 
  ]);
  
  // --- RAY SIMULATOR SPECIFIC STATE ---
  // Physical vertex index used as the origin in direct ray mode.
  const [rayStartVertex, setRayStartVertex] = useState(0); 
  // Ray-mode angle is stored in degrees because that is what the UI exposes.
  const [rayAngle, setRayAngle] = useState(60); 
  // Ray-mode bounce limit prevents accidental infinite or huge unfoldings.
  const [maxBounces, setMaxBounces] = useState(15); 
  
  // --- CODE UNFOLDER SPECIFIC STATE ---
  // Desmos-style sequence list: each row is one independent bounce-code
  // unfolding (its own text, Angle Step, color, visibility). The row that
  // was previously the app's only sequence becomes "Graph 1" here so no
  // existing work is lost when this feature is introduced. A ref (not
  // state) tracks the next creation number so labels/colors stay stable
  // and never renumber when an earlier row is deleted.
  const nextSequenceNumberRef = useRef(2);
  const [sequences, setSequences] = useState(() => [
    createSequenceRow({ number: 1, sequenceText: "3 1 7 2 6 2 8 2 4 2", angleStepInput: String(DEFAULT_ANGLE_INCREMENT), angleA: 15, angleB: 50 })
  ]);
  // The active row drives the main unfolding canvas, the Angle A/B guarded
  // edits, and the Constrained/Ghost/Search tools below — exactly what
  // `billiardsCode` alone used to drive before this row list existed.
  const [activeSequenceId, setActiveSequenceId] = useState('seq-1');
  const activeSequence = sequences.find(s => s.id === activeSequenceId) || sequences[0];
  // `angleParams` is now derived, not stored: Angle A/B come from whichever
  // row is active (so the main canvas always reflects that row's own
  // angles) while base length stays the one value every row shares. Every
  // existing reader of `angleParams` (buildBaseTriangle, the guarded-edit
  // validators, findStableRegion, etc.) keeps working unchanged against
  // this same {a, b, length} shape.
  const angleParams = useMemo(() => ({
    a: activeSequence?.angleA ?? 15,
    b: activeSequence?.angleB ?? 50,
    length: baseTriangleLength,
  }), [activeSequence, baseTriangleLength]);
  // Space-separated integer blocks are parsed into symbolic angle runs.
  // Kept as a read-only alias (instead of renaming every downstream use)
  // so the rest of this file's geometry/validation logic, which predates
  // the multi-sequence feature, keeps working unchanged against "whichever
  // sequence is active" exactly as it did against the old single value.
  const billiardsCode = activeSequence?.sequenceText ?? '';
  // Constrained rejects invalid guarded edits; Ghost allows invalid inspection.
  const [shotEditMode, setShotEditMode] = useState(SHOT_MODE_LOCKED);
  // Epsilon is stored as text so scientific notation remains editable.
  const [clearanceEpsilonInput, setClearanceEpsilonInput] = useState(String(DEFAULT_CLEARANCE_EPSILON));
  // A rejected locked edit reports what was blocked without changing geometry.
  const [lockedShotNotice, setLockedShotNotice] = useState(null);
  // Plain-English pop-up for a rejected sequence/angle apply: { title, message, focusId }.
  const [errorModal, setErrorModal] = useState(null);
  // Sequence-text <input> elements by row id, so the error modal can return
  // focus to the exact row that was rejected once it's dismissed.
  const sequenceInputRefsRef = useRef({});
  // The latest stable-region search result is shown until inputs change.
  const [stableRegionResult, setStableRegionResult] = useState(null);
  // Ghost mode compares edits against the constrained path captured when Ghost starts.
  const [shotPathReference, setShotPathReference] = useState(null);
  // Persistent labels are useful for debugging dense unfolded fans.
  const [showAllLabels, setShowAllLabels] = useState(false);
  // Display decimals are editable text so the field can be cleared/retyped without fighting React.
  const [displayPrecisionInput, setDisplayPrecisionInput] = useState(String(DEFAULT_DISPLAY_DECIMALS));
  // Controls whether the "Valid Angle A-B Region" pop-up is mounted.
  const [isAnglePlotOpen, setIsAnglePlotOpen] = useState(false);
  // Bumped on every "Plot Valid Angle Region" click so an already-open window
  // regenerates and comes to the front instead of a duplicate window opening.
  const [anglePlotRequestId, setAnglePlotRequestId] = useState(0);

  // --- VIEWPORT & INTERACTION STATE ---
  // Ref to the canvas container lets us measure available SVG pixels.
  const containerRef = useRef(null); 
  // SVG size mirrors the measured container and drives viewport math.
  const [svgSize, setSvgSize] = useState({ width: 800, height: 600 }); 
  // Pan stores the mathematical coordinate at the center of the canvas.
  const [pan, setPan] = useState({ x: 5, y: 4 }); 
  // Zoom stores pixels per mathematical unit.
  const [zoom, setZoom] = useState(35);
  // When locked, trackpad/mouse-wheel gestures no longer change zoom (avoids accidental large jumps).
  const [isZoomLocked, setIsZoomLocked] = useState(false);
  // User-entered multiplier applied when the manual zoom button is clicked.
  const [zoomMagnification, setZoomMagnification] = useState('2');

  // Drag state controls panning and cursor feedback.
  const [isDragging, setIsDragging] = useState(false); 
  // The previous mouse point is a ref because it should not cause re-renders.
  const lastMouse = useRef({ x: 0, y: 0 }); 
  // Screen-space mouse position drives hover labels.
  const [mousePos, setMousePos] = useState({ x: -1000, y: -1000 }); 

  // Persist the user's explicit theme choice and expose it for browser color-scheme defaults.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('unfolder-theme', theme);
  }, [theme]);

  // Mount/Resize observer
  useEffect(() => {
    // Measure lazily so the SVG fills whatever flex space the layout gives it.
    const measure = () => {
      // The ref is null until React mounts the canvas container.
      if (containerRef.current) {
        // Browser layout is authoritative for the final canvas dimensions.
        const { width, height } = containerRef.current.getBoundingClientRect();
        // Store dimensions in React state so grid and transforms recompute.
        setSvgSize({ width, height });
      }
    };
    // Measure immediately after mount.
    measure();
    // Re-measure when the browser viewport changes.
    window.addEventListener('resize', measure);
    // Remove the listener on unmount to avoid stale callbacks.
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Hardware-accelerated zoom block 
  useEffect(() => {
    // The wheel listener must be attached directly so it can prevent default scroll.
    const container = containerRef.current;
    // Skip setup until the DOM node exists.
    if (!container) return;
    // Wheel zoom changes only the scale; it does not recenter around the mouse yet.
    const handleWheel = (e) => {
      // Prevent the page from scrolling while the user zooms the canvas.
      e.preventDefault();
      // Locked mode ignores trackpad/wheel gestures entirely to avoid accidental large zoom jumps.
      if (isZoomLocked) return;
      // Constant multiplicative zoom feels natural over large coordinate ranges.
      const zoomFactor = 1.1;
      // Browser wheel deltas are positive for scroll down, which we treat as zoom out.
      const direction = e.deltaY > 0 ? -1 : 1;
      // Clamp zoom to keep SVG stroke math and interaction usable.
      setZoom(prev => Math.max(0.5, Math.min(prev * (direction > 0 ? zoomFactor : 1 / zoomFactor), 5000)));
    };
    // passive:false is required because handleWheel calls preventDefault.
    container.addEventListener('wheel', handleWheel, { passive: false });
    // Remove the exact listener when dependencies change or the app unmounts.
    return () => container.removeEventListener('wheel', handleWheel);
  }, [isZoomLocked]);


  // --- DYNAMIC GEOMETRY GENERATION ---

  const clearanceEpsilon = useMemo(() => {
    // Parse the editable text field into a numeric perpendicular-distance tolerance.
    const parsed = Number(clearanceEpsilonInput);
    // Invalid or negative input falls back to the documented default.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CLEARANCE_EPSILON;
  }, [clearanceEpsilonInput]);

  const displayPrecision = useMemo(() => {
    // Parse integer decimal places from the editable display precision field.
    const parsed = Number(displayPrecisionInput);
    // Blank or malformed precision falls back to the documented twelve-decimal default.
    if (!Number.isFinite(parsed)) return DEFAULT_DISPLAY_DECIMALS;
    // Fractional decimal counts are rounded down because toFixed() expects an integer.
    const integerPrecision = Math.trunc(parsed);
    // Clamp to the useful range for IEEE-754 browser numbers.
    return Math.max(0, Math.min(integerPrecision, MAX_DISPLAY_DECIMALS));
  }, [displayPrecisionInput]);

  const angleInputStep = useMemo(() => {
    // Nonpositive or malformed step sizes fall back without mutating what the user typed.
    return resolvePositiveInputStep(angleIncrementInput, DEFAULT_ANGLE_INCREMENT);
  }, [angleIncrementInput]);

  const angleStepControlIncrement = useMemo(() => {
    // Resolve the independently configurable native increment for the Angle Step control.
    return resolvePositiveInputStep(angleStepControlIncrementInput, DEFAULT_ANGLE_STEP_CONTROL_INCREMENT);
  }, [angleStepControlIncrementInput]);

  const formatFixed = (value) => {
    // Non-finite geometry values should be visible instead of throwing in toFixed().
    if (!Number.isFinite(value)) return String(value);
    // Use the current user-selected decimal count for ordinary scalar readouts.
    return value.toFixed(displayPrecision);
  };

  const formatExponential = (value) => {
    // Non-finite diagnostics should be visible instead of throwing in toExponential().
    if (!Number.isFinite(value)) return String(value);
    // Exponential readouts use the same selected decimal count for consistency.
    return value.toExponential(displayPrecision);
  };

  const formatPoint = (point) => {
    // Points are consistently shown as x, y pairs throughout the inspector and hover labels.
    return `${formatFixed(point.x)}, ${formatFixed(point.y)}`;
  };
  
  const baseTriangle = useMemo(() => {
    // Use the shared pure builder so live rendering and candidate validation match.
    return { ...buildBaseTriangle(baseInputMode, baseCoordsInput, angleParams), color: themePalette.baseTriangle }; 
  }, [baseCoordsInput, baseInputMode, angleParams, themePalette.baseTriangle]);


  const rayData = useMemo(() => {
    // In code mode, skip all ray calculations and expose a harmless empty result.
    if (simulatorMode !== 'ray') return { triangles: [], rayLine: null };

    // Work from the current physical base triangle.
    const T0 = baseTriangle.points;
    // Accumulate reflected copies generated by ray intersections.
    const triangles = [];
    
    // Ray origin is the selected physical vertex.
    const O = { ...T0[rayStartVertex] };
    // Convert the displayed degree angle into a unit direction.
    const rad = (rayAngle * Math.PI) / 180;
    const D = { x: Math.cos(rad), y: Math.sin(rad) };

    // currentTri is the unfolded triangle currently containing the ray segment.
    let currentTri = [...T0];
    // currentRayT is the last accepted parameter along O + tD.
    let currentRayT = 0; 

    // Stop after maxBounces even if geometry would continue further.
    for (let i = 0; i < maxBounces; i++) {
      // bestT tracks the nearest future side intersection.
      let bestT = Infinity; 
      // bestEdge tracks which edge produced bestT.
      let bestEdge = null; 

      // Test the infinite ray against each edge segment of the current triangle.
      for (let e = 0; e < 3; e++) {
        // Segment start.
        const V1 = currentTri[e];
        // Segment end, wrapping around for edge 2.
        const V2 = currentTri[(e + 1) % 3];
        // Segment direction.
        const E = { x: V2.x - V1.x, y: V2.y - V1.y }; 
        
        // 2D cross product denominator for ray/segment intersection.
        const denom = D.x * E.y - D.y * E.x;
        // Parallel lines cannot produce a stable crossing.
        if (Math.abs(denom) < 1e-10) continue; 

        // Difference from ray origin to segment start.
        const diff = { x: V1.x - O.x, y: V1.y - O.y };
        // t parameter along the ray.
        const t = (diff.x * E.y - diff.y * E.x) / denom;
        // u parameter along the segment.
        const u = (diff.x * D.y - diff.y * D.x) / denom;

        // Accept only future ray hits that land on the finite segment.
        if (t > currentRayT + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8) {
          // Keep the nearest future hit.
          if (t < bestT) { 
            bestT = t; 
            bestEdge = e; 
          }
        }
      }

      // No future edge was hit, so the unfolded ray leaves the computed region.
      if (bestEdge === null) break; 

      // Convert the winning ray parameter back into coordinates.
      const hitX = O.x + bestT * D.x;
      const hitY = O.y + bestT * D.y;
      // The selected origin vertex is also used as a singular target check.
      const targetVertex = currentTri[rayStartVertex];
      // Squared distance avoids an unnecessary square root.
      const distSq = (hitX - targetVertex.x)**2 + (hitY - targetVertex.y)**2;
      
      // Stop rendering if ray hits a target singularity perfectly
      if (distSq < 1e-10) {
        // Preserve the final parameter for the displayed ray length.
        currentRayT = bestT;
        break;
      }

      // Reflect the triangle across the side the ray crossed.
      const p1 = currentTri[bestEdge];
      const p2 = currentTri[(bestEdge + 1) % 3];
      const p3 = currentTri[(bestEdge + 2) % 3];
      const newP3 = reflectPoint(p3, p1, p2);

      // Preserve edge endpoints and replace only the opposite vertex.
      const nextTri = [];
      nextTri[bestEdge] = { ...p1 };
      nextTri[(bestEdge + 1) % 3] = { ...p2 };
      nextTri[(bestEdge + 2) % 3] = { ...newP3 };

      // Record the displayed reflected triangle.
      triangles.push({
        id: `Ray-T${i+1}`,
        points: nextTri,
        color: COLORS[(i) % COLORS.length]
      });

      // Continue intersecting from the reflected triangle.
      currentTri = nextTri;
      // Advance past the side just hit to avoid re-hitting it immediately.
      currentRayT = bestT;
    }

    // If nothing was hit, draw a ray long enough to be visible in the current viewport.
    let finalT = currentRayT === 0 ? Math.max(svgSize.width, svgSize.height) / zoom : currentRayT;
    // Return both the reflected triangle chain and the visible ray segment.
    return {
      triangles,
      rayLine: { x1: O.x, y1: O.y, x2: O.x + finalT * D.x, y2: O.y + finalT * D.y }
    };
  }, [simulatorMode, baseTriangle, rayStartVertex, rayAngle, maxBounces, svgSize, zoom]);


  const codeData = useMemo(() => {
    // Use the shared pure unfolder so live rendering and candidate validation match.
    return unfoldCodeData(billiardsCode, baseTriangle, simulatorMode === 'code');
  }, [simulatorMode, billiardsCode, baseTriangle]);


  // --- GEOMETRY ROUTER ---
  // Pick the triangle chain produced by the currently selected mode.
  const activeTriangles = simulatorMode === 'ray' ? rayData.triangles : codeData.triangles;
  // Map physical vertex indices back to symbolic labels for UI and validation.
  const labelsMap = codeData.idxToAngle;

  const livePathConsistency = useMemo(() => {
    // Only Ghost mode needs to compare against a captured constrained path.
    if (simulatorMode !== 'code' || shotEditMode !== SHOT_MODE_PREVIEW || !shotPathReference) return { status: 'valid', violations: [] };
    // Validate that the current Ghost geometry still represents the captured code path.
    return buildCodePathConsistencyValidation({ candidateCodeData: codeData, reference: shotPathReference });
  }, [simulatorMode, shotEditMode, shotPathReference, codeData]);

  const shotClearanceValidation = useMemo(() => {
    // Use the shared direct blue/black line validator so live rendering, locked edits, and search agree.
    return buildPoolshotTowerValidation({ simulatorMode, baseTriangle, activeTriangles, labelsMap, reflectionEdges: codeData.reflectionEdges, parsedSequence: codeData.parsedSequence, clearanceEpsilon, extraViolations: livePathConsistency.violations });
  }, [simulatorMode, baseTriangle, activeTriangles, labelsMap, codeData.reflectionEdges, codeData.parsedSequence, clearanceEpsilon, livePathConsistency.violations]);

  // Store the current shot-vector geometry derived by the validator.
  const shotGeometry = shotClearanceValidation.shotGeometry;
  // Keep the current symbolic endpoint label available to sidebar text.
  const shotSymbol = shotGeometry.shotSymbol;
  // Keep the first endpoint available to the SVG shot line.
  const startShot = shotGeometry.startShot;
  // Keep the final endpoint available to the SVG shot line.
  const finalShot = shotGeometry.finalShot;
  // Keep line length available for text and degenerate guards.
  const lineLength = shotGeometry.lineLength;
  // Preview mode ghosting activates only for an invalid code-mode shot.
  const isGhostedShot = simulatorMode === 'code' && shotEditMode === SHOT_MODE_PREVIEW && shotClearanceValidation.status === 'invalid';
  // Ghost-mode shots keep the base guide color when valid and switch to a lighter red when invalid.
  const shotLineVisualColor = isGhostedShot && shotClearanceValidation.status === 'invalid' ? INVALID_SHOT_COLOR : VALID_SHOT_COLOR;

  // Render the full reflected chain, including the triangle containing the final shot endpoint.
  const renderableActiveTriangles = getRenderableActiveTriangles(activeTriangles);

  const getTriangleRenderStyle = (tri) => ({
    color: tri.color,
    strokeColor: '#000000',
    fillOpacity: isGhostedShot ? 0.035 : 0.1,
    strokeOpacity: isGhostedShot ? 0.35 : 1
  });

  // Lookup a rendered point's validation classification without recomputing the scan.
  const getClearancePointValidation = (triId, vertexIdx, symbol) => {
    // Clearance classification applies only to active code-mode shots.
    if (simulatorMode !== 'code' || activeTriangles.length === 0 || lineLength < 1e-12) return null;
    // Build the stable occurrence key used by the validator.
    const occurrenceKey = getClearanceOccurrenceKey(triId, vertexIdx, symbol);
    // Return the existing classification when this occurrence was part of the scan.
    return shotClearanceValidation.byOccurrence.get(occurrenceKey) || null;
  };

  const getShotVertexRenderColor = (validation, fallbackColor = SHOT_VERTEX_ABOVE_LINE_COLOR) => {
    if (!validation) return fallbackColor;
    if (validation.isShotEndpoint) return SHOT_ENDPOINT_FILL_COLOR;
    return validation.score < 0 ? SHOT_VERTEX_BELOW_LINE_COLOR : fallbackColor;
  };

  const clearShotFeedback = () => {
    // Accepted input changes invalidate the previously displayed region search.
    setStableRegionResult(null);
    // Accepted input changes also clear stale locked-shot rejection text.
    setLockedShotNotice(null);
  };

  const resetShotConstraintReference = () => {
    // Input changes that redefine the code or base triangle invalidate the Ghost reference path.
    setShotPathReference(null);
    // Input changes outside the guarded angle path should clear stale feedback.
    // Shared feedback cleanup keeps the inspector from showing stale results.
    clearShotFeedback();
  };

  const validateLockedAngleCandidate = (candidateParams) => {
    // Ghost mode never blocks candidate angle edits.
    if (shotEditMode !== SHOT_MODE_LOCKED) return { allowed: true };
    // Ray mode has no code-mode endpoint shot to protect.
    if (simulatorMode !== 'code') return { allowed: true };
    // Coordinate mode is not the symbolic x/y angle workflow.
    if (baseInputMode !== 'angles') return { allowed: true };
    // Empty code mode has no unfolded shot to protect.
    if (!billiardsCode.trim()) return { allowed: true };
    // Incomplete typing states would replace the constrained geometry with a fallback triangle.
    if (!hasCompleteAngleParams(candidateParams)) return { allowed: false, reason: 'angle input is incomplete' };
    // Non-triangular inputs are rejected in Constrained mode because they destroy the shot.
    if (!hasValidAngleTriangle(candidateParams)) return { allowed: false, reason: 'triangle angles are invalid' };

    // Build the candidate triangle without committing it to React state.
    const candidateTriangle = buildBaseTriangle('angles', baseCoordsInput, candidateParams);
    // Unfold the current code against the candidate triangle.
    const candidateCodeData = unfoldCodeData(billiardsCode, candidateTriangle, true);
    // Preserve the current finite code interpretation instead of accepting a fresh reinterpretation.
    const pathConsistency = buildCodePathConsistencyValidation({ candidateCodeData, reference: buildCodePathReference(codeData) });
    // Validate the candidate against the direct blue/black line rule before render.
    const candidateSelfValidation = buildPoolshotTowerValidation({ simulatorMode: 'code', baseTriangle: candidateTriangle, activeTriangles: candidateCodeData.triangles, labelsMap: candidateCodeData.idxToAngle, reflectionEdges: candidateCodeData.reflectionEdges, parsedSequence: candidateCodeData.parsedSequence, clearanceEpsilon, extraViolations: pathConsistency.violations });
    // Reject any candidate ray that is intrinsically invalid.
    if (candidateSelfValidation.status === 'invalid') {
      // Use the first self-validation violation to explain the rejection.
      const firstViolation = candidateSelfValidation.violations[0];
      // Build a concise human-readable rejection message.
      const reason = firstViolation ? `${firstViolation.triId} ${firstViolation.vertexName || firstViolation.symbol} expected ${firstViolation.expected}` : 'candidate ray failed blue/black line test';
      // Reject before the angle state can render the bad ray.
      return { allowed: false, reason };
    }
    // Valid candidate rays may be committed.
    return { allowed: true };
  };

  // Per-sequence-row equivalent of validateLockedAngleCandidate above, used
  // by the multi-sequence graph pop-up to test an arbitrary (A, B) pair
  // against *any* row's sequence text. Since Angle A/B are now per-row (not
  // one shared value), `referenceAngleParams` lets each row validate
  // candidates against *its own* committed angles as the reference geometry
  // — defaulting to the active row's when omitted, which preserves the
  // single-row behavior this closure originally had. Unlike
  // validateLockedAngleCandidate this intentionally ignores shotEditMode
  // (Ghost/Constrained) — that toggle exists to guard *live edits* to the
  // active row, not to redefine what "valid" means for a plotted region,
  // so every row's graph uses the same Constrained-style validity
  // definition regardless of which mode the active row happens to be in.
  const buildValidateCandidateForSequence = (sequenceText, referenceAngleParams = angleParams) => (candidateParams) => {
    if (!sequenceText || !sequenceText.trim()) return { allowed: false, reason: 'sequence is empty' };
    if (!hasCompleteAngleParams(candidateParams)) return { allowed: false, reason: 'angle input is incomplete' };
    if (!hasValidAngleTriangle(candidateParams)) return { allowed: false, reason: 'triangle angles are invalid' };

    const candidateTriangle = buildBaseTriangle('angles', baseCoordsInput, candidateParams);
    const candidateCodeData = unfoldCodeData(sequenceText, candidateTriangle, true);
    // The reference path is this row's own current committed unfolding
    // (same sequence text, against that row's own committed angles), not
    // necessarily the active row's — each row is validated against itself.
    const referenceTriangle = buildBaseTriangle('angles', baseCoordsInput, referenceAngleParams);
    const committedCodeData = unfoldCodeData(sequenceText, referenceTriangle, true);
    const pathConsistency = buildCodePathConsistencyValidation({ candidateCodeData, reference: buildCodePathReference(committedCodeData) });
    const candidateSelfValidation = buildPoolshotTowerValidation({ simulatorMode: 'code', baseTriangle: candidateTriangle, activeTriangles: candidateCodeData.triangles, labelsMap: candidateCodeData.idxToAngle, reflectionEdges: candidateCodeData.reflectionEdges, parsedSequence: candidateCodeData.parsedSequence, clearanceEpsilon, extraViolations: pathConsistency.violations });
    if (candidateSelfValidation.status === 'invalid') {
      const firstViolation = candidateSelfValidation.violations[0];
      const reason = firstViolation ? `${firstViolation.triId} ${firstViolation.vertexName || firstViolation.symbol} expected ${firstViolation.expected}` : 'candidate ray failed blue/black line test';
      return { allowed: false, reason };
    }
    return { allowed: true };
  };

  // Edits the Angle A/B/Length panel used by the main canvas and the
  // Constrained/Ghost/Search tools below — always operating on the
  // *active* row's angles (Angle A/B) or the one shared base length,
  // exactly what a single global angleParams state used to hold directly.
  const handleAngleParamChange = (field, value) => {
    // Candidate state mirrors what React would store if the edit is accepted.
    const candidateParams = { ...angleParams, [field]: value };
    // Ask Constrained mode whether this candidate can be committed.
    const guard = validateLockedAngleCandidate(candidateParams);
    // Reject invalid candidates before they change the rendered geometry.
    if (!guard.allowed) {
      // Store the blocked field/value and first line-test reason.
      setLockedShotNotice({ field, value, reason: guard.reason });
      // Leave angleParams unchanged so the last valid geometry remains active.
      return;
    }
    // Commit accepted edits to the normal angle state.
    clearShotFeedback();
    if (field === 'length') {
      setBaseTriangleLength(value);
    } else {
      // Angle A/B belong to the active row only; every other row is untouched.
      const rowField = field === 'a' ? 'angleA' : 'angleB';
      setSequences(rows => rows.map(row => row.id === activeSequenceId ? { ...row, [rowField]: value, validationError: null } : row));
    }
  };

  // Per-row equivalent of handleAngleParamChange for the small Angle A/B
  // inputs on each sequence row. Editing the active row's A/B here is
  // identical to editing the big panel above (same Constrained/Ghost guard,
  // same lockedShotNotice banner) since they edit the same underlying
  // value. Editing a *non*-active row has no rendered shot to protect, so
  // it's guarded with the same A>0, B>0, A<B, A+B<=90 rule the "Valid Angle
  // A-B Region" graph already uses for that row (see angleValidation.js's
  // isValidAnglePair), plus that row's own blue/black-line/tower validity
  // via buildValidateCandidateForSequence — checked in the same cheapest-
  // first order so the reported reason matches the actual failure.
  const handleRowAngleChange = (id, field, value) => {
    if (id === activeSequenceId) {
      handleAngleParamChange(field, value);
      return;
    }
    const row = sequences.find(r => r.id === id);
    if (!row) return;
    const candidateA = field === 'a' ? Number(value) : Number(row.angleA);
    const candidateB = field === 'b' ? Number(value) : Number(row.angleB);
    // Cheap geometric checks first, so the message matches the actual
    // failure instead of always blaming A<B/sum<=90 even when those already
    // hold and the real problem is a deeper path/tower-validity failure.
    let reason = null;
    if (!Number.isFinite(candidateA) || !Number.isFinite(candidateB) || candidateA <= 0 || candidateB <= 0) {
      reason = 'Angle A and Angle B must both be positive numbers.';
    } else if (candidateA >= candidateB) {
      reason = 'Angle A must be smaller than Angle B.';
    } else if (candidateA + candidateB > 90) {
      reason = 'Angle A and Angle B must sum to at most 90°.';
    } else {
      const validateCandidate = buildValidateCandidateForSequence(row.sequenceText, { a: row.angleA, b: row.angleB, length: angleParams.length });
      const result = validateCandidate({ a: candidateA, b: candidateB, length: angleParams.length });
      if (!result.allowed) reason = result.reason;
    }
    if (reason) {
      const message = `This sequence cannot be applied because Angle A and Angle B are invalid.\n${reason}`;
      setSequences(rows => rows.map(r => r.id === id ? { ...r, validationError: message } : r));
      setErrorModal({ title: 'Invalid angles', message, focusId: null });
      return;
    }
    setSequences(rows => rows.map(r => r.id === id ? { ...r, angleA: candidateA, angleB: candidateB, validationError: null } : r));
  };

  const handleOpenAnglePlot = () => {
    // Mounting is idempotent (isAnglePlotOpen is already true after the first
    // click), so this can never create a second window; bumping the request
    // id is what makes a second click on an already-open window refresh and
    // surface it instead of doing nothing.
    setIsAnglePlotOpen(true);
    setAnglePlotRequestId(id => id + 1);
  };

  // --- SEQUENCE ROW LIST HANDLERS ---
  // "+ Add Sequence": appends a new, empty, visible row and makes it active
  // (matches "click a row to edit it" — a freshly added row is the one the
  // user almost certainly wants to type into next).
  const handleAddSequence = () => {
    const number = nextSequenceNumberRef.current++;
    const newRow = createSequenceRow({ number, angleStepInput: angleIncrementInput });
    setSequences(rows => [...rows, newRow]);
    setActiveSequenceId(newRow.id);
  };

  // Duplicates a row's full configuration (text, step, visibility) as a new
  // row with its own id/label/color, inserted immediately after the source
  // row, and makes the copy active.
  //
  // Reads/writes `sequences` directly (a plain value, not a setSequences(rows
  // => ...) functional updater) and computes the new row's number/id up
  // front instead of inside the updater. React StrictMode intentionally
  // invokes functional updaters twice in development to catch exactly this
  // class of bug: mutating nextSequenceNumberRef.current (or calling other
  // setState functions) *inside* an updater would run that side effect
  // twice per click, silently skipping a sequence number and briefly
  // pointing setActiveSequenceId at a row from a discarded first pass.
  const handleDuplicateSequence = (id) => {
    const sourceIndex = sequences.findIndex(row => row.id === id);
    if (sourceIndex === -1) return;
    const source = sequences[sourceIndex];
    const number = nextSequenceNumberRef.current++;
    const copy = { ...createSequenceRow({ number, sequenceText: source.sequenceText, angleStepInput: source.angleStepInput, angleA: source.angleA, angleB: source.angleB }), visible: source.visible };
    const next = [...sequences];
    next.splice(sourceIndex + 1, 0, copy);
    setSequences(next);
    setActiveSequenceId(copy.id);
  };

  // Deletes a row. At least one row always exists: deleting the last
  // remaining row replaces it with a fresh blank one instead of leaving an
  // empty list. Deleting the active row hands "active" to a neighbor
  // (prefer the next row, fall back to the previous one) so the main
  // unfolding view always has something to show. See handleDuplicateSequence
  // above for why this reads `sequences` directly instead of using a
  // setSequences functional updater.
  const handleRemoveSequence = (id) => {
    const index = sequences.findIndex(row => row.id === id);
    if (index === -1) return;
    const remaining = sequences.filter(row => row.id !== id);
    const nextRows = remaining.length > 0
      ? remaining
      : [createSequenceRow({ number: nextSequenceNumberRef.current++, angleStepInput: angleIncrementInput })];
    setSequences(nextRows);
    if (activeSequenceId === id) {
      const fallback = remaining[index] || remaining[index - 1] || nextRows[0];
      setActiveSequenceId(fallback.id);
      resetShotConstraintReference();
    }
  };

  // Visibility only hides a row from the graph and skips its background
  // generation — it never discards the row's text/step/cached points.
  const handleToggleSequenceVisible = (id) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, visible: !row.visible } : row));
  };

  const handleShowAllSequences = () => setSequences(rows => rows.map(row => ({ ...row, visible: true })));
  const handleHideAllSequences = () => setSequences(rows => rows.map(row => ({ ...row, visible: false })));

  // Free typing only ever touches the draft buffer — never the applied
  // `sequenceText` that drives the main canvas/graph — so keystrokes
  // (including spaces) never trigger a redraw or get rewritten mid-edit.
  const handleSequenceDraftChange = (id, text) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, draftSequenceText: text } : row));
  };

  // Validates the row's draft and, only if valid, commits it as the applied
  // sequence (Enter or blur). An invalid draft is left exactly as typed —
  // this row's validationError is set (for the "Invalid sequence" row
  // status) and the shared error modal explains why in plain English; nothing
  // about the graph or main canvas changes for an invalid apply.
  const handleApplySequenceDraft = (id) => {
    const row = sequences.find(r => r.id === id);
    if (!row) return;
    if (row.draftSequenceText === row.sequenceText) return;
    const parsed = parseSequenceDraftText(row.draftSequenceText);
    if (!parsed.valid) {
      setSequences(rows => rows.map(r => r.id === id ? { ...r, validationError: parsed.message } : r));
      setErrorModal({ title: parsed.title, message: parsed.message, focusId: id });
      return;
    }
    setSequences(rows => rows.map(r => r.id === id ? { ...r, sequenceText: r.draftSequenceText, validationError: null } : r));
    if (id === activeSequenceId) resetShotConstraintReference();
  };

  // Escape discards the in-progress edit and restores the last applied text.
  const handleCancelSequenceDraft = (id) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, draftSequenceText: row.sequenceText, validationError: null } : row));
  };

  const handleSequenceAngleStepChange = (id, text) => {
    setSequences(rows => rows.map(row => row.id === id ? { ...row, angleStepInput: text } : row));
  };

  // Native color inputs always yield a valid #rrggbb value, but the guard
  // keeps this handler safe if it's ever driven by something else (e.g. a
  // pasted/typed value) — an invalid color is simply ignored, keeping the
  // row's previous valid color. Only the edited row's color changes.
  const handleSequenceColorChange = (id, hex) => {
    if (!isValidHexColor(hex)) return;
    setSequences(rows => rows.map(row => row.id === id ? { ...row, color: hex } : row));
  };

  const closeErrorModal = () => {
    const focusId = errorModal?.focusId;
    setErrorModal(null);
    if (focusId) {
      // Deferred so it runs after the modal has actually unmounted.
      setTimeout(() => sequenceInputRefsRef.current[focusId]?.focus(), 0);
    }
  };

  // "Active" (which row drives the main canvas) is a distinct concept from
  // "visible" (which rows are plotted in the graph) — selecting a row here
  // never touches any row's visibility.
  const handleSelectActiveSequence = (id) => {
    if (id === activeSequenceId) return;
    setActiveSequenceId(id);
    resetShotConstraintReference();
  };

  const handleStableRegionSearch = () => {
    // Store a running state immediately so the button gives feedback during computation.
    setStableRegionResult({ status: 'running', message: 'Searching local x/y region...' });
    // Compute the bounded local stability region synchronously from the current state.
    const result = findStableRegion({ angleParams, labelsMap, billiardsCode, currentCodeData: codeData, clearanceEpsilon });
    // Store the result for the inspector panel.
    setStableRegionResult(result);
  };

  // --- INTERACTION HANDLERS ---
  const handleMouseDown = (e) => {
    // Only left-click drags should pan the mathematical viewport.
    if (e.button !== 0) return; 
    // Enter dragging mode so mousemove updates pan instead of hover labels.
    setIsDragging(true);
    // Remember the starting screen point for delta calculations.
    lastMouse.current = { x: e.clientX, y: e.clientY };
  };
  
  const handleMouseMove = (e) => {
    // During drag, translate screen-pixel deltas back into math-unit deltas.
    if (isDragging) {
      // Divide by zoom because zoom is pixels per math unit.
      const dx = (e.clientX - lastMouse.current.x) / zoom;
      // SVG screen y grows downward while math y grows upward.
      const dy = (e.clientY - lastMouse.current.y) / zoom;
      // Move the center opposite the drag direction for natural canvas panning.
      setPan(prev => ({ x: prev.x - dx, y: prev.y + dy }));
      // Update the previous mouse point for the next delta.
      lastMouse.current = { x: e.clientX, y: e.clientY };
    } else {
      // Hover labels use screen coordinates and are disabled when all labels are pinned.
      if (containerRef.current && !showAllLabels) {
        // Convert page coordinates into coordinates relative to the SVG container.
        const rect = containerRef.current.getBoundingClientRect();
        setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
    }
  };
  
  // Any mouse release or canvas leave ends pan mode.
  const handleMouseUp = () => setIsDragging(false);

  const handleFitScreen = () => {
    // Include the base triangle and whatever reflected chain is active.
    const allTris = [baseTriangle, ...activeTriangles];
    // Defensive guard: there is normally always at least the base triangle.
    if (allTris.length === 0) return;
    
    // Initialize bounds so the first point always expands them.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // Sweep every vertex in mathematical coordinates.
    allTris.forEach(tri => tri.points.forEach(p => {
        // Expand left bound.
        if (p.x < minX) minX = p.x;
        // Expand right bound.
        if (p.x > maxX) maxX = p.x;
        // Expand bottom bound.
        if (p.y < minY) minY = p.y;
        // Expand top bound.
        if (p.y > maxY) maxY = p.y;
    }));
    
    // Avoid zero-width fit boxes for degenerate inputs.
    const w = Math.max(maxX - minX, 1);
    // Avoid zero-height fit boxes for degenerate inputs.
    const h = Math.max(maxY - minY, 1);
    // Center the viewport on the geometry bounds.
    setPan({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
    // Choose the largest zoom that leaves about 50 px padding per side.
    setZoom(Math.min((svgSize.width - 100) / w, (svgSize.height - 100) / h));
  };

  // Manual zoom-in click applies the user-entered magnification, ignoring wheel/trackpad input entirely.
  const handleManualZoomIn = () => {
    const factor = parseFloat(zoomMagnification);
    if (!Number.isFinite(factor) || factor <= 0) return;
    setZoom(prev => Math.max(0.5, Math.min(prev * factor, 5000)));
  };

  // Manual zoom-out click divides by the same user-entered magnification.
  const handleManualZoomOut = () => {
    const factor = parseFloat(zoomMagnification);
    if (!Number.isFinite(factor) || factor <= 0) return;
    setZoom(prev => Math.max(0.5, Math.min(prev / factor, 5000)));
  };

  // --- RENDERING HELPERS ---
  // The SVG group transform maps mathematical coordinates into screen pixels.
  const transformStr = `translate(${svgSize.width / 2}, ${svgSize.height / 2}) scale(${zoom}, ${-zoom}) translate(${-pan.x}, ${-pan.y})`;
  // Convert a math x coordinate to screen-space x for unscaled annotations.
  const toSvgX = (x) => svgSize.width / 2 + (x - pan.x) * zoom;
  // Convert a math y coordinate to screen-space y; sign flips because SVG y points down.
  const toSvgY = (y) => svgSize.height / 2 - (y - pan.y) * zoom; 
  
  const grid = useMemo(() => {
    // Use finer grid spacing as the user zooms in.
    const step = zoom > 150 ? 1 : zoom > 50 ? 2 : zoom > 15 ? 10 : 50;
    
    // Left visible math coordinate.
    const minMathX = pan.x - (svgSize.width / 2) / zoom;
    // Right visible math coordinate.
    const maxMathX = pan.x + (svgSize.width / 2) / zoom;
    // Bottom visible math coordinate.
    const minMathY = pan.y - (svgSize.height / 2) / zoom;
    // Top visible math coordinate.
    const maxMathY = pan.y + (svgSize.height / 2) / zoom;

    // Separate arrays drive vertical and horizontal SVG line generation.
    const linesX = [], linesY = [];
    // Start on the first visible multiple of the chosen step.
    for (let x = Math.floor(minMathX / step) * step; x <= maxMathX; x += step) linesX.push(x);
    // Do the same for horizontal grid coordinates.
    for (let y = Math.floor(minMathY / step) * step; y <= maxMathY; y += step) linesY.push(y);
    // Return both line coordinates and visible bounds for SVG line endpoints.
    return { linesX, linesY, minMathX, maxMathX, minMathY, maxMathY };
  }, [pan, zoom, svgSize]);


  return (
    <div data-theme={theme} className={`app-theme app-theme-${theme} flex h-screen w-full min-w-0 bg-[#080b0f] text-slate-200 font-sans overflow-hidden`}>
      
      {/* LEFT PANEL - CONTROLS & INSPECTOR */}
      <div className="w-[340px] 2xl:w-[360px] border-r border-white/10 flex flex-col bg-[#10151c] shadow-[12px_0_36px_rgba(0,0,0,0.32)] z-10 overflow-hidden shrink-0">
        
        {/* App Header & Tabs */}
        <div className="pt-8 pb-0 px-5 border-b border-white/10 bg-[#0c1117] shrink-0">
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-100 tracking-tight flex items-center gap-2 mb-1">
                <Activity className="w-5 h-5 text-cyan-300" /> Unfolding Viewer
              </h1>
              <p className="text-[11px] font-medium text-slate-500 uppercase tracking-widest">Invisible Point Workbench</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}
                className="theme-toggle"
                aria-pressed={isDarkTheme}
                aria-label={`Switch to ${isDarkTheme ? 'light' : 'dark'} mode`}
                title={`Switch to ${isDarkTheme ? 'light' : 'dark'} mode`}
              >
                {isDarkTheme ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                <span>{isDarkTheme ? 'Light' : 'Dark'}</span>
              </button>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-[#070b10] p-1">
            <button 
              onClick={() => setSimulatorMode('ray')}
              title="Shoot one ray from a selected vertex."
              className={`rounded-md px-3 py-2 text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${simulatorMode === 'ray' ? 'bg-amber-300/15 text-amber-100 shadow-sm' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
            >
              <Zap className="w-4 h-4"/> Trace Ray
            </button>
            <button 
              onClick={() => setSimulatorMode('code')}
              title="Unfold a space-separated integer code."
              className={`rounded-md px-3 py-2 text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${simulatorMode === 'code' ? 'bg-cyan-300/15 text-cyan-100 shadow-sm' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
            >
              <Code2 className="w-4 h-4"/> Unfold Code
            </button>
          </div>
        </div>

        {/* Scrollable Inspector Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar bg-[#0f141a]">
          
          {/* BASE GEOMETRY CONFIG */}
          <div className="p-4 bg-[#151c24] m-3 rounded-lg shadow-[0_8px_28px_rgba(0,0,0,0.28)] border border-white/10">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs uppercase tracking-wider font-bold text-slate-400 flex items-center gap-1.5">
                <Settings2 className="w-3.5 h-3.5"/> Base Geometry
              </h2>
              <div className="flex bg-[#0b1016] p-0.5 rounded-md border border-white/10">
                <button
                  onClick={() => { resetShotConstraintReference(); setBaseInputMode('coords'); }}
                  title="Enter all three triangle vertices as coordinates."
                  className={`px-2 py-1 text-[10px] font-bold rounded ${baseInputMode === 'coords' ? 'bg-cyan-400/15 text-cyan-100 shadow-sm' : 'text-slate-500 hover:text-slate-200'}`}
                >
                  Coordinates
                </button>
                <button
                  onClick={() => { resetShotConstraintReference(); setBaseInputMode('angles'); }}
                  title="Enter two angles and a base length."
                  className={`px-2 py-1 text-[10px] font-bold rounded ${baseInputMode === 'angles' ? 'bg-cyan-400/15 text-cyan-100 shadow-sm' : 'text-slate-500 hover:text-slate-200'}`}
                >
                  Angles
                </button>
              </div>
            </div>

            {baseInputMode === 'coords' ? (
              <div className="space-y-2.5">
                {[0, 1, 2].map(i => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-slate-500 w-12 text-right mr-1">{['A', 'B', 'C'][i]} (V{i})</span>
                    <input type="text" value={baseCoordsInput[i].x} onChange={e => {
                      const newCoords = [...baseCoordsInput];
                      newCoords[i].x = e.target.value;
                      resetShotConstraintReference();
                      setBaseCoordsInput(newCoords);
                    }} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 placeholder:text-slate-600 transition-all" placeholder="x" />
                    <input type="text" value={baseCoordsInput[i].y} onChange={e => {
                      const newCoords = [...baseCoordsInput];
                      newCoords[i].y = e.target.value;
                      resetShotConstraintReference();
                      setBaseCoordsInput(newCoords);
                    }} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 placeholder:text-slate-600 transition-all" placeholder="y" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-500 w-16 text-right mr-1">Base Length</span>
                  <input type="number" step="0.1" value={angleParams.length} onChange={e => handleAngleParamChange('length', e.target.value)} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-500 w-16 text-right mr-1">Angle A</span>
                  <div className="relative w-full">
                    <input type="number" step={angleInputStep} value={angleParams.a} onChange={e => handleAngleParamChange('a', e.target.value)} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all pr-6" />
                    <span className="absolute right-2 top-1.5 text-slate-500 font-mono text-xs">&deg;</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-500 w-16 text-right mr-1">Angle B</span>
                  <div className="relative w-full">
                    <input type="number" step={angleInputStep} value={angleParams.b} onChange={e => handleAngleParamChange('b', e.target.value)} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all pr-6" />
                    <span className="absolute right-2 top-1.5 text-slate-500 font-mono text-xs">&deg;</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-500 w-16 text-right mr-1">Angle Step</span>
                  <input
                    type="number"
                    min="0"
                    step={angleStepControlIncrement}
                    value={angleIncrementInput}
                    onChange={e => setAngleIncrementInput(e.target.value)}
                    title={`Increment for the Angle A/B number steppers and exact plot grid. Its own native step is ${angleStepControlIncrement}.`}
                    className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-500 w-16 text-right mr-1">Step Increment</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={angleStepControlIncrementInput}
                    onChange={e => setAngleStepControlIncrementInput(e.target.value)}
                    title="Native spinner/arrow increment used by the Angle Step field above."
                    className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all"
                  />
                </div>
                {lockedShotNotice && (
                  <div className="text-[10px] text-amber-100 mt-1 pl-16 font-medium bg-amber-500/10 rounded py-1.5 px-2 border border-amber-300/20">
                    Constrained blocked {lockedShotNotice.field}={lockedShotNotice.value}: {lockedShotNotice.reason}.
                  </div>
                )}
                {(Number(angleParams.a) + Number(angleParams.b) >= 180) && (
                  <div className="text-[10px] text-red-200 mt-1 pl-16 text-center font-medium bg-red-500/10 rounded py-1 border border-red-400/20">Angles must sum &lt; 180&deg;</div>
                )}
                <button
                  type="button"
                  onClick={handleOpenAnglePlot}
                  title="Generate and open the valid A/B angle-pair scatter plot."
                  className="w-full flex items-center justify-center gap-1.5 bg-[#101820]/95 hover:bg-[#172230] text-slate-200 hover:text-cyan-200 px-2.5 py-1.5 rounded-md text-[11px] font-bold transition-colors"
                >
                  <ScatterChart className="w-3.5 h-3.5" />
                  Plot Valid Angle Region
                </button>
              </div>
            )}

            <div className="mt-3 pt-3 border-t border-white/10">
              <label className="grid grid-cols-[1fr_88px] gap-2 items-center">
                <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Display Decimals</span>
                <input
                  type="number"
                  min="0"
                  max={MAX_DISPLAY_DECIMALS}
                  step="1"
                  value={displayPrecisionInput}
                  onChange={e => setDisplayPrecisionInput(e.target.value)}
                  title={`Number of decimal places shown in readouts, clamped from 0 to ${MAX_DISPLAY_DECIMALS}.`}
                  className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs text-center focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all"
                />
              </label>
            </div>
          </div>

          {/* SIMULATOR PARAMETERS */}
          {simulatorMode === 'ray' ? (
            <div className="p-4 bg-[#151c24] m-3 rounded-lg shadow-[0_8px_28px_rgba(0,0,0,0.28)] border border-white/10">
              <h2 className="text-xs uppercase tracking-wider font-bold text-amber-200 mb-4 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" /> Simulation Rules
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="text-[11px] font-bold text-slate-400 flex justify-between mb-1.5"><span>Origin Vertex</span></label>
                  <div className="flex gap-2">
                    {[0, 1, 2].map(v => (
                      <button
                        key={v}
                        onClick={() => setRayStartVertex(v)}
                        title={`Start the ray at vertex ${['A', 'B', 'C'][v]}.`}
                        className={`flex-1 py-1.5 text-xs rounded-md font-bold border transition-colors ${rayStartVertex === v ? 'bg-amber-300/15 border-amber-300/40 text-amber-100' : 'bg-[#0b1016] border-white/10 text-slate-500 hover:text-slate-200 hover:border-slate-500/50'}`}
                      >
                        Start {['A', 'B', 'C'][v]}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-bold text-slate-400 flex justify-between mb-1.5"><span>Trajectory Angle</span></label>
                  <div className="flex gap-3 items-center">
                    <input type="range" min="0" max="360" step="0.1" value={rayAngle} onChange={e => setRayAngle(parseFloat(e.target.value))} className="flex-1 accent-amber-600" />
                    <div className="relative w-20">
                      <input type="number" value={rayAngle} onChange={e => setRayAngle(parseFloat(e.target.value))} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2 py-1.5 text-xs text-center focus:bg-[#101923] focus:border-amber-300 focus:ring-1 focus:ring-amber-300 outline-none font-mono text-slate-100" />
                      <span className="absolute right-1.5 top-1.5 text-slate-500 font-mono text-xs">&deg;</span>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-bold text-slate-400 block mb-1.5">Max Bounces</label>
                  <input type="number" min="0" max="1000" step="1" value={maxBounces} onChange={e => setMaxBounces(parseInt(e.target.value))} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-3 py-1.5 text-sm focus:bg-[#101923] focus:border-amber-300 focus:ring-1 focus:ring-amber-300 outline-none font-mono text-slate-100" />
                </div>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-[#151c24] m-3 rounded-lg shadow-[0_8px_28px_rgba(0,0,0,0.28)] border border-white/10">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs uppercase tracking-wider font-bold text-cyan-200 flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5" /> Sequence Parser
                </h2>
                <span className="text-[10px] font-mono text-slate-500">{sequences.length} sequence{sequences.length === 1 ? '' : 's'}</span>
              </div>
              <p className="text-[10px] text-slate-500 mb-2 leading-relaxed">
                Each row is one independent bounce-code sequence with its own Angle Step and graph color. Click a row to make it the active unfolding shown on the canvas.
              </p>

              {/* Desmos-style sequence row list. Bounded height + its own
                  scrollbar (not the whole sidebar's) so adding many rows
                  can never push Constrained/Ghost/Search or the rest of the
                  sidebar off screen. */}
              <div className="space-y-1.5 max-h-56 overflow-y-auto custom-scrollbar pr-0.5 -mr-0.5">
                {sequences.map(row => {
                  const isActive = row.id === activeSequenceId;
                  const parsedStep = parseAngleStep(row.angleStepInput);
                  const modeLabel = parsedStep.valid ? (isExactModeStep(parsedStep.scale, parsedStep.stepUnits) ? 'Exact' : 'Adaptive') : null;
                  const isDirty = row.draftSequenceText !== row.sequenceText;
                  // Row status: Hidden/Invalid take priority over the plain
                  // "Editing.../Ready" distinction so a bad edit is never
                  // masked by the fact that it's also mid-typing.
                  const rowStatus = !row.visible ? 'Hidden'
                    : row.validationError ? (/angle/i.test(row.validationError) ? 'Invalid angles' : 'Invalid sequence')
                    : isDirty ? 'Editing…'
                    : 'Ready';
                  return (
                    <div
                      key={row.id}
                      onClick={() => handleSelectActiveSequence(row.id)}
                      role="radio"
                      aria-checked={isActive}
                      tabIndex={0}
                      onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectActiveSequence(row.id); } }}
                      title={row.sequenceText ? `${row.label}: ${row.sequenceText}` : `${row.label}: (empty sequence)`}
                      className={`rounded-md border px-2 py-1.5 cursor-pointer transition-colors ${isActive ? 'border-cyan-300/50 bg-cyan-400/10' : 'border-white/10 bg-[#0b1016]'}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 border ${isActive ? 'bg-cyan-300 border-cyan-300' : 'bg-transparent border-slate-600'}`}
                          aria-hidden="true"
                          title={isActive ? `${row.label} is active in the main canvas` : `Click to make ${row.label} active in the main canvas`}
                        />
                        <input
                          type="checkbox"
                          checked={row.visible}
                          onChange={() => handleToggleSequenceVisible(row.id)}
                          onClick={e => e.stopPropagation()}
                          aria-label={`Show ${row.label} in the graph`}
                          title={row.visible ? `Hide ${row.label} from the graph` : `Show ${row.label} in the graph`}
                          className="w-3 h-3 shrink-0 accent-cyan-400"
                        />
                        <input
                          type="color"
                          value={row.color}
                          onChange={e => handleSequenceColorChange(row.id, e.target.value)}
                          onClick={e => e.stopPropagation()}
                          aria-label={`${row.label} graph color`}
                          title={`Choose ${row.label}'s dot/legend color`}
                          className="w-3.5 h-3.5 shrink-0 rounded-full border border-black/30 p-0 bg-transparent cursor-pointer appearance-none overflow-hidden"
                        />
                        <span className={`text-[10px] font-bold shrink-0 w-[52px] truncate ${isActive ? 'text-cyan-200' : 'text-slate-400'}`}>{row.label}</span>
                        <input
                          type="text"
                          ref={el => { sequenceInputRefsRef.current[row.id] = el; }}
                          value={row.draftSequenceText}
                          onChange={e => handleSequenceDraftChange(row.id, e.target.value)}
                          onClick={e => e.stopPropagation()}
                          onFocus={() => handleSelectActiveSequence(row.id)}
                          onKeyDown={e => {
                            e.stopPropagation();
                            if (e.key === 'Enter') { e.preventDefault(); handleApplySequenceDraft(row.id); }
                            else if (e.key === 'Escape') { e.preventDefault(); handleCancelSequenceDraft(row.id); e.currentTarget.blur(); }
                          }}
                          onBlur={() => handleApplySequenceDraft(row.id)}
                          placeholder="e.g. 1 5 16 5 1 2 3 6"
                          aria-label={`${row.label} sequence text`}
                          title="Type freely, including spaces. Press Enter to apply, Escape to discard the edit."
                          className="flex-1 min-w-0 bg-transparent text-[11px] font-mono text-slate-100 outline-none placeholder:text-slate-600 truncate"
                        />
                        <input
                          type="number"
                          min="0"
                          step="0.0001"
                          value={row.angleStepInput}
                          onChange={e => handleSequenceAngleStepChange(row.id, e.target.value)}
                          onClick={e => e.stopPropagation()}
                          aria-label={`${row.label} Angle Step`}
                          title={parsedStep.valid ? `Angle Step for ${row.label}'s own graph (${modeLabel} mode)` : `Angle Step error: ${parsedStep.error}`}
                          className={`w-14 shrink-0 bg-[#0b1016] border rounded px-1 py-0.5 text-[10px] font-mono outline-none ${parsedStep.valid ? 'border-white/10 text-slate-200' : 'border-red-400/50 text-red-200'}`}
                        />
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); handleDuplicateSequence(row.id); }}
                          title={`Duplicate ${row.label}`}
                          aria-label={`Duplicate ${row.label}`}
                          className="shrink-0 text-slate-500 hover:text-cyan-200 p-0.5"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); handleRemoveSequence(row.id); }}
                          title={`Delete ${row.label}`}
                          aria-label={`Delete ${row.label}`}
                          className="shrink-0 text-slate-500 hover:text-red-300 p-0.5"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 pl-[18px]">
                        <span className="text-[10px] font-bold text-slate-500">A</span>
                        <input
                          type="number"
                          value={row.angleA}
                          onChange={e => handleRowAngleChange(row.id, 'a', e.target.value)}
                          onClick={e => e.stopPropagation()}
                          aria-label={`${row.label} Angle A`}
                          title={`${row.label}'s own Angle A (degrees)`}
                          className="w-14 shrink-0 bg-[#0b1016] border border-white/10 rounded px-1 py-0.5 text-[10px] font-mono text-slate-200 outline-none"
                        />
                        <span className="text-[10px] font-bold text-slate-500">B</span>
                        <input
                          type="number"
                          value={row.angleB}
                          onChange={e => handleRowAngleChange(row.id, 'b', e.target.value)}
                          onClick={e => e.stopPropagation()}
                          aria-label={`${row.label} Angle B`}
                          title={`${row.label}'s own Angle B (degrees)`}
                          className="w-14 shrink-0 bg-[#0b1016] border border-white/10 rounded px-1 py-0.5 text-[10px] font-mono text-slate-200 outline-none"
                        />
                        <span className={`text-[9px] font-bold ml-1 ${rowStatus === 'Ready' ? 'text-emerald-300' : rowStatus === 'Editing…' ? 'text-amber-300' : rowStatus === 'Hidden' ? 'text-slate-600' : 'text-red-300'}`}>
                          {rowStatus}
                        </span>
                      </div>
                      {row.validationError && (
                        <div className="mt-1 pl-[18px] text-[9px] text-red-300">{row.validationError}</div>
                      )}
                      {!parsedStep.valid && (
                        <div className="mt-1 pl-[18px] text-[9px] text-red-300">{parsedStep.error}</div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleAddSequence}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-[#0b1016] hover:bg-[#172230] border border-white/10 hover:border-cyan-300/30 text-slate-300 hover:text-cyan-200 px-2.5 py-1.5 rounded-md text-[11px] font-bold transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Sequence
                </button>
                <button
                  type="button"
                  onClick={handleShowAllSequences}
                  title="Show every sequence in the graph"
                  aria-label="Show all sequences"
                  className="shrink-0 bg-[#0b1016] hover:bg-[#172230] border border-white/10 text-slate-400 hover:text-cyan-200 px-2 py-1.5 rounded-md transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleHideAllSequences}
                  title="Hide every sequence from the graph"
                  aria-label="Hide all sequences"
                  className="shrink-0 bg-[#0b1016] hover:bg-[#172230] border border-white/10 text-slate-400 hover:text-cyan-200 px-2 py-1.5 rounded-md transition-colors"
                >
                  <EyeOff className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="mt-3 pt-3 border-t border-white/10 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                Active: <span className="text-cyan-200">{activeSequence?.label}</span> — Constrained/Ghost, Separation Epsilon, and Search below apply to it.
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-[#0b1016] p-1">
                <button
                  onClick={() => { setShotPathReference(null); setLockedShotNotice(null); setShotEditMode(SHOT_MODE_LOCKED); }}
                  title="Reject angle edits before they can make the current code-mode shot invalid."
                  className={`rounded-md px-2 py-1.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${shotEditMode === SHOT_MODE_LOCKED ? 'bg-emerald-400/15 text-emerald-100 shadow-sm' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
                >
                  <ShieldCheck className="w-3.5 h-3.5" /> Constrained
                </button>
                <button
                  onClick={() => { setShotPathReference(simulatorMode === 'code' ? buildCodePathReference(codeData) : null); setLockedShotNotice(null); setShotEditMode(SHOT_MODE_PREVIEW); }}
                  title="Allow invalid shots and render them in ghost mode."
                  className={`rounded-md px-2 py-1.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 ${shotEditMode === SHOT_MODE_PREVIEW ? 'bg-slate-300/15 text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'}`}
                >
                  <Eye className="w-3.5 h-3.5" /> Ghost
                </button>
              </div>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 items-end">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 block mb-1">Separation Epsilon</span>
                  <input
                    type="number"
                    min="0"
                    step="0.0000000001"
                    value={clearanceEpsilonInput}
                    onChange={e => { resetShotConstraintReference(); setClearanceEpsilonInput(e.target.value); }}
                    className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-xs focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all"
                  />
                </label>
                <button
                  onClick={handleStableRegionSearch}
                  disabled={baseInputMode !== 'angles' || shotClearanceValidation.status !== 'valid'}
                  title="Search the local symbolic x/y angle region that preserves the current valid shot."
                  className="h-[34px] px-2.5 rounded-md border border-cyan-300/25 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/15 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                >
                  <Search className="w-4 h-4" />
                </button>
              </div>
              {stableRegionResult && (
                <div className={`mt-3 rounded-md border px-2.5 py-2 text-[10px] leading-relaxed ${stableRegionResult.status === 'found' ? 'border-cyan-300/20 bg-cyan-400/10 text-cyan-100' : stableRegionResult.status === 'running' ? 'border-slate-300/20 bg-slate-400/10 text-slate-200' : 'border-amber-300/20 bg-amber-500/10 text-amber-100'}`}>
                  {stableRegionResult.status === 'found' ? (
                    <div className="font-mono">
                      x in ({formatFixed(stableRegionResult.intervals.xMin)}, {formatFixed(stableRegionResult.intervals.xMax)})<br />
                      y in ({formatFixed(stableRegionResult.intervals.yMin)}, {formatFixed(stableRegionResult.intervals.yMax)})
                      <span className="block mt-1 text-slate-400">step={formatFixed(stableRegionResult.step)} visits={stableRegionResult.visits}{stableRegionResult.capped ? ' capped' : ''}</span>
                    </div>
                  ) : (
                    <div className="flex gap-1.5 items-start">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{stableRegionResult.message || 'Stable region search did not return an interval.'}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ANALYTICS & DATA LOGS */}
          <div className="px-3 pb-8">
            
            {/* Code-mode shot vector, matching the colored endpoint segment drawn on the canvas. */}
            {simulatorMode === 'code' && activeTriangles.length > 0 && (
              <div className="mb-3 bg-[#151c24] p-4 rounded-lg border border-white/10 shadow-[0_8px_28px_rgba(0,0,0,0.22)]">
                <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-3 flex items-center gap-1.5">
                  <Compass className="w-3 h-3 text-cyan-300"/> Shot Vector ({shotSymbol}/A)
                </h3>
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center border-b border-white/10 pb-2">
                    <span className="text-[11px] text-slate-500 font-medium">Final endpoint</span>
                    <span className="text-xs font-mono text-slate-100 font-semibold bg-[#0b1016] px-2 py-0.5 rounded border border-white/10 text-right break-all max-w-[210px]">
                      {formatPoint(finalShot)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] text-slate-500 font-medium">Global Angle <span className="font-mono text-[9px] text-slate-600 ml-1">atan2</span></span>
                    <span className="text-xs font-mono text-cyan-100 font-bold bg-cyan-400/10 px-2 py-0.5 rounded border border-cyan-300/20 text-right break-all max-w-[210px]">
                      {formatFixed(getGlobalAngle(startShot, finalShot))}&deg;
                    </span>
                  </div>
                </div>
              </div>
            )}

            {simulatorMode === 'code' && activeTriangles.length > 0 && (
              <div className={`mb-3 p-4 rounded-lg border shadow-[0_8px_28px_rgba(0,0,0,0.22)] ${shotClearanceValidation.status === 'valid' ? 'bg-emerald-500/10 border-emerald-300/25' : 'bg-red-500/10 border-red-300/25'}`}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-300 mb-2 flex items-center gap-1.5">
                    {shotClearanceValidation.status === 'valid' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-300" />
                    )}
                    Vertex Line Test
                  </h3>
                  <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${shotClearanceValidation.status === 'valid' ? 'text-emerald-100 border-emerald-300/25 bg-emerald-400/10' : 'text-red-100 border-red-300/25 bg-red-400/10'}`}>
                    {shotClearanceValidation.status === 'valid' ? 'VALID' : 'INVALID'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 leading-relaxed">
                  Checked <span className="font-mono text-slate-200">{shotClearanceValidation.checked}</span> A/B/C occurrences:
                  <span className="font-mono text-sky-300"> blue {shotClearanceValidation.stats.blue}</span>,
                  <span className="font-mono text-slate-300"> black {shotClearanceValidation.stats.red}</span>,
                  <span className="font-mono text-yellow-300"> uncolored {shotClearanceValidation.stats.uncolored}</span>,
                  <span className="font-mono text-slate-500"> endpoints {shotClearanceValidation.stats.endpoints}</span>.
                  <div className="mt-1 text-[10px] text-slate-500">
                    Vector: <span className="font-mono text-slate-300">first {shotSymbol}/A to final {shotSymbol}/A</span>
                    <span className="font-mono text-slate-500"> | min gap {formatExponential(shotClearanceValidation.stats.lineMargin)}</span>
                    <span className="font-mono text-slate-500"> | max fan {formatFixed(shotClearanceValidation.stats.fanMaxCentralAngle)}&deg;</span>
                    <span className="font-mono text-slate-500"> | epsilon hits {shotClearanceValidation.stats.epsilonBand}</span>
                    <span className="font-mono text-slate-500"> | {shotEditMode === SHOT_MODE_LOCKED ? 'Constrained' : 'Ghost'}</span>
                  </div>
                </div>
                {shotClearanceValidation.violations.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {shotClearanceValidation.violations.slice(0, 3).map((violation, idx) => (
                      <div key={`${violation.triId}-${violation.symbol}-${idx}`} className="rounded-md border border-red-300/20 bg-[#0b1016]/80 px-2 py-1.5 text-[10px] text-red-100">
                        <span className="font-mono font-bold">{violation.triId}</span>
                        <span className="font-mono"> {violation.symbol}</span> expected {violation.expected}; dy =
                        <span className="font-mono"> {formatExponential(violation.score)}</span>
                        {violation.point && (
                          <span className="font-mono">; vertex = ({formatPoint(violation.point)})</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SEQUENCE LOGS (Code Sim Only) */}
            {simulatorMode === 'code' && codeData.parsedSequence.length > 0 && (
              <div className="mb-3 bg-[#151c24] p-4 rounded-lg border border-white/10 shadow-[0_8px_28px_rgba(0,0,0,0.22)]">
                <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-2 flex items-center gap-1.5">
                  <ChevronRight className="w-3 h-3" /> Unfolded Sequence
                </h3>
                <div className="bg-[#0b1016] p-2 rounded-md border border-white/10 max-h-24 overflow-y-auto flex flex-wrap gap-1.5 custom-scrollbar shadow-inner">
                  {codeData.parsedSequence.map((step, idx) => (
                    <span key={idx} className="bg-[#17212b] text-slate-200 text-[10px] font-mono px-1.5 py-0.5 rounded border border-white/10 shadow-sm flex items-center">
                      {step.count}<span className="text-cyan-300 font-bold ml-0.5">{step.angle}</span>
                    </span>
                  ))}
                </div>
                
                <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mt-4 mb-2 flex items-center gap-1.5">
                  <ChevronRight className="w-3 h-3" /> Boundary Intersections
                </h3>
                <div className="bg-[#0b1016] p-2.5 rounded-md border border-white/10 max-h-24 overflow-y-auto font-mono text-[11px] font-medium text-slate-300 custom-scrollbar break-words leading-relaxed shadow-inner tracking-widest">
                  {codeData.sideSequence?.join(' ')}
                </div>
              </div>
            )}

            {/* VERTEX LOGS */}
            <div className="bg-[#151c24] p-4 rounded-lg border border-white/10 shadow-[0_8px_28px_rgba(0,0,0,0.22)]">
              <div className="flex items-center justify-between mb-3 border-b border-white/10 pb-2">
                <h2 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 flex items-center gap-1.5">
                  <List className="w-3 h-3"/> Vertices Log
                </h2>
                <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 cursor-pointer hover:text-cyan-200 transition-colors">
                  <input type="checkbox" checked={showAllLabels} onChange={e => setShowAllLabels(e.target.checked)} className="accent-cyan-400 w-3 h-3" />
                  PERSIST LABELS
                </label>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-mono bg-[#0b1016] p-2.5 rounded-md border border-white/10 relative overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-slate-300" />
                  <div className="font-bold mb-1.5 text-slate-200 ml-1">{baseTriangle.name}</div>
                  <div className="grid grid-cols-1 gap-y-1 text-slate-500 ml-1 break-all">
                    <div>A ({labelsMap[0]}): <span className="text-slate-200 font-medium">{formatPoint(baseTriangle.points[0])}</span></div>
                    <div>B ({labelsMap[1]}): <span className="text-slate-200 font-medium">{formatPoint(baseTriangle.points[1])}</span></div>
                    <div>C ({labelsMap[2]}): <span className="text-slate-200 font-medium">{formatPoint(baseTriangle.points[2])}</span></div>
                  </div>
                </div>

                {activeTriangles.slice(0, 50).map(tri => (
                  <div key={tri.id} className="text-[11px] font-mono bg-[#111821] p-2 rounded-md border border-white/10 shadow-sm relative overflow-hidden hover:bg-[#18222c] transition-colors">
                    <div className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: getTriangleRenderStyle(tri).color }} />
                    <div className="font-bold mb-1 text-slate-300 ml-1.5">{tri.id}</div>
                    <div className="grid grid-cols-1 gap-y-0.5 text-slate-500 ml-1.5 break-all">
                      <div>A: <span className="text-slate-300">{formatPoint(tri.points[0])}</span></div>
                      <div>B: <span className="text-slate-300">{formatPoint(tri.points[1])}</span></div>
                      <div>C: <span className="text-slate-300">{formatPoint(tri.points[2])}</span></div>
                    </div>
                  </div>
                ))}
                {activeTriangles.length > 50 && <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center py-2 bg-[#0b1016] rounded-md border border-white/10">...and {activeTriangles.length - 50} more</div>}
              </div>
            </div>
            
          </div>
        </div>
      </div>

      {/* RIGHT PANEL - SVG CANVAS */}
      <div className="flex-1 min-w-0 relative bg-[#070b10] overflow-hidden">
        
        {/* Floating Canvas Toolbar */}
        <div className="absolute top-4 right-4 z-10 flex gap-2">
           {simulatorMode === 'code' && (
             <div className="bg-[#101820]/95 text-slate-400 px-3 py-2 text-[11px] rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 font-mono font-bold flex items-center backdrop-blur">
                GENERATED: <span className="text-cyan-200 ml-2">{activeTriangles.length}</span>
             </div>
           )}
          <div className="bg-[#101820]/95 text-slate-300 px-3 py-2 text-[11px] rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 font-mono font-bold flex items-center gap-2 backdrop-blur" title="Current magnification (pixels per unit).">
            <span className="text-slate-500">ZOOM</span>
            <span className="text-cyan-200">{zoom.toFixed(1)}x</span>
          </div>
          <input
            type="number"
            min="0.01"
            step="0.1"
            value={zoomMagnification}
            onChange={(e) => setZoomMagnification(e.target.value)}
            className="w-14 bg-[#101820]/95 hover:bg-[#172230] text-slate-200 px-2 py-2.5 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 backdrop-blur text-xs font-bold text-center"
            title="Magnification multiplier applied by the Zoom button."
          />
          <button onClick={handleManualZoomIn} className="bg-[#101820]/95 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 px-3 py-2.5 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 transition-colors backdrop-blur flex items-center gap-2 text-xs font-bold" title="Zoom in by the magnification multiplier entered to the left.">
            <ZoomIn className="w-4 h-4" />
            Zoom In
          </button>
          <button onClick={handleManualZoomOut} className="bg-[#101820]/95 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 px-3 py-2.5 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 transition-colors backdrop-blur flex items-center gap-2 text-xs font-bold" title="Zoom out by the magnification multiplier entered to the left.">
            <ZoomOut className="w-4 h-4" />
            Zoom Out
          </button>
          <button
            onClick={() => setIsZoomLocked(current => !current)}
            className={`px-3 py-2.5 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border transition-colors backdrop-blur flex items-center gap-2 text-xs font-bold ${isZoomLocked ? 'bg-cyan-500/20 border-cyan-400/40 text-cyan-200' : 'bg-[#101820]/95 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 border-white/10'}`}
            aria-pressed={isZoomLocked}
            title={isZoomLocked ? 'Trackpad/mouse-wheel zoom is locked. Click to unlock.' : 'Lock trackpad/mouse-wheel zoom to prevent accidental zooming.'}
          >
            {isZoomLocked ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
            Fix
          </button>
          <button onClick={handleFitScreen} className="bg-[#101820]/95 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 px-3 py-2.5 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 transition-colors backdrop-blur flex items-center gap-2 text-xs font-bold" title="Fit all generated triangles to the canvas.">
            <Maximize className="w-4 h-4" />
            Fit
          </button>
        </div>
        
        {/* Interactive SVG Area */}
        <div 
          ref={containerRef}
          className={`w-full h-full ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <svg width="100%" height="100%" className="block bg-[#070b10]">
            
            {/* HARDWARE ACCELERATED RENDER LAYER */}
            <g transform={transformStr}>
              
              {/* Academic Graph Paper Grid */}
              <g opacity="1">
                {grid.linesX.map(x => <line key={`gx-${x}`} x1={x} y1={grid.minMathY} x2={x} y2={grid.maxMathY} stroke={x === 0 ? themePalette.gridAxis : themePalette.gridLine} strokeWidth={(x === 0 ? 2 : 1) / zoom} />)}
                {grid.linesY.map(y => <line key={`gy-${y}`} x1={grid.minMathX} y1={y} x2={grid.maxMathX} y2={y} stroke={y === 0 ? themePalette.gridAxis : themePalette.gridLine} strokeWidth={(y === 0 ? 2 : 1) / zoom} />)}
              </g>

              {/* Generated Reflections - Glassy geometry look */}
              {renderableActiveTriangles.map(tri => {
                const triangleStyle = getTriangleRenderStyle(tri);
                return (
                  <polygon
                    key={tri.id}
                    points={`${tri.points[0].x},${tri.points[0].y} ${tri.points[1].x},${tri.points[1].y} ${tri.points[2].x},${tri.points[2].y}`}
                    fill="#ffffff"
                    fillOpacity={triangleStyle.fillOpacity}
                    stroke={triangleStyle.strokeColor}
                    strokeOpacity={triangleStyle.strokeOpacity}
                    strokeWidth={2.2 / zoom} 
                    strokeLinejoin="round"
                  />
                );
              })}

              {/* Base Triangle - Prominent Anchor */}
              <polygon
                points={`${baseTriangle.points[0].x},${baseTriangle.points[0].y} ${baseTriangle.points[1].x},${baseTriangle.points[1].y} ${baseTriangle.points[2].x},${baseTriangle.points[2].y}`}
                fill="#ffffff"
                fillOpacity="0.08"
                stroke="#000000"
                strokeWidth={3 / zoom}
                strokeLinejoin="round"
              />

              {/* Glowing Ray Vector / Visual Analysis Ray Line */}
              {simulatorMode === 'ray' && rayData.rayLine && (
                <g pointerEvents="none">
                  <line
                    x1={rayData.rayLine.x1} y1={rayData.rayLine.y1}
                    x2={rayData.rayLine.x2} y2={rayData.rayLine.y2}
                    stroke="#ea580c" strokeWidth={2.5 / zoom} strokeLinecap="round"
                  />
                  <circle cx={rayData.rayLine.x1} cy={rayData.rayLine.y1} r={4 / zoom} fill="#ea580c" />
                </g>
              )}
              {simulatorMode === 'code' && activeTriangles.length > 0 && (
                <g pointerEvents="none">
                  <line
                    x1={startShot.x} y1={startShot.y}
                    x2={finalShot.x} y2={finalShot.y}
                    stroke={shotLineVisualColor} strokeWidth={2.5 / zoom} strokeDasharray={`${8 / zoom},${8 / zoom}`} strokeLinecap="round" opacity={isGhostedShot ? 0.9 : 1}
                  />
                  <circle cx={startShot.x} cy={startShot.y} r={5 / zoom} fill={SHOT_ENDPOINT_FILL_COLOR} stroke={shotLineVisualColor} strokeWidth={1.5 / zoom} />
                  <circle cx={finalShot.x} cy={finalShot.y} r={5 / zoom} fill={SHOT_ENDPOINT_FILL_COLOR} stroke={shotLineVisualColor} strokeWidth={1.5 / zoom} />
                </g>
              )}
            </g>

            {/* UNSCALED SCREEN-SPACE ANNOTATIONS */}
            <g pointerEvents="none">
              {simulatorMode === 'code' && activeTriangles.length > 0 && (() => {
                const markers = [];
                const seen = new Set();
                // Mark every triangle occurrence that participates in the rendered tower.
                const allTris = [baseTriangle, ...renderableActiveTriangles];

                for (const tri of allTris) {
                  for (const vertexIdx of [0, 1, 2]) {
                    const symbol = labelsMap[vertexIdx];
                    const p = tri.points[vertexIdx];
                    if (!p) continue;

                    const key = getClearanceOccurrenceKey(tri.id, vertexIdx, symbol);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const validation = getClearancePointValidation(tri.id, vertexIdx, symbol);
                    if (!validation) continue;

                    const cx = toSvgX(p.x);
                    const cy = toSvgY(p.y);
                    const radius = validation.valid ? 4 : 6;
                    const showLabel = true;
                    const markerColor = getShotVertexRenderColor(validation);

                    markers.push(
                      <g key={`clearance-mark-${key}`}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={radius + 2}
                          fill={markerColor}
                          opacity={validation.valid ? 0.28 : 0.85}
                        />
                        <circle
                          cx={cx}
                          cy={cy}
                          r={radius}
                          fill={markerColor}
                          opacity={validation.valid ? 0.82 : 1}
                        />
                        {showLabel && (
                          <text
                            x={cx}
                            y={cy + 0.5}
                            fill={markerColor}
                            fontSize="8"
                            fontWeight="900"
                            textAnchor="middle"
                            alignmentBaseline="middle"
                            className="font-mono"
                          >
                            {validation.vertexName}
                          </text>
                        )}
                      </g>
                    );
                  }
                }

                return markers;
              })()}
              
              {/* Base Triangle Corner Variables (x, y, z) dynamically mapped */}
              {(() => {
                const bPoints = baseTriangle.points;
                const mathCentroidX = (bPoints[0].x + bPoints[1].x + bPoints[2].x) / 3;
                const mathCentroidY = (bPoints[0].y + bPoints[1].y + bPoints[2].y) / 3;
                const svgCentroidX = toSvgX(mathCentroidX);
                const svgCentroidY = toSvgY(mathCentroidY);

                return [0, 1, 2].map((vertexIdx) => {
                  const angleLabel = labelsMap[vertexIdx];
                  const p = bPoints[vertexIdx];
                  const cx = toSvgX(p.x);
                  const cy = toSvgY(p.y);
                  
                  const vx = svgCentroidX - cx;
                  const vy = svgCentroidY - cy;
                  const dist = Math.sqrt(vx*vx + vy*vy) || 1;
                  
                  const offsetPx = Math.min(22, dist * 0.4); 
                  const labelX = cx + (vx / dist) * offsetPx;
                  const labelY = cy + (vy / dist) * offsetPx;

                  return (
                    <text 
                      key={`angle-lbl-${vertexIdx}`}
                      x={labelX} 
                      y={labelY} 
                      fill={themePalette.canvasLabel} 
                      fontSize="14" 
                      fontWeight="700"
                      textAnchor="middle"
                      alignmentBaseline="middle"
                      className="font-mono" 
                      style={{ 
                        textShadow: `0 0 5px ${themePalette.labelHalo}, 0 0 5px ${themePalette.labelHalo}, 0 0 8px ${themePalette.labelHalo}`,
                        fontStyle: 'italic'
                      }}
                    >
                      {angleLabel}
                    </text>
                  );
                });
              })()}

              {/* Dynamic Annotation Engine (Proximity Hover & Vertex Coloring).
                  Persistent Labels (showAllLabels) intentionally still shows
                  every vertex + edge-midpoint label of every triangle. A
                  plain hover (no Persistent Labels) instead shows only the
                  single nearest vertex under the cursor, not the whole
                  triangle's vertices and edge midpoints. */}
              {showAllLabels && (() => {
                const labelsToRender = [];
                const renderedCoords = new Set();
                const renderedMidpoints = new Set();

                const processTriangles = (triangles, isDerived) => {
                  for (const tri of triangles) {
                    {
                      const triDisplayColor = isDerived ? getTriangleRenderStyle(tri).color : themePalette.baseTriangle;

                      // 1. Vertex Coordinates Annotation
                      for (let i = 0; i < 3; i++) {
                        const p = tri.points[i];
                        const cx = toSvgX(p.x);
                        const cy = toSvgY(p.y);
                        const coordKey = `${p.x.toFixed(5)},${p.y.toFixed(5)}`;

                        if (!renderedCoords.has(coordKey)) {
                          renderedCoords.add(coordKey);
                          const vertexName = ['A', 'B', 'C'][i];
                          
                          // Dynamic vertex coloring logic based on the all-vertex tower validator.
                          let vColor = triDisplayColor;
                          let vTextColor = vColor;
                          let vertexRadius = isDerived ? 4 : 5;

                          if (simulatorMode === 'code' && activeTriangles.length > 0) {
                            const symbol = labelsMap[i];
                            const clearancePointValidation = getClearancePointValidation(tri.id, i, symbol);
                            
                            if (clearancePointValidation) {
                              vColor = getShotVertexRenderColor(clearancePointValidation, isDerived ? tri.color : themePalette.baseTriangle);
                              vertexRadius = clearancePointValidation.valid ? vertexRadius : 6;
                            }
                          }

                          labelsToRender.push(
                            <g key={`lbl-${isDerived ? 'derived-' : ''}${tri.id}-${i}`}>
                              <circle cx={cx} cy={cy} r={vertexRadius} fill={vColor} opacity={1} />
                              <text 
                                x={cx + 8} 
                                y={cy - 6} 
                                fill={vTextColor} 
                                fontSize="11" 
                                fontWeight="700"
                                className="font-mono tracking-tight" 
                                style={{ textShadow: `0 0 5px ${themePalette.labelHalo}, 0 0 5px ${themePalette.labelHalo}, 0 0 8px ${themePalette.labelHalo}` }}
                              >
                                {vertexName}: ({formatPoint(p)})
                              </text>
                            </g>
                          );
                        }
                      }

                      // 2. Edge Midpoints Annotation (Sides 1, 2, 3)
                      for (let e = 0; e < 3; e++) {
                        const p1 = tri.points[e];
                        const p2 = tri.points[(e + 1) % 3];
                        
                        const midX = (p1.x + p2.x) / 2;
                        const midY = (p1.y + p2.y) / 2;
                        const midKey = `${midX.toFixed(5)},${midY.toFixed(5)}`;

                        if (!renderedMidpoints.has(midKey)) {
                          renderedMidpoints.add(midKey);
                          const cx = toSvgX(midX);
                          const cy = toSvgY(midY);
                          const sideName = EDGE_TO_SIDE[e].toString();

                          labelsToRender.push(
                            <g key={`elbl-${isDerived ? 'derived-' : ''}${tri.id}-${e}`}>
                              <circle cx={cx} cy={cy} r={9} fill={themePalette.midpointFill} stroke={isDerived ? triDisplayColor : themePalette.midpointStroke} strokeWidth={1.5} opacity={0.95} />
                              <text
                                x={cx}
                                y={cy}
                                fill={isDerived ? triDisplayColor : themePalette.midpointText}
                                fontSize="10"
                                fontWeight="800"
                                textAnchor="middle"
                                alignmentBaseline="central"
                                className="font-mono"
                              >
                                {sideName}
                              </text>
                            </g>
                          );
                        }
                      }
                    }
                  }
                };

                processTriangles([baseTriangle], false);
                // Hover annotations cover the same complete reflected chain as the polygons.
                processTriangles(renderableActiveTriangles, true);

                return labelsToRender;
              })()}

              {/* Plain hover (Persistent Labels off): show only the single
                  nearest vertex's coordinate under the cursor instead of the
                  whole triangle's vertices and edge midpoints. */}
              {!showAllLabels && !isDragging && (() => {
                let nearest = null;
                let nearestDistSq = 900; // 30px hit radius, matches the persistent-mode threshold above.

                const considerTriangles = (triangles, isDerived) => {
                  for (const tri of triangles) {
                    for (let i = 0; i < 3; i++) {
                      const p = tri.points[i];
                      const cx = toSvgX(p.x);
                      const cy = toSvgY(p.y);
                      const distSq = (cx - mousePos.x) ** 2 + (cy - mousePos.y) ** 2;
                      if (distSq < nearestDistSq) {
                        nearestDistSq = distSq;
                        nearest = { tri, isDerived, index: i, cx, cy, p };
                      }
                    }
                  }
                };
                considerTriangles([baseTriangle], false);
                considerTriangles(renderableActiveTriangles, true);
                if (!nearest) return null;

                const { tri, isDerived, index, cx, cy, p } = nearest;
                const triDisplayColor = isDerived ? getTriangleRenderStyle(tri).color : themePalette.baseTriangle;
                const vertexName = ['A', 'B', 'C'][index];

                // Dynamic vertex coloring logic based on the all-vertex tower validator.
                let vColor = triDisplayColor;
                let vertexRadius = isDerived ? 4 : 5;
                if (simulatorMode === 'code' && activeTriangles.length > 0) {
                  const symbol = labelsMap[index];
                  const clearancePointValidation = getClearancePointValidation(tri.id, index, symbol);
                  if (clearancePointValidation) {
                    vColor = getShotVertexRenderColor(clearancePointValidation, isDerived ? tri.color : themePalette.baseTriangle);
                    vertexRadius = clearancePointValidation.valid ? vertexRadius : 6;
                  }
                }

                return (
                  <g key={`lbl-${isDerived ? 'derived-' : ''}${tri.id}-${index}`}>
                    <circle cx={cx} cy={cy} r={vertexRadius} fill={vColor} opacity={1} />
                    <text
                      x={cx + 8}
                      y={cy - 6}
                      fill={vColor}
                      fontSize="11"
                      fontWeight="700"
                      className="font-mono tracking-tight"
                      style={{ textShadow: `0 0 5px ${themePalette.labelHalo}, 0 0 5px ${themePalette.labelHalo}, 0 0 8px ${themePalette.labelHalo}` }}
                    >
                      {vertexName}: ({formatPoint(p)})
                    </text>
                  </g>
                );
              })()}
            </g>
          </svg>
        </div>
      </div>

      {/* Valid Angle A-B Region pop-up. A single boolean controls mounting,
          so re-clicking "Plot Valid Angle Region" can never spawn a second
          window; it just bumps anglePlotRequestId to refresh the one that
          exists. Every sequence row is passed through so every visible one
          can be plotted together; `buildValidateCandidateForSequence` lets
          the window build the same constraint check the Angle A/B inputs
          above use, for any row's own sequence text. */}
      {isAnglePlotOpen && (
        <AnglePlotWindow
          sequences={sequences}
          activeSequenceId={activeSequenceId}
          angleParams={angleParams}
          baseLength={Number(angleParams.length) || 0}
          buildValidateCandidateForSequence={buildValidateCandidateForSequence}
          refreshToken={anglePlotRequestId}
          onClose={() => setIsAnglePlotOpen(false)}
          onShowAll={handleShowAllSequences}
          onHideAll={handleHideAllSequences}
          theme={theme}
        />
      )}

      {/* Plain-English error pop-up for a rejected sequence/angle apply
          (Feature 6): no console-only feedback, and no app-provided modal
          system existed to reuse, so this is a small self-contained one. */}
      {errorModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          onClick={closeErrorModal}
          onKeyDown={e => { if (e.key === 'Escape') closeErrorModal(); }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sequence-error-title"
            aria-describedby="sequence-error-message"
            onClick={e => e.stopPropagation()}
            className="w-full max-w-sm bg-[#151c24] border border-red-400/30 rounded-lg shadow-[0_20px_60px_rgba(0,0,0,0.55)] p-4"
          >
            <h3 id="sequence-error-title" className="text-sm font-bold text-red-200 mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {errorModal.title}
            </h3>
            <p id="sequence-error-message" className="text-xs text-slate-300 whitespace-pre-line leading-relaxed mb-4">
              {errorModal.message}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { navigator.clipboard?.writeText(errorModal.message).catch(() => {}); }}
                className="bg-[#0b1016] hover:bg-[#172230] border border-white/10 text-slate-300 px-2.5 py-1.5 rounded-md text-[11px] font-bold transition-colors"
              >
                Copy error details
              </button>
              <button
                type="button"
                autoFocus
                onClick={closeErrorModal}
                className="bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-100 px-3 py-1.5 rounded-md text-[11px] font-bold transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Theme-aware scrollbar styling */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }
      `}</style>
    </div>
  );
}
