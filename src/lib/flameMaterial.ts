import * as THREE from 'three'

/**
 * Point-sprite flames for the 3D view: each point is a flickering teardrop flame whose on-screen size follows a size
 * in metres (the point is projected with the layer's full matrix, so the sprite is measured against a vertical and a
 * horizontal offset of that many metres). Additive, so many small flames read as a fire front.
 */
export function flameMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uViewH: { value: 800 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uViewH;
      attribute float aSize;
      attribute float aSeed;
      varying float vSeed;
      void main() {
        // the sprite is centred on the point: lift it so the flame's base sits at the point
        vec3 c = position + vec3(0.0, aSize * 0.42, 0.0);
        vec4 p = projectionMatrix * vec4(c, 1.0);
        vec4 q = projectionMatrix * vec4(c + vec3(0.0, aSize, 0.0), 1.0);
        vec4 r = projectionMatrix * vec4(c + vec3(aSize * 0.8, 0.0, 0.0), 1.0);
        float px = max(length(q.xy / q.w - p.xy / p.w), length(r.xy / r.w - p.xy / p.w)) * 0.5 * uViewH;
        float flick = 0.88 + 0.16 * sin(uTime * 8.0 + aSeed * 40.0) + 0.08 * sin(uTime * 21.0 + aSeed * 17.0);
        gl_PointSize = clamp(px * flick, 4.0, 200.0);
        gl_Position = p;
        vSeed = aSeed;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying float vSeed;
      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        uv.y = -uv.y;
        float up = (uv.y + 1.0) * 0.5;
        float sway = sin(uTime * 11.0 + vSeed * 30.0 + uv.y * 3.5) * 0.09 * up;
        float w = mix(0.62, 0.06, pow(up, 1.25));
        float d = abs(uv.x - sway) / w;
        float body = 1.0 - smoothstep(0.55, 1.0, d);
        float tips = 1.0 - smoothstep(0.55 + 0.25 * sin(uTime * 7.0 + vSeed * 9.0), 1.0, up);
        float base = smoothstep(0.0, 0.16, up);
        float a = body * tips * base;
        if (a < 0.02) discard;
        float core = (1.0 - smoothstep(0.0, 0.65, d)) * (1.0 - smoothstep(0.1, 0.75, up));
        vec3 col = mix(vec3(0.78, 0.13, 0.02), vec3(1.0, 0.55, 0.08), body);
        col = mix(col, vec3(1.0, 0.92, 0.55), core);
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
}
