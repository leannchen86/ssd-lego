// @ts-check
// Shared JSDoc types. This file intentionally has no runtime state.

/**
 * @typedef {{ kind: 'sata', generation: 0, label: string, shortLabel: 'SATA', canvasLabel: 'SATA' }
 * | { kind: 'nvme', generation: number, label: string, shortLabel: string, canvasLabel: string }} StorageInterface
 */

/**
 * @typedef {object} Drive
 * @property {string} id
 * @property {string} name
 * @property {string} displayName
 * @property {string} capacityLabel
 * @property {string} vendor
 * @property {number} capacityTB
 * @property {string} interface
 * @property {StorageInterface} interfaceInfo
 * @property {string} formFactor
 * @property {number} priceUSD
 * @property {number} pricePerTB
 * @property {number} seqReadMBs
 * @property {number} seqWriteMBs
 * @property {number} random4KReadIOPS
 * @property {number} random4KWriteIOPS
 * @property {string} nandType
 * @property {string} nandVendor
 * @property {string} controller
 * @property {string} controllerVendor
 * @property {number} dramCacheMB
 * @property {number} tbw
 * @property {number} dwpd
 * @property {number} powerW
 * @property {string} category
 * @property {string} color
 * @property {boolean=} middlewareRequired
 * @property {number=} sustainedWriteMBs
 * @property {number=} slcCacheGB
 * @property {number=} lowQueueReadIOPS
 * @property {number=} p99ReadMs
 * @property {number=} afrPct
 */

/**
 * @typedef {object} BaySpec
 * @property {number} count
 * @property {string} formFactor
 * @property {string} interface
 * @property {StorageInterface} interfaceInfo
 * @property {number} lanesPerDrive
 * @property {number} perDriveMaxMBs
 * @property {boolean} hotSwap
 * @property {boolean=} dedicatedLanes
 * @property {string=} note
 */

/**
 * @typedef {object} Bay
 * @property {Drive | null} drive
 * @property {number} bayIndex
 * @property {'chassis' | 'module'} source
 * @property {string=} moduleId
 * @property {string=} moduleName
 * @property {string} formFactor
 * @property {string} interface
 * @property {StorageInterface} interfaceInfo
 * @property {boolean} hotSwap
 * @property {number} lanesPerDrive
 * @property {number} perDriveMaxMBs
 */

/**
 * @typedef {object} BayConfig
 * @property {string} id
 * @property {string} name
 * @property {BaySpec[]} bays
 */

/**
 * @typedef {object} Server
 * @property {string} id
 * @property {string} name
 * @property {string} vendor
 * @property {string} formUnit
 * @property {string} generation
 * @property {boolean} owned
 * @property {number} pcieGen
 * @property {BaySpec[]} bays
 * @property {BayConfig[]=} bayConfigs
 * @property {Array<{type: string, gen: number, occupied: boolean, note?: string}>} pcieSlotsRear
 * @property {number} maxBandwidthGBs
 * @property {Record<string, number>=} maxBandwidthByConfig
 * @property {number} realisticBandwidthRatio
 * @property {number} priceUSD
 * @property {number} powerBaseW
 * @property {string} thermalDesign
 */

/**
 * @typedef {object} Module
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {{slotType: string, minPcieGen: number, optimalPcieGen: number}} requires
 * @property {(BaySpec & { count: number })=} provides
 * @property {number=} thermalLoadW
 * @property {number=} priceUSD
 * @property {number=} maxSeqReadGBs
 * @property {Record<string, {maxGBs: number, note: string}>=} performanceByHostGen
 * @property {string=} whyRecommended
 */

/**
 * @typedef {object} Workload
 * @property {string} id
 * @property {string} name
 * @property {Record<string, number | string>=} requirements
 * @property {Record<string, number>=} modelAssumptions
 * @property {Record<string, string>=} priorities
 * @property {Array<{condition: string, message: string}>=} antiPatterns
 */

/**
 * @typedef {object} Catalog
 * @property {Drive[]} drives
 * @property {Map<string, Drive>} drivesById
 * @property {Drive[]} retailConsumerDrives
 * @property {Server[]} servers
 * @property {Module[]} modules
 * @property {Workload[]} workloads
 */

export {};
