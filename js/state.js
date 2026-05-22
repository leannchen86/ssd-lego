// state.js — serializable app state plus pure-ish domain derivations.
// No subscriptions live here; app.js owns input ordering and render scheduling.

/**
 * @typedef {import('./types.js').Catalog} Catalog
 * @typedef {import('./types.js').Drive} Drive
 * @typedef {import('./types.js').Bay} Bay
 * @typedef {import('./types.js').BaySpec} BaySpec
 * @typedef {import('./types.js').Server} Server
 * @typedef {import('./types.js').Module} Module
 */

export const RAID_MODES = {
  RAID0:  { name: 'RAID 0 (Stripe)',         usableRatio: 1.0,  minDrives: 2, redundancy: 0, raidWritePenalty: 1.0, raidReadBoost: true, description: 'Max speed, no safety net' },
  RAID1:  { name: 'RAID 1 (Mirror)',          usableRatio: 0.5,  minDrives: 2, redundancy: 1, raidWritePenalty: 0.5, raidReadBoost: false, description: 'Mirror pairs, 50% usable' },
  RAID5:  { name: 'RAID 5 (Parity)',          usableRatio: null,  minDrives: 3, redundancy: 1, raidWritePenalty: 0.25, raidReadBoost: false, description: 'N-1 usable, slow rebuilds' },
  RAID10: { name: 'RAID 10 (Mirror+Stripe)',  usableRatio: 0.5,  minDrives: 4, redundancy: 1, raidWritePenalty: 0.5, raidReadBoost: true, description: 'Best perf + redundancy' },
  JBOD:   { name: 'JBOD (No RAID)',           usableRatio: 1.0,  minDrives: 1, redundancy: 0, raidWritePenalty: 1.0, raidReadBoost: false, description: 'Just a bunch of disks' },
};

