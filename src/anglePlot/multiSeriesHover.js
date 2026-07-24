// Pure hit-testing for the multi-sequence graph: finds every plotted point
// (across every visible series) that sits under/near a screen position, so
// hovering a spot where two sequences' regions overlap can report both
// instead of silently only the series that happened to draw last.
//
// Kept framework/canvas-free (plain screen-space math against caller-
// supplied series arrays) so it is unit-testable without a DOM canvas.

/**
 * @param {{ id: string, label: string, color: string, points: {a:number,b:number}[] }[]} series
 * @param {(a:number) => number} toScreenX
 * @param {(b:number) => number} toScreenY
 * @param {number} screenX
 * @param {number} screenY
 * @param {number} hitRadiusPx - max distance from the cursor to the nearest point.
 * @param {number} mergeRadiusPx - once the nearest point is found, any other
 *   series' point within this distance of *that point* (not the cursor) is
 *   treated as "the same spot" and included too — this is what lets a
 *   fully-overlapping pair of series both show up in one hover instead of
 *   only whichever was nearest the exact pixel.
 * @returns {{ id: string, label: string, color: string, a: number, b: number }[]}
 *   Empty when nothing is within hitRadiusPx. Otherwise sorted with the
 *   cursor-nearest series first.
 */
export const findPointsNearScreenPosition = (series, toScreenX, toScreenY, screenX, screenY, hitRadiusPx, mergeRadiusPx = 3) => {
  let nearest = null;
  let nearestDistSq = hitRadiusPx * hitRadiusPx;

  for (const s of series) {
    for (const p of s.points) {
      const dx = toScreenX(p.a) - screenX;
      const dy = toScreenY(p.b) - screenY;
      const distSq = dx * dx + dy * dy;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = { series: s, point: p, distSq };
      }
    }
  }

  if (!nearest) return [];

  const nearestX = toScreenX(nearest.point.a);
  const nearestY = toScreenY(nearest.point.b);
  const mergeRadiusSq = mergeRadiusPx * mergeRadiusPx;

  const matches = [];
  const seenSeriesIds = new Set();
  for (const s of series) {
    for (const p of s.points) {
      const dx = toScreenX(p.a) - nearestX;
      const dy = toScreenY(p.b) - nearestY;
      if (dx * dx + dy * dy > mergeRadiusSq) continue;
      // One representative point per series per hover, closest wins.
      if (seenSeriesIds.has(s.id)) continue;
      seenSeriesIds.add(s.id);
      matches.push({ id: s.id, label: s.label, color: s.color, a: p.a, b: p.b, isNearest: s.id === nearest.series.id });
    }
  }

  matches.sort((left, right) => (right.isNearest ? 1 : 0) - (left.isNearest ? 1 : 0));
  return matches;
};
