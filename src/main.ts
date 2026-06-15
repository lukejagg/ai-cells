import "./style.css";
import { computeShader, renderShader } from "./shaders";

const DEFAULT_GRID_SIZE = 500;
const MIN_GRID_SIZE = 64;
const MAX_GRID_SIZE = 2048;
const WORKGROUP_SIZE = 16;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 80;
const RANGE_SETTING_MIN = -5;
const RANGE_SETTING_MAX = 5;
const NORMALIZATION_TARGET_MAX = 5;

type NormalizationMode = "none" | "sum" | "l1" | "l2";

type Viewport = {
  centerX: number;
  centerY: number;
  zoom: number;
};

type SymmetrySettings = {
  vertical: boolean;
  horizontal: boolean;
  full: boolean;
  min: number;
  max: number;
  normalization: NormalizationMode;
  normalizationMagnitude: number;
};

type SymmetryGroup = {
  canonical: number;
  indexes: number[];
};

type ValueCellController = {
  element: HTMLButtonElement;
  set: (options: {
    value: number;
    min: number;
    max: number;
    disabled?: boolean;
  }) => void;
};

type GpuStateResources = {
  stateA: GPUBuffer;
  stateB: GPUBuffer;
  computeAB: GPUBindGroup;
  computeBA: GPUBindGroup;
  renderA: GPUBindGroup;
  renderB: GPUBindGroup;
};

const visibleStartFilter: Float32Array<ArrayBuffer> = new Float32Array([
  0.0, 0.03, 0.0,
  -0.03, 0.995, 0.03,
  0.0, -0.03, 0.0,
]);
const DISPLAY_FILTER_INDEXES = [8, 7, 6, 5, 4, 3, 2, 1, 0] as const;
const DISPLAY_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

const canvas = queryRequired<HTMLCanvasElement>("#automata-canvas");
const errorPanel = queryRequired<HTMLDivElement>("#error-panel");
const stepsInput = queryRequired<HTMLInputElement>("#steps-input");
const stepsOutput = queryRequired<HTMLOutputElement>("#steps-output");
const settingsButton = queryRequired<HTMLButtonElement>("#settings-button");
const settingsPanel = queryRequired<HTMLElement>("#settings-panel");
const toolbarShell = queryRequired<HTMLElement>(".toolbar-shell");
const randomizeButton = queryRequired<HTMLButtonElement>("#randomize-button");
const pauseButton = queryRequired<HTMLButtonElement>("#pause-button");
const verticalSymmetryInput = queryRequired<HTMLInputElement>("#vertical-symmetry-input");
const horizontalSymmetryInput = queryRequired<HTMLInputElement>("#horizontal-symmetry-input");
const fullSymmetryInput = queryRequired<HTMLInputElement>("#full-symmetry-input");
const normalizationInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="normalization"]'),
);
const gridWidthCell = queryRequired<HTMLElement>("#grid-width-cell");
const gridHeightCell = queryRequired<HTMLElement>("#grid-height-cell");
const randomizeMinCell = queryRequired<HTMLElement>("#randomize-min-cell");
const randomizeMaxCell = queryRequired<HTMLElement>("#randomize-max-cell");
const normalizationMagnitudeCell = queryRequired<HTMLElement>("#normalization-magnitude-cell");
const settingsFilterGrid = queryRequired<HTMLElement>("#settings-filter-grid");

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function wrapNumber(value: number, size: number): number {
  return ((value % size) + size) % size;
}

function showError(message: string): void {
  errorPanel.hidden = false;
  errorPanel.textContent = message;
}

