# Cells Web

WebGPU/Vite port of the Python/Taichi cellular automata prototype.

## Run

```bash
bun install
bun run dev
```

The app keeps the 500 by 500 automata state in WebGPU storage buffers, uses
ping-pong buffers for update steps, and renders directly from the active GPU
buffer. It starts with random state and a visible signed starter filter so a
shared link opens into an active-looking simulation immediately.

## Controls

- Drag: pan the toroidal grid.
- Mouse wheel: zoom into or out of the cursor position.
- `+` / `-`: zoom around the viewport center.
- Arrow keys or `HJKL`: pan.
- Settings: adjust square grid size, filter values, randomize range, symmetry,
  and filter normalization.
- Normalization modes: `None` shows the current filter magnitude, `Sum`
  preserves total grid sum by targeting the signed kernel sum, `L1` targets
  absolute weight sum, and `L2` targets the filter vector magnitude.
- Randomize: randomizes both the state and the 3 by 3 filter using the current
  settings.
- Pause/play button: pause or resume the simulation.
- Space: pause or resume.
- `r`: randomize both the state and filter.
