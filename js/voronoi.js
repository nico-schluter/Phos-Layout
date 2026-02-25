// Voronoi diagram from pad positions using Bowyer-Watson Delaunay triangulation
// Highlights edges between cells of different nets — shows routing boundaries

export class VoronoiOverlay {
    constructor() {
        this.edges = [];       // { x1, y1, x2, y2, netA, netB, clipped }
        this.interNetEdges = []; // subset: edges where netA !== netB
    }

    // Compute Delaunay triangulation using Bowyer-Watson algorithm
    // Points: [{ wx, wy, net, componentId, padNumber }]
    computeDelaunay(points) {
        if (points.length < 3) return [];

        // Super-triangle that contains all points
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            if (p.wx < minX) minX = p.wx;
            if (p.wy < minY) minY = p.wy;
            if (p.wx > maxX) maxX = p.wx;
            if (p.wy > maxY) maxY = p.wy;
        }
        const dx = maxX - minX;
        const dy = maxY - minY;
        const dmax = Math.max(dx, dy);
        const midX = (minX + maxX) / 2;
        const midY = (minY + maxY) / 2;

        // Super-triangle vertices (far outside the point set)
        const st0 = { wx: midX - 20 * dmax, wy: midY - dmax, _super: true };
        const st1 = { wx: midX, wy: midY + 20 * dmax, _super: true };
        const st2 = { wx: midX + 20 * dmax, wy: midY - dmax, _super: true };

        let triangles = [{ a: st0, b: st1, c: st2 }];

        for (const p of points) {
            // Find triangles whose circumcircle contains p
            const bad = [];
            const good = [];

            for (const tri of triangles) {
                if (this.inCircumcircle(p, tri)) {
                    bad.push(tri);
                } else {
                    good.push(tri);
                }
            }

            // Find boundary polygon of the "bad" triangles
            const polygon = [];
            for (const tri of bad) {
                const edges = [
                    [tri.a, tri.b],
                    [tri.b, tri.c],
                    [tri.c, tri.a],
                ];
                for (const [ea, eb] of edges) {
                    // Edge is on boundary if it's not shared by another bad triangle
                    let shared = false;
                    for (const other of bad) {
                        if (other === tri) continue;
                        const ov = [other.a, other.b, other.c];
                        if (ov.includes(ea) && ov.includes(eb)) {
                            shared = true;
                            break;
                        }
                    }
                    if (!shared) polygon.push([ea, eb]);
                }
            }

            // Re-triangulate with the new point
            triangles = good;
            for (const [ea, eb] of polygon) {
                triangles.push({ a: ea, b: eb, c: p });
            }
        }

        // Remove triangles that contain super-triangle vertices
        return triangles.filter(tri =>
            !tri.a._super && !tri.b._super && !tri.c._super
        );
    }

    // Check if point p is inside the circumcircle of triangle tri
    inCircumcircle(p, tri) {
        const ax = tri.a.wx - p.wx;
        const ay = tri.a.wy - p.wy;
        const bx = tri.b.wx - p.wx;
        const by = tri.b.wy - p.wy;
        const cx = tri.c.wx - p.wx;
        const cy = tri.c.wy - p.wy;

        const det = (ax * ax + ay * ay) * (bx * cy - cx * by)
                  - (bx * bx + by * by) * (ax * cy - cx * ay)
                  + (cx * cx + cy * cy) * (ax * by - bx * ay);

        // Ensure consistent orientation
        const orient = (tri.b.wx - tri.a.wx) * (tri.c.wy - tri.a.wy)
                     - (tri.b.wy - tri.a.wy) * (tri.c.wx - tri.a.wx);

        return orient > 0 ? det > 0 : det < 0;
    }

    // Compute circumcenter of a triangle
    circumcenter(tri) {
        const ax = tri.a.wx, ay = tri.a.wy;
        const bx = tri.b.wx, by = tri.b.wy;
        const cx = tri.c.wx, cy = tri.c.wy;

        const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(D) < 1e-10) return null;

        const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
        const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;

        return { wx: ux, wy: uy };
    }

    // Build Voronoi edges from Delaunay triangulation
    // Each Delaunay edge maps to a Voronoi edge connecting the circumcenters
    // of the two triangles sharing that edge.
    update(components, nets, getPadWorld) {
        this.edges = [];
        this.interNetEdges = [];

        // Collect all pad world positions with net info
        const points = [];
        const compMap = new Map(components.map(c => [c.id, c]));

        for (const net of nets) {
            if (!net.enabled) continue;
            for (const padRef of net.pads) {
                const comp = compMap.get(padRef.componentId);
                if (!comp) continue;
                const pad = comp.pads.find(p => p.number === padRef.padNumber);
                if (!pad) continue;
                const world = getPadWorld(comp, pad);
                points.push({
                    wx: world.wx,
                    wy: world.wy,
                    net: net.name,
                    netColor: net.color,
                    componentId: padRef.componentId,
                });
            }
        }

        if (points.length < 3) return;

        const triangles = this.computeDelaunay(points);
        if (triangles.length === 0) return;

        // Build adjacency: for each edge, find the two triangles sharing it
        // Use a map keyed by sorted vertex indices
        const pointIndex = new Map();
        points.forEach((p, i) => pointIndex.set(p, i));

        const edgeTriMap = new Map();
        const edgeKey = (a, b) => {
            const ia = pointIndex.get(a);
            const ib = pointIndex.get(b);
            return ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`;
        };

        for (const tri of triangles) {
            const triEdges = [
                [tri.a, tri.b],
                [tri.b, tri.c],
                [tri.c, tri.a],
            ];
            for (const [ea, eb] of triEdges) {
                const key = edgeKey(ea, eb);
                if (!edgeTriMap.has(key)) {
                    edgeTriMap.set(key, { tris: [], a: ea, b: eb });
                }
                edgeTriMap.get(key).tris.push(tri);
            }
        }

        // For each Delaunay edge shared by two triangles, create a Voronoi edge
        for (const [key, entry] of edgeTriMap) {
            const { a, b, tris } = entry;

            if (tris.length === 2) {
                const cc1 = this.circumcenter(tris[0]);
                const cc2 = this.circumcenter(tris[1]);
                if (!cc1 || !cc2) continue;

                const edge = {
                    x1: cc1.wx, y1: cc1.wy,
                    x2: cc2.wx, y2: cc2.wy,
                    netA: a.net,
                    netB: b.net,
                    colorA: a.netColor,
                    colorB: b.netColor,
                };
                this.edges.push(edge);
                if (a.net !== b.net) {
                    this.interNetEdges.push(edge);
                }
            }
            // Edges on the convex hull (1 triangle) could be extended to infinity,
            // but we skip them for cleaner visuals
        }
    }
}
