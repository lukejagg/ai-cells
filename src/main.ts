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
const CURSOR_RADIUS_MIN = 1;
const CURSOR_RADIUS_MAX = 64;
const DEFAULT_CURSOR_RADIUS = 5;
const NORMALIZATION_TARGET_MAX = 5;
const MINI_SUM_HISTORY_POINTS = 160;

type NormalizationMode = "none" | "sum" | "l1" | "l2";
type ActivationMode = "identity" | "tanh" | "abs" | "sin" | "inverse-gaussian" | "gaussian";
type ColorMode = "signed" | "foreground";
type CursorShape = "box" | "circle";

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

type SumSample = {
  step: number;
  value: number;
};

type RandomState = {
  values: Float32Array<ArrayBuffer>;
  sum: number;
};

const visibleStartFilter: Float32Array<ArrayBuffer> = new Float32Array([
  0.0, 0.03, 0.0,
  -0.03, 1.0, 0.03,
  0.0, -0.03, 0.0,
]);
const DISPLAY_FILTER_INDEXES = [8, 7, 6, 5, 4, 3, 2, 1, 0] as const;
const DISPLAY_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

const canvas = queryRequired<HTMLCanvasElement>("#automata-canvas");
const errorPanel = queryRequired<HTMLDivElement>("#error-panel");
const stepsInput = queryRequired<HTMLInputElement>("#steps-input");
const stepsOutput = queryRequired<HTMLOutputElement>("#steps-output");
const fpsOutput = queryRequired<HTMLOutputElement>("#fps-output");
const settingsButton = queryRequired<HTMLButtonElement>("#settings-button");
const settingsPanel = queryRequired<HTMLElement>("#settings-panel");
const toolbarShell = queryRequired<HTMLElement>(".toolbar-shell");
const sumGraphButton = queryRequired<HTMLButtonElement>("#sum-graph-button");
const sumSparklineCanvas = queryRequired<HTMLCanvasElement>("#sum-sparkline-canvas");
const sumGraphPanel = queryRequired<HTMLElement>("#sum-graph-panel");
const sumGraphCanvas = queryRequired<HTMLCanvasElement>("#sum-graph-canvas");
const sumGraphCurrent = queryRequired<HTMLOutputElement>("#sum-graph-current");
const sumGraphCloseButton = queryRequired<HTMLButtonElement>("#sum-graph-close-button");
const randomizeButton = queryRequired<HTMLButtonElement>("#randomize-button");
const settingsRandomizeButton = queryRequired<HTMLButtonElement>("#settings-randomize-button");
const randomizeStateButton = queryRequired<HTMLButtonElement>("#randomize-state-button");
const fillZerosButton = queryRequired<HTMLButtonElement>("#fill-zeros-button");
const fillOnesButton = queryRequired<HTMLButtonElement>("#fill-ones-button");
const pauseButton = queryRequired<HTMLButtonElement>("#pause-button");
const verticalSymmetryInput = queryRequired<HTMLInputElement>("#vertical-symmetry-input");
const horizontalSymmetryInput = queryRequired<HTMLInputElement>("#horizontal-symmetry-input");
const fullSymmetryInput = queryRequired<HTMLInputElement>("#full-symmetry-input");
const persistentPixelsInput = queryRequired<HTMLInputElement>("#persistent-pixels-input");
const normalizationInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="normalization"]'),
);
const activationInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="activation"]'),
);
const colorModeInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="color-mode"]'),
);
const cursorShapeInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="cursor-shape"]'),
);
const gridWidthCell = queryRequired<HTMLElement>("#grid-width-cell");
const gridHeightCell = queryRequired<HTMLElement>("#grid-height-cell");
const cursorRadiusCell = queryRequired<HTMLElement>("#cursor-radius-cell");
const cursorValueCell = queryRequired<HTMLElement>("#cursor-value-cell");
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

