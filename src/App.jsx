import { useState, useRef, useEffect, useMemo } from 'react';
import { Maximize, Zap, Settings2, List, Code2, Compass, ChevronRight, Activity } from 'lucide-react';

// Academic color palette: distinct but slightly muted/professional tones
const COLORS = [
  '#dc2626', '#d97706', '#059669', '#0284c7', '#4f46e5', 
  '#7c3aed', '#c026d3', '#e11d48', '#ea580c', '#65a30d',
  '#0891b2', '#2563eb', '#db2777', '#b45309', '#16a34a'
];

// Mapping triangle edges (0, 1, 2) to their standard Side numbers (1, 2, 3)
// Edge 0 (V0-V1) is opposite V2(C) -> Side 3
// Edge 1 (V1-V2) is opposite V0(A) -> Side 1
// Edge 2 (V2-V0) is opposite V1(B) -> Side 2
const EDGE_TO_SIDE = { 0: 3, 1: 1, 2: 2 };

// ==========================================
// MATHEMATICAL CORE FUNCTIONS (Optimized)
// ==========================================

/**
 * Reflects a point perfectly across a line segment using Linear Algebra (IEEE 754 precision)
 */
const reflectPoint = (p, p1, p2) => {
  const a = p2.y - p1.y; 
  const b = p1.x - p2.x; 
  const c = p2.x * p1.y - p1.x * p2.y; 
  
  const denom = a * a + b * b;
  if (denom === 0) return { ...p }; 
  
  const factor = 2 * (a * p.x + b * p.y + c) / denom;
  return { x: p.x - a * factor, y: p.y - b * factor };
};

/** Calculates the geometric center of a triangle */
const getCentroid = (tri) => ({
  x: (tri[0].x + tri[1].x + tri[2].x) / 3,
  y: (tri[0].y + tri[1].y + tri[2].y) / 3
});

/** Peeks at where a triangle's centroid would end up if it were reflected across a specific edge */
const testCentroid = (tri, edge) => {
  const p1 = tri[edge];
  const p2 = tri[(edge + 1) % 3];
  const p3 = tri[(edge + 2) % 3];
  const newP3 = reflectPoint(p3, p1, p2);
  return { x: (p1.x + p2.x + newP3.x) / 3, y: (p1.y + p2.y + newP3.y) / 3 };
};

/** Uses Law of Cosines to measure the exact internal radian angle at vertex p2 */
const getAngleAtVertex = (p1, p2, p3) => {
  const dist13_sq = (p1.x - p3.x)**2 + (p1.y - p3.y)**2;
  const dist12_sq = (p1.x - p2.x)**2 + (p1.y - p2.y)**2;
  const dist23_sq = (p3.x - p2.x)**2 + (p3.y - p2.y)**2;
  if (dist12_sq === 0 || dist23_sq === 0) return 0;
  let cosVal = (dist12_sq + dist23_sq - dist13_sq) / (2 * Math.sqrt(dist12_sq) * Math.sqrt(dist23_sq));
  return Math.acos(Math.max(-1, Math.min(1, cosVal))); 
};

/** Calculates global angular trajectory securely in 360 space */
const getGlobalAngle = (startP, endP) => {
  const dx = endP.x - startP.x;
  const dy = endP.y - startP.y;
  let angle = Math.atan2(dy, dx) * (180 / Math.PI);
  if (angle < 0) angle += 360; 
  return angle;
};

// ==========================================
// MAIN APPLICATION COMPONENT
// ==========================================

