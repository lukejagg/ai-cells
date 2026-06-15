# AGENTS.md

## App Philosophy

`cells_web` is the shareable browser front end for the neural automata prototype.
Keep the first screen as the live simulation, not a landing page or explanatory
wrapper. The canvas is the product.

Developer speed matters, but the runtime path should stay GPU-resident:

- Keep automata state in WebGPU buffers.
- Use ping-pong buffers for repeated state updates.
- Render directly from GPU state; avoid CPU readback except for debugging or
  explicit verification.
- Prefer small, focused UI controls that preserve screen space for the canvas.
- Any change that touches shaders, bind groups, uniforms, grid sizing, or render
  scheduling must be verified in a browser, not only with `tsc`.

## Styling Guide

The visual style should follow the Gravel/Ramp dark theme direction used by the
rest of the product:

- Canonical dark background: `#2A2827`.
- Foreground: `#f4f2f0`.
- Muted text: `#a39d99`.
- Card and control surfaces should use dark token-like colors, not arbitrary
  one-off blacks.
- Primary action buttons use the Ramp accent gradient:
  `#e4f222` to `#deea2b`, with text `#2e2e27`.
- Secondary and icon buttons should use card or muted dark surfaces with muted
  foreground, brightening on hover.
- Body font stack: `"Lausanne", Inter, Roboto, Arial, sans-serif`.
- Mono/value font stack:
  `ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas,
  "DejaVu Sans Mono", monospace`.
- Body weight is 300; headings and interactive text are 400; strong emphasis is
  700.
- Use the 12/16 and 14/20 type scale for controls and settings.
- Buttons in the top toolbar should be pill-shaped; the pause/play button should
  be circular.
- The outer toolbar wrapper must stay transparent. The rounded inner toolbar is
  the only visible navbar surface.
- On narrow/mobile widths, hide Steps in the top bar. Keep the top bar at a
  stable height, and render Settings as a separate sheet below it.

## WebGPU Notes

WGSL uniform layout must match the JavaScript buffer sizes exactly. Avoid
`vec3` members in small uniform structs unless the JavaScript buffer accounts for
16-byte alignment and struct padding.

For example, prefer four scalar `u32` values for a 16-byte compute params buffer:

```wgsl
struct ComputeParams {
  grid_size: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};
```

If the page is black, check:

- Browser console and WebGPU validation errors.
- Canvas client size and backing size.
- Uniform buffer sizes versus WGSL layout.
- Whether the compute pass is invalid before render submission.
- Whether screenshots differ over time while unpaused.

## Local Dev

From this directory:

```bash
bun install
bun run dev
```

The dev server is configured for:

```text
http://localhost:5174/
```

Build before handing off changes:

```bash
bun run build
```

Verification checklist:

- Reload `http://localhost:5174/`.
- Confirm there are no browser console errors.
- Confirm the canvas is visibly non-black.
- Confirm the simulation changes over time while unpaused.
- Open Settings and confirm it does not resize the top toolbar.
- Click Randomize with Settings open and confirm Settings remains open.
- Check a narrow/mobile viewport when touching toolbar, modal, or responsive CSS.
