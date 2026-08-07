// Theta: the symbolic angle equation for a code sequence's unfolding,
// expressed in terms of the base triangle's own physical angles X and Y
// (Z is always eliminated via Z = 180 - X - Y, since the base triangle's
// three angles sum to 180 by construction).
//
// Reuses the EXISTING X/Y/Z classification the app already computes for
// every code sequence — App.jsx's unfoldCodeData builds exactly this shape
// (parsedSequence: [{count, angle}], angle one of 'x'/'y'/'z', via
// idxToAngle = {0:'x', 1:'y', 2:'z'}) for every graph, code-driven or
// Angle-Ray-derived alike (see deriveEffectiveSequenceCode). This module
// does not re-derive or guess that classification; it only consumes it.
//
// Sign rule: alternates strictly by POSITION in the sequence, not by which
// symbol a term happens to be — first term negative, second positive, third
// negative, and so on. This mirrors the "cutting sequence" convention where
// consecutive fan terms in an unfolding alternately add and subtract from
// the running angle as the path crosses each side.

/** The symbolic equation always starts here, before any code term is applied. */
export const THETA_INITIAL_CONSTANT = 90;

/**
 * Reduces a code's parsedSequence into { constant, x, y } — the fully
 * Z-eliminated symbolic coefficients of theta = constant + x*X + y*Y.
 *
 * Pure accumulation, no string manipulation: each term's signed coefficient
 * (sign alternates by index, magnitude is the term's own count) is folded
 * directly into the running totals, algebraically substituting
 * Z = 180 - X - Y in place the moment a 'z' term is encountered
 * (coefficient*Z = coefficient*180 - coefficient*X - coefficient*Y).
 *
 * @param {Array<{count: number, angle: 'x'|'y'|'z'}>} parsedSequence
 * @returns {{constant: number, x: number, y: number}|null} null for an
 *   empty/missing sequence (no valid code to compute from) — formatTheta
 *   turns that into the required "θ = —" display.
 */
export const calculateTheta = (parsedSequence) => {
  if (!Array.isArray(parsedSequence) || parsedSequence.length === 0) return null;
  const result = { constant: THETA_INITIAL_CONSTANT, x: 0, y: 0 };
  parsedSequence.forEach((step, index) => {
    // Position-based alternation ONLY — never based on step.angle.
    const sign = index % 2 === 0 ? -1 : 1;
    const coefficient = sign * step.count;
    if (step.angle === 'x') {
      result.x += coefficient;
    } else if (step.angle === 'y') {
      result.y += coefficient;
    } else if (step.angle === 'z') {
      // coefficient * Z = coefficient * (180 - X - Y)
      result.constant += coefficient * 180;
      result.x -= coefficient;
      result.y -= coefficient;
    }
  });
  return result;
};

/**
 * Renders a calculateTheta result as a natural-reading equation string:
 * no "+ -" runs, no explicit "1" coefficients, and every zero term dropped
 * entirely (including a zero constant, so a code that reduces to e.g. just
 * "5X - 3Y" never shows a spurious leading "0").
 *
 * @param {{constant: number, x: number, y: number}|null} theta
 * @returns {string}
 */
export const formatTheta = (theta) => {
  if (!theta) return 'θ = —';

  const terms = [
    { value: theta.constant, label: '' },
    { value: theta.x, label: 'X' },
    { value: theta.y, label: 'Y' },
  ].filter((term) => term.value !== 0);

  if (terms.length === 0) return 'θ = 0';

  const rendered = terms.map((term, index) => {
    const magnitude = Math.abs(term.value) === 1 && term.label ? term.label : `${Math.abs(term.value)}${term.label}`;
    if (index === 0) return term.value < 0 ? `-${magnitude}` : magnitude;
    return term.value < 0 ? ` - ${magnitude}` : ` + ${magnitude}`;
  }).join('');

  return `θ = ${rendered}`;
};
