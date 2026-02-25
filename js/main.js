import { createDemoData, datasets } from './demoData.js';
import { PhysicsEngine } from './physics.js';
import { Renderer } from './renderer.js';
import { InteractionHandler } from './interaction.js';
import { VoronoiOverlay } from './voronoi.js';

// --- State ---
let components, nets, physics, interaction;
let defaultForces = new Map();
let netSliders = new Map();
const voronoi = new VoronoiOverlay();
let voronoiFrameCounter = 0;
const voronoiUpdateInterval = 6; // update every N frames

const canvas = document.getElementById('canvas');
const renderer = new Renderer(canvas);
renderer.voronoiOverlay = voronoi;

// --- UI Elements ---
const datasetSelect = document.getElementById('dataset-select');
const sliderRepulsion = document.getElementById('slider-repulsion');
const repulsionValue = document.getElementById('repulsion-value');
const selectNway = document.getElementById('select-nway');
const inputGrid = document.getElementById('input-grid');
const btnReset = document.getElementById('btn-reset');
const statusText = document.getElementById('status-text');
const btnDisablePower = document.getElementById('btn-disable-power');
const btnResetForces = document.getElementById('btn-reset-forces');
const btnVoronoi = document.getElementById('btn-voronoi');
const btnSpectral = document.getElementById('btn-spectral');

// --- Initialize a dataset ---
function loadDataset(id) {
    const data = createDemoData(id);
    components = data.components;
    nets = data.nets;
    defaultForces = new Map(nets.map(n => [n.name, n.force]));

    renderer.setNetColors(nets);
    renderer.selectedComponents.clear();
    renderer.highlightedNets.clear();
    renderer.highlightedComponents.clear();
    renderer.hoveredComponentId = null;

    physics = new PhysicsEngine(components, nets);
    physics.setRepulsionStrength(parseInt(sliderRepulsion.value) / 100);
    physics.directionWays = parseInt(selectNway.value);
    physics.gridSpacing = parseFloat(inputGrid.value) || 1.27;

    // Spectral initialization — place components using graph topology
    physics.spectralInitialize();

    const state = { components, nets, physics };

    // Recreate interaction handler
    if (interaction) {
        // Remove old listeners by replacing canvas (simplest approach for POC)
        // Actually we can't easily remove listeners, so just overwrite the state
        interaction.state = state;
    } else {
        interaction = new InteractionHandler(canvas, renderer, state);
        interaction.onSelectionChange = updateNetPanelHighlights;
        interaction.onHoverChange = updateNetPanelHighlights;
        interaction.onStatusChange = (text) => { statusText.textContent = text; };
    }

    buildNetPanel();
    syncSettingsFromPhysics();
}

// --- Dataset selector ---
datasetSelect.addEventListener('change', () => {
    loadDataset(datasetSelect.value);
});

// --- Repulsion slider ---
sliderRepulsion.addEventListener('input', () => {
    const val = parseInt(sliderRepulsion.value);
    physics.setRepulsionStrength(val / 100);
    repulsionValue.textContent = val;
    const repInput = document.getElementById('set-repulsion');
    if (repInput) repInput.value = (val / 100).toFixed(2);
});

// --- Alignment controls ---
selectNway.addEventListener('change', () => {
    physics.directionWays = parseInt(selectNway.value);
});

inputGrid.addEventListener('input', () => {
    const val = parseFloat(inputGrid.value);
    if (val > 0) physics.gridSpacing = val;
});

// --- Reset ---
btnReset.addEventListener('click', () => {
    for (const c of components) {
        c.x = c.initialX;
        c.y = c.initialY;
        c.rotation = 0;
        c.angularVel = 0;
        c.vx = 0;
        c.vy = 0;
    }
});

// --- Spectral re-initialization ---
const inputSpectralSpread = document.getElementById('set-spectral-spread');
btnSpectral.addEventListener('click', () => {
    const spread = parseFloat(inputSpectralSpread.value) || 40;
    physics.spectralInitialize(spread);
});

// --- Settings panel ---
const settingsMap = [
    // [elementId, physicsProperty, parse]
    ['set-base-temp',      'baseTemperature',     parseFloat],
    ['set-temp-ramp',      'tempRampSpeed',        parseFloat],
    ['set-temp-decay',     'tempDecaySpeed',        parseFloat],
    ['set-attraction',     'attractionStrength',    parseFloat],
    ['set-repulsion',      'repulsionStrength',     parseFloat],
    ['set-gravity',        'gravityStrength',       parseFloat],
    ['set-damping',        'damping',               parseFloat],
    ['set-dt',             'dt',                    parseFloat],
    ['set-stress',         'stressStrength',        parseFloat],
    ['set-stress-spacing', 'stressBaseSpacing',     parseFloat],
    ['set-crossing',       'crossingStrength',      parseFloat],
    ['set-rot-damp',       'rotationDamping',       parseFloat],
    ['set-torque-scale',   'rotationTorqueScale',   parseFloat],
    ['set-dipole',         'dipoleStrength',        parseFloat],
    ['set-dir-strength',   'directionStrength',     parseFloat],
    ['set-grid-strength',  'gridStrength',          parseFloat],
    ['set-clearance',      'clearanceMargin',       parseFloat],
];

const settingsInputs = settingsMap.map(([id, prop, parse]) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
        const val = parse(el.value);
        if (!isNaN(val)) physics[prop] = val;
    });
    return { el, prop };
});

