// Canvas renderer with pan/zoom, rotation, dual brush visualization, grid overlay, Voronoi

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // View transform
        this.offsetX = 0;
        this.offsetY = 0;
        this.scale = 8;

        this.highlightedNets = new Set();
        this.highlightedComponents = new Set();
        this.selectedComponents = new Set();
        this.hoveredComponentId = null;
        this.netColorMap = new Map();

        // Brush visualization (screen coords for cursor position, world radius computed from viewport fraction)
        // brushVisible: whether modifier is held (show circle even without clicking)
        // brushActive: whether mouse is down and simulating
        this.simBrush = { visible: false, active: false, sx: 0, sy: 0, screenRadius: 0 };
        this.alignBrush = { visible: false, directionActive: false, gridActive: false, sx: 0, sy: 0, screenRadius: 0 };

        // Grid overlay for alignment brush
        this.alignGridSpacing = 1.27;     // mm — synced from physics
        this.showAlignGrid = false;
        this.alignGridBrushWorld = null;   // { wx, wy, radius } for scoping grid overlay

        // Temperature display (0..1)
        this.liveTemperature = 0;

        // Selection rectangle
        this.selectionRect = null;

        // Voronoi overlay
        this.voronoiOverlay = null;       // VoronoiOverlay instance
        this.showVoronoi = false;

        // Crossing count display
        this.crossingCount = 0;

        this.resize();
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.screenWidth = rect.width;
        this.screenHeight = rect.height;
    }

    get screenDiagonal() {
        return Math.hypot(this.screenWidth, this.screenHeight);
    }

    worldToScreen(wx, wy) {
        return {
            sx: wx * this.scale + this.offsetX + this.screenWidth / 2,
            sy: wy * this.scale + this.offsetY + this.screenHeight / 2,
        };
    }

    screenToWorld(sx, sy) {
        return {
            wx: (sx - this.offsetX - this.screenWidth / 2) / this.scale,
            wy: (sy - this.offsetY - this.screenHeight / 2) / this.scale,
        };
    }

    zoom(delta, screenX, screenY) {
        const worldBefore = this.screenToWorld(screenX, screenY);
        const zoomFactor = delta > 0 ? 0.9 : 1.1;
        this.scale *= zoomFactor;
        this.scale = Math.max(0.5, Math.min(100, this.scale));
        const worldAfter = this.screenToWorld(screenX, screenY);
        this.offsetX += (worldAfter.wx - worldBefore.wx) * this.scale;
        this.offsetY += (worldAfter.wy - worldBefore.wy) * this.scale;
    }

    pan(dx, dy) {
        this.offsetX += dx;
        this.offsetY += dy;
    }

    setNetColors(nets) {
        this.netColorMap.clear();
        for (const net of nets) {
            this.netColorMap.set(net.name, net.color);
        }
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

    draw(components, nets) {
        const ctx = this.ctx;
        const w = this.screenWidth;
        const h = this.screenHeight;

        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, w, h);

        this.drawGrid(ctx, w, h);

        // Alignment grid overlay (under components but above background grid)
        if (this.showAlignGrid && this.alignGridBrushWorld) {
            this.drawAlignGrid(ctx, w, h);
        }

        // Voronoi overlay (under ratsnest but above grid)
        if (this.showVoronoi && this.voronoiOverlay) {
            this.drawVoronoi(ctx);
        }

        this.drawRatsnest(ctx, components, nets);

        for (const comp of components) {
            this.drawComponent(ctx, comp);
        }

        this.drawSimBrush(ctx);
        this.drawAlignBrush(ctx);
        this.drawSelectionRect(ctx);
        this.drawCrossingCount(ctx, w, h);
    }

    drawGrid(ctx, w, h) {
        let gridSpacing = 1;
        if (this.scale < 2) gridSpacing = 20;
        else if (this.scale < 5) gridSpacing = 10;
        else if (this.scale < 15) gridSpacing = 5;
        else if (this.scale < 40) gridSpacing = 2;

        const topLeft = this.screenToWorld(0, 0);
        const bottomRight = this.screenToWorld(w, h);
        const startX = Math.floor(topLeft.wx / gridSpacing) * gridSpacing;
        const startY = Math.floor(topLeft.wy / gridSpacing) * gridSpacing;

        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let x = startX; x <= bottomRight.wx; x += gridSpacing) {
            const s = this.worldToScreen(x, 0);
            ctx.moveTo(s.sx, 0);
            ctx.lineTo(s.sx, h);
        }
        for (let y = startY; y <= bottomRight.wy; y += gridSpacing) {
            const s = this.worldToScreen(0, y);
            ctx.moveTo(0, s.sy);
            ctx.lineTo(w, s.sy);
        }
        ctx.stroke();

        const origin = this.worldToScreen(0, 0);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(origin.sx, 0);
        ctx.lineTo(origin.sx, h);
        ctx.moveTo(0, origin.sy);
        ctx.lineTo(w, origin.sy);
        ctx.stroke();
    }

    drawAlignGrid(ctx, w, h) {
        const { wx, wy, radius } = this.alignGridBrushWorld;
        const gs = this.alignGridSpacing;
        if (gs < 0.1) return;

        // Only draw grid lines within the brush radius (world coords)
        const startX = Math.floor((wx - radius) / gs) * gs;
        const endX = Math.ceil((wx + radius) / gs) * gs;
        const startY = Math.floor((wy - radius) / gs) * gs;
        const endY = Math.ceil((wy + radius) / gs) * gs;

        // Limit line count to avoid performance issues
        const maxLines = 200;
        const xCount = (endX - startX) / gs;
        const yCount = (endY - startY) / gs;
        if (xCount + yCount > maxLines) return;

        ctx.strokeStyle = 'rgba(80, 227, 194, 0.15)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let x = startX; x <= endX; x += gs) {
            const s1 = this.worldToScreen(x, wy - radius);
            const s2 = this.worldToScreen(x, wy + radius);
            ctx.moveTo(s1.sx, s1.sy);
            ctx.lineTo(s2.sx, s2.sy);
        }
        for (let y = startY; y <= endY; y += gs) {
            const s1 = this.worldToScreen(wx - radius, y);
            const s2 = this.worldToScreen(wx + radius, y);
            ctx.moveTo(s1.sx, s1.sy);
            ctx.lineTo(s2.sx, s2.sy);
        }
        ctx.stroke();

        // Draw grid dots at intersections
        ctx.fillStyle = 'rgba(80, 227, 194, 0.25)';
        for (let x = startX; x <= endX; x += gs) {
            for (let y = startY; y <= endY; y += gs) {
                const dist = Math.hypot(x - wx, y - wy);
                if (dist > radius) continue;
                const s = this.worldToScreen(x, y);
                ctx.beginPath();
                ctx.arc(s.sx, s.sy, 1.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    drawRatsnest(ctx, components, nets) {
        const compMap = new Map(components.map(c => [c.id, c]));

        for (const net of nets) {
            if (!net.enabled) continue;

            const isHighlighted = this.highlightedNets.has(net.name);
            const color = net.color || '#444';

            const padPositions = [];
            for (const padRef of net.pads) {
                const comp = compMap.get(padRef.componentId);
                if (!comp) continue;
                const pad = comp.pads.find(p => p.number === padRef.padNumber);
                if (!pad) continue;
                padPositions.push(this.getPadWorld(comp, pad));
            }
            if (padPositions.length < 2) continue;

            ctx.strokeStyle = isHighlighted ? color : this.fadeColor(color, 0.25);
            ctx.lineWidth = isHighlighted ? 1.5 : 0.5;
            ctx.setLineDash(isHighlighted ? [] : [3, 3]);

            // Prim's MST
            const connected = new Set([0]);
            const edges = [];
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
                edges.push([bestFrom, bestTo]);
            }

            ctx.beginPath();
            for (const [from, to] of edges) {
                const s1 = this.worldToScreen(padPositions[from].wx, padPositions[from].wy);
                const s2 = this.worldToScreen(padPositions[to].wx, padPositions[to].wy);
                ctx.moveTo(s1.sx, s1.sy);
                ctx.lineTo(s2.sx, s2.sy);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    drawComponent(ctx, comp) {
        const s = this.worldToScreen(comp.x, comp.y);
        const w = comp.width * this.scale;
        const h = comp.height * this.scale;
        const rot = (comp.rotation || 0) * Math.PI / 180;

        const isSelected = this.selectedComponents.has(comp.id);
        const isHovered = this.hoveredComponentId === comp.id;
        const isHighlighted = this.highlightedComponents.has(comp.id);

        let bodyColor = '#2a2a4a';
        let borderColor = '#3a3a6a';
        if (isSelected) {
            bodyColor = '#3a2a4a';
            borderColor = '#e94560';
        } else if (isHovered || isHighlighted) {
            bodyColor = '#2a3a4a';
            borderColor = '#4a90d9';
        }

        ctx.save();
        ctx.translate(s.sx, s.sy);
        ctx.rotate(rot);

        ctx.fillStyle = bodyColor;
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.strokeRect(-w / 2, -h / 2, w, h);

        // Pin 1 indicator
        const indicatorSize = Math.max(3, this.scale * 0.6);
        ctx.fillStyle = borderColor;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 1, -h / 2 + 1);
        ctx.lineTo(-w / 2 + 1 + indicatorSize, -h / 2 + 1);
        ctx.lineTo(-w / 2 + 1, -h / 2 + 1 + indicatorSize);
        ctx.closePath();
        ctx.fill();

        // Reference label
        const label = comp.value ? `${comp.reference} (${comp.value})` : comp.reference;
        const fontSize = Math.max(8, Math.min(12, this.scale * 1.2));
        ctx.font = `${fontSize}px -apple-system, sans-serif`;
        ctx.fillStyle = '#c0c0d0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (w > 20) {
            ctx.fillText(label, 0, 0, w - 4);
        }

        ctx.restore();

        // Pads
        for (const pad of comp.pads) {
            const padWorld = this.getPadWorld(comp, pad);
            const padScreen = this.worldToScreen(padWorld.wx, padWorld.wy);
            const padSize = Math.max(2, this.scale * 0.5);
            const netColor = this.netColorMap.get(pad.net) || '#555';
            const isPadHighlighted = this.highlightedNets.has(pad.net);

            ctx.fillStyle = isPadHighlighted ? netColor : this.fadeColor(netColor, 0.5);
            ctx.beginPath();
            ctx.arc(padScreen.sx, padScreen.sy, padSize, 0, Math.PI * 2);
            ctx.fill();

            if (isPadHighlighted) {
                ctx.strokeStyle = netColor;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
    }

    drawSimBrush(ctx) {
        if (!this.simBrush.visible) return;
        const { sx, sy, screenRadius, active } = this.simBrush;
        if (screenRadius < 1) return;

        // Outer circle — brighter when actively simulating
        const alpha = active ? 0.6 : 0.25;
        ctx.strokeStyle = `rgba(233, 69, 96, ${alpha})`;
        ctx.lineWidth = active ? 1.5 : 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(sx, sy, screenRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        if (active) {
            // Filled gradient showing falloff
            const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, screenRadius);
            gradient.addColorStop(0, 'rgba(233, 69, 96, 0.08)');
            gradient.addColorStop(0.7, 'rgba(233, 69, 96, 0.03)');
            gradient.addColorStop(1, 'rgba(233, 69, 96, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(sx, sy, screenRadius, 0, Math.PI * 2);
            ctx.fill();

            // Temperature arc indicator
            if (this.liveTemperature > 0.01) {
                const t = this.liveTemperature;
                const arcEnd = -Math.PI / 2 + t * Math.PI * 2;
                ctx.strokeStyle = `rgba(255, ${Math.round(200 * (1 - t))}, ${Math.round(50 * (1 - t))}, ${0.3 + t * 0.5})`;
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(sx, sy, screenRadius + 4, -Math.PI / 2, arcEnd);
                ctx.stroke();
            }
        }

        // Center dot
        ctx.fillStyle = `rgba(233, 69, 96, ${active ? 0.6 : 0.3})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    drawAlignBrush(ctx) {
        if (!this.alignBrush.visible) return;
        const { sx, sy, screenRadius, directionActive, gridActive } = this.alignBrush;
        if (screenRadius < 1) return;

        const active = directionActive || gridActive;
        const alpha = active ? 0.5 : 0.2;

        // Outer circle — teal color for alignment
        ctx.strokeStyle = `rgba(80, 227, 194, ${alpha})`;
        ctx.lineWidth = active ? 1.5 : 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(sx, sy, screenRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        if (active) {
            const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, screenRadius);
            gradient.addColorStop(0, 'rgba(80, 227, 194, 0.06)');
            gradient.addColorStop(0.7, 'rgba(80, 227, 194, 0.02)');
            gradient.addColorStop(1, 'rgba(80, 227, 194, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(sx, sy, screenRadius, 0, Math.PI * 2);
            ctx.fill();
        }

        // Center dot
        ctx.fillStyle = `rgba(80, 227, 194, ${active ? 0.6 : 0.3})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    drawSelectionRect(ctx) {
        if (!this.selectionRect) return;
        const { x1, y1, x2, y2 } = this.selectionRect;
        const rx = Math.min(x1, x2);
        const ry = Math.min(y1, y2);
        const rw = Math.abs(x2 - x1);
        const rh = Math.abs(y2 - y1);
        const isLeftToRight = x2 >= x1;

        ctx.strokeStyle = isLeftToRight ? 'rgba(74, 144, 217, 0.8)' : 'rgba(80, 227, 194, 0.8)';
        ctx.fillStyle = isLeftToRight ? 'rgba(74, 144, 217, 0.08)' : 'rgba(80, 227, 194, 0.08)';
        ctx.lineWidth = 1;
        ctx.setLineDash(isLeftToRight ? [] : [4, 4]);
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
    }

    drawVoronoi(ctx) {
        const overlay = this.voronoiOverlay;
        if (!overlay) return;

        // Draw all Voronoi edges very faintly
        ctx.lineWidth = 0.5;
        ctx.setLineDash([]);

        // Same-net edges: very faint
        for (const edge of overlay.edges) {
            const s1 = this.worldToScreen(edge.x1, edge.y1);
            const s2 = this.worldToScreen(edge.x2, edge.y2);

            // Clip to reasonable screen bounds to avoid drawing huge lines
            if (s1.sx < -500 || s1.sx > this.screenWidth + 500 ||
                s1.sy < -500 || s1.sy > this.screenHeight + 500) continue;
            if (s2.sx < -500 || s2.sx > this.screenWidth + 500 ||
                s2.sy < -500 || s2.sy > this.screenHeight + 500) continue;

            if (edge.netA === edge.netB) {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
                ctx.lineWidth = 0.5;
            } else {
                // Inter-net edges: highlighted — these are routing boundaries
                ctx.strokeStyle = 'rgba(255, 200, 60, 0.35)';
                ctx.lineWidth = 1.5;
            }
            ctx.beginPath();
            ctx.moveTo(s1.sx, s1.sy);
            ctx.lineTo(s2.sx, s2.sy);
            ctx.stroke();
        }
    }

    drawCrossingCount(ctx, w, h) {
        const count = this.crossingCount;
        if (count === undefined) return;

        const text = `Crossings: ${count}`;
        ctx.font = '12px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';

        const color = count === 0 ? 'rgba(126, 211, 33, 0.8)'
            : count <= 3 ? 'rgba(245, 166, 35, 0.8)'
            : 'rgba(233, 69, 96, 0.8)';

        ctx.fillStyle = color;
        ctx.fillText(text, 10, h - 10);
    }

    fadeColor(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    hitTest(sx, sy, components) {
        const world = this.screenToWorld(sx, sy);
        for (let i = components.length - 1; i >= 0; i--) {
            const c = components[i];
            const dx = world.wx - c.x;
            const dy = world.wy - c.y;
            const rot = -(c.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(rot);
            const sin = Math.sin(rot);
            const localX = dx * cos - dy * sin;
            const localY = dx * sin + dy * cos;
            if (localX >= -c.width / 2 && localX <= c.width / 2 &&
                localY >= -c.height / 2 && localY <= c.height / 2) {
                return c;
            }
        }
        return null;
    }

    isInSelectionRect(comp, rect) {
        const s = this.worldToScreen(comp.x, comp.y);
        const rx = Math.min(rect.x1, rect.x2);
        const ry = Math.min(rect.y1, rect.y2);
        const rw = Math.abs(rect.x2 - rect.x1);
        const rh = Math.abs(rect.y2 - rect.y1);
        const isLeftToRight = rect.x2 >= rect.x1;
        const hw = comp.width * this.scale / 2;
        const hh = comp.height * this.scale / 2;

        if (isLeftToRight) {
            return (s.sx - hw >= rx && s.sx + hw <= rx + rw &&
                    s.sy - hh >= ry && s.sy + hh <= ry + rh);
        } else {
            return (s.sx + hw >= rx && s.sx - hw <= rx + rw &&
                    s.sy + hh >= ry && s.sy - hh <= ry + rh);
        }
    }
}
