import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const APP_SOURCE_URL = new URL('../src/App.jsx', import.meta.url);

const loadMathApi = () => {
  const source = readFileSync(APP_SOURCE_URL, 'utf8');
  const helperSource = source.split('export default function App()')[0].replace(/^import .*$/gm, '');
  eval(`${helperSource}
globalThis.__unfolderMathApi = {
  DEFAULT_CLEARANCE_EPSILON,
  buildAngleParamsFromSymbolValues,
  buildBaseTriangle,
  buildCodePathConsistencyValidation,
  buildCodePathReference,
  buildFanConstraintValidation,
  buildPoolshotTowerValidation,
  findStableRegion,
  getAngleAtVertex,
  getGlobalAngle,
  getRenderableActiveTriangles,
  getSymbolAngleValues,
  getSymbolAngleDegreesFromTriangle,
  reflectPoint,
  resolvePositiveInputStep,
  unfoldCodeData
};`);
  const api = globalThis.__unfolderMathApi;
  delete globalThis.__unfolderMathApi;
  return api;
};

const api = loadMathApi();

const DEFAULT_CODE = '3 1 7 2 6 2 8 2 4 2';

const DEFAULT_ANGLE_PARAMS = { a: 15, b: 50, length: 10 };

const degrees = (radians) => radians * 180 / Math.PI;

const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);

const midpoint = (left, right) => ({ x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 });

const signedLineNumerator = (point, lineA, lineB) => (
  (lineB.x - lineA.x) * (point.y - lineA.y) - (lineB.y - lineA.y) * (point.x - lineA.x)
);

