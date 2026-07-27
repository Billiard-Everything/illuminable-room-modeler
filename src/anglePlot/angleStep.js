// Parses and validates the existing "Angle Step" field and turns it into an
// exact, decimal-safe representation for grid generation.
//
// Why not repeatedly add doubles (and why not integer tenths anymore)
// ---------------------------------------------------------------------
// Binary floating point cannot represent most decimal fractions exactly
// (0.1, 0.01, 0.0000003, ...). Repeatedly adding such a step in ordinary
// `number` arithmetic accumulates rounding error over many iterations,
// which can silently produce duplicate or missing grid points. The
// previous version of this feature sidestepped that by always stepping in
// fixed integer tenths-of-a-degree, but that only works for a hard-coded
// 0.1 step.
//
// Instead, this module parses the step's decimal digits directly out of
// the user's input *string* (never round-tripping through a binary
// `number` for the digits themselves) and represents it as a JS BigInt
// count of "step units" at a given decimal `scale` — e.g. step "0.0000003"
// has scale 7 and is stored as the exact integer 3n (3 * 10^-7). Grid
// generation (see visibleAnglePointGenerator.js) then walks A and B as
// BigInt multiples of that unit, so stepping is exact integer addition no matter
// how small the step is or how many iterations run. Values are converted
// to floating-point `number`s only once per generated point, at the point
// they're handed to the rest of the app's (inherently double-based)
// trig/validation code — a single, non-accumulating conversion, not a
// repeated one.

const PLAIN_DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Validates the raw "Angle Step" text and, if valid, returns its exact
 * decimal-scaled integer representation.
 *
 * @param {string} rawInput
 * @returns {{ valid: true, scale: number, stepUnits: bigint, stepDegrees: number }
 *         | { valid: false, error: string }}
 */
export const parseAngleStep = (rawInput) => {
  if (typeof rawInput !== 'string' || rawInput.trim() === '') {
    return { valid: false, error: 'Angle Step cannot be blank.' };
  }
  const trimmed = rawInput.trim();

  const stepDegrees = Number(trimmed);
  if (!Number.isFinite(stepDegrees)) {
    return { valid: false, error: 'Angle Step must be a numeric value.' };
  }
  if (stepDegrees <= 0) {
    return { valid: false, error: 'Angle Step must be greater than zero.' };
  }
  // Plain decimal notation only (e.g. "0.0000003", not "3e-7"): the exact
  // scaled-integer parsing below reads digits straight off this string, so
  // the string's shape must be a normal decimal number.
  if (!PLAIN_DECIMAL_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Angle Step must be a plain decimal number (e.g. 0.0000003), not scientific notation.' };
  }

  const dotIndex = trimmed.indexOf('.');
  const scale = dotIndex === -1 ? 0 : trimmed.length - dotIndex - 1;
  const digitsOnly = trimmed.replace('.', '');
  const stepUnits = BigInt(digitsOnly);

  return { valid: true, scale, stepUnits, stepDegrees };
};

/**
 * Narrows the full 0 < A < B, A+B <= 90 domain down to an optional viewport
 * rectangle (plain floating degrees, e.g. from the plot panel's current
 * pan/zoom), expressed as exact BigInt step-unit bounds. Used by
 * visibleAnglePointGenerator.js so a "scope to current view" sweep always
 * walks exactly the range it reports.
 *
 * Viewport bounds only need to be *approximately* respected (they come from
 * screen pixels, not a value the user typed), so they are snapped outward
 * (floor for a lower bound, ceil for an upper bound) onto the exact step
 * lattice with plain floating-point division — only the step lattice itself
 * needs to stay BigInt-exact, which this preserves by snapping to whole
 * multiples of `stepUnits`.
 *
 * @returns {{ limitUnits: bigint, startAUnits: bigint, endAUnits: bigint, minBUnits: bigint|null, maxBUnitsCap: bigint|null }}
 *   minBUnits/maxBUnitsCap are null when the view imposes no extra bound
 *   beyond the domain's own A<B and A+B<=90 constraints.
 */
export const computeSweepRange = (scale, stepUnits, viewBounds) => {
  const limitUnits = 90n * (10n ** BigInt(scale));
  const domainMaxAUnits = (limitUnits - stepUnits) / 2n;

  let startAUnits = stepUnits;
  let endAUnits = domainMaxAUnits;
  let minBUnits = null;
  let maxBUnitsCap = null;

  if (viewBounds) {
    const stepDegrees = Number(stepUnits) / 10 ** scale;
    const snapUnits = (degrees, roundUp) => {
      const steps = degrees / stepDegrees;
      const n = roundUp ? Math.ceil(steps) : Math.floor(steps);
      return BigInt(Math.max(0, n)) * stepUnits;
    };
    if (Number.isFinite(viewBounds.minA)) {
      const snapped = snapUnits(viewBounds.minA, false);
      if (snapped > startAUnits) startAUnits = snapped;
    }
    if (Number.isFinite(viewBounds.maxA)) {
      const snapped = snapUnits(viewBounds.maxA, true);
      if (snapped < endAUnits) endAUnits = snapped;
    }
    if (Number.isFinite(viewBounds.minB)) minBUnits = snapUnits(viewBounds.minB, false);
    if (Number.isFinite(viewBounds.maxB)) maxBUnitsCap = snapUnits(viewBounds.maxB, true);
  }

  return { limitUnits, startAUnits, endAUnits, minBUnits, maxBUnitsCap };
};

/** Decimal places needed to show every digit of the given step without rounding it away. */
export const displayScaleForStep = (scale) => Math.max(0, scale);
