// Demo datasets for Phos Layout POC

const palette = [
    '#e94560', '#f5a623', '#7ed321', '#4a90d9', '#bd10e0',
    '#50e3c2', '#d0021b', '#f8e71c', '#8b572a', '#417505',
    '#9013fe', '#ff6f61', '#88d8b0', '#c3a6ff', '#ff9a76',
    '#6c5ce7', '#fd79a8', '#00cec9', '#e17055', '#dfe6e9',
];

function makePassive(ref, value, width, height, x, y, net1, net2) {
    return {
        id: ref, reference: ref, value, width, height,
        x, y, initialX: x, initialY: y,
        rotation: 0, angularVel: 0, vx: 0, vy: 0,
        pads: [
            { number: '1', name: '1', relX: -width / 2, relY: 0, net: net1 },
            { number: '2', name: '2', relX: width / 2, relY: 0, net: net2 },
        ]
    };
}

function makeIC(id, ref, value, width, height, x, y, pads) {
    return {
        id, reference: ref, value, width, height,
        x, y, initialX: x, initialY: y,
        rotation: 0, angularVel: 0, vx: 0, vy: 0,
        pads,
    };
}

function classifyNet(name, padCount) {
    const upper = name.toUpperCase();
    const powerPatterns = ['GND', 'VCC', 'VDD', 'VIN', 'VOUT', 'VEE', 'VSS',
        '3V3', '5V', '12V', '3.3V', '1V8', '2V5', 'VBUS', 'VBAT', 'PWR'];
    if (padCount >= 6) return 'power';
    if (powerPatterns.some(p => upper.includes(p))) return 'power';
    return 'signal';
}

function buildNets(components) {
    const netMap = {};
    for (const comp of components) {
        for (const pad of comp.pads) {
            if (!pad.net) continue;
            if (!netMap[pad.net]) netMap[pad.net] = [];
            netMap[pad.net].push({ componentId: comp.id, padNumber: pad.number });
        }
    }
    const nets = Object.entries(netMap).map(([name, pads]) => {
        const type = classifyNet(name, pads.length);
        return {
            name, pads, type,
            force: type === 'power' ? 0.2 : 1.0,
            enabled: true, color: null,
        };
    });
    nets.forEach((net, i) => { net.color = palette[i % palette.length]; });
    return nets;
}

// --- Linear Regulator (simple, should produce roughly linear layout) ---
function createLinearRegulator() {
    // Scatter initial positions randomly so we can see the tool work
    const spread = 25;
    const rx = () => (Math.random() - 0.5) * spread;
    const ry = () => (Math.random() - 0.5) * spread;

    const components = [
        // Input pin header (2-pin: VIN, GND)
        makeIC('J1', 'J1', 'Input Header', 4, 6, rx(), ry(), [
            { number: '1', name: 'VIN', relX: 0, relY: -2, net: 'VIN' },
            { number: '2', name: 'GND', relX: 0, relY: 2, net: 'GND' },
        ]),
        // Input bulk capacitor
        makePassive('C1', '10uF', 3.2, 1.6, rx(), ry(), 'VIN', 'GND'),
        // Input ceramic cap
        makePassive('C2', '100nF', 2, 1.25, rx(), ry(), 'VIN', 'GND'),
        // LDO regulator (SOT-223: VIN, GND, VOUT)
        makeIC('U1', 'U1', 'AMS1117-3.3', 6.5, 3.5, rx(), ry(), [
            { number: '1', name: 'VIN', relX: -3.25, relY: 0, net: 'VIN' },
            { number: '2', name: 'GND', relX: 0, relY: 1.75, net: 'GND' },
            { number: '3', name: 'VOUT', relX: 3.25, relY: 0, net: 'VOUT_3V3' },
        ]),
        // Output ceramic cap
        makePassive('C3', '100nF', 2, 1.25, rx(), ry(), 'VOUT_3V3', 'GND'),
        // Output bulk capacitor
        makePassive('C4', '22uF', 3.2, 1.6, rx(), ry(), 'VOUT_3V3', 'GND'),
        // Output pin header (2-pin: VOUT, GND)
        makeIC('J2', 'J2', 'Output Header', 4, 6, rx(), ry(), [
            { number: '1', name: 'VOUT', relX: 0, relY: -2, net: 'VOUT_3V3' },
            { number: '2', name: 'GND', relX: 0, relY: 2, net: 'GND' },
        ]),
    ];
    return { components, nets: buildNets(components) };
}

