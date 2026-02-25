// Interaction handler: modifier-based brushes, select/drag, pan/zoom, rotation
// Default = select/drag/area-select
// Shift = simulation brush (L=simulate, R=temperature ramp)
// Alt = alignment brush (L=direction align, R=grid align)
// Shift+Alt = both brushes simultaneously

export class InteractionHandler {
    constructor(canvas, renderer, state) {
        this.canvas = canvas;
        this.renderer = renderer;
        this.state = state;

        // Interaction state
        this.isPanning = false;
        this.isDragging = false;
        this.isAreaSelecting = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.mouseScreenX = 0;         // always-updated cursor position
        this.mouseScreenY = 0;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.dragOffsets = new Map();

        // Modifier tracking
        this.shiftHeld = false;
        this.altHeld = false;

        // Brush state
        this.simBrushLDown = false;     // left mouse down in sim brush mode
        this.simBrushRDown = false;     // right mouse down (temp ramp)
        this.alignBrushLDown = false;   // left mouse down in align brush mode
        this.alignBrushRDown = false;   // right mouse down (grid align)

        // Viewport-relative brush sizing
        this.brushFraction = 0.15;      // fraction of screen diagonal

        this.onSelectionChange = null;
        this.onHoverChange = null;
        this.onStatusChange = null;     // status bar text callback

        this.bindEvents();
    }

    // Compute world-space brush radius from viewport fraction
    get brushWorldRadius() {
        return this.brushFraction * this.renderer.screenDiagonal / this.renderer.scale;
    }

    get brushScreenRadius() {
        return this.brushFraction * this.renderer.screenDiagonal;
    }

    bindEvents() {
        const c = this.canvas;
        c.addEventListener('mousedown', e => this.onMouseDown(e));
        c.addEventListener('mousemove', e => this.onMouseMove(e));
        c.addEventListener('mouseup', e => this.onMouseUp(e));
        c.addEventListener('wheel', e => this.onWheel(e), { passive: false });
        c.addEventListener('contextmenu', e => e.preventDefault());
        c.addEventListener('mouseleave', () => this.onMouseLeave());

        document.addEventListener('keydown', e => this.onKeyDown(e));
        document.addEventListener('keyup', e => this.onKeyUp(e));
    }

    getCanvasPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // Update brush visibility and physics brush state based on current modifiers
    syncBrushState() {
        const physics = this.state.physics;
        const renderer = this.renderer;
        const world = renderer.screenToWorld(this.mouseScreenX, this.mouseScreenY);
        const worldRadius = this.brushWorldRadius;
        const screenRadius = this.brushScreenRadius;

        // Simulation brush (Shift)
        const simVisible = this.shiftHeld;
        renderer.simBrush.visible = simVisible;
        renderer.simBrush.sx = this.mouseScreenX;
        renderer.simBrush.sy = this.mouseScreenY;
        renderer.simBrush.screenRadius = screenRadius;
        renderer.simBrush.active = this.simBrushLDown || this.simBrushRDown;

        physics.simBrush.active = this.simBrushLDown;
        physics.simBrush.wx = world.wx;
        physics.simBrush.wy = world.wy;
        physics.simBrush.radius = worldRadius;

        // Temperature ramping (right-click while Shift held)
        physics.tempRamping = this.simBrushRDown;

        // Alignment brush (Alt)
        const alignVisible = this.altHeld;
        renderer.alignBrush.visible = alignVisible;
        renderer.alignBrush.sx = this.mouseScreenX;
        renderer.alignBrush.sy = this.mouseScreenY;
        renderer.alignBrush.screenRadius = screenRadius;
        renderer.alignBrush.directionActive = this.alignBrushLDown;
        renderer.alignBrush.gridActive = this.alignBrushRDown;

        physics.alignBrush.active = this.alignBrushLDown || this.alignBrushRDown;
        physics.alignBrush.directionActive = this.alignBrushLDown;
        physics.alignBrush.gridActive = this.alignBrushRDown;
        physics.alignBrush.wx = world.wx;
        physics.alignBrush.wy = world.wy;
        physics.alignBrush.radius = worldRadius;

        // Grid overlay
        renderer.showAlignGrid = this.alignBrushRDown;
        if (this.alignBrushRDown) {
            renderer.alignGridBrushWorld = { wx: world.wx, wy: world.wy, radius: worldRadius };
            renderer.alignGridSpacing = physics.gridSpacing;
        }

        // Sync temperature display
        renderer.liveTemperature = physics.liveTemperature;

        // Cursor
        if (simVisible || alignVisible) {
            this.canvas.style.cursor = 'crosshair';
        } else {
            this.canvas.style.cursor = this.isDragging ? 'grabbing' : 'default';
        }

        // Status text
        if (this.onStatusChange) {
            if (this.simBrushLDown && this.alignBrushLDown) {
                this.onStatusChange('Simulating + Aligning');
            } else if (this.simBrushLDown) {
                this.onStatusChange('Simulating...');
            } else if (this.simBrushRDown) {
                this.onStatusChange('Ramping temperature...');
            } else if (this.alignBrushLDown) {
                this.onStatusChange('Aligning to directions...');
            } else if (this.alignBrushRDown) {
                this.onStatusChange('Aligning to grid...');
            } else if (simVisible && alignVisible) {
                this.onStatusChange('Shift+Alt: L=sim+align  R=temp+grid');
            } else if (simVisible) {
                this.onStatusChange('Shift: L=simulate  R=temperature');
            } else if (alignVisible) {
                this.onStatusChange('Alt: L=direction align  R=grid align');
            } else {
                this.onStatusChange('Click to select, drag to move');
            }
        }
    }

