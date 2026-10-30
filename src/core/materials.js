import * as THREE from 'three';

// Uniforms shared by all model materials (selection color, ghost alpha, ...).
export const sharedUniforms = {
  uSelColor: { value: new THREE.Color(0xffc400) },
  uHoverColor: { value: new THREE.Color(0x7fd3ff) },
  uGhostAlpha: { value: 0.18 },
  uSection: { value: 0 },
  uEdgeColor: { value: new THREE.Color(0x1d1d1d) },
  uEdgeOpacity: { value: 0.55 },
};

const stateFetch = /* glsl */ `
  uniform highp sampler2D flagTex;
  uniform highp sampler2D colorTex;
  uniform int texWidth;
  uniform float uGhostAlpha;
  attribute float eid;
  ivec2 stateCoord() {
    int i = int(eid + 0.5);
    return ivec2(i % texWidth, i / texWidth);
  }
`;

const meshVertex = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  ${stateFetch}
  attribute vec4 rgba;
  uniform float uPass;
  varying vec3 vWorldNormal;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSel;
  varying float vHover;
  void main() {
    ivec2 tc = stateCoord();
    vec4 fl = texelFetch(flagTex, tc, 0);
    vec4 oc = texelFetch(colorTex, tc, 0);
    float alpha = fl.g > 0.5 ? uGhostAlpha : rgba.a;
    bool transp = alpha < 0.995;
    if (fl.r < 0.5 || (uPass < 0.5 && transp) || (uPass > 0.5 && !transp)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vColor = oc.a > 0.5 ? oc.rgb : rgba.rgb;
    vAlpha = alpha;
    vSel = fl.b;
    vHover = fl.a;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    #include <begin_vertex>
    #include <project_vertex>
    #include <clipping_planes_vertex>
  }
`;

const meshFragment = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_fragment>
  uniform vec3 uSelColor;
  uniform vec3 uHoverColor;
  uniform float uSection;
  varying vec3 vWorldNormal;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSel;
  varying float vHover;
  void main() {
    #include <clipping_planes_fragment>
    vec3 n = normalize(vWorldNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 L1 = normalize(vec3(0.45, 0.85, 0.35));
    vec3 L2 = normalize(vec3(-0.55, 0.25, -0.6));
    float light = 0.52 + 0.36 * max(dot(n, L1), 0.0) + 0.16 * max(dot(n, L2), 0.0) + 0.04 * n.y;
    vec3 col = vColor * light;
    // Looking into a cut solid shows its back faces: shade them flat like a section cap.
    if (!gl_FrontFacing && uSection > 0.5) col = vColor * 0.55;
    if (vSel > 0.5) col = mix(col, uSelColor, 0.6);
    else if (vHover > 0.5) col = mix(col, uHoverColor, 0.35);
    gl_FragColor = vec4(col, vAlpha);
  }
`;

const edgeVertex = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  ${stateFetch}
  varying float vA;
  void main() {
    vec4 fl = texelFetch(flagTex, stateCoord(), 0);
    if (fl.r < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vA = fl.g > 0.5 ? 0.12 : 1.0;
    #include <begin_vertex>
    #include <project_vertex>
    #include <clipping_planes_vertex>
  }
`;

const edgeFragment = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_fragment>
  uniform vec3 uEdgeColor;
  uniform float uEdgeOpacity;
  varying float vA;
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = vec4(uEdgeColor, vA * uEdgeOpacity);
  }
`;

export function createMeshMaterial(model, pass) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      ...sharedUniforms,
      flagTex: { value: model.flagTex },
      colorTex: { value: model.colorTex },
      texWidth: { value: model.texW },
      uPass: { value: pass },
    },
    vertexShader: meshVertex,
    fragmentShader: meshFragment,
    side: THREE.DoubleSide,
    clipping: true,
    transparent: pass === 1,
    depthWrite: pass === 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  m.userData.clippable = true;
  return m;
}

export function createEdgeMaterial(model) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      ...sharedUniforms,
      flagTex: { value: model.flagTex },
      colorTex: { value: model.colorTex },
      texWidth: { value: model.texW },
    },
    vertexShader: edgeVertex,
    fragmentShader: edgeFragment,
    clipping: true,
    transparent: true,
    depthWrite: false,
  });
  m.userData.clippable = true;
  return m;
}