const assertAlmostEqual = (actual, expected, tolerance = 1e-10, label = 'value') => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, received ${actual}`);
};

const assertPointAlmostEqual = (actual, expected, tolerance = 1e-10, label = 'point') => {
  assertAlmostEqual(actual.x, expected.x, tolerance, `${label}.x`);
  assertAlmostEqual(actual.y, expected.y, tolerance, `${label}.y`);
};

const buildDefaultCodeData = () => {
  const baseTriangle = api.buildBaseTriangle('angles', [], DEFAULT_ANGLE_PARAMS);
  const codeData = api.unfoldCodeData(DEFAULT_CODE, baseTriangle, true);
  return { baseTriangle, codeData };
};

test('editable native input steps accept a configurable positive increment and safely fall back', () => {
  assert.equal(api.resolvePositiveInputStep('0.0025', 0.0001), 0.0025);
  assert.equal(api.resolvePositiveInputStep('0.0000003', 0.0001), 0.0000003);
  assert.equal(api.resolvePositiveInputStep('', 0.0001), 0.0001);
  assert.equal(api.resolvePositiveInputStep('0', 0.0001), 0.0001);
  assert.equal(api.resolvePositiveInputStep('-1', 0.0001), 0.0001);
});

const validateCandidate = (a, b, referenceData = null) => {
  const baseTriangle = api.buildBaseTriangle('angles', [], { a, b, length: 10 });
  const codeData = api.unfoldCodeData(DEFAULT_CODE, baseTriangle, true);
  const pathReference = referenceData ? api.buildCodePathReference(referenceData) : null;
  const pathConsistency = pathReference
    ? api.buildCodePathConsistencyValidation({ candidateCodeData: codeData, reference: pathReference })
    : { status: 'valid', violations: [] };
  const validation = api.buildPoolshotTowerValidation({
    simulatorMode: 'code',
    baseTriangle,
    activeTriangles: codeData.triangles,
    labelsMap: codeData.idxToAngle,
    reflectionEdges: codeData.reflectionEdges,
    parsedSequence: codeData.parsedSequence,
    clearanceEpsilon: api.DEFAULT_CLEARANCE_EPSILON,
    extraViolations: pathConsistency.violations
  });
  return { baseTriangle, codeData, pathConsistency, validation };
};

test('reflectPoint satisfies exact mirror invariants within floating-point tolerance', () => {
  assertPointAlmostEqual(api.reflectPoint({ x: 2, y: 3 }, { x: -5, y: 0 }, { x: 7, y: 0 }), { x: 2, y: -3 }, 1e-12, 'horizontal reflection');
  assertPointAlmostEqual(api.reflectPoint({ x: 4, y: -2 }, { x: 1, y: -5 }, { x: 1, y: 5 }), { x: -2, y: -2 }, 1e-12, 'vertical reflection');

  const lineA = { x: -2.5, y: 0.75 };
  const lineB = { x: 4.25, y: 5.5 };
  const source = { x: 3.2, y: -1.7 };
  const reflected = api.reflectPoint(source, lineA, lineB);
  const reflectedTwice = api.reflectPoint(reflected, lineA, lineB);
  const bisectorPoint = midpoint(source, reflected);

  assertPointAlmostEqual(reflectedTwice, source, 1e-10, 'double reflection');
  assertAlmostEqual(distance(source, lineA), distance(reflected, lineA), 1e-10, 'distance to first line point');
  assertAlmostEqual(distance(source, lineB), distance(reflected, lineB), 1e-10, 'distance to second line point');
  assertAlmostEqual(signedLineNumerator(source, lineA, lineB), -signedLineNumerator(reflected, lineA, lineB), 1e-10, 'opposite signed line distances');
  assertAlmostEqual(signedLineNumerator(bisectorPoint, lineA, lineB), 0, 1e-10, 'midpoint lies on mirror line');
});

test('angle-mode triangle construction preserves requested Euclidean geometry', () => {
  const baseTriangle = api.buildBaseTriangle('angles', [], DEFAULT_ANGLE_PARAMS);
  const [vertexA, vertexB, vertexC] = baseTriangle.points;

  assertPointAlmostEqual(vertexA, { x: 0, y: 0 }, 1e-12, 'physical A');
  assertPointAlmostEqual(vertexB, { x: 10, y: 0 }, 1e-12, 'physical B');
  assertAlmostEqual(distance(vertexA, vertexB), 10, 1e-12, 'base length AB');
  assertAlmostEqual(degrees(api.getAngleAtVertex(vertexB, vertexA, vertexC)), 15, 1e-10, 'angle A');
  assertAlmostEqual(degrees(api.getAngleAtVertex(vertexA, vertexB, vertexC)), 50, 1e-10, 'angle B');
  assertAlmostEqual(degrees(api.getAngleAtVertex(vertexA, vertexC, vertexB)), 115, 1e-10, 'angle C');
});

test('default code unfolding has the known symbolic mapping and side path', () => {
  const { baseTriangle, codeData } = buildDefaultCodeData();

  assert.deepEqual(codeData.idxToAngle, { 0: 'x', 1: 'y', 2: 'z' });
  assert.deepEqual(codeData.angleToIdx, { x: 0, y: 1, z: 2 });
  assert.equal(codeData.triangles.length, 37);
  assert.equal(codeData.sideSequence.length, 37);
  assert.equal(codeData.reflectionEdges.length, 37);
  assert.deepEqual(codeData.parsedSequence.map(step => `${step.count}${step.angle}`), ['3y', '1z', '7x', '2y', '6x', '2y', '8x', '2y', '4x', '2y']);
  assert.deepEqual(
    codeData.parsedSequence.map((step, runIndex) => codeData.triangles.filter(tri => tri.fanRunIndex === runIndex).length),
    codeData.parsedSequence.map(step => step.count)
  );
  for (let runIndex = 0; runIndex < codeData.parsedSequence.length; runIndex++) {
    const runTriangles = codeData.triangles.filter(tri => tri.fanRunIndex === runIndex);
    for (const tri of runTriangles) {
      assert.equal(tri.fanRunCount, codeData.parsedSequence[runIndex].count);
      assert.equal(tri.fanSymbol, codeData.parsedSequence[runIndex].angle);
      assertPointAlmostEqual(tri.fanPoint, runTriangles[0].fanPoint, 1e-10, `fan ${runIndex} point`);
    }
  }
  assert.deepEqual(codeData.sideSequence.slice(0, 15), [1, 3, 1, 2, 3, 2, 3, 2, 3, 2, 3, 1, 3, 2, 3]);
  assert.deepEqual(codeData.reflectionEdges.slice(0, 15), [1, 0, 1, 2, 0, 2, 0, 2, 0, 2, 0, 1, 0, 2, 0]);

  const symbolAngles = api.getSymbolAngleDegreesFromTriangle(baseTriangle, codeData.idxToAngle);
  assertAlmostEqual(symbolAngles.x, 15, 1e-10, 'symbol angle x');
  assertAlmostEqual(symbolAngles.y, 50, 1e-10, 'symbol angle y');
  assertAlmostEqual(symbolAngles.z, 115, 1e-10, 'symbol angle z');
});

test('rendering includes the final reflected triangle instead of treating it as look-ahead geometry', () => {
  const { codeData } = buildDefaultCodeData();
  const renderableTriangles = api.getRenderableActiveTriangles(codeData.triangles);

  assert.equal(renderableTriangles.length, codeData.triangles.length);
  assert.equal(renderableTriangles.length, codeData.parsedSequence.reduce((total, step) => total + step.count, 0));
  assert.strictEqual(renderableTriangles.at(-1), codeData.triangles.at(-1));
  assert.equal(renderableTriangles.at(-1).id, 'Code-T37');
});

test('symbolic angle conversion round-trips through the current physical label map', () => {
  const { codeData } = buildDefaultCodeData();
  const symbols = api.getSymbolAngleValues(DEFAULT_ANGLE_PARAMS, codeData.idxToAngle);
  const rebuilt = api.buildAngleParamsFromSymbolValues(symbols, codeData.idxToAngle, DEFAULT_ANGLE_PARAMS.length);

  assertAlmostEqual(symbols.x, 15, 1e-12, 'symbol x');
  assertAlmostEqual(symbols.y, 50, 1e-12, 'symbol y');
  assertAlmostEqual(symbols.z, 115, 1e-12, 'symbol z');
  assertAlmostEqual(Number(rebuilt.a), 15, 1e-12, 'rebuilt physical A');
  assertAlmostEqual(Number(rebuilt.b), 50, 1e-12, 'rebuilt physical B');
  assertAlmostEqual(Number(rebuilt.length), 10, 1e-12, 'rebuilt length');
});

test('default shot validator excludes endpoint coordinates from line validity and accepts the known valid sample', () => {
  const { baseTriangle, codeData } = buildDefaultCodeData();
  const validation = api.buildPoolshotTowerValidation({
    simulatorMode: 'code',
    baseTriangle,
    activeTriangles: codeData.triangles,
    labelsMap: codeData.idxToAngle,
    reflectionEdges: codeData.reflectionEdges,
    parsedSequence: codeData.parsedSequence,
    clearanceEpsilon: api.DEFAULT_CLEARANCE_EPSILON
  });

  assert.equal(validation.status, 'valid');
  assert.equal(validation.shotGeometry.shotSymbol, 'x');
  assert.equal(validation.shotGeometry.shotVertexIdx, 0);
  assert.equal(validation.checked, (codeData.triangles.length + 1) * 3);
  assert.equal(validation.checked, 114);
  assert.equal(validation.stats.blue, 66);
  assert.equal(validation.stats.red, 45);
  assert.equal(validation.stats.uncolored, 0);
  assert.equal(validation.stats.endpoints, 3);
  assert.equal(validation.stats.invalid, 0);
  assert.equal(validation.stats.fanChecked, 10);
  assertAlmostEqual(validation.stats.fanMaxCentralAngle, 150, 1e-9, 'max fan angle');
  assertAlmostEqual(validation.stats.lineMargin, 0.27988321468051813, 1e-10, 'line margin');
  assert.equal(validation.violations.length, 0);

  const endpointClassifications = [...validation.byOccurrence.values()].filter(classification => classification.isShotEndpoint);
  assert.equal(endpointClassifications.length, validation.stats.endpoints);
  assert.ok(endpointClassifications.every(classification => classification.valid));
  assert.ok(endpointClassifications.every(classification => Math.abs(classification.score) <= 1e-8));
  assert.equal(
    validation.stats.blue + validation.stats.red + validation.stats.uncolored + validation.stats.endpoints,
    validation.checked
  );
});

test('terminal endpoint tower-role conflicts do not invalidate an otherwise valid line', () => {
  const endpointConflictCodes = [
    '2 4 2 10 2 6 2 9 1 2',
    '3 1 9 2 6 2 10 2 4 1'
  ];

  for (const billiardsCode of endpointConflictCodes) {
    const baseTriangle = api.buildBaseTriangle('angles', [], { a: 13, b: 50, length: 10 });
    const codeData = api.unfoldCodeData(billiardsCode, baseTriangle, true);
    const validation = api.buildPoolshotTowerValidation({
      simulatorMode: 'code',
      baseTriangle,
      activeTriangles: codeData.triangles,
      labelsMap: codeData.idxToAngle,
      reflectionEdges: codeData.reflectionEdges,
      parsedSequence: codeData.parsedSequence,
      clearanceEpsilon: api.DEFAULT_CLEARANCE_EPSILON
    });

    assert.equal(validation.status, 'valid', billiardsCode);
    assert.equal(validation.stats.invalid, 0, billiardsCode);
    assert.equal(validation.violations.length, 0, billiardsCode);
    assert.ok(
      [...validation.byOccurrence.values()]
        .filter(classification => classification.isShotEndpoint)
        .every(classification => classification.valid),
      billiardsCode
    );
  }
});

test('direct blue/black y-line predicate rejects known invalid angle perturbations before rendering', () => {
  const { codeData: referenceData } = buildDefaultCodeData();

  const knownValidA = validateCandidate(15.1, 50, referenceData);
  assert.equal(knownValidA.pathConsistency.status, 'valid');
  assert.equal(knownValidA.validation.status, 'valid');

  const knownValidB = validateCandidate(15, 50.1, referenceData);
  assert.equal(knownValidB.pathConsistency.status, 'valid');
  assert.equal(knownValidB.validation.status, 'valid');

  const invalidA = validateCandidate(16, 50, referenceData).validation;
  assert.equal(invalidA.status, 'invalid');
  assert.equal(invalidA.violations[0].triId, 'T0');
  assert.equal(invalidA.violations[0].vertexName, 'B');
  assert.equal(invalidA.violations[0].symbol, 'y');
  assert.equal(invalidA.violations[0].expected, 'black y < line y');
  assert.ok(invalidA.violations[0].score > 0);

  const invalidB = validateCandidate(15, 51, referenceData).validation;
  assert.equal(invalidB.status, 'invalid');
  assert.equal(invalidB.violations[0].expected, 'blue y > line y');
  assert.ok(invalidB.violations[0].score < 0);

  const invalidC = validateCandidate(14, 50, referenceData).validation;
  assert.equal(invalidC.status, 'invalid');
  assert.equal(invalidC.violations[0].triId, 'T0');
  assert.equal(invalidC.violations[0].vertexName, 'C');
  assert.equal(invalidC.violations[0].symbol, 'z');
  assert.equal(invalidC.violations[0].expected, 'blue y > line y');
  assert.ok(invalidC.violations[0].score < 0);
});

test('fan central-angle failures are reported independently of the line-side scan', () => {
  const { codeData: referenceData } = buildDefaultCodeData();
  const invalidFan = validateCandidate(23, 50, referenceData).validation;

  assert.equal(invalidFan.status, 'invalid');
  assert.equal(invalidFan.violations[0].triId, 'fan-7');
  assert.equal(invalidFan.violations[0].symbol, 'x');
  assert.equal(invalidFan.violations[0].vertexName, '8x');
  assert.equal(invalidFan.violations[0].expected, '8x < 180deg');
  assertAlmostEqual(invalidFan.stats.fanMaxCentralAngle, 184, 1e-9, 'fan overflow angle');
  assert.ok(invalidFan.stats.invalid > 0);

  const directFan = api.buildFanConstraintValidation({
    parsedSequence: [{ count: 8, angle: 'x' }],
    symbolAngles: { x: 23, y: 50, z: 107 }
  });
  assert.equal(directFan.status, 'invalid');
  assert.equal(directFan.violations[0].expected, '8x < 180deg');
});

test('code-path consistency distinguishes same-path perturbations from changed interpretations', () => {
  const { codeData: referenceData } = buildDefaultCodeData();
  const reference = api.buildCodePathReference(referenceData);

  const samePath = validateCandidate(15.1, 50, referenceData).codeData;
  assert.equal(api.buildCodePathConsistencyValidation({ candidateCodeData: samePath, reference }).status, 'valid');

  const changedPath = validateCandidate(50, 15, referenceData).codeData;
  const changedValidation = api.buildCodePathConsistencyValidation({ candidateCodeData: changedPath, reference });
  assert.equal(changedValidation.status, 'invalid');
  assert.ok(changedValidation.violations.some(violation => violation.expected === 'same symbolic angle mapping'));
});

test('stable-region search finds a local component around the known valid symbolic point', () => {
  const { codeData } = buildDefaultCodeData();
  const result = api.findStableRegion({
    angleParams: DEFAULT_ANGLE_PARAMS,
    labelsMap: codeData.idxToAngle,
    billiardsCode: DEFAULT_CODE,
    currentCodeData: codeData,
    clearanceEpsilon: api.DEFAULT_CLEARANCE_EPSILON
  });

  assert.equal(result.status, 'found');
  assert.equal(result.step, 0.001);
  assert.ok(result.visits > 0);
  assert.equal(result.intervals.zMin, undefined);
  assert.equal(result.intervals.zMax, undefined);
  assert.ok(result.intervals.xMin < 15 && result.intervals.xMax > 15);
  assert.ok(result.intervals.yMin < 50 && result.intervals.yMax > 50);
  assert.ok(result.intervals.xMax - result.intervals.xMin > 0.1);
  assert.ok(result.intervals.yMax - result.intervals.yMin > 0.1);
});

test('global angle uses atan2 quadrant logic for horizontal, vertical, and wrapped rays', () => {
  assertAlmostEqual(api.getGlobalAngle({ x: 0, y: 0 }, { x: 1, y: 0 }), 0, 1e-12, 'east');
  assertAlmostEqual(api.getGlobalAngle({ x: 0, y: 0 }, { x: 0, y: 1 }), 90, 1e-12, 'north');
  assertAlmostEqual(api.getGlobalAngle({ x: 0, y: 0 }, { x: -1, y: 0 }), 180, 1e-12, 'west');
  assertAlmostEqual(api.getGlobalAngle({ x: 0, y: 0 }, { x: 0, y: -1 }), 270, 1e-12, 'south');
});