// --- MCU Board (original, more complex) ---
function createMcuBoard() {
    const components = [
        makeIC('U1', 'U1', 'STM32F405', 14, 14, 0, 0, [
            { number: '1', name: 'VDD', relX: -7, relY: -5, net: 'VCC_3V3' },
            { number: '2', name: 'GND', relX: -7, relY: -3, net: 'GND' },
            { number: '3', name: 'PA5_SCK', relX: -7, relY: -1, net: 'SPI_SCK' },
            { number: '4', name: 'PA6_MISO', relX: -7, relY: 1, net: 'SPI_MISO' },
            { number: '5', name: 'PA7_MOSI', relX: -7, relY: 3, net: 'SPI_MOSI' },
            { number: '6', name: 'PB0_CS', relX: -7, relY: 5, net: 'FLASH_CS' },
            { number: '7', name: 'PC0_LED1', relX: 7, relY: -5, net: 'LED1' },
            { number: '8', name: 'PC1_LED2', relX: 7, relY: -3, net: 'LED2' },
            { number: '9', name: 'PA9_TX', relX: 7, relY: -1, net: 'UART_TX' },
            { number: '10', name: 'PA10_RX', relX: 7, relY: 1, net: 'UART_RX' },
            { number: '11', name: 'VDD2', relX: 7, relY: 3, net: 'VCC_3V3' },
            { number: '12', name: 'GND2', relX: 7, relY: 5, net: 'GND' },
            { number: '13', name: 'NRST', relX: -3, relY: -7, net: 'RESET' },
            { number: '14', name: 'BOOT0', relX: 1, relY: -7, net: 'BOOT0' },
        ]),
        makeIC('U2', 'U2', 'W25Q128', 8, 6, 30, 0, [
            { number: '1', name: 'CS', relX: -4, relY: -2, net: 'FLASH_CS' },
            { number: '2', name: 'DO', relX: -4, relY: 0, net: 'SPI_MISO' },
            { number: '3', name: 'WP', relX: -4, relY: 2, net: 'VCC_3V3' },
            { number: '4', name: 'GND', relX: 4, relY: 2, net: 'GND' },
            { number: '5', name: 'DI', relX: 4, relY: 0, net: 'SPI_MOSI' },
            { number: '6', name: 'CLK', relX: 4, relY: -2, net: 'SPI_SCK' },
            { number: '7', name: 'HOLD', relX: 0, relY: -3, net: 'VCC_3V3' },
            { number: '8', name: 'VCC', relX: 0, relY: 3, net: 'VCC_3V3' },
        ]),
        makeIC('U3', 'U3', 'AMS1117-3.3', 8, 5, -30, -20, [
            { number: '1', name: 'VIN', relX: -4, relY: 0, net: 'VIN_5V' },
            { number: '2', name: 'GND', relX: 0, relY: 2.5, net: 'GND' },
            { number: '3', name: 'VOUT', relX: 4, relY: 0, net: 'VCC_3V3' },
        ]),
        makeIC('J1', 'J1', 'USB-C', 10, 8, -50, -20, [
            { number: '1', name: 'VBUS', relX: -3, relY: -2, net: 'VIN_5V' },
            { number: '2', name: 'D-', relX: -3, relY: 0, net: 'USB_DN' },
            { number: '3', name: 'D+', relX: -3, relY: 2, net: 'USB_DP' },
            { number: '4', name: 'GND', relX: 3, relY: 0, net: 'GND' },
        ]),
        makeIC('J2', 'J2', 'UART Header', 6, 8, 50, 0, [
            { number: '1', name: 'TX', relX: 0, relY: -3, net: 'UART_TX' },
            { number: '2', name: 'RX', relX: 0, relY: -1, net: 'UART_RX' },
            { number: '3', name: 'GND', relX: 0, relY: 1, net: 'GND' },
            { number: '4', name: 'VCC', relX: 0, relY: 3, net: 'VCC_3V3' },
        ]),
        makePassive('C1', '100nF', 3, 1.5, -10, -15, 'VCC_3V3', 'GND'),
        makePassive('C2', '100nF', 3, 1.5, -5, -15, 'VCC_3V3', 'GND'),
        makePassive('C3', '10uF', 4, 2, -15, -20, 'VIN_5V', 'GND'),
        makePassive('C4', '10uF', 4, 2, -20, -15, 'VCC_3V3', 'GND'),
        makePassive('C5', '100nF', 3, 1.5, 20, 10, 'VCC_3V3', 'GND'),
        makePassive('R1', '330R', 3, 1.5, 20, -15, 'LED1', 'LED1_R'),
        makePassive('R2', '330R', 3, 1.5, 25, -15, 'LED2', 'LED2_R'),
        makePassive('D1', 'Green', 3, 2, 30, -15, 'LED1_R', 'GND'),
        makePassive('D2', 'Red', 3, 2, 35, -15, 'LED2_R', 'GND'),
        makePassive('R3', '10K', 3, 1.5, -15, 10, 'RESET', 'VCC_3V3'),
        makePassive('R4', '10K', 3, 1.5, -10, 10, 'BOOT0', 'GND'),
        makePassive('R5', '22R', 3, 1.5, -40, -10, 'USB_DP', 'USB_DP_R'),
        makePassive('R6', '22R', 3, 1.5, -40, -5, 'USB_DN', 'USB_DN_R'),
    ];
    return { components, nets: buildNets(components) };
}

export const datasets = {
    'ldo': { name: 'Linear Regulator', create: createLinearRegulator },
    'mcu': { name: 'MCU Board', create: createMcuBoard },
};

export function createDemoData(datasetId = 'ldo') {
    const ds = datasets[datasetId] || datasets['ldo'];
    return ds.create();
}