function formatValue(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function createValueCell(
  label: string,
  onChange: (value: number) => void,
  decimals = 2,
): ValueCellController {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "value-cell";
  element.setAttribute("aria-label", label);

  const valueElement = document.createElement("span");
  valueElement.className = "value-cell-value";
  element.append(valueElement);

  let value = 0;
  let min = -1;
  let max = 1;
  let disabled = false;

  function set(options: {
    value: number;
    min: number;
    max: number;
    disabled?: boolean;
  }): void {
    value = Number.isFinite(options.value) ? options.value : 0;
    min = options.min;
    max = options.max;
    disabled = options.disabled ?? false;

    const span = Math.max(max - min, 0.0001);
    const position = clamp(((value - min) / span) * 100, 0, 100);
    element.style.setProperty("--value-position", `${position}%`);
    element.classList.toggle("negative", value < 0);
    element.classList.toggle("mirrored", disabled);
    element.disabled = disabled;
    valueElement.textContent = formatValue(value, decimals);
    element.setAttribute("aria-valuemin", `${min}`);
    element.setAttribute("aria-valuemax", `${max}`);
    element.setAttribute("aria-valuenow", `${value}`);
  }

  function updateFromDelta(deltaX: number, pointerY: number, start: {
    x: number;
    y: number;
    value: number;
  }): void {
    const range = Math.max(max - min, 0.0001);
    const upwardDistance = Math.max(0, start.y - pointerY);
    const precision = 1 / (1 + upwardDistance / 90);
    const pixelsForFullRange = 260;
    const nextValue = clamp(
      start.value + deltaX * (range / pixelsForFullRange) * precision,
      min,
      max,
    );
    onChange(nextValue);
  }

  element.addEventListener("pointerdown", (event) => {
    if (disabled || event.button !== 0) {
      return;
    }

    event.preventDefault();
    const start = {
      x: event.clientX,
      y: event.clientY,
      value,
    };

    element.setPointerCapture(event.pointerId);

    const handlePointerMove = (moveEvent: PointerEvent): void => {
      updateFromDelta(moveEvent.clientX - start.x, moveEvent.clientY, start);
    };

    const handlePointerEnd = (endEvent: PointerEvent): void => {
      element.releasePointerCapture(endEvent.pointerId);
      element.removeEventListener("pointermove", handlePointerMove);
      element.removeEventListener("pointerup", handlePointerEnd);
      element.removeEventListener("pointercancel", handlePointerEnd);
    };

    element.addEventListener("pointermove", handlePointerMove);
    element.addEventListener("pointerup", handlePointerEnd);
    element.addEventListener("pointercancel", handlePointerEnd);
  });

  element.addEventListener("keydown", (event) => {
    if (disabled) {
      return;
    }

    const range = Math.max(max - min, 0.0001);
    const step = event.shiftKey ? range / 100 : range / 30;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      onChange(clamp(value - step, min, max));
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      onChange(clamp(value + step, min, max));
    }
  });

  set({ value: 0, min: -1, max: 1 });
  return { element, set };
}

function randomState(cellCount: number): Float32Array<ArrayBuffer> {
  const values = new Float32Array(cellCount);
  for (let i = 0; i < values.length; i += 1) {
    values[i] = Math.random() * 2 - 1;
  }
  return values;
}

function zeroState(cellCount: number): Float32Array<ArrayBuffer> {
  return new Float32Array(cellCount);
}

function displayIndex(row: number, column: number): number {
  return row * 3 + column;
}

function normalizedRange(settings: SymmetrySettings): { min: number; max: number } {
  return {
    min: Math.min(settings.min, settings.max),
    max: Math.max(settings.min, settings.max),
  };
}

function getSelectedNormalization(): NormalizationMode {
  const selected = normalizationInputs.find((input) => input.checked)?.value;
  if (selected === "sum" || selected === "l1" || selected === "l2") {
    return selected;
  }
  return "none";
}

function getSymmetryGroups(settings: SymmetrySettings): SymmetryGroup[] {
  const parents: number[] = DISPLAY_INDEXES.map((index) => index);

  function find(index: number): number {
    let current = index;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]];
      current = parents[current];
    }
    return current;
  }

  function union(a: number, b: number): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) {
      return;
    }

    const canonical = Math.min(rootA, rootB);
    parents[rootA] = canonical;
    parents[rootB] = canonical;
  }

  const mirrorVertical = settings.full || settings.vertical;
  const mirrorHorizontal = settings.full || settings.horizontal;

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const index = displayIndex(row, column);
      if (mirrorVertical) {
        union(index, displayIndex(2 - row, column));
      }
      if (mirrorHorizontal) {
        union(index, displayIndex(row, 2 - column));
      }
      if (settings.full) {
        union(index, displayIndex(column, row));
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const index of DISPLAY_INDEXES) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }

  return Array.from(groups.values())
    .map((indexes) => {
      indexes.sort((a, b) => a - b);
      return {
        canonical: indexes[0],
        indexes,
      };
    })
    .sort((a, b) => a.canonical - b.canonical);
}

