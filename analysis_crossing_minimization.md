# Crossing Minimization Analysis — PhosLayout

## The Problem

The current force model (spring attraction to K-nearest same-net pads + inverse-square repulsion + gravity) produces round/hexagonal clumps instead of the linear or branching arrangements a human designer would create. The linear regulator circuit (J1 → C1,C2 → U1 → C3,C4 → J2) should lay out as a chain, but the simulation collapses it into a ball.

Two distinct failures are at play:

1. **The energy function has no crossing term.** The simulation literally cannot see crossings — it optimizes distance and overlap, nothing else.
2. **The energy landscape is rotationally symmetric.** A row and a circle of the same components have similar total spring energy, but the circle is often *lower* energy because it's more compact. There is no force that prefers one axis over another, so the symmetric (round) solution wins.

---

## Graph Theory Perspective

### The netlist is a hypergraph

A PCB netlist is a **hypergraph**: each net is a hyperedge connecting ≥2 pads across multiple components. The current implementation converts this to a standard graph by connecting each pad to its K=3 nearest same-net pads. This conversion matters — it determines the edge set that the layout is optimizing.

### Signal vs. power graph separation

For the **linear regulator** example, the component-level connectivity:

```
Signal nets only (VIN, VOUT_3V3):
  J1 — C1 — U1 — C3 — J2
  J1 — C2 — U1 — C4 — J2
  (a "caterpillar" graph — a tree with maximum degree ≤ some bound)

With GND included:
  Every component connects to every other via GND → nearly K₇
```

The signal graph is **planar** (it's a tree — crossing number cr = 0). It can be drawn as a clean chain with zero crossings. But GND turns the graph into a near-complete graph, which is maximally non-planar.

**Key insight: PCB signal nets are nearly always sparse and nearly planar. Power/ground nets create the non-planarity, but those nets are routed on separate copper layers anyway.** The layout should optimize primarily for signal-net crossing minimization, not treat all nets equally.

### Why the current model produces balls

The force equilibrium of spring-attraction + radial-repulsion is equivalent to minimizing:

```
E = Σ_edges k·d² + Σ_pairs C/d
```

This energy function is **rotationally invariant** — any rotation of a minimum is also a minimum. The global minimum for a nearly-complete graph (which GND creates) is a roughly circular arrangement. Even with GND force reduced to 0.2×, it still dominates because it contributes O(n²) pairwise attractions while signal nets contribute O(n) edges.

The ball/hex-grid is also a natural consequence of **Thomson's problem** (distributing repulsive charges on a sphere) — when attraction is roughly uniform and repulsion is uniform, you get the most symmetric packing possible.

### Crossing number complexity

Computing the minimum crossing number cr(G) is NP-hard in general. However:

- For **planar** graphs (cr = 0), recognition and embedding are O(n) via the planarity testing algorithms (Hopcroft-Tarjan, Boyer-Myrvold).
- For **nearly planar** graphs (cr = k for small k), fixed-parameter tractable algorithms exist.
- For practical PCB-sized graphs (10–200 components), heuristic approaches are more than sufficient.

**Counting crossings in a given drawing** is O(E²) by checking all edge pairs — cheap for PCB scale.

---

## Why The Ball Formation Guarantees Crossings

Consider 4 components A, B, C, D where A→B and C→D are signal connections with no other signal edges. In a row arrangement [A B C D], these edges don't cross. In a circular arrangement, the edges A→B and C→D cross with ~50% probability depending on the ordering around the circle.

More formally: for a random circular arrangement of n nodes with m edges, the expected number of crossings is:

```
E[crossings] = m·(m-1) / (3·(2n-2 choose 2))  ×  (n² - terms)
```

The circular/ball arrangement essentially **randomizes** the angular ordering of components, producing crossings proportional to m². A linear arrangement respects the topological ordering and avoids most of them.

---

## Proposed Approaches (Ranked by Impact / Complexity)

### 1. Edge Crossing Penalty Force ⭐ (highest impact)

The most direct fix: detect crossings every frame and apply forces that uncross them.

**Algorithm per frame:**
```
for each pair of ratsnest edges (a→b) and (c→d):
    if segments_intersect(a, b, c, d):
        // Compute signed perpendicular distances
        // Push endpoints to "uncross" the pair
        
        // Method: for edge (a,b), compute which side of line(c,d)
        // each endpoint is on. Apply force pushing both endpoints
        // to the SAME side of line(c,d). Vice versa for (c,d).
        
        crossingForce = crossing_strength / max(segment_distance, ε)
        apply perpendicular forces to a, b, c, d
```

**The uncrossing force direction:**
Two edges cross when their endpoints interleave around the crossing point. To uncross, we want one edge to "pass over" the other. The natural force is:

- For edge (a,b) crossing edge (c,d) at point P:
  - Compute normal to (c,d): `n_cd = perpendicular(d - c)`
  - Project a and b onto n_cd. If they're on opposite sides → they already straddle the edge, push both to the same side
  - If they're on the same side → push them further that way (they're close to crossing)

