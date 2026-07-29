// Graph model: maps between a `graphs` table row (snake_case columns) and
// the plain domain shape the rest of this server (and, eventually, an API
// layer) works with. A pure mapping module — no I/O, no SQL — kept
// separate from graphRepository.js so the *shape* of a graph and the
// *queries* that produce it can change independently.
//
// `params` here is exactly the shape src/anglePlot/graph.js's
// graphParamsFromSequence produces and graphHasher.js's hashGraph consumes
// — the same five fields, the same names — so a graph computed in the
// browser and a graph row in this table are never subtly different
// shapes of "the same thing."

/** @returns {{id, hash, params: {sequenceText, angleA, angleB, angleStepInput, baseLength}, algorithmVersion, ownerUserId, createdAt, updatedAt}} */
export const graphRowToModel = (row) => ({
  id: row.id,
  hash: row.hash,
  params: {
    sequenceText: row.sequence_text,
    angleA: row.angle_a,
    angleB: row.angle_b,
    angleStepInput: row.angle_step_input,
    baseLength: row.base_length,
  },
  algorithmVersion: row.algorithm_version,
  ownerUserId: row.owner_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