function applySymmetryToDisplayValues(
  displayValues: number[],
  settings: SymmetrySettings,
  editedIndex?: number,
): number[] {
  const nextValues = [...displayValues];
  for (const group of getSymmetryGroups(settings)) {
    const sourceIndex = editedIndex !== undefined && group.indexes.includes(editedIndex)
      ? editedIndex
      : group.canonical;
    const value = nextValues[sourceIndex] ?? 0;
    for (const index of group.indexes) {
      nextValues[index] = value;
    }
  }
  return nextValues;
}

function filterToDisplayValues(values: Float32Array<ArrayBuffer>): number[] {
  return DISPLAY_INDEXES.map((displayGridIndex) => {
    const filterIndex = DISPLAY_FILTER_INDEXES[displayGridIndex];
    return values[filterIndex];
  });
}

function displayValuesToFilter(displayValues: number[]): Float32Array<ArrayBuffer> {
  const values = new Float32Array(9);
  for (const displayGridIndex of DISPLAY_INDEXES) {
    const filterIndex = DISPLAY_FILTER_INDEXES[displayGridIndex];
    values[filterIndex] = displayValues[displayGridIndex] ?? 0;
  }
  return values;
}

function filterMetric(
  values: Float32Array<ArrayBuffer>,
  mode: Exclude<NormalizationMode, "none"> | "current",
): number {
  if (mode === "sum") {
    return values.reduce((sum, value) => sum + value, 0);
  }
  if (mode === "l1") {
    return values.reduce((sum, value) => sum + Math.abs(value), 0);
  }

  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

function applyNormalization(
  values: Float32Array<ArrayBuffer>,
  settings: SymmetrySettings,
): Float32Array<ArrayBuffer> {
  if (settings.normalization === "none") {
    return values;
  }

  const metric = filterMetric(values, settings.normalization);
  if (Math.abs(metric) < 0.000001) {
    return values;
  }

  const target = settings.normalization === "sum"
    ? settings.normalizationMagnitude
    : Math.max(0, settings.normalizationMagnitude);
  const scale = target / metric;
  return values.map((value) => value * scale) as Float32Array<ArrayBuffer>;
}

function randomFilter(settings: SymmetrySettings): Float32Array<ArrayBuffer> {
  const { min, max } = normalizedRange(settings);
  const displayValues = new Array<number>(9).fill(0);

  for (const group of getSymmetryGroups(settings)) {
    const value = min + Math.random() * (max - min);
    for (const index of group.indexes) {
      displayValues[index] = value;
    }
  }

  return applyNormalization(displayValuesToFilter(displayValues), settings);
}

async function init(): Promise<void> {
  if (!navigator.gpu) {
    showError("WebGPU is not available in this browser.");
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    showError("No WebGPU adapter was found.");
    return;
  }

  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    showError(`WebGPU device lost: ${info.message || info.reason}`);
  });

  const context = canvas.getContext("webgpu");
  if (!context) {
    showError("Could not create a WebGPU canvas context.");
    return;
  }
  const webgpuContext: GPUCanvasContext = context;

  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  const filterBuffer = device.createBuffer({
    label: "3x3 filter",
    size: 9 * Float32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const computeParamsBuffer = device.createBuffer({
    label: "compute params",
    size: 4 * Uint32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const renderUniformBuffer = device.createBuffer({
    label: "render uniforms",
    size: 8 * Float32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computeModule = device.createShaderModule({
    label: "automata compute shader",
    code: computeShader,
  });
  const renderModule = device.createShaderModule({
    label: "automata render shader",
    code: renderShader,
  });
  const computePipeline = device.createComputePipeline({
    label: "automata step pipeline",
    layout: "auto",
    compute: {
      module: computeModule,
      entryPoint: "main",
    },
  });
  const renderPipeline = device.createRenderPipeline({
    label: "automata render pipeline",
    layout: "auto",
    vertex: {
      module: renderModule,
      entryPoint: "vs_main",
    },
    fragment: {
      module: renderModule,
      entryPoint: "fs_main",
      targets: [{ format: presentationFormat }],
    },
    primitive: {
      topology: "triangle-list",
    },
  });

  const computeBindGroupLayout = computePipeline.getBindGroupLayout(0);
  const renderBindGroupLayout = renderPipeline.getBindGroupLayout(0);

  let gridSize = DEFAULT_GRID_SIZE;
  let cellCount = gridSize * gridSize;
  let workgroupCount = Math.ceil(gridSize / WORKGROUP_SIZE);
  let currentState = 0;
  let paused = false;
  let stepsPerFrame = Number(stepsInput.value);
  let randomizeMinValue = -1;
  let randomizeMaxValue = 1;
  let normalizationMagnitude = 1;
  let filterValues: Float32Array<ArrayBuffer> = new Float32Array(visibleStartFilter);

  const view: Viewport = {
    centerX: gridSize * 0.5,
    centerY: gridSize * 0.5,
    zoom: 1,
  };
  const renderUniformValues = new Float32Array(8);
  const settingsFilterCells: ValueCellController[] = [];
  const gridWidthValueCell = createValueCell("Grid width", resizeGrid, 0);
  const gridHeightValueCell = createValueCell("Grid height", resizeGrid, 0);
  const minCell = createValueCell("Randomize minimum", (value) => {
    randomizeMinValue = Math.min(value, randomizeMaxValue);
    syncControlCells();
  });
  const maxCell = createValueCell("Randomize maximum", (value) => {
    randomizeMaxValue = Math.max(value, randomizeMinValue);
    syncControlCells();
  });
  const normalizationCell = createValueCell("Normalization magnitude", (value) => {
    const mode = getSelectedNormalization();
    normalizationMagnitude = mode === "sum"
      ? clamp(value, -NORMALIZATION_TARGET_MAX, NORMALIZATION_TARGET_MAX)
      : clamp(value, 0, NORMALIZATION_TARGET_MAX);
    applyCurrentNormalization();
  });

  let resources = createGpuStateResources(gridSize);
  writeComputeParams();

  function createGpuStateResources(size: number): GpuStateResources {
    const stateBufferSize = size * size * Float32Array.BYTES_PER_ELEMENT;
    const stateA = device.createBuffer({
      label: "state A",
      size: stateBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const stateB = device.createBuffer({
      label: "state B",
      size: stateBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    return {
      stateA,
      stateB,
      computeAB: device.createBindGroup({
        label: "compute A to B",
        layout: computeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: stateA } },
          { binding: 1, resource: { buffer: stateB } },
          { binding: 2, resource: { buffer: filterBuffer } },
          { binding: 3, resource: { buffer: computeParamsBuffer } },
        ],
      }),
      computeBA: device.createBindGroup({
        label: "compute B to A",
        layout: computeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: stateB } },
          { binding: 1, resource: { buffer: stateA } },
          { binding: 2, resource: { buffer: filterBuffer } },
          { binding: 3, resource: { buffer: computeParamsBuffer } },
        ],
      }),
      renderA: device.createBindGroup({
        label: "render A",
        layout: renderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: stateA } },
          { binding: 1, resource: { buffer: renderUniformBuffer } },
        ],
      }),
      renderB: device.createBindGroup({
        label: "render B",
        layout: renderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: stateB } },
          { binding: 1, resource: { buffer: renderUniformBuffer } },
        ],
      }),
    };
  }

  function destroyGpuStateResources(oldResources: GpuStateResources): void {
    oldResources.stateA.destroy();
    oldResources.stateB.destroy();
  }

  function writeComputeParams(): void {
    device.queue.writeBuffer(computeParamsBuffer, 0, new Uint32Array([gridSize, 0, 0, 0]));
  }

  function readRandomizeSettings(): SymmetrySettings {
    return {
      vertical: verticalSymmetryInput.checked,
      horizontal: horizontalSymmetryInput.checked,
      full: fullSymmetryInput.checked,
      min: randomizeMinValue,
      max: randomizeMaxValue,
      normalization: getSelectedNormalization(),
      normalizationMagnitude,
    };
  }

  function configureCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      webgpuContext.configure({
        device,
        format: presentationFormat,
        alphaMode: "opaque",
      });
    }
  }

  function syncControlCells(): void {
    gridWidthValueCell.set({
      value: gridSize,
      min: MIN_GRID_SIZE,
      max: MAX_GRID_SIZE,
    });
    gridHeightValueCell.set({
      value: gridSize,
      min: MIN_GRID_SIZE,
      max: MAX_GRID_SIZE,
    });
    minCell.set({
      value: randomizeMinValue,
      min: RANGE_SETTING_MIN,
      max: randomizeMaxValue,
    });
    maxCell.set({
      value: randomizeMaxValue,
      min: randomizeMinValue,
      max: RANGE_SETTING_MAX,
    });
    syncNormalizationCell();
    syncFilterCells();
  }

  function syncNormalizationCell(): void {
    const mode = getSelectedNormalization();
    if (mode === "none") {
      const currentMagnitude = filterMetric(filterValues, "current");
      normalizationCell.set({
        value: currentMagnitude,
        min: 0,
        max: Math.max(1, currentMagnitude * 2),
        disabled: true,
      });
      return;
    }

    normalizationCell.set({
      value: normalizationMagnitude,
      min: mode === "sum" ? -NORMALIZATION_TARGET_MAX : 0,
      max: NORMALIZATION_TARGET_MAX,
    });
  }

  function syncFilterCells(): void {
    const settings = readRandomizeSettings();
    const groups = getSymmetryGroups(settings);
    const canonicalByIndex = new Map<number, number>();
    const displayValues = filterToDisplayValues(filterValues);
    const { min, max } = normalizedRange(settings);

    for (const group of groups) {
      for (const index of group.indexes) {
        canonicalByIndex.set(index, group.canonical);
      }
    }

    for (const displayGridIndex of DISPLAY_INDEXES) {
      const cell = settingsFilterCells[displayGridIndex];
      if (!cell) {
        continue;
      }

      cell.set({
        value: displayValues[displayGridIndex] ?? 0,
        min,
        max,
        disabled: canonicalByIndex.get(displayGridIndex) !== displayGridIndex,
      });
    }
  }

  function writeFilter(values: Float32Array<ArrayBuffer>): void {
    filterValues = values;
    device.queue.writeBuffer(filterBuffer, 0, filterValues);
    syncNormalizationCell();
    syncFilterCells();
  }

  function commitFilterFromDisplayValues(displayValues: number[], editedIndex?: number): void {
    const settings = readRandomizeSettings();
    const symmetricValues = applySymmetryToDisplayValues(displayValues, settings, editedIndex);
    const normalizedValues = applyNormalization(displayValuesToFilter(symmetricValues), settings);
    writeFilter(normalizedValues);
  }

  function updateFilterFromDisplayValue(displayGridIndex: number, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }

    const displayValues = filterToDisplayValues(filterValues);
    displayValues[displayGridIndex] = value;
    commitFilterFromDisplayValues(displayValues, displayGridIndex);
  }

  function applyCurrentSymmetryToFilter(): void {
    commitFilterFromDisplayValues(filterToDisplayValues(filterValues));
  }

  function applyCurrentNormalization(): void {
    writeFilter(applyNormalization(filterValues, readRandomizeSettings()));
  }

  function writeRandomState(): void {
    device.queue.writeBuffer(resources.stateA, 0, randomState(cellCount));
    device.queue.writeBuffer(resources.stateB, 0, zeroState(cellCount));
    currentState = 0;
  }

  function resizeGrid(rawSize: number): void {
    const nextSize = Math.round(clamp(rawSize, MIN_GRID_SIZE, MAX_GRID_SIZE));
    if (nextSize === gridSize) {
      syncControlCells();
      return;
    }

    const oldSize = gridSize;
    const oldResources = resources;
    gridSize = nextSize;
    cellCount = gridSize * gridSize;
    workgroupCount = Math.ceil(gridSize / WORKGROUP_SIZE);
    view.centerX = (view.centerX / oldSize) * gridSize;
    view.centerY = (view.centerY / oldSize) * gridSize;
    resources = createGpuStateResources(gridSize);
    writeComputeParams();
    writeRandomState();
    destroyGpuStateResources(oldResources);
    clampViewport();
    syncControlCells();
  }

  function clampViewport(): void {
    view.zoom = Math.min(Math.max(view.zoom, MIN_ZOOM), MAX_ZOOM);
    view.centerX = wrapNumber(view.centerX, gridSize);
    view.centerY = wrapNumber(view.centerY, gridSize);
  }

  function canvasOffsetFromClient(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const minDimension = Math.max(Math.min(rect.width, rect.height), 1);

    return {
      x: (clientX - rect.left - rect.width * 0.5) / minDimension,
      y: (clientY - rect.top - rect.height * 0.5) / minDimension,
    };
  }

  function zoomAtClientPoint(clientX: number, clientY: number, zoomFactor: number): void {
    const offset = canvasOffsetFromClient(clientX, clientY);
    const oldCellsVisible = gridSize / view.zoom;
    const targetX = view.centerX + offset.x * oldCellsVisible;
    const targetY = view.centerY + offset.y * oldCellsVisible;

    view.zoom *= zoomFactor;
    clampViewport();

    const newCellsVisible = gridSize / view.zoom;
    view.centerX = targetX - offset.x * newCellsVisible;
    view.centerY = targetY - offset.y * newCellsVisible;
    clampViewport();
  }

  function updateControls(): void {
    pauseButton.setAttribute("aria-label", paused ? "Play" : "Pause");
    pauseButton.innerHTML = paused
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7z"></path><path d="M13 5h4v14h-4z"></path></svg>`;
    stepsOutput.value = `${stepsPerFrame}`;
  }

  function setSettingsOpen(isOpen: boolean): void {
    settingsPanel.hidden = !isOpen;
    settingsButton.setAttribute("aria-expanded", `${isOpen}`);
    if (isOpen) {
      syncControlCells();
    }
  }

  function togglePaused(): void {
    paused = !paused;
    updateControls();
  }

  function randomizeAll(): void {
    writeRandomState();
    writeFilter(randomFilter(readRandomizeSettings()));
  }

  function stepFrame(now: number): void {
    configureCanvas();
    clampViewport();

    renderUniformValues[0] = view.centerX;
    renderUniformValues[1] = view.centerY;
    renderUniformValues[2] = canvas.width;
    renderUniformValues[3] = canvas.height;
    renderUniformValues[4] = view.zoom;
    renderUniformValues[5] = now;
    renderUniformValues[6] = gridSize;
    renderUniformValues[7] = 0;
    device.queue.writeBuffer(renderUniformBuffer, 0, renderUniformValues);

    const encoder = device.createCommandEncoder({ label: "frame command encoder" });

    if (!paused) {
      const computePass = encoder.beginComputePass({ label: "automata update pass" });
      computePass.setPipeline(computePipeline);
      for (let step = 0; step < stepsPerFrame; step += 1) {
        computePass.setBindGroup(0, currentState === 0 ? resources.computeAB : resources.computeBA);
        computePass.dispatchWorkgroups(workgroupCount, workgroupCount);
        currentState = currentState === 0 ? 1 : 0;
      }
      computePass.end();
    }

    const textureView = webgpuContext.getCurrentTexture().createView();
    const renderPass = encoder.beginRenderPass({
      label: "automata render pass",
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.025, g: 0.028, b: 0.026, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    renderPass.setPipeline(renderPipeline);
    renderPass.setBindGroup(0, currentState === 0 ? resources.renderA : resources.renderB);
    renderPass.draw(3);
    renderPass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(stepFrame);
  }

  let dragging = false;
  let previousPointer: { x: number; y: number } | null = null;

  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    previousPointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging || previousPointer === null) {
      return;
    }

    const dx = event.clientX - previousPointer.x;
    const dy = event.clientY - previousPointer.y;
    const minDimension = Math.max(Math.min(canvas.clientWidth, canvas.clientHeight), 1);
    const cellsVisible = gridSize / view.zoom;
    view.centerX -= (dx / minDimension) * cellsVisible;
    view.centerY -= (dy / minDimension) * cellsVisible;
    previousPointer = { x: event.clientX, y: event.clientY };
    clampViewport();
  });

  canvas.addEventListener("pointerup", (event) => {
    dragging = false;
    previousPointer = null;
    canvas.releasePointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointercancel", () => {
    dragging = false;
    previousPointer = null;
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const zoomFactor = Math.pow(1.12, -event.deltaY / 100);
      zoomAtClientPoint(event.clientX, event.clientY, zoomFactor);
    },
    { passive: false },
  );

  window.addEventListener("keydown", (event) => {
    const panAmount = 4 / view.zoom;
    if (event.key === " ") {
      event.preventDefault();
      togglePaused();
    } else if (event.key === "r") {
      randomizeAll();
    } else if (event.key === "Escape") {
      setSettingsOpen(false);
    } else if (event.key === "+" || event.key === "=") {
      view.zoom *= 1.04;
      clampViewport();
    } else if (event.key === "-") {
      view.zoom /= 1.04;
      clampViewport();
    } else if (event.key === "ArrowLeft" || event.key === "h") {
      view.centerX -= panAmount;
      clampViewport();
    } else if (event.key === "ArrowRight" || event.key === "l") {
      view.centerX += panAmount;
      clampViewport();
    } else if (event.key === "ArrowUp" || event.key === "k") {
      view.centerY -= panAmount;
      clampViewport();
    } else if (event.key === "ArrowDown" || event.key === "j") {
      view.centerY += panAmount;
      clampViewport();
    }
  });

  settingsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setSettingsOpen(settingsPanel.hidden);
  });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (
      target instanceof Node
      && !toolbarShell.contains(target)
      && !settingsPanel.contains(target)
    ) {
      setSettingsOpen(false);
    }
  });
  settingsPanel.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  pauseButton.addEventListener("click", togglePaused);
  randomizeButton.addEventListener("click", randomizeAll);
  for (const input of [verticalSymmetryInput, horizontalSymmetryInput, fullSymmetryInput]) {
    input.addEventListener("change", applyCurrentSymmetryToFilter);
  }
  for (const input of normalizationInputs) {
    input.addEventListener("change", applyCurrentNormalization);
  }
  stepsInput.addEventListener("input", () => {
    stepsPerFrame = Number(stepsInput.value);
    stepsOutput.value = `${stepsPerFrame}`;
  });

  gridWidthCell.append(gridWidthValueCell.element);
  gridHeightCell.append(gridHeightValueCell.element);
  randomizeMinCell.append(minCell.element);
  randomizeMaxCell.append(maxCell.element);
  normalizationMagnitudeCell.append(normalizationCell.element);

  for (const displayGridIndex of DISPLAY_INDEXES) {
    const settingsFilterCell = createValueCell(
      `Filter value ${displayGridIndex + 1}`,
      (value) => updateFilterFromDisplayValue(displayGridIndex, value),
    );
    settingsFilterGrid.append(settingsFilterCell.element);
    settingsFilterCells[displayGridIndex] = settingsFilterCell;
  }

  new ResizeObserver(configureCanvas).observe(canvas);
  writeRandomState();
  writeFilter(filterValues);
  syncControlCells();
  updateControls();
  requestAnimationFrame(stepFrame);
}

init().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