**Complexity:** O(E²) per frame. With MST-based nets (approach #3), E ≈ total_pads - num_nets. For the MCU board: ~40 pads, ~15 nets → ~25 MST edges → 300 pair checks. Negligible.

**Why this works:** It directly adds the missing term to the energy function. The simulation can now "see" crossings and actively eliminate them. Combined with temperature/annealing, it can escape local minima where uncrossing one pair creates another.

**Subtlety:** The force must be strong enough to overcome attraction (which wants short edges, even if they cross) but not so strong that it creates oscillation. A good heuristic: crossing force ∝ attraction strength × some multiplier (2–5×). The crossing penalty should dominate when components are close but their edges cross — which is exactly the ball scenario.

**Net weighting:** Crossing penalty should be weighted by the product of the two nets' force values. Two signal nets crossing = bad (high penalty). Signal crossing power = less bad. Two power nets crossing = irrelevant (zero penalty).

---

### 2. Graph-Distance Stress (prevents ball formation) ⭐

Instead of only having forces between directly-connected components, compute **graph-theoretic shortest-path distances** between ALL component pairs and use them as ideal spacing targets.

**Setup (once, or when nets change):**
```
1. Build component adjacency graph from signal nets
   - Edge weight = 1 for each shared signal net
   - Ignore or heavily discount power nets
2. All-pairs shortest paths (Floyd-Warshall, O(V³), V < 200)
3. Ideal distance: d_ij = hop_count × base_spacing
```

**Per-frame force:**
```
for each pair of components (i, j):
    actual_dist = |pos_i - pos_j|
    ideal_dist = graph_distance[i][j] * base_spacing
    
    // Stress force: attract if too far, repel if too close
    // Weight by 1/d_ij² (nearby-in-graph pairs matter most)
    weight = 1 / (graph_distance[i][j])²
    force = weight * (actual_dist - ideal_dist) / actual_dist
    // Apply along the line connecting i and j
```

This is **stress majorization** (Kamada-Kawai style). The key difference from the current model: components that are 3 hops apart in the signal graph are given an ideal distance of 3× base_spacing. This **prevents the ball** because it forces graph-distant components apart, preserving the topology.

For the linear regulator: J1 is 2 hops from U1 in the signal graph, so ideal distance = 2×base. J1 is 4 hops from J2, so ideal distance = 4×base. This naturally produces a chain.

**Replaces or supplements:** the current per-net K-nearest attraction + global repulsion. The stress model unifies both — it attracts when too far AND repels when too close relative to ideal distance.

---

### 3. MST-Based Net Decomposition (reduces edge chaos)

Currently: each pad connects to K=3 nearest same-net pads → up to 3N edges per net.
Proposed: compute a **Minimum Spanning Tree** of each net's pad positions → exactly N-1 edges per net.

```
for each net:
    pads = all pad world-positions in this net
    mst = prim_or_kruskal(pads)  // using Euclidean distance
    // Only create attraction forces along MST edges
```

**Benefits:**
- Produces chain/tree structures naturally (MST of points along a line IS the line)
- Fewer edges → fewer potential crossings → crossing penalty is more effective
- Removes the redundant edges that "pull sideways" and cause ball formation
- Adapts to component positions (recompute MST each frame or every N frames)

**For the GND net (7 pads in the LDO):** K=3 nearest produces up to 21 directional edges. MST produces exactly 6. Those 6 edges form a tree that connects all GND pads with minimum total wire length — which is exactly what a PCB router would aim for.

**Steiner tree variant:** Even better than MST would be a **Rectilinear Steiner Minimum Tree** (RSMT), which is the standard wirelength model in VLSI placement. But MST is within a factor of 3/2 of optimal and is much simpler to compute.

**Recomputation frequency:** MST changes as components move. Recomputing every frame is fine — Prim's algorithm on N points is O(N²), and nets rarely exceed ~20 pads.

---

### 4. Spectral Initialization (Fiedler Vector)

Use the graph's eigenvectors to compute an initial placement that respects connectivity structure, instead of random scattering.

**Algorithm:**
```
1. Build weighted Laplacian L of the component graph (signal nets only)
   L[i][i] = sum of edge weights from i
   L[i][j] = -weight(i,j)
2. Compute eigenvectors v₂, v₃ (2nd and 3rd smallest eigenvalues)
3. Set initial positions: x_i = v₂[i] * scale, y_i = v₃[i] * scale
```

The **Fiedler vector** (v₂) finds the "most linear" ordering of the graph. For the linear regulator, it would discover the chain J1→C1/C2→U1→C3/C4→J2 automatically and place them along a line.

v₃ captures the second axis of variation — for a pure chain it's nearly zero (everything on a line), for a branching circuit it separates branches.

**Why this helps:** The force simulation is highly sensitive to initial conditions. Starting from a random scatter, it finds the nearest local minimum (the ball). Starting from a spectrally-informed layout, it's already near the global minimum and just needs refinement.

**Implementation:** Eigen decomposition of a small matrix (V×V, V < 200) is trivial. Can use power iteration or Jacobi method. Many JS linear algebra libraries exist (ml-matrix, numeric.js), or implement power iteration in ~30 lines.

**When to apply:** On dataset load, and optionally as a "reset to spectral layout" button. Could also be applied locally within a brush region.

---

### 5. Topological Layering (Sugiyama-inspired)

For circuits with natural signal flow (inputs → processing → outputs):

```
1. Identify source/sink components:
   - Connectors with only input nets → sources
   - Connectors with only output nets → sinks
   - Or: user tags them (simple UI)
2. BFS from sources, assign each component a "layer" = hop distance
3. Add weak positional force: F_layer = k * (x - layer * spacing)
   - This biases the x-axis toward the topological order
4. Within each layer, use barycentric ordering to set y-positions
```

**For linear regulator:**
- Layer 0: J1 (input connector)
- Layer 1: C1, C2 (VIN caps, 1 hop from J1)
- Layer 2: U1 (LDO, 1 hop from C1/C2)
- Layer 3: C3, C4 (VOUT caps, 1 hop from U1)
- Layer 4: J2 (output connector)

This directly produces the expected linear arrangement. The layering force doesn't need to be strong — just enough to break the rotational symmetry so the force simulation converges to a chain instead of a ball.

**Limitation:** Not all circuits have a clean flow direction (e.g., bidirectional buses, feedback loops). The layering should be treated as a weak bias, not a hard constraint. The user could toggle it on/off or set the flow direction.

---

### 6. Congestion-Aware Spreading

A VLSI-inspired approach: estimate routing congestion and use it to modulate repulsion.

```
1. Overlay a grid (e.g., 2mm cells) on the layout area
2. For each grid cell, count ratsnest segments passing through it
3. Compute congestion gradient at each component position
4. Add force pushing components away from high-congestion regions
```

**Why it helps:** Congestion is a proxy for crossings. A region where 10 ratsnest lines converge will inevitably have crossings. Spreading components away from such regions reduces both congestion and crossings.

**Complexity:** O(E × G) per frame where G is grid cells. For small grids (50×50) and few edges (<100), this is ~250K operations — fine.

**Lower priority** than approaches 1–4 because it's indirect (congestion ≈ crossings but not exactly) and more complex to implement.

---

## Recommended Implementation Order

### Phase 1: Structural Improvements (break the ball)
These prevent ball formation even without explicit crossing detection:

1. **MST-based net decomposition** — Replace K=3 nearest with per-net MST. Low complexity, immediate improvement. Chains instead of cliques within each net.
2. **Graph-distance stress** — Add ideal-distance forces between all component pairs based on signal-graph hop distance. Directly prevents distant components from collapsing together.

### Phase 2: Crossing Elimination
Now that the layout is roughly chain-shaped:

3. **Edge crossing penalty force** — Detect crossings per-frame, apply uncrossing forces. This is the "finishing move" that the simulation currently has no way to achieve.

### Phase 3: Better Starting Points
Reduce dependence on initial conditions:

4. **Spectral initialization** — Place components using Fiedler vectors of the signal graph Laplacian. The simulation starts near the answer instead of at a random scatter.

### Phase 4: Optional Refinements

5. **Topological layering** — For circuits with obvious flow direction, add weak axis bias.
6. **Congestion spreading** — For complex boards with many nets.

---

## Net Classification Heuristic

Several approaches above depend on distinguishing "signal" nets from "power" nets. Heuristic:

```
function classifyNet(net):
    if net.pads.length > threshold (e.g., 6):    → power
    if net.name matches /^(GND|VCC|VDD|V\w+)/:   → power  
    if net.force < 0.5 (user already turned it down): → power
    else:                                          → signal
```

Power nets are:
- Excluded from graph-distance computation
- Given zero or low crossing penalty weight
- Still included in attraction (with their existing low force multiplier) but not in the structural/topological calculations

---

## Crossing Detection Algorithm Reference

For the crossing penalty force, efficient segment intersection test:

```javascript
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    // Returns intersection point or null
    const dABx = bx - ax, dABy = by - ay;
    const dCDx = dx - cx, dCDy = dy - cy;
    const denom = dABx * dCDy - dABy * dCDx;
    if (Math.abs(denom) < 1e-10) return null; // parallel
    
    const t = ((cx - ax) * dCDy - (cy - ay) * dCDx) / denom;
    const u = ((cx - ax) * dABy - (cy - ay) * dABx) / denom;
    
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return { x: ax + t * dABx, y: ay + t * dABy, t, u };
    }
    return null;
}
```

For the uncrossing force on a detected crossing between edges (a→b) and (c→d):

```javascript
// Normal to edge c→d
const nCDx = -(dy - cy), nCDy = dx - cx;
const lenCD = Math.hypot(nCDx, nCDy);

// Project a onto normal of c→d
const projA = (ax - cx) * nCDx / lenCD + (ay - cy) * nCDy / lenCD;
// Push a further in the direction it's already on
const forceOnA = crossingStrength * sign(projA) / max(abs(projA), epsilon);
// Apply nCDx/lenCD * forceOnA, nCDy/lenCD * forceOnA to component of pad a
// Similarly for b, c, d
```

---

## Comparison with VLSI Placement

The PhosLayout problem is a simplified version of VLSI analytical placement. Key relevant techniques from that field:

| VLSI Technique | PhosLayout Analog | Status |
|---|---|---|
| Quadratic placement (minimize Σ wire²) | Spring attraction | ✅ Current |
| Spreading forces (prevent overlap) | Repulsion | ✅ Current |
| HPWL minimization | Not applicable (we need crossing min) | — |
| Congestion-driven spreading | Approach #6 above | Future |
| Spectral placement (Fiedler) | Approach #4 above | Proposed |
| Min-cut partitioning | Could inform layering | Future |
| Simulated annealing (VPR/TimberWolf) | Temperature brush | ✅ Current |

The main divergence: VLSI tools optimize **wirelength + congestion** because the router handles crossings via multiple metal layers. PCB layout has far fewer layers (typically 2–4), making crossing minimization much more important relative to pure wirelength.

---

## Expected Outcome

With approaches 1–4 implemented, the linear regulator should:
- Lay out as a chain (J1 → C1/C2 → U1 → C3/C4 → J2) with near-zero signal-net crossings
- GND net forms a spanning tree along the chain rather than a hub-and-spoke
- The MCU board should separate into functional clusters (power section, SPI flash section, UART section, LED section) with signal nets mostly non-crossing between clusters

The simulation brush workflow becomes:
1. Load → spectral initialization gives roughly correct topology
2. Broad brush + high temp → refine positions, crossing forces prevent tangles
3. Narrow brush + low temp → local optimization, alignment
4. Manual tweaks for final polish