    onMouseDown(e) {
        const pos = this.getCanvasPos(e);
        this.lastMouseX = pos.x;
        this.lastMouseY = pos.y;
        this.mouseScreenX = pos.x;
        this.mouseScreenY = pos.y;
        this.dragStartX = pos.x;
        this.dragStartY = pos.y;

        // Middle mouse → pan (always)
        if (e.button === 1) {
            this.isPanning = true;
            this.canvas.classList.add('dragging');
            e.preventDefault();
            return;
        }

        // If Shift or Alt held → brush mode
        if (this.shiftHeld || this.altHeld) {
            e.preventDefault();
            if (e.button === 0) {
                if (this.shiftHeld) this.simBrushLDown = true;
                if (this.altHeld) this.alignBrushLDown = true;
            }
            if (e.button === 2) {
                if (this.shiftHeld) this.simBrushRDown = true;
                if (this.altHeld) this.alignBrushRDown = true;
            }
            this.syncBrushState();
            return;
        }

        // Left mouse — default mode: select/drag/area-select
        if (e.button === 0) {
            const hit = this.renderer.hitTest(pos.x, pos.y, this.state.components);

            if (hit) {
                const shift = e.shiftKey;
                if (shift) {
                    if (this.renderer.selectedComponents.has(hit.id)) {
                        this.renderer.selectedComponents.delete(hit.id);
                    } else {
                        this.renderer.selectedComponents.add(hit.id);
                    }
                } else if (!this.renderer.selectedComponents.has(hit.id)) {
                    this.renderer.selectedComponents.clear();
                    this.renderer.selectedComponents.add(hit.id);
                }
                // Start dragging
                this.isDragging = true;
                this.dragOffsets.clear();
                const world = this.renderer.screenToWorld(pos.x, pos.y);
                for (const id of this.renderer.selectedComponents) {
                    const c = this.state.components.find(comp => comp.id === id);
                    if (c) {
                        this.dragOffsets.set(id, { dx: c.x - world.wx, dy: c.y - world.wy });
                        c.vx = 0;
                        c.vy = 0;
                    }
                }
                this.canvas.style.cursor = 'grabbing';
                this.updateHighlights();
                if (this.onSelectionChange) this.onSelectionChange();
            } else {
                // Area selection
                this.renderer.selectedComponents.clear();
                this.isAreaSelecting = true;
                this.renderer.selectionRect = {
                    x1: pos.x, y1: pos.y,
                    x2: pos.x, y2: pos.y,
                };
                if (this.onSelectionChange) this.onSelectionChange();
            }
        }
    }