export default function App() {
  // --- APP STATE VARIABLES ---
  const [simulatorMode, setSimulatorMode] = useState('code'); 
  const [baseInputMode, setBaseInputMode] = useState('angles'); 
  const [angleParams, setAngleParams] = useState({ a: 15, b: 50, length: 10 }); 
  const [baseCoordsInput, setBaseCoordsInput] = useState([
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 5 } 
  ]);
  
  // --- RAY SIMULATOR SPECIFIC STATE ---
  const [rayStartVertex, setRayStartVertex] = useState(0); 
  const [rayAngle, setRayAngle] = useState(60); 
  const [maxBounces, setMaxBounces] = useState(15); 
  
  // --- CODE UNFOLDER SPECIFIC STATE ---
  const [billiardsCode, setBilliardsCode] = useState("3 1 7 2 6 2 8 2 4 2"); 
  const [showAllLabels, setShowAllLabels] = useState(false);

  // --- VIEWPORT & INTERACTION STATE ---
  const containerRef = useRef(null); 
  const [svgSize, setSvgSize] = useState({ width: 800, height: 600 }); 
  const [pan, setPan] = useState({ x: 5, y: 4 }); 
  const [zoom, setZoom] = useState(35); 
  
  const [isDragging, setIsDragging] = useState(false); 
  const lastMouse = useRef({ x: 0, y: 0 }); 
  const [mousePos, setMousePos] = useState({ x: -1000, y: -1000 }); 

  // Mount/Resize observer
  useEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setSvgSize({ width, height });
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Hardware-accelerated zoom block 
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (e) => {
      e.preventDefault();
      const zoomFactor = 1.1;
      const direction = e.deltaY > 0 ? -1 : 1;
      setZoom(prev => Math.max(0.5, Math.min(prev * (direction > 0 ? zoomFactor : 1 / zoomFactor), 5000)));
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);


  // --- DYNAMIC GEOMETRY GENERATION ---
  
  const baseTriangle = useMemo(() => {
    let points;
    if (baseInputMode === 'coords') {
      points = baseCoordsInput.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
    } else {
      const A = Number(angleParams.a) || 0; 
      const B = Number(angleParams.b) || 0; 
      const L = Number(angleParams.length) || 0; 
      const C = 180 - A - B; 
      
      if (A <= 0 || B <= 0 || C <= 0 || L <= 0) {
        points = [{x: 0, y: 0}, {x: Math.max(L, 1), y: 0}, {x: Math.max(L, 1)/2, y: 1}]; 
      } else {
        const radA = A * Math.PI / 180;
        const radB = B * Math.PI / 180;
        const radC = C * Math.PI / 180;
        const b = L * (Math.sin(radB) / Math.sin(radC));
        
        points = [
          { x: 0, y: 0 },
          { x: L, y: 0 },
          { x: b * Math.cos(radA), y: b * Math.sin(radA) }
        ];
      }
    }
    return { id: 'T0', name: 'T0 (Base)', points, color: '#e2e8f0' }; 
  }, [baseCoordsInput, baseInputMode, angleParams]);


  const rayData = useMemo(() => {
    if (simulatorMode !== 'ray') return { triangles: [], rayLine: null };

    const T0 = baseTriangle.points;
    const triangles = [];
    
    const O = { ...T0[rayStartVertex] };
    const rad = (rayAngle * Math.PI) / 180;
    const D = { x: Math.cos(rad), y: Math.sin(rad) };

    let currentTri = [...T0];
    let currentRayT = 0; 

    for (let i = 0; i < maxBounces; i++) {
      let bestT = Infinity; 
      let bestEdge = null; 

      for (let e = 0; e < 3; e++) {
        const V1 = currentTri[e];
        const V2 = currentTri[(e + 1) % 3];
        const E = { x: V2.x - V1.x, y: V2.y - V1.y }; 
        
        const denom = D.x * E.y - D.y * E.x;
        if (Math.abs(denom) < 1e-10) continue; 

        const diff = { x: V1.x - O.x, y: V1.y - O.y };
        const t = (diff.x * E.y - diff.y * E.x) / denom;
        const u = (diff.x * D.y - diff.y * D.x) / denom;

        if (t > currentRayT + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8) {
          if (t < bestT) { 
            bestT = t; 
            bestEdge = e; 
          }
        }
      }

      if (bestEdge === null) break; 

      const hitX = O.x + bestT * D.x;
      const hitY = O.y + bestT * D.y;
      const targetVertex = currentTri[rayStartVertex];
      const distSq = (hitX - targetVertex.x)**2 + (hitY - targetVertex.y)**2;
      
      // Stop rendering if ray hits a target singularity perfectly
      if (distSq < 1e-10) {
        currentRayT = bestT;
        break;
      }

      const p1 = currentTri[bestEdge];
      const p2 = currentTri[(bestEdge + 1) % 3];
      const p3 = currentTri[(bestEdge + 2) % 3];
      const newP3 = reflectPoint(p3, p1, p2);

      const nextTri = [];
      nextTri[bestEdge] = { ...p1 };
      nextTri[(bestEdge + 1) % 3] = { ...p2 };
      nextTri[(bestEdge + 2) % 3] = { ...newP3 };

      triangles.push({
        id: `Ray-T${i+1}`,
        points: nextTri,
        color: COLORS[(i) % COLORS.length]
      });

      currentTri = nextTri;
      currentRayT = bestT;
    }

    let finalT = currentRayT === 0 ? Math.max(svgSize.width, svgSize.height) / zoom : currentRayT;
    return {
      triangles,
      rayLine: { x1: O.x, y1: O.y, x2: O.x + finalT * D.x, y2: O.y + finalT * D.y }
    };
  }, [simulatorMode, baseTriangle, rayStartVertex, rayAngle, maxBounces, svgSize, zoom]);


  const codeData = useMemo(() => {
    const defaultData = { triangles: [], parsedSequence: [], sideSequence: [], idxToAngle: {0: 'x', 1: 'y', 2: 'z'} };
    if (simulatorMode !== 'code' || !billiardsCode.trim()) return defaultData;

    const nums = billiardsCode.trim().split(/\s+/).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
    if (nums.length === 0) return defaultData;

    // --- ALGORITHMIC PARSER ---
    const angles = [];
    const axes = ['x', 'y', 'z'];
    if (nums.length > 0) angles.push('y');
    if (nums.length > 1) angles.push('x');

    for (let i = 2; i < nums.length; i++) {
      const currNum = nums[i - 1]; 
      const currAngle = angles[i - 1];
      const lastAngle = angles[i - 2];

      if (currNum % 2 === 0) angles.push(lastAngle); 
      else angles.push(axes.find(a => a !== currAngle && a !== lastAngle)); 
    }

    const parsedSequence = nums.map((n, i) => ({ count: n, angle: angles[i] }));
    
    // --- SMART ANGLE MAPPING ---
    const maxBouncesCode = { x: 0, y: 0, z: 0 };
    parsedSequence.forEach(step => {
      if (step.count > maxBouncesCode[step.angle]) {
        maxBouncesCode[step.angle] = step.count;
      }
    });

    const pts = baseTriangle.points;
    const actualAngles = [
      { idx: 0, rad: getAngleAtVertex(pts[2], pts[0], pts[1]) }, 
      { idx: 1, rad: getAngleAtVertex(pts[0], pts[1], pts[2]) }, 
      { idx: 2, rad: getAngleAtVertex(pts[1], pts[2], pts[0]) }  
    ].sort((a, b) => a.rad - b.rad); 

    const syms = ['x', 'y', 'z'].sort((a, b) => (maxBouncesCode[b] - maxBouncesCode[a]) || a.localeCompare(b));

    const angleToIdx = {}; 
    const idxToAngle = {}; 
    angleToIdx[syms[0]] = actualAngles[0].idx; idxToAngle[actualAngles[0].idx] = syms[0];
    angleToIdx[syms[1]] = actualAngles[1].idx; idxToAngle[actualAngles[1].idx] = syms[1];
    angleToIdx[syms[2]] = actualAngles[2].idx; idxToAngle[actualAngles[2].idx] = syms[2];

    // --- SPATIAL MIRRORING ---
    const triangles = [];
    const sideSequence = []; 
    let currentTri = [...baseTriangle.points];
    let currentCentroid = getCentroid(currentTri);
    let currentDir = { x: currentCentroid.x - currentTri[0].x, y: currentCentroid.y - currentTri[0].y };

    let lastEdge = null; 
    let triCount = 0;
    const MAX_TRIS = 3000; 
    
    const getEdgesForAngle = (idx) => idx === 0 ? [0, 2] : (idx === 1 ? [0, 1] : [1, 2]);

    for (const step of parsedSequence) {
      const edges = getEdgesForAngle(angleToIdx[step.angle]);
      let currentEdge;

      if (lastEdge !== null && edges.includes(lastEdge)) {
        currentEdge = edges[0] === lastEdge ? edges[1] : edges[0];
      } else {
        const cA = testCentroid(currentTri, edges[0]);
        const cB = testCentroid(currentTri, edges[1]);
        
        const dotA = (cA.x - currentCentroid.x) * currentDir.x + (cA.y - currentCentroid.y) * currentDir.y;
        const dotB = (cB.x - currentCentroid.x) * currentDir.x + (cB.y - currentCentroid.y) * currentDir.y;
        currentEdge = dotA > dotB ? edges[0] : edges[1];
      }

      for (let i = 0; i < step.count; i++) {
        if (triCount >= MAX_TRIS) break;

        sideSequence.push(EDGE_TO_SIDE[currentEdge]);

        const p1 = currentTri[currentEdge];
        const p2 = currentTri[(currentEdge + 1) % 3];
        const p3 = currentTri[(currentEdge + 2) % 3];
        const newP3 = reflectPoint(p3, p1, p2);

        const nextTri = [];
        nextTri[currentEdge] = { ...p1 };
        nextTri[(currentEdge + 1) % 3] = { ...p2 };
        nextTri[(currentEdge + 2) % 3] = { ...newP3 };

        triangles.push({
          id: `Code-T${triangles.length + 1}`,
          points: nextTri,
          color: COLORS[(triangles.length) % COLORS.length]
        });

        const nextCentroid = getCentroid(nextTri);
        currentDir = { x: nextCentroid.x - currentCentroid.x, y: nextCentroid.y - currentCentroid.y };
        currentCentroid = nextCentroid;

        currentTri = nextTri;
        lastEdge = currentEdge;
        currentEdge = currentEdge === edges[0] ? edges[1] : edges[0];
        triCount++;
      }
      if (triCount >= MAX_TRIS) break;
    }

    return { triangles, parsedSequence, idxToAngle, sideSequence };
  }, [simulatorMode, billiardsCode, baseTriangle]);


  // --- GEOMETRY ROUTER ---
  const activeTriangles = simulatorMode === 'ray' ? rayData.triangles : codeData.triangles;
  const labelsMap = codeData.idxToAngle || {0: 'x', 1: 'y', 2: 'z'};

  // Extracted constants to prevent repeated calculation overhead inside rendering logic
  const startA = baseTriangle.points[0];
  const finalA = activeTriangles.length > 0 ? activeTriangles[activeTriangles.length - 1].points[0] : startA;
  const lineDx = finalA.x - startA.x;
  const lineDy = finalA.y - startA.y;

  // --- INTERACTION HANDLERS ---
  const handleMouseDown = (e) => {
    if (e.button !== 0) return; 
    setIsDragging(true);
    lastMouse.current = { x: e.clientX, y: e.clientY };
  };
  
  const handleMouseMove = (e) => {
    if (isDragging) {
      const dx = (e.clientX - lastMouse.current.x) / zoom;
      const dy = (e.clientY - lastMouse.current.y) / zoom;
      setPan(prev => ({ x: prev.x - dx, y: prev.y + dy }));
      lastMouse.current = { x: e.clientX, y: e.clientY };
    } else {
      if (containerRef.current && !showAllLabels) {
        const rect = containerRef.current.getBoundingClientRect();
        setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
    }
  };
  
  const handleMouseUp = () => setIsDragging(false);

  const handleFitScreen = () => {
    const allTris = [baseTriangle, ...activeTriangles];
    if (allTris.length === 0) return;
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    allTris.forEach(tri => tri.points.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }));
    
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    setPan({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
    setZoom(Math.min((svgSize.width - 100) / w, (svgSize.height - 100) / h));
  };

  // --- RENDERING HELPERS ---
  const transformStr = `translate(${svgSize.width / 2}, ${svgSize.height / 2}) scale(${zoom}, ${-zoom}) translate(${-pan.x}, ${-pan.y})`;
  const toSvgX = (x) => svgSize.width / 2 + (x - pan.x) * zoom;
  const toSvgY = (y) => svgSize.height / 2 - (y - pan.y) * zoom; 
  
  const grid = useMemo(() => {
    const step = zoom > 150 ? 1 : zoom > 50 ? 2 : zoom > 15 ? 10 : 50;
    
    const minMathX = pan.x - (svgSize.width / 2) / zoom;
    const maxMathX = pan.x + (svgSize.width / 2) / zoom;
    const minMathY = pan.y - (svgSize.height / 2) / zoom;
    const maxMathY = pan.y + (svgSize.height / 2) / zoom;

    const linesX = [], linesY = [];
    for (let x = Math.floor(minMathX / step) * step; x <= maxMathX; x += step) linesX.push(x);
    for (let y = Math.floor(minMathY / step) * step; y <= maxMathY; y += step) linesY.push(y);
    return { linesX, linesY, minMathX, maxMathX, minMathY, maxMathY };
  }, [pan, zoom, svgSize]);


  return (
    <div className="flex h-screen w-full min-w-0 bg-[#080b0f] text-slate-200 font-sans overflow-hidden">
      
      {/* LEFT PANEL - CONTROLS & INSPECTOR */}
      <div className="w-[340px] 2xl:w-[360px] border-r border-white/10 flex flex-col bg-[#10151c] shadow-[12px_0_36px_rgba(0,0,0,0.32)] z-10 overflow-hidden shrink-0">
        
        {/* App Header & Tabs */}
        <div className="pt-8 pb-0 px-5 border-b border-white/10 bg-[#0c1117] shrink-0">
          <h1 className="text-xl font-bold text-slate-100 tracking-tight flex items-center gap-2 mb-1">
            <Activity className="w-5 h-5 text-cyan-300" /> Unfolding Viewer
          </h1>
          <p className="text-[11px] font-medium text-slate-500 uppercase tracking-widest mb-5">Invisible Point Workbench</p>
          
          <div className="flex gap-2">
            <button 
              onClick={() => setSimulatorMode('ray')}
              className={`px-3 pb-3 text-sm font-semibold transition-all border-b-2 flex items-center gap-1.5 ${simulatorMode === 'ray' ? 'border-amber-300 text-amber-200' : 'border-transparent text-slate-500 hover:text-slate-200'}`}
            >
              <Zap className="w-4 h-4"/> Ray Sim
            </button>
            <button 
              onClick={() => setSimulatorMode('code')}
              className={`px-3 pb-3 text-sm font-semibold transition-all border-b-2 flex items-center gap-1.5 ${simulatorMode === 'code' ? 'border-cyan-300 text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-200'}`}
            >
              <Code2 className="w-4 h-4"/> Code Sim
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
                <button onClick={() => setBaseInputMode('coords')} className={`px-2 py-1 text-[10px] font-bold rounded ${baseInputMode === 'coords' ? 'bg-cyan-400/15 text-cyan-100 shadow-sm' : 'text-slate-500 hover:text-slate-200'}`}>XY</button>
                <button onClick={() => setBaseInputMode('angles')} className={`px-2 py-1 text-[10px] font-bold rounded ${baseInputMode === 'angles' ? 'bg-cyan-400/15 text-cyan-100 shadow-sm' : 'text-slate-500 hover:text-slate-200'}`}>Deg</button>
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
                      setBaseCoordsInput(newCoords);
                    }} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 placeholder:text-slate-600 transition-all" placeholder="x" />
                    <input type="text" value={baseCoordsInput[i].y} onChange={e => {
                      const newCoords = [...baseCoordsInput];
                      newCoords[i].y = e.target.value;
                      setBaseCoordsInput(newCoords);
                    }} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 placeholder:text-slate-600 transition-all" placeholder="y" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-500 w-16 text-right mr-1">Base Length</span>
                  <input type="number" step="0.1" value={angleParams.length} onChange={e => setAngleParams({...angleParams, length: e.target.value})} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-500 w-16 text-right mr-1">Angle A</span>
                  <div className="relative w-full">
                    <input type="number" step="0.1" value={angleParams.a} onChange={e => setAngleParams({...angleParams, a: e.target.value})} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all pr-6" />
                    <span className="absolute right-2 top-1.5 text-slate-500 font-mono text-xs">&deg;</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-500 w-16 text-right mr-1">Angle B</span>
                  <div className="relative w-full">
                    <input type="number" step="0.1" value={angleParams.b} onChange={e => setAngleParams({...angleParams, b: e.target.value})} className="w-full bg-[#0b1016] border border-white/10 rounded-md px-2.5 py-1.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono text-slate-100 transition-all pr-6" />
                    <span className="absolute right-2 top-1.5 text-slate-500 font-mono text-xs">&deg;</span>
                  </div>
                </div>
                {(Number(angleParams.a) + Number(angleParams.b) >= 180) && (
                  <div className="text-[10px] text-red-200 mt-1 pl-16 text-center font-medium bg-red-500/10 rounded py-1 border border-red-400/20">Angles must sum &lt; 180&deg;</div>
                )}
              </div>
            )}
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
                      <button key={v} onClick={() => setRayStartVertex(v)} className={`flex-1 py-1.5 text-xs rounded-md font-bold border transition-colors ${rayStartVertex === v ? 'bg-amber-300/15 border-amber-300/40 text-amber-100' : 'bg-[#0b1016] border-white/10 text-slate-500 hover:text-slate-200 hover:border-slate-500/50'}`}>{['A', 'B', 'C'][v]}</button>
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
              <h2 className="text-xs uppercase tracking-wider font-bold text-cyan-200 mb-2 flex items-center gap-1.5">
                <Code2 className="w-3.5 h-3.5" /> Sequence Parser
              </h2>
              <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
                Space-separated bounce-block counts, parsed into symbolic angle runs.
              </p>
              <textarea 
                value={billiardsCode}
                onChange={e => setBilliardsCode(e.target.value)}
                className="w-full bg-[#0b1016] border border-white/10 rounded-md p-2.5 text-sm focus:bg-[#101923] focus:border-cyan-300 focus:ring-1 focus:ring-cyan-300 outline-none font-mono resize-none h-20 text-slate-100 shadow-inner placeholder:text-slate-600"
                placeholder="e.g. 1 5 16 5 1 2 3 6"
              />
            </div>
          )}

          {/* ANALYTICS & DATA LOGS */}
          <div className="px-3 pb-8">
            
            {/* V0 TRAJECTORY (Always visible if active) */}
            {activeTriangles.length > 0 && (
              <div className="mb-3 bg-[#151c24] p-4 rounded-lg border border-white/10 shadow-[0_8px_28px_rgba(0,0,0,0.22)]">
                <h3 className="text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-3 flex items-center gap-1.5">
                  <Compass className="w-3 h-3 text-cyan-300"/> Trajectory Analysis (A)
                </h3>
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-center border-b border-white/10 pb-2">
                    <span className="text-[11px] text-slate-500 font-medium">Final Coordinate</span>
                    <span className="text-xs font-mono text-slate-100 font-semibold bg-[#0b1016] px-2 py-0.5 rounded border border-white/10">
                      {finalA.x.toFixed(4)}, {finalA.y.toFixed(4)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] text-slate-500 font-medium">Global Angle <span className="font-mono text-[9px] text-slate-600 ml-1">atan2</span></span>
                    <span className="text-xs font-mono text-cyan-100 font-bold bg-cyan-400/10 px-2 py-0.5 rounded border border-cyan-300/20">
                      {getGlobalAngle(startA, finalA).toFixed(6)}&deg;
                    </span>
                  </div>
                </div>
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
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-slate-500 ml-1">
                    <div>A ({labelsMap[0]}): <span className="text-slate-200 font-medium">{baseTriangle.points[0].x.toFixed(4)}, {baseTriangle.points[0].y.toFixed(4)}</span></div>
                    <div>B ({labelsMap[1]}): <span className="text-slate-200 font-medium">{baseTriangle.points[1].x.toFixed(4)}, {baseTriangle.points[1].y.toFixed(4)}</span></div>
                    <div className="col-span-2">C ({labelsMap[2]}): <span className="text-slate-200 font-medium">{baseTriangle.points[2].x.toFixed(4)}, {baseTriangle.points[2].y.toFixed(4)}</span></div>
                  </div>
                </div>

                {activeTriangles.slice(0, 50).map(tri => (
                  <div key={tri.id} className="text-[11px] font-mono bg-[#111821] p-2 rounded-md border border-white/10 shadow-sm relative overflow-hidden hover:bg-[#18222c] transition-colors">
                    <div className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: tri.color }} />
                    <div className="font-bold mb-1 text-slate-300 ml-1.5">{tri.id}</div>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-slate-500 ml-1.5">
                      <div>A: <span className="text-slate-300">{tri.points[0].x.toFixed(4)}, {tri.points[0].y.toFixed(4)}</span></div>
                      <div>B: <span className="text-slate-300">{tri.points[1].x.toFixed(4)}, {tri.points[1].y.toFixed(4)}</span></div>
                      <div className="col-span-2">C: <span className="text-slate-300">{tri.points[2].x.toFixed(4)}, {tri.points[2].y.toFixed(4)}</span></div>
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
          <button onClick={handleFitScreen} className="bg-[#101820]/95 hover:bg-[#172230] text-slate-300 hover:text-cyan-200 p-2.5 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.32)] border border-white/10 transition-colors backdrop-blur" title="Fit to Screen">
            <Maximize className="w-4 h-4" />
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
                {grid.linesX.map(x => <line key={`gx-${x}`} x1={x} y1={grid.minMathY} x2={x} y2={grid.maxMathY} stroke={x === 0 ? "#334155" : "#182231"} strokeWidth={(x === 0 ? 2 : 1) / zoom} />)}
                {grid.linesY.map(y => <line key={`gy-${y}`} x1={grid.minMathX} y1={y} x2={grid.maxMathX} y2={y} stroke={y === 0 ? "#334155" : "#182231"} strokeWidth={(y === 0 ? 2 : 1) / zoom} />)}
              </g>

              {/* Generated Reflections - Glassy geometry look */}
              {activeTriangles.map(tri => (
                <polygon
                  key={tri.id}
                  points={`${tri.points[0].x},${tri.points[0].y} ${tri.points[1].x},${tri.points[1].y} ${tri.points[2].x},${tri.points[2].y}`}
                  fill={tri.color}
                  fillOpacity="0.1"
                  stroke={tri.color}
                  strokeWidth={2.2 / zoom} 
                  strokeLinejoin="round"
                />
              ))}

              {/* Base Triangle - Prominent Anchor */}
              <polygon
                points={`${baseTriangle.points[0].x},${baseTriangle.points[0].y} ${baseTriangle.points[1].x},${baseTriangle.points[1].y} ${baseTriangle.points[2].x},${baseTriangle.points[2].y}`}
                fill={baseTriangle.color}
                fillOpacity="0.08"
                stroke={baseTriangle.color}
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
                    x1={startA.x} y1={startA.y}
                    x2={finalA.x} y2={finalA.y}
                    stroke="#dc2626" strokeWidth={2.5 / zoom} strokeDasharray={`${8 / zoom},${8 / zoom}`} strokeLinecap="round"
                  />
                </g>
              )}
            </g>

            {/* UNSCALED SCREEN-SPACE ANNOTATIONS */}
            <g pointerEvents="none">
              
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
                      fill="#cbd5e1" 
                      fontSize="14" 
                      fontWeight="700"
                      textAnchor="middle"
                      alignmentBaseline="middle"
                      className="font-mono" 
                      style={{ 
                        textShadow: '0 0 5px #070b10, 0 0 5px #070b10, 0 0 8px #070b10',
                        fontStyle: 'italic'
                      }}
                    >
                      {angleLabel}
                    </text>
                  );
                });
              })()}

              {/* Dynamic Annotation Engine (Proximity Hover & Vertex Coloring) */}
              {(() => {
                const labelsToRender = [];
                const renderedCoords = new Set();
                const renderedMidpoints = new Set();

                const processTriangles = (triangles, isDerived) => {
                  for (const tri of triangles) {
                    let triHovered = showAllLabels;
                    
                    if (!triHovered && !isDragging) {
                      for (const p of tri.points) {
                        const cx = toSvgX(p.x); 
                        const cy = toSvgY(p.y); 
                        if ((cx - mousePos.x)**2 + (cy - mousePos.y)**2 < 900) {
                          triHovered = true;
                          break;
                        }
                      }
                    }

                    if (triHovered) {
                      // 1. Vertex Coordinates Annotation
                      for (let i = 0; i < 3; i++) {
                        const p = tri.points[i];
                        const cx = toSvgX(p.x);
                        const cy = toSvgY(p.y);
                        const coordKey = `${p.x.toFixed(5)},${p.y.toFixed(5)}`;

                        if (!renderedCoords.has(coordKey)) {
                          renderedCoords.add(coordKey);
                          const vertexName = ['A', 'B', 'C'][i];
                          
                          // Dynamic vertex coloring logic based on proximity to the central trajectory line
                          let vColor = isDerived ? tri.color : '#e2e8f0';
                          let isStartOrFinal = false;

                          if (activeTriangles.length > 0) {
                            const isStartA = tri.id === 'T0' && i === 0;
                            const isFinalA = tri.id === activeTriangles[activeTriangles.length - 1].id && i === 0;
                            
                            if (isStartA || isFinalA) {
                              vColor = '#dc2626'; // Red for origin/final trajectory anchors
                              isStartOrFinal = true;
                            } else {
                              if (Math.abs(lineDx) > 1e-10) {
                                const yLine = startA.y + (p.x - startA.x) * (lineDy / lineDx);
                                if (p.y > yLine + 1e-8) vColor = '#2563eb'; // Blue for above the line mathematically
                                else if (p.y < yLine - 1e-8) vColor = '#e5e7eb'; // Light mark for below the line on dark canvas
                                else vColor = '#e5e7eb'; 
                              } else {
                                if (p.x < startA.x - 1e-8) vColor = '#2563eb';
                                else vColor = '#e5e7eb';
                              }
                            }
                          }

                          labelsToRender.push(
                            <g key={`lbl-${isDerived ? 'derived-' : ''}${tri.id}-${i}`}>
                              <circle cx={cx} cy={cy} r={isStartOrFinal ? 6 : (isDerived ? 4 : 5)} fill={vColor} opacity={1} />
                              <text 
                                x={cx + 8} 
                                y={cy - 6} 
                                fill={vColor} 
                                fontSize="11" 
                                fontWeight="700"
                                className="font-mono tracking-tight" 
                                style={{ textShadow: '0 0 5px #070b10, 0 0 5px #070b10, 0 0 8px #070b10' }}
                              >
                                {vertexName}: ({p.x.toFixed(4)}, {p.y.toFixed(4)})
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
                              <circle cx={cx} cy={cy} r={9} fill="#0b1016" stroke={isDerived ? tri.color : "#cbd5e1"} strokeWidth={1.5} opacity={0.95} />
                              <text
                                x={cx}
                                y={cy}
                                fill={isDerived ? tri.color : "#e2e8f0"}
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
                processTriangles(activeTriangles, true);
                
                return labelsToRender;
              })()}
            </g>
          </svg>
        </div>
      </div>
      
      {/* Dark Theme Scrollbar Styling */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #64748b; }
      `}</style>
    </div>
  );
}
