export const computeShader = /* wgsl */ `
struct ComputeParams {
  grid_size: u32,
  activation_mode: u32,
  persistent: u32,
  pad2: u32,
};

@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32, 9>;
@group(0) @binding(3) var<uniform> params: ComputeParams;

fn wrap_index(value: i32) -> u32 {
  let size = i32(params.grid_size);
  return u32((value % size + size) % size);
}

fn finite_value(value: f32) -> f32 {
  if (!(value >= -1.0e20 && value <= 1.0e20)) {
    return 0.0;
  }
  return value;
}

fn stable_tanh(value: f32) -> f32 {
  let limited = clamp(value, -20.0, 20.0);
  let e = exp(2.0 * limited);
  return (e - 1.0) / (e + 1.0);
}

fn activation(value: f32) -> f32 {
  let x = finite_value(value);
  if (params.activation_mode == 1u) {
    return stable_tanh(x);
  }
  if (params.activation_mode == 2u) {
    return abs(x);
  }
  if (params.activation_mode == 3u) {
    return sin(x);
  }
  if (params.activation_mode == 4u) {
    return 1.0 - (1.0 / (0.9 * x * x + 1.0));
  }
  if (params.activation_mode == 5u) {
    let centered = x - 3.5;
    return 1.0 / pow(2.0, centered * centered);
  }
  return x;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.grid_size || gid.y >= params.grid_size) {
    return;
  }

  let state_index = gid.y * params.grid_size + gid.x;
  if (params.persistent != 0u) {
    let current = finite_value(src[state_index]);
    if (abs(current) > 0.000001) {
      dst[state_index] = current;
      return;
    }
  }

  var acc = 0.0;
  for (var fy = 0u; fy < 3u; fy = fy + 1u) {
    for (var fx = 0u; fx < 3u; fx = fx + 1u) {
      let sx = wrap_index(i32(gid.x) + i32(fx) - 1);
      let sy = wrap_index(i32(gid.y) + i32(fy) - 1);
      let sample_index = sy * params.grid_size + sx;
      let weight_index = fy * 3u + fx;
      acc = acc + src[sample_index] * weights[weight_index];
    }
  }

  dst[state_index] = finite_value(activation(acc));
}
`;

export const renderShader = /* wgsl */ `
struct RenderParams {
  center: vec2<f32>,
  canvas_size: vec2<f32>,
  zoom: f32,
  frame: f32,
  grid_size: f32,
  color_mode: f32,
};

struct VertexOut {
  @builtin(position) position: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> state: array<f32>;
@group(0) @binding(1) var<uniform> params: RenderParams;

fn wrap_index(value: i32) -> u32 {
  let size = i32(params.grid_size);
  return u32((value % size + size) % size);
}

fn finite_magnitude(value: f32) -> f32 {
  let abs_value = abs(value);
  if (!(abs_value >= 0.0)) {
    return 0.0;
  }

  let limited = min(abs_value, 20.0);
  let e = exp(-2.0 * limited);
  return (1.0 - e) / (1.0 + e);
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );

  var out: VertexOut;
  out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let min_dimension = max(min(params.canvas_size.x, params.canvas_size.y), 1.0);
  let cells_visible = params.grid_size / params.zoom;
  let offset = (position.xy - params.canvas_size * 0.5) / min_dimension;

  let sample_x = params.center.x + offset.x * cells_visible;
  let sample_y = params.center.y + offset.y * cells_visible;
  let grid_x = wrap_index(i32(floor(sample_x)));
  let grid_y = wrap_index(i32(floor(sample_y)));
  let value = state[grid_y * u32(params.grid_size) + grid_x];
  let magnitude = finite_magnitude(value);

  if (params.color_mode >= 0.5) {
    let foreground = vec3<f32>(1.0, 0.917647, 0.0);
    return vec4<f32>(foreground * magnitude, 1.0);
  }

  if (value >= 0.0) {
    return vec4<f32>(magnitude, magnitude * 0.88, 0.08, 1.0);
  }

  return vec4<f32>(0.08, magnitude * 0.78, magnitude, 1.0);
}
`;