const DEFAULT_ELECTRICITY_USD_KWH = 0.12;
const DEFAULT_CONSUMER_AFR = 0.01;
const DEFAULT_UBER = 1e-16;
const DEFAULT_COOLING_PROFILE = 'stock';
const COOLING_PROFILE_MULTIPLIERS = {
  constrained: 0.75,
  stock: 1,
  boosted: 1.3,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function coolingProfileMultiplier(profile) {
  return COOLING_PROFILE_MULTIPLIERS[profile] || COOLING_PROFILE_MULTIPLIERS[DEFAULT_COOLING_PROFILE];
}

export function interfaceCompatible(driveInterface, bayInterface) {
  if (driveInterface.kind !== bayInterface.kind) return false;
  if (driveInterface.kind === 'sata') return true;
  return driveInterface.generation <= bayInterface.generation;
}

export function formFactorCompatible(drive, bay) {
  if (drive.formFactor === bay.formFactor) return true;
  return drive.formFactor === '2.5"' &&
    bay.formFactor === '3.5"' &&
    drive.interfaceInfo.kind === 'sata' &&
    bay.interfaceInfo.kind === 'sata';
}

export function driveCompatibleWithBay(drive, bay) {
  return formFactorCompatible(drive, bay) && interfaceCompatible(drive.interfaceInfo, bay.interfaceInfo);
}

function bayThermalBudgetW(server, bay) {
  const design = server?.thermalDesign || 'standard';
  const isNvme = String(bay.interface || '').startsWith('NVMe');
  const table = isNvme
    ? {
        tower: 7,
        standard: 8,
        'enterprise-optimized': 12,
        'nvme-optimized': bay.formFactor === 'E3.S' ? 15 : 16,
      }
    : {
        tower: 4.5,
        standard: 5.5,
        'enterprise-optimized': 7,
        'nvme-optimized': 8,
      };
  return table[design] || table.standard;
}

function moduleThermalBudgetW(server) {
  const design = server?.thermalDesign || 'standard';
  return {
    tower: 60,
    standard: 45,
    'enterprise-optimized': 75,
    'nvme-optimized': 110,
  }[design] || 45;
}

function deriveThermalModel(state, drivePowerW, modulePowerW) {
  const profile = state.coolingProfile || DEFAULT_COOLING_PROFILE;
  const profileMultiplier = coolingProfileMultiplier(profile);
  const chassisBudgetW = state.bays
    .filter(b => b.source === 'chassis')
    .reduce((s, b) => s + bayThermalBudgetW(state.server, b), 0);
  const moduleBudgetW = state.modules.reduce((s) => s + moduleThermalBudgetW(state.server), 0);
  const thermalBudgetW = Math.max(1, (chassisBudgetW + moduleBudgetW) * profileMultiplier);
  const thermalLoadW = drivePowerW + modulePowerW;
  const thermalPressure = thermalLoadW / thermalBudgetW;
  const overBudget = Math.max(0, thermalPressure - 1);
  const thermalBurstThrottleFactor = overBudget > 0
    ? clamp(1 - overBudget * 0.22, 0.72, 1)
    : 1;
  const thermalSustainedThrottleFactor = overBudget > 0
    ? clamp(1 - overBudget * 0.55, 0.45, 1)
    : 1;
  const thermalStatus = thermalPressure > 1.25
    ? 'throttling'
    : thermalPressure > 1
      ? 'hot'
      : thermalPressure > 0.82
        ? 'warm'
        : 'healthy';

  return {
    coolingProfile: profile,
    thermalLoadW,
    thermalBudgetW,
    thermalHeadroomW: thermalBudgetW - thermalLoadW,
    thermalPressure,
    thermalStatus,
    thermalBurstThrottleFactor,
    thermalSustainedThrottleFactor,
  };
}

function interfaceGen(drive) {
  return drive.interfaceInfo.generation;
}

function isDramless(drive) {
  return !drive.dramCacheMB || drive.dramCacheMB <= 0;
}

function estimateSustainedWriteMBs(drive) {
  if (drive.sustainedWriteMBs) return drive.sustainedWriteMBs;

  const gen = interfaceGen(drive);
  const qlc = drive.nandType === 'QLC';
  const dramless = isDramless(drive);
  let factor;

  if (drive.interfaceInfo.kind === 'sata') {
    factor = qlc ? 0.35 : dramless ? 0.65 : 0.85;
  } else {
    factor = qlc ? 0.08 : dramless ? 0.18 : gen >= 5 ? 0.28 : 0.26;
  }

  const estimate = drive.seqWriteMBs * factor;
  if (drive.interfaceInfo.kind === 'sata') {
    return Math.max(120, Math.min(drive.seqWriteMBs, estimate));
  }
  return Math.max(500, Math.min(drive.seqWriteMBs, estimate));
}

function estimateSlcCacheGB(drive) {
  if (drive.slcCacheGB) return drive.slcCacheGB;

  const gen = interfaceGen(drive);
  const qlc = drive.nandType === 'QLC';
  const dramless = isDramless(drive);
  let perTB;
  let cap;

  if (drive.interfaceInfo.kind === 'sata') {
    perTB = qlc ? 20 : 35;
    cap = qlc ? 160 : 220;
  } else if (qlc) {
    perTB = 70;
    cap = 350;
  } else {
    perTB = dramless ? 55 : gen >= 5 ? 120 : 95;
    cap = dramless ? 280 : gen >= 5 ? 700 : 520;
  }

  return Math.min(cap, Math.max(16, drive.capacityTB * perTB));
}

function estimateLowQueueReadIOPS(drive) {
  if (drive.lowQueueReadIOPS) return drive.lowQueueReadIOPS;
  const qlc = drive.nandType === 'QLC';
  const dramless = isDramless(drive);
  const factor = drive.interfaceInfo.kind === 'sata'
    ? (qlc ? 0.34 : dramless ? 0.38 : 0.48)
    : (qlc ? 0.13 : dramless ? 0.18 : 0.22);
  return Math.round(drive.random4KReadIOPS * factor);
}

function estimateReadP99Ms(drive) {
  if (drive.p99ReadMs) return drive.p99ReadMs;
  if (drive.interfaceInfo.kind === 'sata') {
    return (drive.nandType === 'QLC' ? 9.0 : 6.0) + (isDramless(drive) ? 1.5 : 0);
  }
  const gen = interfaceGen(drive);
  return (gen >= 5 ? 1.1 : 1.6) + (drive.nandType === 'QLC' ? 1.6 : 0) + (isDramless(drive) ? 0.5 : 0);
}

function estimateDriveAfr(drive) {
  if (drive.afrPct) return drive.afrPct / 100;
  let afr = DEFAULT_CONSUMER_AFR;
  if (drive.nandType === 'QLC') afr += 0.003;
  if (isDramless(drive)) afr += 0.002;
  return afr;
}

function degradedRiskMembers(mode, driveCount) {
  if (mode === 'RAID5') return Math.max(0, driveCount - 1);
  if (mode === 'RAID1' || mode === 'RAID10') return driveCount >= 2 ? 1 : 0;
  return 0;
}

export function createState(catalog) {
  return {
    // Catalogs
    catalog,
    drives: catalog.drives,
    serverCatalog: catalog.servers,
    moduleCatalog: catalog.modules,
    workloadCatalog: catalog.workloads,
    retailConsumerDrives: catalog.retailConsumerDrives,

    // Selected config
    server: null,
    activeBayConfig: null,   // for servers with multiple bay configs (R7725)
    raidMode: 'JBOD',
    networkGbpsOverride: null,
    coolingProfile: DEFAULT_COOLING_PROFILE,
    fillStrategy: 'use-case',
    fillDriveId: null,
    bays: [],                // { drive: driveObj | null, bayIndex, source: 'chassis'|'module', interfaceType, formFactor }
    modules: [],             // installed expansion modules
    workload: null,          // selected workload profile

    // UI state
    hoveredBay: -1,
    selectedBay: -1,
    dragDrive: null,
    dragStart: null,
    paletteDragging: false,
    hoverCard: { visible: false, drive: null, bay: null, clientX: 0, clientY: 0 },
    canvasCursor: 'default',
    leftPanelOpen: true,
    needsShellRender: true,
    needsFullUiRender: true,
    needsControlRender: true,
    needsCanvasRender: true,
    needsCanvasChromeRender: true,
    needsHoverRender: true,
  };
}

// Build bays array from server + active bay config + installed modules
export function buildBays(server, activeBayConfig, modules) {
  const bays = [];
  if (!server) return bays;

  // Get bay specs — use active config if server has bayConfigs
  let baySpecs;
  if (activeBayConfig && server.bayConfigs) {
    const config = server.bayConfigs.find(c => c.id === activeBayConfig);
    baySpecs = config ? config.bays : server.bays;
  } else {
    baySpecs = server.bays;
  }

  // Chassis bays
  let idx = 0;
  for (const spec of baySpecs) {
    for (let i = 0; i < spec.count; i++) {
      bays.push({
        drive: null,
        bayIndex: idx++,
        source: 'chassis',
        formFactor: spec.formFactor,
        interface: spec.interface,
        interfaceInfo: spec.interfaceInfo,
        hotSwap: spec.hotSwap,
        lanesPerDrive: spec.lanesPerDrive || 0,
        perDriveMaxMBs: spec.perDriveMaxMBs || 0,
      });
    }
  }

  // Expansion module bays
  for (const mod of modules) {
    if (mod.provides) {
      for (let i = 0; i < mod.provides.count; i++) {
        bays.push({
          drive: null,
          bayIndex: idx++,
          source: 'module',
          moduleId: mod.id,
          moduleName: mod.name,
          formFactor: mod.provides.formFactor,
          interface: mod.provides.interface,
          interfaceInfo: mod.provides.interfaceInfo,
          hotSwap: mod.provides.hotSwap,
          lanesPerDrive: mod.provides.lanesPerDrive || 0,
          perDriveMaxMBs: mod.provides.perDriveMaxMBs || 0,
        });
      }
    }
  }

  return bays;
}

export function driveCompatWithBays(drive, bays) {
  for (let i = 0; i < bays.length; i++) {
    if (driveCompatibleWithBay(drive, bays[i])) return true;
  }
  return false;
}

export function baySpecsRetailCompatible(baySpecs, retailDrives) {
  if (baySpecs.length === 0) return false;
  for (let i = 0; i < baySpecs.length; i++) {
    let hasMatch = false;
    for (let j = 0; j < retailDrives.length; j++) {
      if (driveCompatibleWithBay(retailDrives[j], baySpecs[i])) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) return false;
  }
  return true;
}

export function supportedBayConfigs(server, retailDrives) {
  if (!server?.bayConfigs) return [];
  return server.bayConfigs.filter(config => baySpecsRetailCompatible(config.bays, retailDrives));
}

export function defaultBayConfig(server, retailDrives) {
  if (!server?.bayConfigs) return null;
  return supportedBayConfigs(server, retailDrives)[0]?.id || null;
}

export function visibleServers(state) {
  return state.serverCatalog.filter(server => {
    if (server.bayConfigs) return supportedBayConfigs(server, state.retailConsumerDrives).length > 0;
    return baySpecsRetailCompatible(server.bays, state.retailConsumerDrives);
  });
}

export function rebuildBays(state) {
  state.bays = buildBays(state.server, state.activeBayConfig, state.modules);
  state.selectedBay = -1;
  state.hoveredBay = -1;
  state.needsCanvasRender = true;
  state.needsFullUiRender = true;
}

export function buildSignature(state) {
  const bayDrives = state.bays.map(b => b.drive?.id || '').join(',');
  const modules = state.modules.map(m => m.id).join(',');
  return [
    state.server?.id || '',
    state.activeBayConfig || '',
    state.raidMode || '',
    state.networkGbpsOverride ?? '',
    state.coolingProfile || '',
    state.fillStrategy || '',
    state.fillDriveId || '',
    state.workload?.id || '',
    modules,
    bayDrives,
  ].join('|');
}

export function findCompatibleBay(state, drive, startIndex = 0) {
  if (!drive) return -1;
  const from = Math.max(0, startIndex);
  let bay = state.bays.findIndex((b, i) =>
    i >= from && !b.drive && driveCompatibleWithBay(drive, b)
  );
  if (bay >= 0) return bay;
  bay = state.bays.findIndex(b => !b.drive && driveCompatibleWithBay(drive, b));
  return bay;
}

export function placeDriveInBay(state, drive, bayIndex) {
  if (!drive || bayIndex < 0 || !state.bays[bayIndex]) return false;
  const bay = state.bays[bayIndex];
  if (!driveCompatibleWithBay(drive, bay)) return false;

  bay.drive = drive;
  state.selectedBay = bayIndex;
  state.hoveredBay = bayIndex;
  state.dragDrive = null;
  state.needsCanvasRender = true;
  state.needsFullUiRender = true;
  return true;
}

export function compatibleDrivesForBay(state, bay) {
  return state.retailConsumerDrives.filter(drive => driveCompatibleWithBay(drive, bay));
}

function estimateFillSustainedMBs(drive) {
  if (drive.sustainedWriteMBs) return drive.sustainedWriteMBs;
  if (drive.interfaceInfo.kind === 'sata') {
    const factor = drive.nandType === 'QLC' ? 0.35 : (!drive.dramCacheMB ? 0.65 : 0.85);
    return Math.max(120, Math.min(drive.seqWriteMBs, drive.seqWriteMBs * factor));
  }
  const gen = drive.interfaceInfo.generation || 4;
  const factor = drive.nandType === 'QLC' ? 0.08 : (!drive.dramCacheMB ? 0.18 : gen >= 5 ? 0.28 : 0.26);
  return Math.max(500, Math.min(drive.seqWriteMBs, drive.seqWriteMBs * factor));
}

function fillSortValue(state, drive, strategy, candidates) {
  const costPerTB = drive.pricePerTB;
  const sustained = estimateFillSustainedMBs(drive);
  const max = (getValue) => Math.max(1, ...candidates.map(getValue));
  const min = (getValue) => Math.min(...candidates.map(getValue).filter(v => Number.isFinite(v) && v > 0));
  const norm = (value, maxValue) => maxValue > 0 ? value / maxValue : 0;

  switch (strategy) {
    case 'specific':
      return drive.id === state.fillDriveId ? 1 : -Infinity;
    case 'value':
      return min(d => d.pricePerTB) / costPerTB;
    case 'capacity':
      return drive.capacityTB + (1 / costPerTB);
    case 'sustained-write':
      return sustained + (drive.dwpd || 0) * 100;
    case 'random-read':
      return (drive.random4KReadIOPS || 0) + (drive.interfaceInfo.kind === 'sata' ? 0 : 50000);
    case 'endurance':
      return (drive.dwpd || 0) * 1000000 + (drive.tbw || 0);
    case 'use-case':
    default:
      break;
  }

  const priorities = state.workload?.priorities || {};
  const weight = (key, fallback) => ({
    critical: 4,
    high: 3,
    moderate: 2,
    low: 1,
  }[priorities[key]] || fallback);
  const weights = {
    value: weight('costPerTB', 2.5),
    capacity: weight('capacity', 1.5),
    sustained: weight('seqWrite', 1),
    random: weight('randomRead', 1),
    endurance: weight('endurance', 1),
    latency: weight('latency', 1),
  };
  const qlcSensitive = weights.sustained + weights.endurance + weights.latency >= 5;
  const qlcFactor = drive.nandType === 'QLC' ? (qlcSensitive ? 0.72 : 0.9) : 1;
  const nvmeFactor = drive.interfaceInfo.kind === 'sata' ? 0.82 : 1;

  const score =
    weights.value * (min(d => d.pricePerTB) / costPerTB) +
    weights.capacity * norm(drive.capacityTB, max(d => d.capacityTB)) +
    weights.sustained * norm(sustained, max(d => estimateFillSustainedMBs(d))) +
    weights.random * norm(drive.random4KReadIOPS || 0, max(d => d.random4KReadIOPS || 0)) +
    weights.endurance * norm(drive.dwpd || 0, max(d => d.dwpd || 0)) +
    weights.latency * norm(drive.random4KReadIOPS || 0, max(d => d.random4KReadIOPS || 0)) * nvmeFactor;

  return score * qlcFactor;
}

export function pickFillDriveForBay(state, bay) {
  const candidates = compatibleDrivesForBay(state, bay);
  if (candidates.length === 0) return null;
  const strategy = state.fillStrategy || 'use-case';
  if (strategy === 'specific') {
    return candidates.find(d => d.id === state.fillDriveId) || null;
  }
  const ranked = [...candidates].sort((a, b) => {
    const diff = fillSortValue(state, b, strategy, candidates) - fillSortValue(state, a, strategy, candidates);
    if (diff !== 0) return diff;
    return a.pricePerTB - b.pricePerTB;
  });
  return ranked[0] || null;
}

export function fillEmptyBays(state) {
  let filled = 0;
  for (let i = 0; i < state.bays.length; i++) {
    const bay = state.bays[i];
    if (bay.drive) continue;
    const drive = pickFillDriveForBay(state, bay);
    if (drive) {
      bay.drive = drive;
      filled += 1;
    }
  }
  if (filled > 0) {
    state.needsCanvasRender = true;
    state.needsFullUiRender = true;
  }
  return filled;
}

export function clearBays(state) {
  let changed = false;
  for (let i = 0; i < state.bays.length; i++) {
    if (state.bays[i].drive) changed = true;
    state.bays[i].drive = null;
  }
  state.selectedBay = -1;
  if (changed) {
    state.needsCanvasRender = true;
    state.needsFullUiRender = true;
  }
}

export function computeStats(state) {
  const filled = state.bays.filter(b => b.drive !== null);
  const driveCount = filled.length;

  if (driveCount === 0 || !state.server) {
    return {
      driveCount: 0, rawTB: 0, usableTB: 0, totalCost: 0, costPerUsableTB: 0,
      aggSeqReadGBs: 0, aggSeqWriteGBs: 0, realisticReadGBs: 0, realisticWriteGBs: 0,
      chassisMaxBWGBs: 0, busSaturated: false, totalPowerW: 0, rebuildTimeHours: 0, rebuildDegraded: false, rebuildWarning: '',
      raidValid: false, raidError: '',
      vendorConcentration: {}, nandVendorConcentration: {},
      driveCost: 0, chassisCost: 0, moduleCost: 0,
      costPerUsableTBYear5: 0,
      chassisBays: 0, moduleBays: 0,
      unpricedDrives: 0, priceIncomplete: false,
      realisticSustainedWriteGBs: 0, writeCliffRatio: 1, slcCacheGB: 0, cacheExhaustMinutes: 0,
      lowQueueReadIOPS: 0, estimatedP99ReadMs: 0,
      drivePotentialReadGBs: 0, platformReadGBs: 0, bottleneckReadGBs: 0,
      energyCostPerYear: 0, electricityUSDPerKWh: DEFAULT_ELECTRICITY_USD_KWH,
      expectedFailuresPerYear: 0, rebuildSecondFailureRiskPct: 0, ureDuringRebuildRiskPct: 0,
      controllerVendorConcentration: {}, networkGbps: 0, networkLimitGBs: 0, networkBottleneck: false,
      coolingProfile: DEFAULT_COOLING_PROFILE, thermalLoadW: 0, thermalBudgetW: 0, thermalHeadroomW: 0,
      thermalPressure: 0, thermalStatus: 'empty', thermalThrottleFactor: 1, thermalBurstThrottleFactor: 1,
    };
  }

  const raid = RAID_MODES[state.raidMode];
  const server = state.server;

  // RAID validity
  let raidValid = driveCount >= raid.minDrives;
  let raidError = '';
  if (!raidValid) {
    raidError = `${raid.name} requires at least ${raid.minDrives} drives`;
  }
  if (state.raidMode === 'RAID10' && driveCount % 2 !== 0) {
    raidValid = false;
    raidError = 'RAID 10 requires an even number of drives';
  }

  // Capacity
  const rawTB = filled.reduce((s, b) => s + b.drive.capacityTB, 0);
  let usableRatio = raid.usableRatio;
  if (state.raidMode === 'RAID5') {
    usableRatio = (driveCount - 1) / driveCount;
  }
  const usableTB = rawTB * (usableRatio ?? 1);

  // Cost breakdown
  const driveCost = filled.reduce((s, b) => s + b.drive.priceUSD, 0);
  const chassisCost = server.priceUSD || 0;
  const moduleCost = state.modules.reduce((s, m) => s + (m.priceUSD || 0), 0);
  const totalCost = driveCost + chassisCost + moduleCost;
  const costPerUsableTB = usableTB > 0 ? totalCost / usableTB : 0;

  // TCO amortization — drives have shorter replacement cycle than chassis
  // Drives: 3.5yr (warranty-aligned), chassis + expansion: 5yr
  const DRIVE_AMORT_YEARS = 3.5;
  const CHASSIS_AMORT_YEARS = 5;
  const annualCost = (driveCost / DRIVE_AMORT_YEARS) + ((chassisCost + moduleCost) / CHASSIS_AMORT_YEARS);
  const costPerUsableTBYear5 = usableTB > 0 ? annualCost / usableTB : 0;

  // Price completeness — count drives with priceUSD === 0 (TBD)
  const unpricedDrives = filled.filter(b => !b.drive.priceUSD).length;
  const priceIncomplete = unpricedDrives > 0;

  // Bandwidth — compute per source
  // Chassis bays use server bandwidth limits
  // Module bays use module's performance cap (affected by host PCIe gen)
  let aggSeqReadGBs = 0;
  let aggSeqWriteGBs = 0;

  const chassisFilled = filled.filter(b => b.source === 'chassis');
  const moduleFilled = filled.filter(b => b.source === 'module');

  // Chassis drives — SATA uses per-drive dedicated links capped by controller.
  const bayReadMBs = (bay) => bay.perDriveMaxMBs > 0
    ? Math.min(bay.drive.seqReadMBs, bay.perDriveMaxMBs)
    : bay.drive.seqReadMBs;
  const bayPeakWriteMBs = (bay) => bay.perDriveMaxMBs > 0
    ? Math.min(bay.drive.seqWriteMBs, bay.perDriveMaxMBs)
    : bay.drive.seqWriteMBs;
  const baySustainedWriteMBs = (bay) => bay.perDriveMaxMBs > 0
    ? Math.min(estimateSustainedWriteMBs(bay.drive), bay.perDriveMaxMBs)
    : estimateSustainedWriteMBs(bay.drive);

  let chassisReadGBs = chassisFilled.reduce((s, b) => s + bayReadMBs(b) / 1000, 0);
  let chassisWriteGBs = chassisFilled.reduce((s, b) => s + bayPeakWriteMBs(b) / 1000, 0);
  let chassisSustainedWriteGBs = chassisFilled.reduce((s, b) => s + baySustainedWriteMBs(b) / 1000, 0);

  // Determine chassis max BW (may vary by bay config)
  let chassisMaxBW = server.maxBandwidthGBs;
  if (server.maxBandwidthByConfig && state.activeBayConfig) {
    chassisMaxBW = server.maxBandwidthByConfig[state.activeBayConfig] || chassisMaxBW;
  }

  const cappedChassisRead = Math.min(chassisReadGBs, chassisMaxBW);
  const cappedChassisWrite = Math.min(chassisWriteGBs, chassisMaxBW);
  const cappedChassisSustainedWrite = Math.min(chassisSustainedWriteGBs, chassisMaxBW);

  aggSeqReadGBs = cappedChassisRead;
  aggSeqWriteGBs = cappedChassisWrite;
  let aggSustainedWriteGBs = cappedChassisSustainedWrite;
  let modulePotentialReadGBs = 0;

  // Module drives — capped by module's performance at host PCIe gen
  for (const mod of state.modules) {
    const modDrives = moduleFilled.filter(b => b.moduleId === mod.id);
    if (modDrives.length === 0) continue;
    const modReadGBs = modDrives.reduce((s, b) => s + b.drive.seqReadMBs / 1000, 0);
    const modWriteGBs = modDrives.reduce((s, b) => s + b.drive.seqWriteMBs / 1000, 0);
    const modSustainedWriteGBs = modDrives.reduce((s, b) => s + estimateSustainedWriteMBs(b.drive) / 1000, 0);
    modulePotentialReadGBs += modReadGBs;

    let modMaxBW = mod.maxSeqReadGBs || Infinity;
    // Cap by host PCIe gen
    if (mod.performanceByHostGen && server.pcieGen) {
      const perf = mod.performanceByHostGen[server.pcieGen];
      if (perf) modMaxBW = perf.maxGBs;
    }

    aggSeqReadGBs += Math.min(modReadGBs, modMaxBW);
    aggSeqWriteGBs += Math.min(modWriteGBs, modMaxBW);
    aggSustainedWriteGBs += Math.min(modSustainedWriteGBs, modMaxBW);
  }

  const preThermalReadGBs = aggSeqReadGBs * server.realisticBandwidthRatio;
  const preThermalWriteGBs = aggSeqWriteGBs * server.realisticBandwidthRatio * raid.raidWritePenalty;
  const preThermalSustainedWriteGBs = aggSustainedWriteGBs * server.realisticBandwidthRatio * raid.raidWritePenalty;
  const busSaturated = chassisReadGBs > chassisMaxBW;

  // Power
  const drivePower = filled.reduce((s, b) => s + b.drive.powerW, 0);
  const modulePower = state.modules.reduce((s, m) => s + (m.thermalLoadW || 0), 0);
  const totalPowerW = server.powerBaseW + drivePower + modulePower;
  const electricityUSDPerKWh = state.workload?.modelAssumptions?.electricityUSDPerKWh || DEFAULT_ELECTRICITY_USD_KWH;
  const energyCostPerYear = (totalPowerW / 1000) * 24 * 365 * electricityUSDPerKWh;

  const thermal = deriveThermalModel(state, drivePower, modulePower);
  const drivePotentialReadGBs = (chassisReadGBs + modulePotentialReadGBs) * server.realisticBandwidthRatio * thermal.thermalBurstThrottleFactor;
  const realisticReadGBs = preThermalReadGBs * thermal.thermalBurstThrottleFactor;
  const realisticWriteGBs = preThermalWriteGBs * thermal.thermalBurstThrottleFactor;
  const realisticSustainedWriteGBs = preThermalSustainedWriteGBs * thermal.thermalSustainedThrottleFactor;

  // Consumer SSD realism approximations. These are planning signals, not lab measurements.
  const slcCacheGB = filled.reduce((s, b) => s + estimateSlcCacheGB(b.drive), 0);
  const writeCliffRatio = realisticWriteGBs > 0 ? realisticSustainedWriteGBs / realisticWriteGBs : 1;
  const cacheFillGBs = Math.max(0, realisticWriteGBs - realisticSustainedWriteGBs);
  const cacheExhaustMinutes = cacheFillGBs > 0 ? slcCacheGB / cacheFillGBs / 60 : Infinity;
  const lowQueueReadIOPS = Math.round(
    filled.reduce((s, b) => s + estimateLowQueueReadIOPS(b.drive), 0) * thermal.thermalBurstThrottleFactor
  );
  const baseP99ReadMs = filled.length ? Math.max(...filled.map(b => estimateReadP99Ms(b.drive))) : 0;
  const estimatedP99ReadMs = baseP99ReadMs
    * (busSaturated ? 1.35 : 1)
    * (state.raidMode === 'RAID5' ? 1.15 : 1)
    * (1 + (1 - thermal.thermalBurstThrottleFactor) * 1.8);

  const networkOverride = state.networkGbpsOverride;
  const networkGbps = networkOverride === 'local'
    ? Infinity
    : Number.isFinite(networkOverride)
      ? networkOverride
      : state.workload?.modelAssumptions?.networkGbps || server.networkGbps || 25;
  const networkLimitGBs = Number.isFinite(networkGbps) ? (networkGbps / 8) * 0.92 : Infinity;
  const networkBottleneck = realisticReadGBs > networkLimitGBs * 1.15;
  const bottleneckReadGBs = Math.min(realisticReadGBs, networkLimitGBs);

  // Rebuild time — varies significantly by RAID mode
  let rebuildTimeHours = 0;
  let rebuildDegraded = false;
  let rebuildWarning = '';
  const maxDriveTB = driveCount > 0 ? Math.max(...filled.map(b => b.drive.capacityTB)) : 0;

  if (state.raidMode === 'RAID0' || state.raidMode === 'JBOD') {
    // No rebuild possible — data is lost on drive failure
    rebuildTimeHours = 0;
    rebuildWarning = state.raidMode === 'RAID0'
      ? 'RAID 0: Any drive failure destroys the entire array. No rebuild possible.'
      : 'JBOD: Failed drive data is lost. No rebuild.';
  } else if (state.raidMode === 'RAID10' || state.raidMode === 'RAID1') {
    // Mirror rebuild — isolated to mirror pair, ~200 MB/s (read one drive, write one)
    rebuildTimeHours = maxDriveTB * 1024 / (200 * 3.6);
    rebuildDegraded = state.raidMode === 'RAID10'; // RAID10: specific mirror pair is vulnerable
  } else if (state.raidMode === 'RAID5') {
    // Must read ALL remaining drives; parity computation slows things down
    // Baseline 60 MB/s, reduced by 20% for every 8 drives above 8
    let effectiveSpeed = 60;
    if (driveCount > 8) {
      const extraGroups = Math.floor((driveCount - 8) / 8);
      effectiveSpeed = effectiveSpeed * Math.pow(0.8, extraGroups);
    }
    rebuildTimeHours = maxDriveTB * 1024 / (effectiveSpeed * 3.6);
    rebuildDegraded = true; // Array is vulnerable during entire rebuild
  }

  const expectedFailuresPerYear = filled.reduce((s, b) => s + estimateDriveAfr(b.drive), 0);
  const rebuildWindowYears = rebuildTimeHours / (24 * 365);
  const riskMembers = degradedRiskMembers(state.raidMode, driveCount);
  const avgAfr = driveCount > 0 ? expectedFailuresPerYear / driveCount : DEFAULT_CONSUMER_AFR;
  const rebuildSecondFailureRiskPct = riskMembers > 0
    ? (1 - Math.exp(-riskMembers * avgAfr * rebuildWindowYears)) * 100
    : 0;
  const bitsReadDuringRebuild = state.raidMode === 'RAID5'
    ? Math.max(0, rawTB - maxDriveTB) * 8e12
    : maxDriveTB * 8e12;
  const ureDuringRebuildRiskPct = (state.raidMode === 'RAID5' || state.raidMode === 'RAID1' || state.raidMode === 'RAID10')
    ? (1 - Math.exp(-bitsReadDuringRebuild * DEFAULT_UBER)) * 100
    : 0;

  // Vendor concentration
  const vendorConcentration = {};
  const nandVendorConcentration = {};
  const controllerVendorConcentration = {};
  filled.forEach(b => {
    vendorConcentration[b.drive.vendor] = (vendorConcentration[b.drive.vendor] || 0) + 1;
    nandVendorConcentration[b.drive.nandVendor] = (nandVendorConcentration[b.drive.nandVendor] || 0) + 1;
    controllerVendorConcentration[b.drive.controllerVendor] = (controllerVendorConcentration[b.drive.controllerVendor] || 0) + 1;
  });

  // Bay counts by source
  const chassisBays = state.bays.filter(b => b.source === 'chassis').length;
  const moduleBays = state.bays.filter(b => b.source === 'module').length;

  return {
    driveCount, rawTB, usableTB,
    totalCost, driveCost, chassisCost, moduleCost,
    costPerUsableTB, costPerUsableTBYear5,
    aggSeqReadGBs, aggSeqWriteGBs,
    realisticReadGBs, realisticWriteGBs,
    realisticSustainedWriteGBs, writeCliffRatio, slcCacheGB, cacheExhaustMinutes,
    lowQueueReadIOPS, estimatedP99ReadMs,
    drivePotentialReadGBs,
    platformReadGBs: realisticReadGBs,
    bottleneckReadGBs,
    chassisMaxBWGBs: chassisMaxBW,
    busSaturated, totalPowerW, energyCostPerYear, electricityUSDPerKWh,
    coolingProfile: thermal.coolingProfile,
    thermalLoadW: thermal.thermalLoadW,
    thermalBudgetW: thermal.thermalBudgetW,
    thermalHeadroomW: thermal.thermalHeadroomW,
    thermalPressure: thermal.thermalPressure,
    thermalStatus: thermal.thermalStatus,
    thermalThrottleFactor: thermal.thermalSustainedThrottleFactor,
    thermalBurstThrottleFactor: thermal.thermalBurstThrottleFactor,
    rebuildTimeHours, rebuildDegraded, rebuildWarning,
    raidValid, raidError,
    expectedFailuresPerYear, rebuildSecondFailureRiskPct, ureDuringRebuildRiskPct,
    vendorConcentration, nandVendorConcentration, controllerVendorConcentration,
    chassisBays, moduleBays,
    unpricedDrives, priceIncomplete,
    networkGbps, networkLimitGBs, networkBottleneck,
  };
}