    onMouseMove(e) {
        const pos = this.getCanvasPos(e);
        const dx = pos.x - this.lastMouseX;
        const dy = pos.y - this.lastMouseY;
        this.mouseScreenX = pos.x;
        this.mouseScreenY = pos.y;

        if (this.isPanning) {
            this.renderer.pan(dx, dy);
        }

        if (this.isDragging) {
            const world = this.renderer.screenToWorld(pos.x, pos.y);
            for (const [id, offset] of this.dragOffsets) {
                const comp = this.state.components.find(c => c.id === id);
                if (comp) {
                    comp.x = world.wx + offset.dx;
                    comp.y = world.wy + offset.dy;
                    comp.vx = 0;
                    comp.vy = 0;
                }
            }
        }

        if (this.isAreaSelecting) {
            this.renderer.selectionRect.x2 = pos.x;
            this.renderer.selectionRect.y2 = pos.y;
        }

        // Always sync brush position when modifiers are held
        if (this.shiftHeld || this.altHeld) {
            this.syncBrushState();
        }

        // Hover detection (only when not in any active interaction)
        if (!this.isPanning && !this.isDragging && !this.isAreaSelecting &&
            !this.simBrushLDown && !this.simBrushRDown &&
            !this.alignBrushLDown && !this.alignBrushRDown) {
            const hit = this.renderer.hitTest(pos.x, pos.y, this.state.components);
            const hoveredId = hit ? hit.id : null;
            if (hoveredId !== this.renderer.hoveredComponentId) {
                this.renderer.hoveredComponentId = hoveredId;
                this.updateHighlights();
                if (this.onHoverChange) this.onHoverChange();
            }
        }

        this.lastMouseX = pos.x;
        this.lastMouseY = pos.y;
    }

    onMouseUp(e) {
        if (this.isPanning) {
            this.isPanning = false;
            this.canvas.classList.remove('dragging');
        }

        if (this.isDragging) {
            this.isDragging = false;
            this.dragOffsets.clear();
            this.canvas.style.cursor = this.shiftHeld || this.altHeld ? 'crosshair' : 'default';
        }

        // Release brush buttons
        if (e.button === 0) {
            this.simBrushLDown = false;
            this.alignBrushLDown = false;
        }
        if (e.button === 2) {
            this.simBrushRDown = false;
            this.alignBrushRDown = false;
        }

        if (this.isAreaSelecting) {
            const rect = this.renderer.selectionRect;
            if (rect && Math.abs(rect.x2 - rect.x1) > 3 && Math.abs(rect.y2 - rect.y1) > 3) {
                for (const comp of this.state.components) {
                    if (this.renderer.isInSelectionRect(comp, rect)) {
                        this.renderer.selectedComponents.add(comp.id);
                    }
                }
            }
            this.isAreaSelecting = false;
            this.renderer.selectionRect = null;
            this.updateHighlights();
            if (this.onSelectionChange) this.onSelectionChange();
        }

        this.syncBrushState();
    }

    onMouseLeave() {
        // Deactivate all brush interactions
        this.simBrushLDown = false;
        this.simBrushRDown = false;
        this.alignBrushLDown = false;
        this.alignBrushRDown = false;
        this.renderer.simBrush.visible = false;
        this.renderer.alignBrush.visible = false;
        this.syncBrushState();
    }

    onWheel(e) {
        e.preventDefault();
        const pos = this.getCanvasPos(e);

        if (this.shiftHeld || this.altHeld) {
            // Adjust brush size (viewport-relative fraction)
            const delta = e.deltaY > 0 ? 0.92 : 1.08;
            this.brushFraction = Math.max(0.03, Math.min(0.5, this.brushFraction * delta));
            this.syncBrushState();
        } else {
            // Normal zoom
            this.renderer.zoom(e.deltaY, pos.x, pos.y);
        }
    }

