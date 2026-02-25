// Force-directed physics with MST-based attraction, graph-distance stress,
// edge crossing penalty, continuous rotation, alignment forces, temperature scaling
// R4: phase 1 crossing minimization — MST nets, stress forces, crossing penalty

export class PhysicsEngine {
    constructor(components, nets) {
        this.components = components;
        this.nets = nets;
        this.compMap = new Map(components.map(c => [c.id, c]));

        // Simulation parameters
        this.baseTemperature = 0.3;
        this.liveTemperature = 0;
        this.repulsionStrength = 1.0;
        this.attractionStrength = 0.08;
        this.gravityStrength = 0.002;
        this.damping = 0.7;
        this.dt = 0.4;
        this.clearanceMargin = 2.0;
        this.rotationDamping = 0.85;
        this.rotationTorqueScale = 0.003;

        // Graph-distance stress parameters
        this.stressStrength = 0.015;      // strength of ideal-distance spring
        this.stressBaseSpacing = 12.0;    // mm per graph hop

        // Edge crossing penalty parameters
        this.crossingStrength = 0.4;      // crossing repulsion force

        // Dipole alignment torque parameters
        this.dipoleStrength = 0.02;       // torque strength for dipole alignment

        // Alignment parameters
        this.directionWays = 4;
        this.directionStrength = 0.05;
        this.gridSpacing = 1.27;
        this.gridStrength = 0.3;

        // Brush state (set by interaction handler)
        this.simBrush = {
            active: false,
            wx: 0, wy: 0,
            radius: 30,
        };
        this.alignBrush = {
            active: false,
            directionActive: false,
            gridActive: false,
            wx: 0, wy: 0,
            radius: 30,
        };

        // Temperature ramping (right-click in sim brush)
        this.tempRamping = false;
        this.tempRampTarget = 0;
        this.tempRampSpeed = 0.1;          // ~10s to fully charge
        this.tempDecaySpeed = 0.2;         // ~5s to fully decay

        // Initialize component angular velocity
        for (const c of components) {
            c.boundingRadius = Math.hypot(c.width / 2, c.height / 2) + this.clearanceMargin;
            if (c.angularVel === undefined) c.angularVel = 0;
            if (c.rotation === undefined) c.rotation = 0;
        }

        // Build component index for graph distance
        this.compIndex = new Map();
        components.forEach((c, i) => this.compIndex.set(c.id, i));

        // Compute graph-distance matrix (signal nets only)
        this.graphDist = this.computeGraphDistances();

        // Cache for MST edges (recomputed periodically)
        this.mstEdgeCache = [];
        this.mstFrameCounter = 0;
        this.mstUpdateInterval = 3; // recompute MST every N frames

        // Precompute dipole map: for each component, list of { netPairKey, localAngle }
        // A "dipole" is the vector between two pads on different nets within the same component.
        this.dipolePairs = this.buildDipolePairs();
    }

    // Build dipole pair lookup: netPairKey -> list of { compId, localAngle }
    // localAngle is the angle of (padB - padA) in the component's local frame
    buildDipolePairs() {
        const pairMap = new Map(); // netPairKey -> [{ compId, localAngle }]

        for (const comp of this.components) {
            // Group pads by net
            const netPads = new Map(); // netName -> [pad]
            for (const pad of comp.pads) {
                if (!pad.net) continue;
                if (!netPads.has(pad.net)) netPads.set(pad.net, []);
                netPads.get(pad.net).push(pad);
            }

            const netNames = [...netPads.keys()].sort();
            // For each unique pair of nets on this component
            for (let i = 0; i < netNames.length; i++) {
                for (let j = i + 1; j < netNames.length; j++) {
                    const nA = netNames[i];
                    const nB = netNames[j];
                    const key = `${nA}::${nB}`;

                    // Use the centroid of each net's pads as the dipole endpoints
                    const padsA = netPads.get(nA);
                    const padsB = netPads.get(nB);
                    let axSum = 0, aySum = 0;
                    for (const p of padsA) { axSum += p.relX; aySum += p.relY; }
                    let bxSum = 0, bySum = 0;
                    for (const p of padsB) { bxSum += p.relX; bySum += p.relY; }

                    const ax = axSum / padsA.length;
                    const ay = aySum / padsA.length;
                    const bx = bxSum / padsB.length;
                    const by = bySum / padsB.length;

                    const dx = bx - ax;
                    const dy = by - ay;
                    if (Math.hypot(dx, dy) < 0.01) continue;

                    const localAngle = Math.atan2(dy, dx);

                    if (!pairMap.has(key)) pairMap.set(key, []);
                    pairMap.get(key).push({ compId: comp.id, localAngle });
                }
            }
        }

        return pairMap;
    }