function formatStepScale(exponent: number): string {
  const scale = 2 ** exponent;
  const formattedScale = scale >= 1
    ? Math.round(scale).toLocaleString()
    : scale.toFixed(Math.abs(exponent));
  return `2^${exponent} (${formattedScale})`;
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

function randomState(cellCount: number): RandomState {
  const values = new Float32Array(cellCount);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = Math.random() * 2 - 1;
    values[i] = value;
    sum += value;
  }
  return { values, sum };
}

function zeroState(cellCount: number): Float32Array<ArrayBuffer> {
  return new Float32Array(cellCount);
}

function uniformState(cellCount: number, value: number): Float32Array<ArrayBuffer> {
  const values = new Float32Array(cellCount);
  if (value !== 0) {
    values.fill(value);
  }
  return values;
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

function getSelectedActivation(): ActivationMode {
  const selected = activationInputs.find((input) => input.checked)?.value;
  if (
    selected === "identity"
    || selected === "tanh"
    || selected === "abs"
    || selected === "sin"
    || selected === "inverse-gaussian"
    || selected === "gaussian"
  ) {
    return selected;
  }
  return "tanh";
}

function activationModeIndex(mode: ActivationMode): number {
  if (mode === "tanh") {
    return 1;
  }
  if (mode === "abs") {
    return 2;
  }
  if (mode === "sin") {
    return 3;
  }
  if (mode === "inverse-gaussian") {
    return 4;
  }
  if (mode === "gaussian") {
    return 5;
  }
  return 0;
}

function getSelectedColorMode(): ColorMode {
  const selected = colorModeInputs.find((input) => input.checked)?.value;
  return selected === "foreground" ? "foreground" : "signed";
}

function getSelectedCursorShape(): CursorShape {
  const selected = cursorShapeInputs.find((input) => input.checked)?.value;
  return selected === "circle" ? "circle" : "box";
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

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const displayValues = new Array<number>(9).fill(0);

    for (const group of getSymmetryGroups(settings)) {
      const value = min + Math.random() * (max - min);
      for (const index of group.indexes) {
        displayValues[index] = value;
      }
    }

    const values = displayValuesToFilter(displayValues);
    if (settings.normalization !== "sum" || Math.abs(filterMetric(values, "sum")) >= 0.000001) {
      return applyNormalization(values, settings);
    }
  }

  const fallbackDisplayValues = new Array<number>(9).fill(0);
  fallbackDisplayValues[4] = settings.normalizationMagnitude;
  return displayValuesToFilter(fallbackDisplayValues);
}

function formatSumValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const absValue = Math.abs(value);
  if (absValue >= 1_000_000 || (absValue > 0 && absValue < 0.01)) {
    return value.toExponential(2);
  }

  return value.toLocaleString(undefined, {
    maximumFractionDigits: absValue >= 100 ? 0 : 2,
  });
}

function resizeGraphCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width || canvas.width / dpr);
  const cssHeight = Math.max(1, rect.height || canvas.height / dpr);
  const width = Math.floor(cssWidth * dpr);
  const height = Math.floor(cssHeight * dpr);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  return { width: cssWidth, height: cssHeight };
}