    onKeyDown(e) {
        const prevShift = this.shiftHeld;
        const prevAlt = this.altHeld;
        this.shiftHeld = e.shiftKey;
        this.altHeld = e.altKey;

        if (this.shiftHeld !== prevShift || this.altHeld !== prevAlt) {
            this.syncBrushState();
        }

        // R → rotate 90° CW (Shift+R = CCW)
        if (e.key === 'r' || e.key === 'R') {
            // Don't consume if Shift is the modifier for brush (only handle 'r' without alt-brush conflict)
            const degrees = e.shiftKey ? -90 : 90;
            const selectedIds = [...this.renderer.selectedComponents];

            if (selectedIds.length > 0) {
                if (selectedIds.length === 1) {
                    this.state.physics.rotateComponent(selectedIds[0], degrees);
                } else {
                    let cx = 0, cy = 0;
                    const comps = selectedIds.map(id => this.state.components.find(c => c.id === id)).filter(Boolean);
                    for (const c of comps) { cx += c.x; cy += c.y; }
                    cx /= comps.length;
                    cy /= comps.length;

                    const rad = degrees * Math.PI / 180;
                    const cos = Math.cos(rad);
                    const sin = Math.sin(rad);
                    for (const c of comps) {
                        const ddx = c.x - cx;
                        const ddy = c.y - cy;
                        c.x = cx + ddx * cos - ddy * sin;
                        c.y = cy + ddx * sin + ddy * cos;
                        this.state.physics.rotateComponent(c.id, degrees);
                    }
                }
            } else if (this.renderer.hoveredComponentId) {
                this.state.physics.rotateComponent(this.renderer.hoveredComponentId, degrees);
            }
            return;
        }

        // Escape → deselect all
        if (e.key === 'Escape') {
            this.renderer.selectedComponents.clear();
            this.clearHighlights();
            if (this.onSelectionChange) this.onSelectionChange();
            return;
        }

        // Ctrl+A → select all
        if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            for (const c of this.state.components) {
                this.renderer.selectedComponents.add(c.id);
            }
            this.updateHighlights();
            if (this.onSelectionChange) this.onSelectionChange();
            return;
        }
    }

    onKeyUp(e) {
        const prevShift = this.shiftHeld;
        const prevAlt = this.altHeld;
        this.shiftHeld = e.shiftKey;
        this.altHeld = e.altKey;

        // If modifier released, stop corresponding brush actions
        if (!this.shiftHeld) {
            this.simBrushLDown = false;
            this.simBrushRDown = false;
        }
        if (!this.altHeld) {
            this.alignBrushLDown = false;
            this.alignBrushRDown = false;
        }

        if (this.shiftHeld !== prevShift || this.altHeld !== prevAlt) {
            this.syncBrushState();
        }
    }

    updateHighlights() {
        this.renderer.highlightedNets.clear();
        this.renderer.highlightedComponents.clear();

        const activeIds = new Set(this.renderer.selectedComponents);
        if (this.renderer.hoveredComponentId) {
            activeIds.add(this.renderer.hoveredComponentId);
        }
        if (activeIds.size === 0) return;

        for (const id of activeIds) {
            const comp = this.state.components.find(c => c.id === id);
            if (!comp) continue;
            for (const pad of comp.pads) {
                if (pad.net) this.renderer.highlightedNets.add(pad.net);
            }
        }

        for (const c of this.state.components) {
            for (const pad of c.pads) {
                if (this.renderer.highlightedNets.has(pad.net)) {
                    this.renderer.highlightedComponents.add(c.id);
                    break;
                }
            }
        }
    }

    clearHighlights() {
        this.renderer.highlightedNets.clear();
        this.renderer.highlightedComponents.clear();
    }

    highlightNet(netName) {
        this.renderer.highlightedNets.clear();
        this.renderer.highlightedComponents.clear();

        if (netName) {
            this.renderer.highlightedNets.add(netName);
            const net = this.state.nets.find(n => n.name === netName);
            if (net) {
                for (const padRef of net.pads) {
                    this.renderer.highlightedComponents.add(padRef.componentId);
                }
            }
        }
    }
}