function syncSettingsFromPhysics() {
    for (const { el, prop } of settingsInputs) {
        el.value = physics[prop];
    }
    // Sync repulsion slider too
    sliderRepulsion.value = Math.round(physics.repulsionStrength * 100);
    repulsionValue.textContent = Math.round(physics.repulsionStrength * 100);
}

// Keep repulsion slider and settings input in sync
document.getElementById('set-repulsion').addEventListener('input', () => {
    sliderRepulsion.value = Math.round(physics.repulsionStrength * 100);
    repulsionValue.textContent = Math.round(physics.repulsionStrength * 100);
});

// --- Net Panel ---
function buildNetPanel() {
    const container = document.getElementById('net-list');
    container.innerHTML = '';
    netSliders.clear();

    const sortedNets = [...nets].sort((a, b) => b.pads.length - a.pads.length);

    for (const net of sortedNets) {
        const item = document.createElement('div');
        item.className = 'net-item';
        item.dataset.netName = net.name;

        const header = document.createElement('div');
        header.className = 'net-item-header';

        const dot = document.createElement('span');
        dot.className = 'net-color-dot';
        dot.style.backgroundColor = net.color;

        const name = document.createElement('span');
        name.className = 'net-name';
        name.textContent = net.name;

        // Net type badge (signal / power) — click to toggle
        const typeBadge = document.createElement('span');
        typeBadge.className = `net-type-badge ${net.type}`;
        typeBadge.textContent = net.type === 'power' ? 'PWR' : 'SIG';
        typeBadge.title = 'Click to toggle signal/power classification';
        typeBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            net.type = net.type === 'power' ? 'signal' : 'power';
            typeBadge.textContent = net.type === 'power' ? 'PWR' : 'SIG';
            typeBadge.className = `net-type-badge ${net.type}`;
            // Refresh graph distances when classification changes
            physics.refreshGraphDistances();
        });

        const count = document.createElement('span');
        count.className = 'net-pad-count';
        count.textContent = `${net.pads.length}p`;

        header.appendChild(dot);
        header.appendChild(name);
        header.appendChild(typeBadge);
        header.appendChild(count);

        const forceRow = document.createElement('div');
        forceRow.className = 'net-force-row';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'net-force-slider';
        slider.min = '0';
        slider.max = '100';
        slider.value = Math.round(net.force * 100);

        const valueEl = document.createElement('span');
        valueEl.className = 'net-force-value';
        valueEl.textContent = `${Math.round(net.force * 100)}%`;

        slider.addEventListener('input', () => {
            net.force = parseInt(slider.value) / 100;
            valueEl.textContent = `${slider.value}%`;
        });

        forceRow.appendChild(slider);
        forceRow.appendChild(valueEl);

        item.appendChild(header);
        item.appendChild(forceRow);

        netSliders.set(net.name, { slider, valueEl, net, typeBadge });

        item.addEventListener('mouseenter', () => {
            interaction.highlightNet(net.name);
            updateNetPanelHighlights();
        });
        item.addEventListener('mouseleave', () => {
            if (renderer.selectedComponents.size > 0) {
                interaction.updateHighlights();
            } else {
                interaction.clearHighlights();
            }
            updateNetPanelHighlights();
        });

        container.appendChild(item);
    }
}

function updateNetPanelHighlights() {
    const items = document.querySelectorAll('.net-item');
    for (const item of items) {
        const netName = item.dataset.netName;
        item.classList.toggle('highlighted', renderer.highlightedNets.has(netName));
    }
}

// --- Net panel actions ---
btnDisablePower.addEventListener('click', () => {
    const powerPatterns = ['GND', 'VCC', 'VDD', 'VIN', 'VOUT', '3V3', '5V', '12V', 'VBUS'];
    for (const [netName, entry] of netSliders) {
        const isPower = powerPatterns.some(p => netName.toUpperCase().includes(p));
        if (isPower) {
            entry.net.force = 0;
            entry.slider.value = 0;
            entry.valueEl.textContent = '0%';
        }
    }
});

btnResetForces.addEventListener('click', () => {
    for (const [netName, entry] of netSliders) {
        const def = defaultForces.get(netName) || 1.0;
        entry.net.force = def;
        entry.slider.value = Math.round(def * 100);
        entry.valueEl.textContent = `${Math.round(def * 100)}%`;
    }
});

// --- Voronoi toggle ---
btnVoronoi.addEventListener('click', () => {
    renderer.showVoronoi = !renderer.showVoronoi;
    btnVoronoi.classList.toggle('active', renderer.showVoronoi);
});

// --- Temperature display in status bar ---
setInterval(() => {
    if (physics && physics.liveTemperature > 0.01) {
        const pct = Math.round(physics.liveTemperature * 100);
        statusText.textContent = `Temp: ${pct}%`;
    }
}, 200);

// --- Resize ---
window.addEventListener('resize', () => renderer.resize());

// --- Load default dataset ---
loadDataset('ldo');

// --- Main Loop ---
function loop() {
    physics.step();

    // Sync temperature display to renderer each frame
    renderer.liveTemperature = physics.liveTemperature;

    // Update Voronoi overlay periodically (expensive)
    if (renderer.showVoronoi) {
        voronoiFrameCounter++;
        if (voronoiFrameCounter >= voronoiUpdateInterval) {
            voronoi.update(components, nets, (comp, pad) => physics.getPadWorld(comp, pad));
            voronoiFrameCounter = 0;
        }
    }

    // Update crossing count every few frames
    if (physics.mstEdgeCache.length > 0) {
        renderer.crossingCount = physics.countCrossings();
    }

    renderer.draw(components, nets);
    requestAnimationFrame(loop);
}

loop();