    setTemperature(t) { this.baseTemperature = t; }
    setRepulsionStrength(r) { this.repulsionStrength = r; }

    // --- Net classification ---
    static classifyNet(net) {
        const name = net.name.toUpperCase();
        const powerPatterns = ['GND', 'VCC', 'VDD', 'VIN', 'VOUT', 'VEE', 'VSS',
            '3V3', '5V', '12V', '3.3V', '1V8', '2V5', 'VBUS', 'VBAT', 'PWR'];
        if (net.pads.length >= 6) return 'power';
        if (powerPatterns.some(p => name.includes(p))) return 'power';
        return 'signal';
    }

    // --- Graph distance computation (Floyd-Warshall on component adjacency) ---
    computeGraphDistances() {
        const n = this.components.length;
        const INF = 9999;
        // Initialize distance matrix
        const dist = Array.from({ length: n }, () => new Float32Array(n).fill(INF));
        for (let i = 0; i < n; i++) dist[i][i] = 0;

        // Build adjacency from signal nets only
        for (const net of this.nets) {
            if (!net.enabled) continue;
            const netType = net.type || PhysicsEngine.classifyNet(net);
            if (netType === 'power') continue;

            // Collect unique component IDs in this net
            const compIds = new Set();
            for (const padRef of net.pads) compIds.add(padRef.componentId);
            const ids = [...compIds];

            // All pairs within this net get distance 1
            for (let a = 0; a < ids.length; a++) {
                for (let b = a + 1; b < ids.length; b++) {
                    const ia = this.compIndex.get(ids[a]);
                    const ib = this.compIndex.get(ids[b]);
                    if (ia !== undefined && ib !== undefined) {
                        dist[ia][ib] = Math.min(dist[ia][ib], 1);
                        dist[ib][ia] = Math.min(dist[ib][ia], 1);
                    }
                }
            }
        }

        // Floyd-Warshall
        for (let k = 0; k < n; k++) {
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    const through = dist[i][k] + dist[k][j];
                    if (through < dist[i][j]) dist[i][j] = through;
                }
            }
        }

        return dist;
    }

    // Recompute graph distances (call when nets change)
    refreshGraphDistances() {
        this.graphDist = this.computeGraphDistances();
    }

    // --- Spectral initialization (Fiedler vector placement) ---
    // Computes the 2nd and 3rd smallest eigenvectors of the graph Laplacian
    // built from signal nets, then maps them to x/y positions.
    // spread: mm extent of the initial placement
    spectralInitialize(spread = 40) {
        const n = this.components.length;
        if (n < 3) return; // not enough components for spectral

        // Build weighted adjacency matrix from signal nets
        const W = Array.from({ length: n }, () => new Float64Array(n));
        for (const net of this.nets) {
            if (!net.enabled) continue;
            const netType = net.type || PhysicsEngine.classifyNet(net);
            if (netType === 'power') continue;

            const compIds = new Set();
            for (const padRef of net.pads) compIds.add(padRef.componentId);
            const ids = [...compIds];

            // Weight = net.force (signal nets already have force=1.0 by default)
            const weight = net.force;
            for (let a = 0; a < ids.length; a++) {
                for (let b = a + 1; b < ids.length; b++) {
                    const ia = this.compIndex.get(ids[a]);
                    const ib = this.compIndex.get(ids[b]);
                    if (ia !== undefined && ib !== undefined) {
                        W[ia][ib] += weight;
                        W[ib][ia] += weight;
                    }
                }
            }
        }

        // Build Laplacian L = D - W
        const L = Array.from({ length: n }, () => new Float64Array(n));
        for (let i = 0; i < n; i++) {
            let degSum = 0;
            for (let j = 0; j < n; j++) {
                if (i !== j) {
                    L[i][j] = -W[i][j];
                    degSum += W[i][j];
                }
            }
            L[i][i] = degSum;
        }

        // Compute eigenvectors using inverse power iteration with deflation
        // We need the 2nd and 3rd smallest eigenvectors (skip the trivial constant one)
        const v2 = this._laplacianEigenvector(L, n, 1);
        const v3 = this._laplacianEigenvector(L, n, 2, v2 ? [v2] : []);

        if (!v2) return; // graph too disconnected

        // Map eigenvector values to positions
        // Normalize to [-1, 1] range then scale by spread
        const normalize = (v) => {
            let minV = Infinity, maxV = -Infinity;
            for (let i = 0; i < n; i++) { minV = Math.min(minV, v[i]); maxV = Math.max(maxV, v[i]); }
            const range = maxV - minV;
            if (range < 1e-10) return v;
            const out = new Float64Array(n);
            for (let i = 0; i < n; i++) out[i] = 2 * (v[i] - minV) / range - 1;
            return out;
        };

        const xCoords = normalize(v2);
        const yCoords = v3 ? normalize(v3) : new Float64Array(n);

        for (let i = 0; i < n; i++) {
            const c = this.components[i];
            c.x = xCoords[i] * spread / 2;
            c.y = yCoords[i] * spread / 2;
            c.vx = 0;
            c.vy = 0;
            c.angularVel = 0;
        }
    }

    // Compute k-th smallest eigenvector of Laplacian using shifted inverse iteration
    // deflate: array of previously found eigenvectors to project out
    _laplacianEigenvector(L, n, k, deflate = []) {
        // Use inverse iteration with shift: (L - σI)^{-1} v converges to
        // eigenvector of smallest eigenvalue near σ.
        // For k=1 (Fiedler), shift just above 0.
        // For k=2, shift above the Fiedler eigenvalue.

        // Small shift to make (L - σI) invertible (L has eigenvalue 0)
        const sigma = k === 1 ? 0.001 : 0.01 * k;

        // Build shifted matrix A = L - σI
        const A = Array.from({ length: n }, (_, i) => {
            const row = new Float64Array(n);
            for (let j = 0; j < n; j++) row[j] = L[i][j];
            row[i] -= sigma;
            return row;
        });

        // Solve via Gaussian elimination (LU-like) — precompute once
        // We'll use iterative refinement instead: just do power iteration on L directly
        // with deflation of known eigenvectors.

        // Power iteration on L to find smallest non-trivial eigenvector:
        // Actually, use the algebraic approach: iterate v = L*v, then the LARGEST
        // eigenvector of L corresponds to the MOST connected cut. We want the smallest
        // non-zero. Use inverse iteration approximated by solving with conjugate gradient.

        // Simpler approach: use the normalized Laplacian trick.
        // Actually, let's just do direct power iteration on (maxLambda*I - L)
        // which flips the spectrum, so the smallest eigenvalue of L becomes the largest.

        // Estimate max eigenvalue (Gershgorin bound)
        let maxLambda = 0;
        for (let i = 0; i < n; i++) maxLambda = Math.max(maxLambda, L[i][i] * 2);
        if (maxLambda < 1e-6) return null; // no edges

        // Build M = maxLambda*I - L (flipped spectrum)
        const M = Array.from({ length: n }, (_, i) => {
            const row = new Float64Array(n);
            for (let j = 0; j < n; j++) row[j] = -L[i][j];
            row[i] += maxLambda;
            return row;
        });

        // Random initial vector
        let v = new Float64Array(n);
        for (let i = 0; i < n; i++) v[i] = Math.random() - 0.5;

        // Always deflate the constant vector (eigenvalue 0 of L = largest of M)
        const ones = new Float64Array(n).fill(1 / Math.sqrt(n));

        const deflateVecs = [ones, ...deflate];

        const projectOut = (vec) => {
            for (const d of deflateVecs) {
                let dot = 0;
                for (let i = 0; i < n; i++) dot += vec[i] * d[i];
                for (let i = 0; i < n; i++) vec[i] -= dot * d[i];
            }
        };

        projectOut(v);

        // Normalize
        let norm = 0;
        for (let i = 0; i < n; i++) norm += v[i] * v[i];
        norm = Math.sqrt(norm);
        if (norm < 1e-10) return null;
        for (let i = 0; i < n; i++) v[i] /= norm;

        // Power iteration: 200 iterations is plenty for small graphs
        for (let iter = 0; iter < 200; iter++) {
            // w = M * v
            const w = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                let sum = 0;
                for (let j = 0; j < n; j++) sum += M[i][j] * v[j];
                w[i] = sum;
            }

            // Deflate
            projectOut(w);

            // Normalize
            norm = 0;
            for (let i = 0; i < n; i++) norm += w[i] * w[i];
            norm = Math.sqrt(norm);
            if (norm < 1e-10) return null;
            for (let i = 0; i < n; i++) w[i] /= norm;

            v = w;
        }

        return v;
    }

    getPadWorld(comp, pad) {
        const rot = (comp.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        return {
            wx: comp.x + pad.relX * cos - pad.relY * sin,
            wy: comp.y + pad.relX * sin + pad.relY * cos,
        };
    }

    // Smoothstep brush weight for a given brush config
    brushWeight(comp, brush) {
        if (!brush.active) return 0;
        const dist = Math.hypot(comp.x - brush.wx, comp.y - brush.wy);
        const r = brush.radius;
        if (dist >= r) return 0;
        const t = dist / r;
        return 1 - t * t * (3 - 2 * t);
    }

    // Update temperature ramping (call once per frame)
    updateTemperatureRamp(dtSec) {
        if (this.tempRamping) {
            this.tempRampTarget = Math.min(1, this.tempRampTarget + this.tempRampSpeed * dtSec);
        } else {
            this.tempRampTarget = Math.max(0, this.tempRampTarget - this.tempDecaySpeed * dtSec);
        }
        this.liveTemperature = this.baseTemperature + this.tempRampTarget * (1 - this.baseTemperature);
    }

    // --- Compute MST edges for each net (pad-level, used for both attraction and crossing) ---
    computeAllMSTEdges() {
        const compMap = this.compMap;
        const allEdges = [];

        for (const net of this.nets) {
            if (!net.enabled || net.force <= 0) continue;

            const padPositions = [];
            for (const padRef of net.pads) {
                const comp = compMap.get(padRef.componentId);
                if (!comp) continue;
                const pad = comp.pads.find(p => p.number === padRef.padNumber);
                if (!pad) continue;
                const world = this.getPadWorld(comp, pad);
                padPositions.push({ ...world, componentId: comp.id, pad, net });
            }
            if (padPositions.length < 2) continue;

            // Prim's MST
            const connected = new Set([0]);
            while (connected.size < padPositions.length) {
                let bestDist = Infinity, bestFrom = -1, bestTo = -1;
                for (const ci of connected) {
                    for (let j = 0; j < padPositions.length; j++) {
                        if (connected.has(j)) continue;
                        const d = Math.hypot(
                            padPositions[ci].wx - padPositions[j].wx,
                            padPositions[ci].wy - padPositions[j].wy
                        );
                        if (d < bestDist) { bestDist = d; bestFrom = ci; bestTo = j; }
                    }
                }
                if (bestTo === -1) break;
                connected.add(bestTo);
                allEdges.push({
                    p1: padPositions[bestFrom],
                    p2: padPositions[bestTo],
                    net,
                    dist: bestDist,
                });
            }
        }

        return allEdges;
    }

    // --- Segment intersection test ---
    static segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
        const dABx = bx - ax, dABy = by - ay;
        const dCDx = dx - cx, dCDy = dy - cy;
        const denom = dABx * dCDy - dABy * dCDx;
        if (Math.abs(denom) < 1e-10) return null;

        const t = ((cx - ax) * dCDy - (cy - ay) * dCDx) / denom;
        const u = ((cx - ax) * dABy - (cy - ay) * dABx) / denom;

        if (t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99) {
            return { x: ax + t * dABx, y: ay + t * dABy, t, u };
        }
        return null;
    }

    step() {
        const simActive = this.simBrush.active;
        const alignActive = this.alignBrush.active &&
            (this.alignBrush.directionActive || this.alignBrush.gridActive);

        if (!simActive && !alignActive) {
            this.updateTemperatureRamp(1 / 60);
            return;
        }

        this.updateTemperatureRamp(1 / 60);

        const comps = this.components;
        const forces = new Map();
        const torques = new Map();
        for (const c of comps) {
            forces.set(c.id, { fx: 0, fy: 0 });
            torques.set(c.id, 0);
        }

        const temp = this.liveTemperature;
        const forceScale = simActive ? (0.05 + 0.95 * temp) : 0;

        // --- Center of mass ---
        let cmx = 0, cmy = 0;
        for (const c of comps) { cmx += c.x; cmy += c.y; }
        cmx /= comps.length;
        cmy /= comps.length;

        if (simActive) {
            // --- Compute MST edges (periodically) ---
            this.mstFrameCounter++;
            if (this.mstFrameCounter >= this.mstUpdateInterval || this.mstEdgeCache.length === 0) {
                this.mstEdgeCache = this.computeAllMSTEdges();
                this.mstFrameCounter = 0;
            }

            // --- MST-based attraction: spring force along MST edges ---
            for (const edge of this.mstEdgeCache) {
                const { p1, p2, net } = edge;
                if (p1.componentId === p2.componentId) continue;

                const dx = p2.wx - p1.wx;
                const dy = p2.wy - p1.wy;
                const dist = Math.hypot(dx, dy);
                if (dist < 0.01) continue;

                const strength = this.attractionStrength * net.force * forceScale;
                const ndx = dx / dist;
                const ndy = dy / dist;
                const forceMag = strength * dist;

                const f1 = forces.get(p1.componentId);
                const f2 = forces.get(p2.componentId);
                f1.fx += ndx * forceMag;
                f1.fy += ndy * forceMag;
                f2.fx -= ndx * forceMag;
                f2.fy -= ndy * forceMag;

                // Torque on both components
                const comp1 = this.compMap.get(p1.componentId);
                const rx1 = p1.wx - comp1.x;
                const ry1 = p1.wy - comp1.y;
                torques.set(p1.componentId,
                    torques.get(p1.componentId) + (rx1 * ndy - ry1 * ndx) * forceMag * this.rotationTorqueScale);

                const comp2 = this.compMap.get(p2.componentId);
                const rx2 = p2.wx - comp2.x;
                const ry2 = p2.wy - comp2.y;
                torques.set(p2.componentId,
                    torques.get(p2.componentId) - (rx2 * ndy - ry2 * ndx) * forceMag * this.rotationTorqueScale);
            }

            // --- Graph-distance stress (Kamada-Kawai style) ---
            const stressScale = this.stressStrength * forceScale;
            const baseDist = this.stressBaseSpacing;
            const n = comps.length;
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    const gd = this.graphDist[i][j];
                    if (gd >= 9999) continue; // disconnected in signal graph — skip

                    const a = comps[i];
                    const b = comps[j];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    let dist = Math.hypot(dx, dy);
                    if (dist < 0.1) dist = 0.1;

                    const idealDist = gd * baseDist;
                    const weight = 1 / (gd * gd); // close-in-graph pairs matter more
                    const displacement = dist - idealDist;
                    const forceMag = stressScale * weight * displacement;

                    const nx = dx / dist;
                    const ny = dy / dist;

                    forces.get(a.id).fx += nx * forceMag;
                    forces.get(a.id).fy += ny * forceMag;
                    forces.get(b.id).fx -= nx * forceMag;
                    forces.get(b.id).fy -= ny * forceMag;
                }
            }

            // --- Edge crossing penalty ---
            const crossScale = this.crossingStrength * forceScale;
            const edges = this.mstEdgeCache;
            for (let i = 0; i < edges.length; i++) {
                for (let j = i + 1; j < edges.length; j++) {
                    const e1 = edges[i];
                    const e2 = edges[j];

                    // Skip edges from the same net (internal crossings less meaningful)
                    if (e1.net === e2.net) continue;

                    // Skip if edges share a component (adjacent edges can't meaningfully uncross)
                    if (e1.p1.componentId === e2.p1.componentId ||
                        e1.p1.componentId === e2.p2.componentId ||
                        e1.p2.componentId === e2.p1.componentId ||
                        e1.p2.componentId === e2.p2.componentId) continue;

                    const cross = PhysicsEngine.segmentsIntersect(
                        e1.p1.wx, e1.p1.wy, e1.p2.wx, e1.p2.wy,
                        e2.p1.wx, e2.p1.wy, e2.p2.wx, e2.p2.wy
                    );
                    if (!cross) continue;

                    // Weight by net types: signal×signal = full, signal×power = 0.3, power×power = 0
                    const t1 = e1.net.type || PhysicsEngine.classifyNet(e1.net);
                    const t2 = e2.net.type || PhysicsEngine.classifyNet(e2.net);
                    let typeWeight = 1.0;
                    if (t1 === 'power' && t2 === 'power') continue;
                    if (t1 === 'power' || t2 === 'power') typeWeight = 0.3;

                    // Force direction: push endpoints of each edge to be on the same side
                    // of the other edge. Use perpendicular to each edge.
                    const strength = crossScale * typeWeight * (e1.net.force + e2.net.force) * 0.5;

                    // Perpendicular to edge2, push edge1 endpoints
                    const e2dx = e2.p2.wx - e2.p1.wx;
                    const e2dy = e2.p2.wy - e2.p1.wy;
                    const e2len = Math.hypot(e2dx, e2dy);
                    if (e2len < 0.01) continue;
                    const n2x = -e2dy / e2len;
                    const n2y = e2dx / e2len;

                    // Which side of edge2 are edge1's endpoints?
                    const side1a = (e1.p1.wx - e2.p1.wx) * n2x + (e1.p1.wy - e2.p1.wy) * n2y;
                    const side1b = (e1.p2.wx - e2.p1.wx) * n2x + (e1.p2.wy - e2.p1.wy) * n2y;

                    // Push both endpoints of edge1 toward the side of the midpoint
                    const midSide1 = side1a + side1b;
                    const dir1 = midSide1 >= 0 ? 1 : -1;

                    const f1a = forces.get(e1.p1.componentId);
                    const f1b = forces.get(e1.p2.componentId);
                    f1a.fx += n2x * dir1 * strength;
                    f1a.fy += n2y * dir1 * strength;
                    f1b.fx += n2x * dir1 * strength;
                    f1b.fy += n2y * dir1 * strength;

                    // Perpendicular to edge1, push edge2 endpoints
                    const e1dx = e1.p2.wx - e1.p1.wx;
                    const e1dy = e1.p2.wy - e1.p1.wy;
                    const e1len = Math.hypot(e1dx, e1dy);
                    if (e1len < 0.01) continue;
                    const n1x = -e1dy / e1len;
                    const n1y = e1dx / e1len;

                    const side2a = (e2.p1.wx - e1.p1.wx) * n1x + (e2.p1.wy - e1.p1.wy) * n1y;
                    const side2b = (e2.p2.wx - e1.p1.wx) * n1x + (e2.p2.wy - e1.p1.wy) * n1y;

                    const midSide2 = side2a + side2b;
                    const dir2 = midSide2 >= 0 ? 1 : -1;

                    const f2a = forces.get(e2.p1.componentId);
                    const f2b = forces.get(e2.p2.componentId);
                    f2a.fx += n1x * dir2 * strength;
                    f2a.fy += n1y * dir2 * strength;
                    f2b.fx += n1x * dir2 * strength;
                    f2b.fy += n1y * dir2 * strength;
                }
            }

            // --- Dipole alignment torque ---
            // For each net-pair shared by multiple components, apply torque to
            // align their dipole vectors. This creates local orientational order.
            const dipoleScale = this.dipoleStrength * forceScale;
            if (dipoleScale > 0) {
                for (const [key, entries] of this.dipolePairs) {
                    if (entries.length < 2) continue;
                    for (let i = 0; i < entries.length; i++) {
                        for (let j = i + 1; j < entries.length; j++) {
                            const a = entries[i];
                            const b = entries[j];
                            if (a.compId === b.compId) continue;

                            const compA = this.compMap.get(a.compId);
                            const compB = this.compMap.get(b.compId);
                            if (!compA || !compB) continue;

                            // World-frame dipole angle = localAngle + component rotation
                            const rotA = (compA.rotation || 0) * Math.PI / 180;
                            const rotB = (compB.rotation || 0) * Math.PI / 180;
                            const worldAngleA = a.localAngle + rotA;
                            const worldAngleB = b.localAngle + rotB;

                            // sin(angleA - angleB) gives the torque direction
                            // Positive means A should rotate clockwise relative to B
                            const angleDiff = Math.sin(worldAngleA - worldAngleB);

                            // Weight by proximity — closer components influence more
                            const dist = Math.hypot(compA.x - compB.x, compA.y - compB.y);
                            const proximity = 1 / (1 + dist * 0.1);

                            const torqueMag = dipoleScale * angleDiff * proximity;

                            torques.set(a.compId, torques.get(a.compId) - torqueMag);
                            torques.set(b.compId, torques.get(b.compId) + torqueMag);
                        }
                    }
                }
            }

            // --- Repulsion ---
            const repBase = this.repulsionStrength * 1.0 * forceScale;
            for (let i = 0; i < comps.length; i++) {
                for (let j = i + 1; j < comps.length; j++) {
                    const a = comps[i];
                    const b = comps[j];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    let dist = Math.hypot(dx, dy);
                    const minDist = a.boundingRadius + b.boundingRadius;
                    if (dist < 0.1) dist = 0.1;
                    const cutoff = minDist * 3;
                    if (dist > cutoff) continue;

                    const forceMag = repBase * (minDist * minDist) / (dist * dist);
                    const nx = dx / dist;
                    const ny = dy / dist;

                    forces.get(a.id).fx -= nx * forceMag;
                    forces.get(a.id).fy -= ny * forceMag;
                    forces.get(b.id).fx += nx * forceMag;
                    forces.get(b.id).fy += ny * forceMag;
                }
            }

            // --- Center gravity ---
            for (const c of comps) {
                const f = forces.get(c.id);
                f.fx += (cmx - c.x) * this.gravityStrength * forceScale;
                f.fy += (cmy - c.y) * this.gravityStrength * forceScale;
            }
        }

        // --- Alignment forces (apply when alignBrush active) ---
        if (alignActive) {
            for (const c of comps) {
                const aw = this.brushWeight(c, this.alignBrush);
                if (aw <= 0) continue;

                // Direction alignment: torque toward nearest N-way angle
                if (this.alignBrush.directionActive) {
                    const angleStep = 360 / this.directionWays;
                    const currentDeg = ((c.rotation % 360) + 360) % 360;
                    const nearestSnap = Math.round(currentDeg / angleStep) * angleStep;
                    let angleDiff = nearestSnap - currentDeg;
                    if (angleDiff > 180) angleDiff -= 360;
                    if (angleDiff < -180) angleDiff += 360;
                    torques.set(c.id,
                        (torques.get(c.id) || 0) + angleDiff * this.directionStrength * aw);
                }

                // Grid alignment: spring toward nearest grid intersection
                if (this.alignBrush.gridActive) {
                    const gs = this.gridSpacing;
                    const snapX = Math.round(c.x / gs) * gs;
                    const snapY = Math.round(c.y / gs) * gs;
                    const f = forces.get(c.id);
                    f.fx += (snapX - c.x) * this.gridStrength * aw;
                    f.fy += (snapY - c.y) * this.gridStrength * aw;
                }
            }
        }

        // --- Zero net force correction ---
        if (simActive) {
            let avgFx = 0, avgFy = 0, activeCount = 0;
            for (const c of comps) {
                const w = this.brushWeight(c, this.simBrush);
                if (w <= 0) continue;
                const f = forces.get(c.id);
                avgFx += f.fx;
                avgFy += f.fy;
                activeCount++;
            }
            if (activeCount > 0) {
                avgFx /= activeCount;
                avgFy /= activeCount;
                for (const c of comps) {
                    const f = forces.get(c.id);
                    f.fx -= avgFx;
                    f.fy -= avgFy;
                }
            }
        }

        // --- Temperature noise (only when sim brush active) ---
        // Quadratic ramp: gentle at low temp, explosive at high temp
        const tempNoise = simActive ? temp * temp * 25.0 : 0;

        // --- Integrate ---
        for (const c of comps) {
            const sw = this.brushWeight(c, this.simBrush);
            const aw = this.brushWeight(c, this.alignBrush);
            const w = Math.max(sw, aw);
            if (w <= 0) continue;

            const f = forces.get(c.id);

            // Temperature noise scaled by brush weight
            if (tempNoise > 0 && sw > 0) {
                f.fx += (Math.random() - 0.5) * tempNoise * sw;
                f.fy += (Math.random() - 0.5) * tempNoise * sw;
            }

            // Position integration
            c.vx = (c.vx + f.fx * this.dt * w) * this.damping;
            c.vy = (c.vy + f.fy * this.dt * w) * this.damping;
            c.x += c.vx * this.dt;
            c.y += c.vy * this.dt;

            // Rotation integration (continuous)
            const torque = torques.get(c.id) || 0;
            if (tempNoise > 0 && sw > 0) {
                c.angularVel += (Math.random() - 0.5) * tempNoise * 0.5 * sw;
            }
            c.angularVel = (c.angularVel + torque * this.dt * w) * this.rotationDamping;
            c.rotation += c.angularVel * this.dt;
        }
    }

    // Manual rotation (R key) — discrete 90° snap
    rotateComponent(compId, degrees) {
        const comp = this.compMap.get(compId);
        if (!comp) return;
        comp.rotation = ((comp.rotation || 0) + degrees + 360) % 360;
        comp.angularVel = 0;
    }

    // --- Crossing count (for display/diagnostics) ---
    countCrossings() {
        const edges = this.mstEdgeCache;
        let count = 0;
        for (let i = 0; i < edges.length; i++) {
            for (let j = i + 1; j < edges.length; j++) {
                const e1 = edges[i];
                const e2 = edges[j];
                if (e1.net === e2.net) continue;
                if (e1.p1.componentId === e2.p1.componentId ||
                    e1.p1.componentId === e2.p2.componentId ||
                    e1.p2.componentId === e2.p1.componentId ||
                    e1.p2.componentId === e2.p2.componentId) continue;

                const cross = PhysicsEngine.segmentsIntersect(
                    e1.p1.wx, e1.p1.wy, e1.p2.wx, e1.p2.wy,
                    e2.p1.wx, e2.p1.wy, e2.p2.wx, e2.p2.wy
                );
                if (cross) count++;
            }
        }
        return count;
    }
}
