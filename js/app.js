// app.js — ordered input, state derivation, canvas/DOM projection, scheduling
import { loadCatalog } from './catalog.js?v=46';
import {
  buildSignature,
  clearBays,
  computeStats,
  createState,
  defaultBayConfig,
  driveCompatibleWithBay,
  driveCompatWithBays,
  fillEmptyBays,
  findCompatibleBay,
  placeDriveInBay,
  rebuildBays,
} from './state.js?v=46';
import { RackRenderer } from './renderer.js?v=46';
import { UI } from './ui.js?v=46';
import { generateInsights, computeWorkloadFitness } from './insights.js?v=46';

const DRAG_THRESHOLD_PX = 6;

async function main() {
  const catalog = await loadCatalog();
  const state = createState(catalog);
  restoreSidebarState(state);

  const canvas = document.getElementById('rack-canvas');
  const renderer = new RackRenderer(canvas);
  const input = createInputState();
  let lastBuildSignature = '';
  let scheduledRaf = null;
  let latestStats = computeStats(state);

  const dispatch = (action) => {
    input.actions.push(action);
    scheduleRender();
  };
  const ui = new UI(state, {
    generateInsights,
    computeFitness: computeWorkloadFitness,
    dispatch,
  });

  function scheduleRender() {
    if (scheduledRaf !== null) return;
    scheduledRaf = requestAnimationFrame(function renderAndMaybeScheduleAnotherRender(now) {
      scheduledRaf = null;
      const stillAnimating = render(now);
      if (stillAnimating) scheduleRender();
    });
  }

  function canvasRect() {
    return canvas.getBoundingClientRect();
  }

  function bayAtClientPoint(clientX, clientY) {
    const rect = canvasRect();
    const inside =
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;
    if (!inside) return -1;
    return renderer.hitTest(clientX - rect.left, clientY - rect.top);
  }

  function canvasContainsClientPoint(clientX, clientY) {
    const rect = canvasRect();
    return (
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    );
  }

  function targetBayFromPoint(drive, clientX, clientY) {
    const exactBay = bayAtClientPoint(clientX, clientY);
    if (exactBay >= 0) return exactBay;
    return canvasContainsClientPoint(clientX, clientY) ? findCompatibleBay(state, drive) : -1;
  }

  function placeDriveFromPoint(drive, clientX, clientY) {
    if (!drive) return false;
    const exactBay = bayAtClientPoint(clientX, clientY);
    if (placeDriveInBay(state, drive, exactBay)) return true;
    if (!canvasContainsClientPoint(clientX, clientY)) return false;
    return placeDriveInBay(state, drive, findCompatibleBay(state, drive));
  }

  function setHoveredBay(nextBay) {
    if (state.hoveredBay === nextBay) return;
    state.hoveredBay = nextBay;
    state.needsCanvasRender = true;
  }

  function hideDriveHover() {
    if (!state.hoverCard.visible && state.hoverCard.drive === null) return;
    state.hoverCard = { visible: false, drive: null, bay: null, clientX: 0, clientY: 0 };
    state.needsHoverRender = true;
  }

  function showDriveHover(drive, bay, clientX, clientY) {
    const current = state.hoverCard;
    if (
      current.visible &&
      current.drive === drive &&
      current.bay === bay &&
      current.clientX === clientX &&
      current.clientY === clientY
    ) {
      return;
    }
    state.hoverCard = { visible: true, drive, bay, clientX, clientY };
    state.needsHoverRender = true;
  }

  function syncFillDriveSelection() {
    const drives = state.retailConsumerDrives
      .filter(drive => !state.server || driveCompatWithBays(drive, state.bays))
      .sort((a, b) =>
        a.formFactor.localeCompare(b.formFactor) ||
        a.interface.localeCompare(b.interface) ||
        a.pricePerTB - b.pricePerTB
      );
    const current = drives.some(drive => drive.id === state.fillDriveId)
      ? state.fillDriveId
      : drives[0]?.id || null;
    if (state.fillDriveId !== current) {
      state.fillDriveId = current;
      state.needsControlRender = true;
      state.needsFullUiRender = true;
    }
  }

  function handleAction(action) {
    switch (action.type) {
      case 'server-change': {
        const server = state.serverCatalog.find(s => s.id === action.serverId) || null;
        state.server = server;
        state.modules = [];
        state.activeBayConfig = defaultBayConfig(server, state.retailConsumerDrives);
        rebuildBays(state);
        syncFillDriveSelection();
        state.needsControlRender = true;
        break;
      }
      case 'bay-config-change':
        state.activeBayConfig = action.configId;
        rebuildBays(state);
        syncFillDriveSelection();
        state.needsControlRender = true;
        break;
      case 'raid-change':
        state.raidMode = action.raidMode;
        state.needsFullUiRender = true;
        break;
      case 'workload-change':
        state.workload = state.workloadCatalog.find(w => w.id === action.workloadId) || null;
        syncFillDriveSelection();
        state.needsControlRender = true;
        state.needsFullUiRender = true;
        break;
      case 'network-change':
        state.networkGbpsOverride = action.value === 'auto'
          ? null
          : action.value === 'local'
            ? 'local'
            : Number(action.value);
        state.needsFullUiRender = true;
        state.needsControlRender = true;
        break;
      case 'cooling-change':
        state.coolingProfile = action.coolingProfile;
        state.needsFullUiRender = true;
        break;
      case 'fill-strategy-change':
        state.fillStrategy = action.strategy;
        syncFillDriveSelection();
        state.needsControlRender = true;
        state.needsFullUiRender = true;
        break;
      case 'fill-drive-change':
        state.fillDriveId = action.driveId || null;
        state.needsFullUiRender = true;
        state.needsControlRender = true;
        break;
      case 'fill-all':
        if (state.server) fillEmptyBays(state);
        break;
      case 'clear-all':
        clearBays(state);
        break;
      case 'palette-click': {
        const drive = state.catalog.drivesById.get(action.driveId);
        if (!drive) break;
        let bay = state.selectedBay;
        if (bay < 0 || !state.bays[bay]) bay = findCompatibleBay(state, drive);
        if (placeDriveInBay(state, drive, bay)) {
          const next = state.bays.findIndex((b, i) =>
            i > bay && !b.drive && driveCompatibleWithBay(drive, b)
          );
          state.selectedBay = next >= 0 ? next : -1;
        }
        break;
      }
      case 'palette-pointer-down': {
        const drive = state.catalog.drivesById.get(action.driveId);
        if (!drive) break;
        hideDriveHover();
        state.dragDrive = drive;
        state.dragStart = { x: action.clientX, y: action.clientY };
        state.paletteDragging = false;
        state.needsCanvasRender = true;
        break;
      }
      case 'palette-drag-start': {
        const drive = state.catalog.drivesById.get(action.driveId);
        if (!drive) break;
        hideDriveHover();
        state.dragDrive = drive;
        state.dragStart = { x: action.clientX, y: action.clientY };
        state.paletteDragging = true;
        state.needsCanvasRender = true;
        break;
      }
      case 'palette-hover':
        if (!state.dragDrive) {
          const drive = state.catalog.drivesById.get(action.driveId);
          if (drive) showDriveHover(drive, null, action.clientX, action.clientY);
        }
        break;
      case 'palette-hover-end':
      case 'hover-dismiss':
        hideDriveHover();
        break;
      case 'sidebar-toggle':
        state.leftPanelOpen = !state.leftPanelOpen;
        state.needsShellRender = true;
        try {
          localStorage.setItem('ssd-rack-sim.leftPanel.open', String(state.leftPanelOpen));
        } catch (_) {
          // Local storage is a convenience, not a data dependency.
        }
        break;
      default:
        break;
    }
  }

  function handleCanvasMove(event) {
    const bay = bayAtClientPoint(event.clientX, event.clientY);
    setHoveredBay(bay);
    state.canvasCursor = bay >= 0 ? 'pointer' : 'default';
    state.needsCanvasChromeRender = true;

    if (!state.dragDrive && bay >= 0 && state.bays[bay]?.drive) {
      showDriveHover(state.bays[bay].drive, state.bays[bay], event.clientX, event.clientY);
    } else {
      hideDriveHover();
    }
  }

  function handleCanvasClick(event) {
    const bay = bayAtClientPoint(event.clientX, event.clientY);
    if (bay >= 0) {
      state.selectedBay = bay;
    } else {
      state.selectedBay = -1;
      hideDriveHover();
    }
    state.needsFullUiRender = true;
    state.needsCanvasRender = true;
  }

  function handleCanvasContextMenu(event) {
    const bay = bayAtClientPoint(event.clientX, event.clientY);
    if (bay >= 0 && state.bays[bay]?.drive) {
      state.bays[bay].drive = null;
      state.selectedBay = -1;
      hideDriveHover();
      state.needsFullUiRender = true;
      state.needsCanvasRender = true;
    }
  }

  function handlePalettePointerMove(event) {
    if (!state.dragDrive || !state.dragStart) return;
    const distance = Math.hypot(event.clientX - state.dragStart.x, event.clientY - state.dragStart.y);
    if (distance > DRAG_THRESHOLD_PX) state.paletteDragging = true;
    if (state.paletteDragging) setHoveredBay(targetBayFromPoint(state.dragDrive, event.clientX, event.clientY));
  }

  function finishPaletteDrag(event) {
    if (!state.dragDrive || !state.dragStart) return;
    const distance = Math.hypot(event.clientX - state.dragStart.x, event.clientY - state.dragStart.y);
    const shouldPlace = state.paletteDragging || distance > DRAG_THRESHOLD_PX;
    if (shouldPlace) placeDriveFromPoint(state.dragDrive, event.clientX, event.clientY);
    state.dragDrive = null;
    state.dragStart = null;
    state.paletteDragging = false;
    hideDriveHover();
    state.needsCanvasRender = true;
  }

  function handleCanvasDragOver(event) {
    if (!state.dragDrive) return;
    setHoveredBay(targetBayFromPoint(state.dragDrive, event.clientX, event.clientY));
    hideDriveHover();
  }

  function handleCanvasDrop(event) {
    const driveId = event.driveId || '';
    const drive = state.catalog.drivesById.get(driveId) || state.dragDrive;
    hideDriveHover();
    placeDriveFromPoint(drive, event.clientX, event.clientY);
    state.dragDrive = null;
    state.dragStart = null;
    state.paletteDragging = false;
    state.needsCanvasRender = true;
  }

  function drainInput() {
    for (let i = 0; i < input.actions.length; i++) handleAction(input.actions[i]);
    input.actions.length = 0;

    if (input.canvasMove) handleCanvasMove(input.canvasMove);
    if (input.canvasLeave) {
      setHoveredBay(-1);
      state.canvasCursor = 'default';
      state.needsCanvasChromeRender = true;
      hideDriveHover();
    }
    if (input.canvasClick) handleCanvasClick(input.canvasClick);
    if (input.canvasContextMenu) handleCanvasContextMenu(input.canvasContextMenu);
    if (input.pointerMove) handlePalettePointerMove(input.pointerMove);
    if (input.pointerUp) finishPaletteDrag(input.pointerUp);
    if (input.canvasDragOver) handleCanvasDragOver(input.canvasDragOver);
    if (input.canvasDrop) handleCanvasDrop(input.canvasDrop);
    if (input.dragEnd && state.dragDrive) finishPaletteDrag(input.dragEnd);
    if (input.hoverDismiss) hideDriveHover();

    input.canvasMove = null;
    input.canvasLeave = false;
    input.canvasClick = null;
    input.canvasContextMenu = null;
    input.pointerMove = null;
    input.pointerUp = null;
    input.canvasDragOver = null;
    input.canvasDrop = null;
    input.dragEnd = null;
    input.hoverDismiss = false;
  }

  function render(now) {
    drainInput();
    syncFillDriveSelection();

    const signature = buildSignature(state);
    if (signature !== lastBuildSignature) {
      lastBuildSignature = signature;
      state.needsFullUiRender = true;
      state.needsControlRender = true;
      state.needsCanvasRender = true;
      latestStats = computeStats(state);
    } else if (state.needsFullUiRender) {
      latestStats = computeStats(state);
    }

    if (state.needsShellRender) ui.renderShell();
    if (state.needsControlRender) ui.renderControls(latestStats);
    if (state.needsFullUiRender) ui.refresh(latestStats);
    if (state.needsHoverRender) ui.renderHover();
    if (state.needsCanvasChromeRender) ui.renderCanvasChrome();
    if (state.needsCanvasRender || shouldAnimateCanvas()) renderer.render(state, latestStats, now);

    state.needsShellRender = false;
    state.needsControlRender = false;
    state.needsFullUiRender = false;
    state.needsHoverRender = false;
    state.needsCanvasChromeRender = false;
    state.needsCanvasRender = false;

    return shouldAnimateCanvas();
  }

  function shouldAnimateCanvas() {
    return state.bays.some(bay => bay.drive) || state.dragDrive !== null;
  }

  canvas.addEventListener('mousemove', (e) => {
    input.canvasMove = { clientX: e.clientX, clientY: e.clientY };
    scheduleRender();
  });
  canvas.addEventListener('mouseleave', () => {
    input.canvasLeave = true;
    scheduleRender();
  });
  canvas.addEventListener('click', (e) => {
    input.canvasClick = { clientX: e.clientX, clientY: e.clientY };
    scheduleRender();
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    input.canvasContextMenu = { clientX: e.clientX, clientY: e.clientY };
    scheduleRender();
  });
  canvas.addEventListener('dragover', (e) => {
    if (!state.dragDrive) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    input.canvasDragOver = { clientX: e.clientX, clientY: e.clientY };
    scheduleRender();
  });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    input.canvasDrop = {
      clientX: e.clientX,
      clientY: e.clientY,
      driveId: e.dataTransfer?.getData('application/x-drive-id') ||
        e.dataTransfer?.getData('text/plain') ||
        '',
    };
    scheduleRender();
  });
  canvas.addEventListener('dragleave', () => {
    input.canvasLeave = true;
    scheduleRender();
  });

  document.addEventListener('pointermove', (e) => {
    input.pointerMove = { clientX: e.clientX, clientY: e.clientY };
    scheduleRender();
  });
  document.addEventListener('pointerup', (e) => {
    input.pointerUp = { clientX: e.clientX, clientY: e.clientY };
    scheduleRender();
  });
  document.addEventListener('dragend', (e) => {
    input.dragEnd = { clientX: e.clientX, clientY: e.clientY };
    scheduleRender();
  }, true);
  document.addEventListener('mousemove', (e) => {
    const target = e.target;
    if (target instanceof Element && (target.closest('.drive-card') || target.id === 'rack-canvas')) return;
    input.hoverDismiss = true;
    scheduleRender();
  });
  document.addEventListener('scroll', () => {
    input.hoverDismiss = true;
    scheduleRender();
  }, true);

  render(document.timeline.currentTime || 0);
  if (shouldAnimateCanvas()) scheduleRender();
}

function createInputState() {
  return {
    actions: [],
    canvasMove: null,
    canvasLeave: false,
    canvasClick: null,
    canvasContextMenu: null,
    pointerMove: null,
    pointerUp: null,
    canvasDragOver: null,
    canvasDrop: null,
    dragEnd: null,
    hoverDismiss: false,
  };
}

function restoreSidebarState(state) {
  try {
    const stored = localStorage.getItem('ssd-rack-sim.leftPanel.open');
    if (stored !== null) state.leftPanelOpen = stored === 'true';
  } catch (_) {
    state.leftPanelOpen = true;
  }
}

main().catch(console.error);