function drawSumGraph(
  canvas: HTMLCanvasElement,
  samples: SumSample[],
  options: { compact: boolean },
): void {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const { width, height } = resizeGraphCanvas(canvas);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const finiteSamples = samples.filter((sample) => Number.isFinite(sample.value));
  const values = finiteSamples.map((sample) => sample.value);

  if (values.length === 0) {
    context.strokeStyle = "rgba(244, 242, 240, 0.18)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height * 0.5);
    context.lineTo(width, height * 0.5);
    context.stroke();
    return;
  }

  let min = values[0] ?? 0;
  let max = values[0] ?? 0;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (Math.abs(max - min) < 0.000001) {
    const padding = Math.max(1, Math.abs(max) * 0.1);
    min -= padding;
    max += padding;
  }

  const padLeft = options.compact ? 3 : 58;
  const padRight = options.compact ? 3 : 12;
  const padTop = options.compact ? 4 : 16;
  const padBottom = options.compact ? 4 : 30;
  const graphWidth = Math.max(1, width - padLeft - padRight);
  const graphHeight = Math.max(1, height - padTop - padBottom);
  const range = max - min;

  function point(index: number, value: number): { x: number; y: number } {
    const x = padLeft + (values.length === 1 ? graphWidth : (index / (values.length - 1)) * graphWidth);
    const y = padTop + graphHeight - ((value - min) / range) * graphHeight;
    return { x, y };
  }

  if (!options.compact) {
    context.font = "11px ui-monospace, Menlo, Consolas, monospace";
    context.fillStyle = "rgba(244, 242, 240, 0.68)";
    context.strokeStyle = "rgba(244, 242, 240, 0.22)";
    context.lineWidth = 1;

    const axisBottom = padTop + graphHeight;
    context.beginPath();
    context.moveTo(padLeft, padTop);
    context.lineTo(padLeft, axisBottom);
    context.lineTo(padLeft + graphWidth, axisBottom);
    context.stroke();

    const yTicks = [
      { value: max, y: padTop },
      { value: (min + max) * 0.5, y: padTop + graphHeight * 0.5 },
      { value: min, y: axisBottom },
    ];
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const tick of yTicks) {
      context.fillText(formatSumValue(tick.value), padLeft - 7, tick.y);
    }

    const firstStep = finiteSamples[0]?.step ?? 0;
    const lastStep = finiteSamples[finiteSamples.length - 1]?.step ?? firstStep;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(`step ${firstStep}`, padLeft + 4, padTop + 4);
    context.textAlign = "center";
    context.fillText("x: step", padLeft + graphWidth * 0.5, padTop + 4);
    context.textAlign = "right";
    context.fillText(`step ${lastStep}`, padLeft + graphWidth - 4, padTop + 4);

    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillText(`step ${firstStep}`, padLeft, height - 6);
    context.textAlign = "center";
    context.fillText("step", padLeft + graphWidth * 0.5, height - 6);
    context.textAlign = "right";
    context.fillText(`step ${lastStep}`, padLeft + graphWidth, height - 6);
  }

  if (!options.compact && min < 0 && max > 0) {
    const zeroY = padTop + graphHeight - ((0 - min) / range) * graphHeight;
    context.strokeStyle = "rgba(244, 242, 240, 0.16)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(padLeft, zeroY);
    context.lineTo(padLeft + graphWidth, zeroY);
    context.stroke();
  }

  context.lineJoin = "round";
  context.lineCap = "round";
  context.lineWidth = options.compact ? 1.5 : 2;
  context.strokeStyle = "#e4f222";
  context.beginPath();
  if (values.length === 1) {
    const { y } = point(0, values[0] ?? 0);
    context.moveTo(padLeft, y);
    context.lineTo(padLeft + graphWidth, y);
  } else {
    values.forEach((value, index) => {
      const { x, y } = point(index, value);
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });
  }
  context.stroke();

  if (!options.compact) {
    const latest = point(values.length - 1, values[values.length - 1] ?? 0);
    context.fillStyle = "#e4f222";
    context.beginPath();
    context.arc(latest.x, latest.y, 3.5, 0, Math.PI * 2);
    context.fill();
  }
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
  let stepExponent = Number(stepsInput.value);
  let stepsPerFrame = 2 ** stepExponent;
  let stepAccumulator = 0;
  let randomizeMinValue = -1;
  let randomizeMaxValue = 1;
  let normalizationMagnitude = 1;
  let cursorRadiusValue = DEFAULT_CURSOR_RADIUS;
  let cursorPaintValue = 1;
  let filterValues: Float32Array<ArrayBuffer> = new Float32Array(visibleStartFilter);
  let targetGridSum = 0;

  const view: Viewport = {
    centerX: gridSize * 0.5,
    centerY: gridSize * 0.5,
    zoom: 1,
  };
  const renderUniformValues = new Float32Array(8);
  const settingsFilterCells: ValueCellController[] = [];
  const sumHistory: SumSample[] = [];
  let graphOpen = false;
  let lastFrameTime = 0;
  let smoothedFps = 0;
  let lastFpsRenderTime = 0;
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
  const cursorRadiusValueCell = createValueCell("Cursor radius", (value) => {
    cursorRadiusValue = Math.round(clamp(value, CURSOR_RADIUS_MIN, CURSOR_RADIUS_MAX));
    syncControlCells();
  }, 0);
  const cursorPaintValueCell = createValueCell("Cursor value", (value) => {
    cursorPaintValue = clamp(value, -1, 1);
    syncControlCells();
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
    device.queue.writeBuffer(
      computeParamsBuffer,
      0,
      new Uint32Array([
        gridSize,
        activationModeIndex(getSelectedActivation()),
        persistentPixelsInput.checked ? 1 : 0,
        0,
      ]),
    );
  }

  function writeTargetSum(value: number): void {
    targetGridSum = Number.isFinite(value) ? value : 0;
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
    cursorRadiusValueCell.set({
      value: cursorRadiusValue,
      min: CURSOR_RADIUS_MIN,
      max: CURSOR_RADIUS_MAX,
    });
    cursorPaintValueCell.set({
      value: cursorPaintValue,
      min: -1,
      max: 1,
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
    const nextState = randomState(cellCount);
    device.queue.writeBuffer(resources.stateA, 0, nextState.values);
    device.queue.writeBuffer(resources.stateB, 0, zeroState(cellCount));
    writeTargetSum(nextState.sum);
    currentState = 0;
  }

  function writeUniformState(value: number): void {
    const boundedValue = Number.isFinite(value) ? value : 0;
    const nextState = uniformState(cellCount, boundedValue);
    device.queue.writeBuffer(resources.stateA, 0, nextState);
    device.queue.writeBuffer(resources.stateB, 0, nextState);
    writeTargetSum(boundedValue * cellCount);
    currentState = 0;
    resetSumHistory();
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
    resetSumHistory();
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

  function gridPointFromClient(clientX: number, clientY: number): { x: number; y: number } {
    const offset = canvasOffsetFromClient(clientX, clientY);
    const cellsVisible = gridSize / view.zoom;
    return {
      x: Math.floor(view.centerX + offset.x * cellsVisible),
      y: Math.floor(view.centerY + offset.y * cellsVisible),
    };
  }

  function wrappedSegments(start: number, length: number, size: number): Array<{ start: number; length: number }> {
    const boundedLength = Math.min(Math.max(Math.round(length), 1), size);
    if (boundedLength >= size) {
      return [{ start: 0, length: size }];
    }

    const normalizedStart = wrapNumber(Math.floor(start), size);
    if (normalizedStart + boundedLength <= size) {
      return [{ start: normalizedStart, length: boundedLength }];
    }

    const firstLength = size - normalizedStart;
    return [
      { start: normalizedStart, length: firstLength },
      { start: 0, length: boundedLength - firstLength },
    ];
  }

  function paintAtGridPoint(gridX: number, gridY: number): void {
    const radius = Math.min(Math.max(1, Math.round(cursorRadiusValue)), Math.floor(gridSize * 0.5));
    const shape = getSelectedCursorShape();
    const rowsByLength = new Map<number, Float32Array<ArrayBuffer>>();

    function rowValues(length: number): Float32Array<ArrayBuffer> {
      const existing = rowsByLength.get(length);
      if (existing) {
        return existing;
      }

      const values = new Float32Array(length);
      values.fill(cursorPaintValue);
      rowsByLength.set(length, values);
      return values;
    }

    function writeRow(y: number, startX: number, length: number): void {
      const row = wrapNumber(y, gridSize);
      for (const xSegment of wrappedSegments(startX, length, gridSize)) {
        const values = rowValues(xSegment.length);
        const byteOffset = (row * gridSize + xSegment.start) * Float32Array.BYTES_PER_ELEMENT;
        device.queue.writeBuffer(resources.stateA, byteOffset, values);
        device.queue.writeBuffer(resources.stateB, byteOffset, values);
      }
    }

    if (shape === "circle") {
      for (let dy = -radius; dy <= radius; dy += 1) {
        const halfWidth = Math.floor(Math.sqrt(radius * radius - dy * dy));
        writeRow(gridY + dy, gridX - halfWidth, halfWidth * 2 + 1);
      }
      return;
    }

    const brushSize = Math.min(gridSize, radius * 2);
    const startX = Math.floor(gridX - brushSize * 0.5);
    const startY = Math.floor(gridY - brushSize * 0.5);
    for (let dy = 0; dy < brushSize; dy += 1) {
      writeRow(startY + dy, startX, brushSize);
    }
  }

  function paintAtClientPoint(clientX: number, clientY: number): void {
    const point = gridPointFromClient(clientX, clientY);
    paintAtGridPoint(point.x, point.y);
  }

  function updateControls(): void {
    pauseButton.setAttribute("aria-label", paused ? "Play" : "Pause");
    pauseButton.innerHTML = paused
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7z"></path><path d="M13 5h4v14h-4z"></path></svg>`;
    sumGraphCloseButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5.1 5.1 6.4 10.7 12l-5.6 5.6 1.3 1.3 5.6-5.6 5.6 5.6 1.3-1.3-5.6-5.6 5.6-5.6-1.3-1.3-5.6 5.6z"></path></svg>`;
    stepsOutput.value = formatStepScale(stepExponent);
  }

  function setSettingsOpen(isOpen: boolean): void {
    settingsPanel.hidden = !isOpen;
    settingsButton.setAttribute("aria-expanded", `${isOpen}`);
    if (isOpen) {
      syncControlCells();
    }
  }

  function setGraphOpen(isOpen: boolean): void {
    graphOpen = isOpen;
    sumGraphPanel.hidden = !isOpen;
    sumGraphButton.setAttribute("aria-expanded", `${isOpen}`);
    if (isOpen) {
      setSettingsOpen(false);
    }
    drawSumGraphs();
  }

  function togglePaused(): void {
    paused = !paused;
    updateControls();
  }

  function resetSumHistory(): void {
    sumHistory.length = 0;
    stepAccumulator = 0;
    if (Number.isFinite(targetGridSum)) {
      sumHistory.push({ step: 0, value: targetGridSum });
      sumGraphCurrent.value = formatSumValue(targetGridSum);
      sumGraphButton.setAttribute("aria-label", `Open total sum graph, latest sum ${formatSumValue(targetGridSum)}`);
    } else {
      sumGraphCurrent.value = "0";
      sumGraphButton.setAttribute("aria-label", "Open total sum graph");
    }
    drawSumGraphs();
  }

  function drawSumGraphs(): void {
    const miniSamples = sumHistory.slice(-MINI_SUM_HISTORY_POINTS);
    drawSumGraph(sumSparklineCanvas, miniSamples, { compact: true });
    if (graphOpen) {
      drawSumGraph(sumGraphCanvas, sumHistory, { compact: false });
    }
  }

  function randomizeAll(): void {
    writeRandomState();
    resetSumHistory();
    writeFilter(randomFilter(readRandomizeSettings()));
  }

  function randomizeStateOnly(): void {
    writeRandomState();
    resetSumHistory();
  }

  function stepFrame(now: number): void {
    if (lastFrameTime > 0) {
      const frameDelta = Math.max(now - lastFrameTime, 0.001);
      const instantFps = 1000 / frameDelta;
      smoothedFps = smoothedFps === 0 ? instantFps : smoothedFps * 0.9 + instantFps * 0.1;
      if (now - lastFpsRenderTime > 250) {
        fpsOutput.value = `${Math.round(smoothedFps)} fps`;
        lastFpsRenderTime = now;
      }
    }
    lastFrameTime = now;

    configureCanvas();
    clampViewport();

    renderUniformValues[0] = view.centerX;
    renderUniformValues[1] = view.centerY;
    renderUniformValues[2] = canvas.width;
    renderUniformValues[3] = canvas.height;
    renderUniformValues[4] = view.zoom;
    renderUniformValues[5] = now;
    renderUniformValues[6] = gridSize;
    renderUniformValues[7] = getSelectedColorMode() === "foreground" ? 1 : 0;
    device.queue.writeBuffer(renderUniformBuffer, 0, renderUniformValues);

    const encoder = device.createCommandEncoder({ label: "frame command encoder" });
    let stepsThisFrame = 0;

    if (!paused) {
      stepAccumulator += stepsPerFrame;
      stepsThisFrame = Math.floor(stepAccumulator);
      stepAccumulator -= stepsThisFrame;

      if (stepsThisFrame > 0) {
        const computePass = encoder.beginComputePass({ label: "automata update pass" });
        computePass.setPipeline(computePipeline);
        for (let step = 0; step < stepsThisFrame; step += 1) {
          computePass.setBindGroup(0, currentState === 0 ? resources.computeAB : resources.computeBA);
          computePass.dispatchWorkgroups(workgroupCount, workgroupCount);
          currentState = currentState === 0 ? 1 : 0;
        }
        computePass.end();
      }
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

  let pointerMode: "pan" | "paint" | null = null;
  let previousPointer: { x: number; y: number } | null = null;

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events used in browser checks do not always register an active pointer.
    }
    if (event.shiftKey) {
      pointerMode = "pan";
      previousPointer = { x: event.clientX, y: event.clientY };
      canvas.classList.add("is-panning");
      return;
    }

    pointerMode = "paint";
    previousPointer = null;
    canvas.classList.add("is-painting");
    paintAtClientPoint(event.clientX, event.clientY);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (pointerMode === "paint") {
      paintAtClientPoint(event.clientX, event.clientY);
      return;
    }

    if (pointerMode !== "pan" || previousPointer === null) {
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
    pointerMode = null;
    previousPointer = null;
    canvas.classList.remove("is-panning", "is-painting");
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  });

  canvas.addEventListener("pointercancel", (event) => {
    pointerMode = null;
    previousPointer = null;
    canvas.classList.remove("is-panning", "is-painting");
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
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
      setGraphOpen(false);
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
    const willOpen = settingsPanel.hidden;
    if (willOpen) {
      setGraphOpen(false);
    }
    setSettingsOpen(willOpen);
  });
  toolbarShell.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  sumGraphButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setGraphOpen(sumGraphPanel.hidden);
  });
  sumGraphCloseButton.addEventListener("click", () => {
    setGraphOpen(false);
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
    if (
      target instanceof Node
      && !toolbarShell.contains(target)
      && !sumGraphPanel.contains(target)
    ) {
      setGraphOpen(false);
    }
  });
  settingsPanel.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  sumGraphPanel.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  pauseButton.addEventListener("click", togglePaused);
  randomizeButton.addEventListener("click", randomizeAll);
  settingsRandomizeButton.addEventListener("click", randomizeAll);
  randomizeStateButton.addEventListener("click", randomizeStateOnly);
  fillZerosButton.addEventListener("click", () => writeUniformState(0));
  fillOnesButton.addEventListener("click", () => writeUniformState(1));
  for (const input of [verticalSymmetryInput, horizontalSymmetryInput, fullSymmetryInput]) {
    input.addEventListener("change", applyCurrentSymmetryToFilter);
  }
  for (const input of normalizationInputs) {
    input.addEventListener("change", applyCurrentNormalization);
  }
  for (const input of activationInputs) {
    input.addEventListener("change", writeComputeParams);
  }
  persistentPixelsInput.addEventListener("change", writeComputeParams);
  stepsInput.addEventListener("input", () => {
    stepExponent = Number(stepsInput.value);
    stepsPerFrame = 2 ** stepExponent;
    stepAccumulator = 0;
    stepsOutput.value = formatStepScale(stepExponent);
  });

  gridWidthCell.append(gridWidthValueCell.element);
  gridHeightCell.append(gridHeightValueCell.element);
  cursorRadiusCell.append(cursorRadiusValueCell.element);
  cursorValueCell.append(cursorPaintValueCell.element);
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
  const graphResizeObserver = new ResizeObserver(drawSumGraphs);
  graphResizeObserver.observe(sumSparklineCanvas);
  graphResizeObserver.observe(sumGraphCanvas);
  writeRandomState();
  resetSumHistory();
  writeFilter(filterValues);
  syncControlCells();
  updateControls();
  requestAnimationFrame(stepFrame);
}

init().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
