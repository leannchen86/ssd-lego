// @ts-check
// Catalog loading and normalization. JSON strings are parsed into structured
// fields once, so hot paths do not rediscover the same facts.

/**
 * @typedef {import('./types.js').StorageInterface} StorageInterface
 * @typedef {import('./types.js').Drive} Drive
 * @typedef {import('./types.js').BaySpec} BaySpec
 * @typedef {import('./types.js').Server} Server
 * @typedef {import('./types.js').Module} Module
 * @typedef {import('./types.js').Workload} Workload
 * @typedef {import('./types.js').Catalog} Catalog
 */

async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Catalog field ${field} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Catalog field ${field} must be a finite number`);
  }
  return value;
}

/**
 * @param {string} label
 * @returns {StorageInterface}
 */
export function parseStorageInterface(label) {
  if (label === 'SATA III') {
    return { kind: 'sata', generation: 0, label, shortLabel: 'SATA', canvasLabel: 'SATA' };
  }

  const match = label.match(/^NVMe PCIe (\d+)$/);
  if (match) {
    const generation = Number(match[1]);
    return {
      kind: 'nvme',
      generation,
      label,
      shortLabel: `Gen${generation}`,
      canvasLabel: `GEN${generation}`,
    };
  }

  throw new Error(`Unsupported storage interface: ${label}`);
}

/**
 * @param {number} capacityTB
 */
export function capacityLabel(capacityTB) {
  if (capacityTB > 0 && capacityTB < 1) return `${Math.round(capacityTB * 1000)}GB`;
  return `${Number.isInteger(capacityTB) ? capacityTB.toFixed(0) : capacityTB.toString()}TB`;
}

/**
 * @param {string} name
 * @param {number} capacityTB
 */
export function displayNameWithoutCapacity(name, capacityTB) {
  const label = capacityLabel(capacityTB);
  const tokens = [
    label,
    `${capacityTB}TB`,
    `${Number.isInteger(capacityTB) ? capacityTB.toFixed(0) : capacityTB.toString()} TB`,
    `${Math.round(capacityTB * 1000)}GB`,
    `${Math.round(capacityTB * 1000)} GB`,
  ];
  let display = name;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length === 0 || token === '0TB') continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    display = display.replace(new RegExp(`\\s+${escaped}$`, 'i'), '');
  }
  return display.trim() || name;
}

/**
 * @param {any} raw
 * @param {string} owner
 * @returns {BaySpec}
 */
function normalizeBaySpec(raw, owner) {
  const interfaceLabel = requiredString(raw.interface, `${owner}.interface`);
  return {
    ...raw,
    count: requiredNumber(raw.count, `${owner}.count`),
    formFactor: requiredString(raw.formFactor, `${owner}.formFactor`),
    interface: interfaceLabel,
    interfaceInfo: parseStorageInterface(interfaceLabel),
    lanesPerDrive: Number(raw.lanesPerDrive || 0),
    perDriveMaxMBs: Number(raw.perDriveMaxMBs || 0),
    hotSwap: Boolean(raw.hotSwap),
  };
}

/**
 * @param {any} raw
 * @returns {Drive}
 */
function normalizeDrive(raw) {
  const id = requiredString(raw.id, 'drive.id');
  const name = requiredString(raw.name, `${id}.name`);
  const capacityTB = requiredNumber(raw.capacityTB, `${id}.capacityTB`);
  const interfaceLabel = requiredString(raw.interface, `${id}.interface`);
  const priceUSD = Number(raw.priceUSD || 0);
  return {
    ...raw,
    id,
    name,
    displayName: displayNameWithoutCapacity(name, capacityTB),
    capacityLabel: capacityLabel(capacityTB),
    capacityTB,
    interface: interfaceLabel,
    interfaceInfo: parseStorageInterface(interfaceLabel),
    formFactor: requiredString(raw.formFactor, `${id}.formFactor`),
    priceUSD,
    pricePerTB: capacityTB > 0 ? priceUSD / capacityTB : Infinity,
    seqReadMBs: requiredNumber(raw.seqReadMBs, `${id}.seqReadMBs`),
    seqWriteMBs: requiredNumber(raw.seqWriteMBs, `${id}.seqWriteMBs`),
    random4KReadIOPS: requiredNumber(raw.random4KReadIOPS, `${id}.random4KReadIOPS`),
    random4KWriteIOPS: requiredNumber(raw.random4KWriteIOPS, `${id}.random4KWriteIOPS`),
    dramCacheMB: Number(raw.dramCacheMB || 0),
    tbw: Number(raw.tbw || 0),
    dwpd: Number(raw.dwpd || 0),
    powerW: Number(raw.powerW || 0),
  };
}

/**
 * @param {any} raw
 * @returns {Server}
 */
function normalizeServer(raw) {
  const id = requiredString(raw.id, 'server.id');
  const bays = raw.bays.map((spec, index) => normalizeBaySpec(spec, `${id}.bays[${index}]`));
  const bayConfigs = raw.bayConfigs
    ? raw.bayConfigs.map((config) => ({
        ...config,
        id: requiredString(config.id, `${id}.bayConfigs.id`),
        name: requiredString(config.name, `${id}.bayConfigs.name`),
        bays: config.bays.map((spec, index) => normalizeBaySpec(spec, `${id}.${config.id}.bays[${index}]`)),
      }))
    : undefined;
  return {
    ...raw,
    id,
    name: requiredString(raw.name, `${id}.name`),
    bays,
    bayConfigs,
    pcieSlotsRear: raw.pcieSlotsRear || [],
    maxBandwidthGBs: Number(raw.maxBandwidthGBs || 0),
    realisticBandwidthRatio: Number(raw.realisticBandwidthRatio || 1),
    priceUSD: Number(raw.priceUSD || 0),
    powerBaseW: Number(raw.powerBaseW || 0),
  };
}

/**
 * @param {any} raw
 * @returns {Module}
 */
function normalizeModule(raw) {
  const id = requiredString(raw.id, 'module.id');
  return {
    ...raw,
    id,
    name: requiredString(raw.name, `${id}.name`),
    provides: raw.provides ? normalizeBaySpec(raw.provides, `${id}.provides`) : undefined,
  };
}

/**
 * @returns {Promise<Catalog>}
 */
export async function loadCatalog() {
  const [rawDrives, rawServers, rawModules, rawWorkloads] = await Promise.all([
    loadJSON('./data/drives.json'),
    loadJSON('./data/servers.json'),
    loadJSON('./data/modules.json'),
    loadJSON('./data/workloads.json'),
  ]);

  const drives = rawDrives.map(normalizeDrive);
  const drivesById = new Map();
  for (let i = 0; i < drives.length; i++) drivesById.set(drives[i].id, drives[i]);

  return {
    drives,
    drivesById,
    retailConsumerDrives: drives.filter(drive => drive.category === 'consumer' && drive.priceUSD > 0),
    servers: rawServers.map(normalizeServer),
    modules: rawModules.map(normalizeModule),
    workloads: rawWorkloads.map(workload => ({ ...workload })),
  };
}
