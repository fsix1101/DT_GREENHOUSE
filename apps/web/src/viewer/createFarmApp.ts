import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { unpackFrame, decodeFrameValue, getSubType } from "../protocol/frame.ts";
import { ACTUATOR_DEVICES, SENSOR_DEVICES } from "../protocolDashboard/constants.ts";
import { type Bytes } from "../protocol/types.ts";

type ModelSpec =
  | {
    kind: "obj";
    objUrl: string;
    mtlUrl?: string;
    id?: string;
    normalize?: "centerGround" | "none";
    transform?: {
      position?: [number, number, number];
      rotation?: [number, number, number];
      scale?: number | [number, number, number];
    };
  }
  | {
    kind: "gltf";
    url: string;
    id?: string;
    normalize?: "centerGround" | "none";
    transform?: {
      position?: [number, number, number];
      rotation?: [number, number, number];
      scale?: number | [number, number, number];
    };
  };

type FarmAppOptions = {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  model: ModelSpec;
  extras?: ModelSpec[];
  socketUrl: string;
};

type FarmApp = {
  start(): void;
  dispose(): void;
};

type LatestTelemetry = {
  ts: number;
  temperatureC?: number;
  humidityPct?: number;
  co2ppm?: number;
};

export function createFarmApp(options: FarmAppOptions): FarmApp {
  const renderer = new THREE.WebGLRenderer({
    canvas: options.canvas,
    antialias: true,
    alpha: false
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // 限制像素比以提高性能
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  (renderer as unknown as { physicallyCorrectLights?: boolean }).physicallyCorrectLights = true;

  const scene = new THREE.Scene();
  const fallbackBackground = new THREE.Color(0x0b1220);
  scene.background = fallbackBackground;

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
  camera.position.set(5, 3, 8);
  camera.rotation.order = "YXZ";

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.enabled = false;
  transformControls.visible = false;
  scene.add(transformControls);

  const hemiLight = new THREE.HemisphereLight(0xf2f6ff, 0x223344, 0.35);
  scene.add(hemiLight);

  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, 0, 0);
  scene.add(sunTarget);

  const sunLight = new THREE.DirectionalLight(0xfff1df, 3.2);
  sunLight.position.set(80, 120, -4);
  sunLight.target = sunTarget;
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024); // 减小阴影映射大小以提高性能
  sunLight.shadow.bias = -0.00008;
  sunLight.shadow.normalBias = 0.015;
  scene.add(sunLight);

  const shadowGround = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.25 }));
  shadowGround.rotation.x = -Math.PI / 2;
  shadowGround.position.y = 0;
  shadowGround.receiveShadow = true;
  scene.add(shadowGround);

  const sunBillboardMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0xfff2cf) },
      uIntensity: { value: 1.0 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uIntensity;

      float smoothCircle(vec2 uv, float radius, float blur) {
        float d = length(uv - vec2(0.5));
        return 1.0 - smoothstep(radius, radius + blur, d);
      }

      void main() {
        float core = smoothCircle(vUv, 0.16, 0.02);
        float halo = smoothCircle(vUv, 0.48, 0.20);
        float a = clamp(core * 0.9 + halo * 0.35, 0.0, 1.0);
        vec3 col = uColor * (core * 1.1 + halo * 0.55) * uIntensity;
        gl_FragColor = vec4(col, a);
      }
    `
  });
  const sunBillboard = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sunBillboardMaterial);
  sunBillboard.renderOrder = 999;
  scene.add(sunBillboard);

  const grid = new THREE.GridHelper(50, 50, 0x335577, 0x223344);
  grid.position.y = 0.001;
  scene.add(grid);

  const rootGroup = new THREE.Group();
  scene.add(rootGroup);

  const monitorCanvas = document.createElement("canvas");
  monitorCanvas.width = 640;
  monitorCanvas.height = 420;
  const monitorCtx = monitorCanvas.getContext("2d");
  if (!monitorCtx) {
    throw new Error("Monitor canvas context unavailable");
  }
  const monitorCtx2d = monitorCtx;
  const monitorTexture = new THREE.CanvasTexture(monitorCanvas);
  monitorTexture.colorSpace = THREE.SRGBColorSpace;
  const monitorMaterial = new THREE.MeshBasicMaterial({ map: monitorTexture, transparent: true, side: THREE.DoubleSide });
  const monitorGeometry = new THREE.PlaneGeometry(8, 4.5);
  const monitorMesh = new THREE.Mesh(monitorGeometry, monitorMaterial);
  monitorMesh.position.set(-4.22, 3, 4.43);
  monitorMesh.rotation.set(0, -Math.PI / 2, 0);
  monitorMesh.renderOrder = 2;
  rootGroup.add(monitorMesh);

  const objectsById = new Map<string, THREE.Object3D>();
  let importedObjectCount = 0;
  const objectSpecById = new Map<string, ModelSpec>();
  type ImportedAsset = {
    id: string;
    kind: "gltf" | "obj";
    file: File;
    mtlFile?: File;
    name: string;
    createdAt: number;
  };
  const importedAssetsById = new Map<string, ImportedAsset>();
  const importedAssetIdByKey = new Map<string, string>();
  const importedAssetIdByObjectId = new Map<string, string>();

  let socket: WebSocket | null = null;
  let socketState: "disconnected" | "connecting" | "connected" = "disconnected";
  let latestTelemetry: LatestTelemetry | null = null;
  const latestSensorValues = new Map<string, { value: number | boolean; ts: number }>();
  const actuatorStates = new Map<string, boolean>();
  let monitorDirty = true;
  let lastMonitorDraw = 0;
  let rafId = 0;
  let backgroundTexture: THREE.Texture | null = null;
  let environmentTexture: THREE.Texture | null = null;
  const clock = new THREE.Clock();

  type GizmoKind = "point" | "box" | "sphere" | "plane";

  type Gizmo = {
    id: string;
    kind: GizmoKind;
    mesh: THREE.Mesh;
  };

  const gizmoGroup = new THREE.Group();
  scene.add(gizmoGroup);
  const gizmos: Gizmo[] = [];
  let selectedGizmoId: string | null = null;
  let selectedSceneObjectId: string | null = null;
  const selectedSceneObjectIds = new Set<string>();
  let selectedKind: "gizmo" | "scene" | "sceneMulti" | null = null;
  const collapsedGroupIds = new Set<string>();
  const multiSelectProxy = new THREE.Object3D();
  multiSelectProxy.visible = false;
  scene.add(multiSelectProxy);

  const controlsRoot = document.getElementById("controls");
  let engineeringMode = false;
  
  let mixer: THREE.AnimationMixer | null = null;
  const shadeActions: THREE.AnimationAction[] = []; // 遮阳棚相关动画
  const fanActions: THREE.AnimationAction[] = [];
  let isShadeOpen = false;
  let isHighWind = false;
  
  let cameraPosSpan: HTMLSpanElement | null = null;
  let cameraRotSpan: HTMLSpanElement | null = null;
  let cameraPosInputs: HTMLInputElement[] | null = null;
  let cameraRotInputs: HTMLInputElement[] | null = null;
  let gizmoListContainer: HTMLDivElement | null = null;
  let sceneObjectListContainer: HTMLDivElement | null = null;
  let importedAssetListContainer: HTMLDivElement | null = null;
  let gizmoDetailContainer: HTMLDivElement | null = null;
  let gizmoTypeSelect: HTMLSelectElement | null = null;
  let gizmoDetailTitle: HTMLDivElement | null = null;
  let gizmoPosInputs: HTMLInputElement[] | null = null;
  let gizmoRotInputs: HTMLInputElement[] | null = null;
  let gizmoScaleInputs: HTMLInputElement[] | null = null;
  for (const device of ACTUATOR_DEVICES) {
    actuatorStates.set(device.id, false);
  }

  if (controlsRoot) {
    controlsRoot.style.position = "fixed";
    controlsRoot.style.bottom = "20px";
    controlsRoot.style.right = "20px";
    controlsRoot.style.zIndex = "1000";
    
    const cameraContainer = document.createElement("div");
    cameraContainer.style.marginTop = "12px";
    cameraContainer.style.padding = "8px 10px";
    cameraContainer.style.borderRadius = "6px";
    cameraContainer.style.border = "1px solid rgba(148, 163, 184, 0.8)";
    cameraContainer.style.background = "rgba(15, 23, 42, 0.9)";
    cameraContainer.style.display = "flex";
    cameraContainer.style.flexDirection = "column";
    cameraContainer.style.gap = "6px";

    const title = document.createElement("div");
    title.textContent = "当前视角";
    title.style.fontWeight = "600";
    title.style.fontSize = "12px";
    cameraContainer.appendChild(title);

    const posLine = document.createElement("div");
    posLine.style.display = "flex";
    posLine.style.justifyContent = "space-between";
    const posLabel = document.createElement("span");
    posLabel.textContent = "位置";
    cameraPosSpan = document.createElement("span");
    cameraPosSpan.textContent = "x=0 y=0 z=0";
    posLine.appendChild(posLabel);
    posLine.appendChild(cameraPosSpan);
    cameraContainer.appendChild(posLine);

    const rotLine = document.createElement("div");
    rotLine.style.display = "flex";
    rotLine.style.justifyContent = "space-between";
    const rotLabel = document.createElement("span");
    rotLabel.textContent = "旋转(°)";
    cameraRotSpan = document.createElement("span");
    cameraRotSpan.textContent = "x=0 y=0 z=0";
    rotLine.appendChild(rotLabel);
    rotLine.appendChild(cameraRotSpan);
    cameraContainer.appendChild(rotLine);

    const formContainer = document.createElement("div");
    formContainer.style.marginTop = "6px";
    formContainer.style.display = "flex";
    formContainer.style.flexDirection = "column";
    formContainer.style.gap = "4px";

    function createNumberInput(): HTMLInputElement {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.style.width = "80px";
      input.style.background = "rgba(15,23,42,1)";
      input.style.border = "1px solid rgba(51, 65, 85, 1)";
      input.style.color = "#e5e7eb";
      input.style.borderRadius = "4px";
      input.style.padding = "2px 4px";
      input.style.fontSize = "11px";
      return input;
    }

    const posRow = document.createElement("div");
    posRow.style.display = "flex";
    posRow.style.alignItems = "center";
    posRow.style.gap = "4px";
    const posRowLabel = document.createElement("span");
    posRowLabel.textContent = "设置位置";
    posRowLabel.style.minWidth = "60px";
    const posInputX = createNumberInput();
    const posInputY = createNumberInput();
    const posInputZ = createNumberInput();
    posRow.appendChild(posRowLabel);
    posRow.appendChild(posInputX);
    posRow.appendChild(posInputY);
    posRow.appendChild(posInputZ);
    formContainer.appendChild(posRow);

    const rotRow = document.createElement("div");
    rotRow.style.display = "flex";
    rotRow.style.alignItems = "center";
    rotRow.style.gap = "4px";
    const rotRowLabel = document.createElement("span");
    rotRowLabel.textContent = "设置旋转";
    rotRowLabel.style.minWidth = "60px";
    const rotInputX = createNumberInput();
    const rotInputY = createNumberInput();
    const rotInputZ = createNumberInput();
    rotRow.appendChild(rotRowLabel);
    rotRow.appendChild(rotInputX);
    rotRow.appendChild(rotInputY);
    rotRow.appendChild(rotInputZ);
    formContainer.appendChild(rotRow);

    const applyRow = document.createElement("div");
    applyRow.style.display = "flex";
    applyRow.style.justifyContent = "flex-end";
    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.textContent = "应用视角";
    applyButton.style.marginTop = "4px";
    applyButton.style.padding = "3px 10px";
    applyButton.style.borderRadius = "4px";
    applyButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    applyButton.style.background = "rgba(15, 23, 42, 1)";
    applyButton.style.color = "#e5e7eb";
    applyButton.style.fontSize = "11px";
    applyButton.style.cursor = "pointer";
    applyRow.appendChild(applyButton);
    formContainer.appendChild(applyRow);

    cameraContainer.appendChild(formContainer);
    controlsRoot.appendChild(cameraContainer);

    cameraPosInputs = [posInputX, posInputY, posInputZ];
    cameraRotInputs = [rotInputX, rotInputY, rotInputZ];

    function applyCameraFromInputs(): void {
      if (!cameraPosInputs || !cameraRotInputs) return;
      const currentPos = camera.position;
      const currentRot = camera.rotation;

      const px = Number.parseFloat(cameraPosInputs[0]!.value);
      const py = Number.parseFloat(cameraPosInputs[1]!.value);
      const pz = Number.parseFloat(cameraPosInputs[2]!.value);

      const rxDeg = Number.parseFloat(cameraRotInputs[0]!.value);
      const ryDeg = Number.parseFloat(cameraRotInputs[1]!.value);
      const rzDeg = Number.parseFloat(cameraRotInputs[2]!.value);

      const posX = Number.isFinite(px) ? px : currentPos.x;
      const posY = Number.isFinite(py) ? py : currentPos.y;
      const posZ = Number.isFinite(pz) ? pz : currentPos.z;

      const rotX = Number.isFinite(rxDeg) ? THREE.MathUtils.degToRad(rxDeg) : currentRot.x;
      const rotY = Number.isFinite(ryDeg) ? THREE.MathUtils.degToRad(ryDeg) : currentRot.y;
      const rotZ = Number.isFinite(rzDeg) ? THREE.MathUtils.degToRad(rzDeg) : currentRot.z;

      camera.position.set(posX, posY, posZ);
      camera.rotation.set(rotX, rotY, rotZ);
      camera.updateMatrixWorld(true);
      yaw = camera.rotation.y;
      pitch = camera.rotation.x;
    }

    applyButton.addEventListener("click", () => {
      applyCameraFromInputs();
    });

    for (const input of cameraPosInputs) {
      input.addEventListener("input", () => {
        applyCameraFromInputs();
      });
    }
    for (const input of cameraRotInputs) {
      input.addEventListener("input", () => {
        applyCameraFromInputs();
      });
    }

    const gizmoContainer = document.createElement("div");
    gizmoContainer.style.marginTop = "8px";
    gizmoContainer.style.padding = "8px 10px";
    gizmoContainer.style.borderRadius = "6px";
    gizmoContainer.style.border = "1px solid rgba(148, 163, 184, 0.8)";
    gizmoContainer.style.background = "rgba(15, 23, 42, 0.9)";
    gizmoContainer.style.display = "flex";
    gizmoContainer.style.flexDirection = "column";
    gizmoContainer.style.gap = "6px";

    const gizmoTitle = document.createElement("div");
    gizmoTitle.textContent = "测绘物体 / 场景物体";
    gizmoTitle.style.fontWeight = "600";
    gizmoTitle.style.fontSize = "12px";
    gizmoContainer.appendChild(gizmoTitle);

    const typeRow = document.createElement("div");
    typeRow.style.display = "flex";
    typeRow.style.alignItems = "center";
    typeRow.style.gap = "6px";
    const typeLabel = document.createElement("span");
    typeLabel.textContent = "类型";
    typeLabel.style.minWidth = "40px";
    const typeSelect = document.createElement("select");
    typeSelect.style.flex = "1";
    typeSelect.style.background = "rgba(15,23,42,1)";
    typeSelect.style.border = "1px solid rgba(51, 65, 85, 1)";
    typeSelect.style.color = "#e5e7eb";
    typeSelect.style.borderRadius = "4px";
    typeSelect.style.padding = "2px 4px";
    typeSelect.style.fontSize = "11px";

    const optPoint = document.createElement("option");
    optPoint.value = "point";
    optPoint.textContent = "点";
    const optBox = document.createElement("option");
    optBox.value = "box";
    optBox.textContent = "立方体";
    const optSphere = document.createElement("option");
    optSphere.value = "sphere";
    optSphere.textContent = "球体";
    const optPlane = document.createElement("option");
    optPlane.value = "plane";
    optPlane.textContent = "平面";

    typeSelect.appendChild(optPoint);
    typeSelect.appendChild(optBox);
    typeSelect.appendChild(optSphere);
    typeSelect.appendChild(optPlane);

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.textContent = "新增";
    addButton.style.padding = "3px 10px";
    addButton.style.borderRadius = "4px";
    addButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    addButton.style.background = "rgba(15, 23, 42, 1)";
    addButton.style.color = "#e5e7eb";
    addButton.style.fontSize = "11px";
    addButton.style.cursor = "pointer";

    addButton.addEventListener("click", () => {
      const kind = typeSelect.value as GizmoKind;
      addGizmo(kind);
    });

    typeRow.appendChild(typeLabel);
    typeRow.appendChild(typeSelect);
    typeRow.appendChild(addButton);
    gizmoContainer.appendChild(typeRow);

    const sceneListTitle = document.createElement("div");
    sceneListTitle.textContent = "场景物体列表";
    sceneListTitle.style.fontSize = "11px";
    sceneListTitle.style.opacity = "0.9";
    gizmoContainer.appendChild(sceneListTitle);

    const sceneListDiv = document.createElement("div");
    sceneListDiv.style.display = "flex";
    sceneListDiv.style.flexDirection = "column";
    sceneListDiv.style.gap = "4px";
    sceneListDiv.style.marginBottom = "6px";
    gizmoContainer.appendChild(sceneListDiv);

    const listTitle = document.createElement("div");
    listTitle.textContent = "测绘物体列表";
    listTitle.style.fontSize = "11px";
    listTitle.style.opacity = "0.9";
    gizmoContainer.appendChild(listTitle);

    const listDiv = document.createElement("div");
    listDiv.style.display = "flex";
    listDiv.style.flexDirection = "column";
    listDiv.style.gap = "4px";
    gizmoContainer.appendChild(listDiv);

    const detailDiv = document.createElement("div");
    detailDiv.style.display = "flex";
    detailDiv.style.flexDirection = "column";
    detailDiv.style.gap = "4px";
    detailDiv.style.marginTop = "4px";

    const detailTitle = document.createElement("div");
    detailTitle.textContent = "未选中物体";
    detailTitle.style.fontSize = "11px";
    detailTitle.style.opacity = "0.85";
    detailDiv.appendChild(detailTitle);

    const modeRow = document.createElement("div");
    modeRow.style.display = "flex";
    modeRow.style.justifyContent = "flex-end";
    modeRow.style.gap = "6px";

    const translateButton = document.createElement("button");
    translateButton.type = "button";
    translateButton.textContent = "移动";
    translateButton.style.padding = "3px 8px";
    translateButton.style.borderRadius = "4px";
    translateButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    translateButton.style.background = "rgba(15, 23, 42, 1)";
    translateButton.style.color = "#e5e7eb";
    translateButton.style.fontSize = "11px";
    translateButton.style.cursor = "pointer";
    translateButton.addEventListener("click", () => {
      controlMode = "object";
      transformControls.setMode("translate");
      syncTransformControls();
    });

    const rotateButton = document.createElement("button");
    rotateButton.type = "button";
    rotateButton.textContent = "旋转";
    rotateButton.style.padding = "3px 8px";
    rotateButton.style.borderRadius = "4px";
    rotateButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    rotateButton.style.background = "rgba(15, 23, 42, 1)";
    rotateButton.style.color = "#e5e7eb";
    rotateButton.style.fontSize = "11px";
    rotateButton.style.cursor = "pointer";
    rotateButton.addEventListener("click", () => {
      controlMode = "object";
      transformControls.setMode("rotate");
      syncTransformControls();
    });

    const scaleButton = document.createElement("button");
    scaleButton.type = "button";
    scaleButton.textContent = "缩放";
    scaleButton.style.padding = "3px 8px";
    scaleButton.style.borderRadius = "4px";
    scaleButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    scaleButton.style.background = "rgba(15, 23, 42, 1)";
    scaleButton.style.color = "#e5e7eb";
    scaleButton.style.fontSize = "11px";
    scaleButton.style.cursor = "pointer";
    scaleButton.addEventListener("click", () => {
      controlMode = "object";
      transformControls.setMode("scale");
      syncTransformControls();
    });

    modeRow.appendChild(translateButton);
    modeRow.appendChild(rotateButton);
    modeRow.appendChild(scaleButton);
    detailDiv.appendChild(modeRow);

    const gizmoPosRow = document.createElement("div");
    gizmoPosRow.style.display = "flex";
    gizmoPosRow.style.alignItems = "center";
    gizmoPosRow.style.gap = "4px";
    const gizmoPosLabel = document.createElement("span");
    gizmoPosLabel.textContent = "位置";
    gizmoPosLabel.style.minWidth = "60px";
    const gizmoPosX = createNumberInput();
    const gizmoPosY = createNumberInput();
    const gizmoPosZ = createNumberInput();
    gizmoPosRow.appendChild(gizmoPosLabel);
    gizmoPosRow.appendChild(gizmoPosX);
    gizmoPosRow.appendChild(gizmoPosY);
    gizmoPosRow.appendChild(gizmoPosZ);
    detailDiv.appendChild(gizmoPosRow);

    const gizmoRotRow = document.createElement("div");
    gizmoRotRow.style.display = "flex";
    gizmoRotRow.style.alignItems = "center";
    gizmoRotRow.style.gap = "4px";
    const gizmoRotLabel = document.createElement("span");
    gizmoRotLabel.textContent = "旋转(°)";
    gizmoRotLabel.style.minWidth = "60px";
    const gizmoRotX = createNumberInput();
    const gizmoRotY = createNumberInput();
    const gizmoRotZ = createNumberInput();
    gizmoRotRow.appendChild(gizmoRotLabel);
    gizmoRotRow.appendChild(gizmoRotX);
    gizmoRotRow.appendChild(gizmoRotY);
    gizmoRotRow.appendChild(gizmoRotZ);
    detailDiv.appendChild(gizmoRotRow);

    const gizmoScaleRow = document.createElement("div");
    gizmoScaleRow.style.display = "flex";
    gizmoScaleRow.style.alignItems = "center";
    gizmoScaleRow.style.gap = "4px";
    const gizmoScaleLabel = document.createElement("span");
    gizmoScaleLabel.textContent = "缩放";
    gizmoScaleLabel.style.minWidth = "60px";
    const gizmoScaleX = createNumberInput();
    const gizmoScaleY = createNumberInput();
    const gizmoScaleZ = createNumberInput();
    gizmoScaleRow.appendChild(gizmoScaleLabel);
    gizmoScaleRow.appendChild(gizmoScaleX);
    gizmoScaleRow.appendChild(gizmoScaleY);
    gizmoScaleRow.appendChild(gizmoScaleZ);
    detailDiv.appendChild(gizmoScaleRow);

    const gizmoButtonsRow = document.createElement("div");
    gizmoButtonsRow.style.display = "flex";
    gizmoButtonsRow.style.justifyContent = "flex-end";
    gizmoButtonsRow.style.gap = "6px";

    const applyGizmoButton = document.createElement("button");
    applyGizmoButton.type = "button";
    applyGizmoButton.textContent = "应用参数";
    applyGizmoButton.style.padding = "3px 8px";
    applyGizmoButton.style.borderRadius = "4px";
    applyGizmoButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    applyGizmoButton.style.background = "rgba(15, 23, 42, 1)";
    applyGizmoButton.style.color = "#e5e7eb";
    applyGizmoButton.style.fontSize = "11px";
    applyGizmoButton.style.cursor = "pointer";
    applyGizmoButton.addEventListener("click", () => {
      applyGizmoFromInputs();
    });

    const duplicateButton = document.createElement("button");
    duplicateButton.type = "button";
    duplicateButton.textContent = "复制物体";
    duplicateButton.style.padding = "3px 8px";
    duplicateButton.style.borderRadius = "4px";
    duplicateButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    duplicateButton.style.background = "rgba(15, 23, 42, 1)";
    duplicateButton.style.color = "#e5e7eb";
    duplicateButton.style.fontSize = "11px";
    duplicateButton.style.cursor = "pointer";
    duplicateButton.addEventListener("click", () => {
      duplicateSelectedObject();
      const original = duplicateButton.textContent;
      duplicateButton.textContent = "已复制";
      setTimeout(() => {
        duplicateButton.textContent = original;
      }, 600);
    });

    const copySelectedButton = document.createElement("button");
    copySelectedButton.type = "button";
    copySelectedButton.textContent = "复制选中JSON";
    copySelectedButton.style.padding = "3px 8px";
    copySelectedButton.style.borderRadius = "4px";
    copySelectedButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    copySelectedButton.style.background = "rgba(15, 23, 42, 1)";
    copySelectedButton.style.color = "#e5e7eb";
    copySelectedButton.style.fontSize = "11px";
    copySelectedButton.style.cursor = "pointer";
    copySelectedButton.addEventListener("click", () => {
      copySelectedGizmoToClipboard();
      const original = copySelectedButton.textContent;
      copySelectedButton.textContent = "已复制";
      setTimeout(() => {
        copySelectedButton.textContent = original;
      }, 600);
    });

    const copyAllButton = document.createElement("button");
    copyAllButton.type = "button";
    copyAllButton.textContent = "复制全部";
    copyAllButton.style.padding = "3px 8px";
    copyAllButton.style.borderRadius = "4px";
    copyAllButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    copyAllButton.style.background = "rgba(15, 23, 42, 1)";
    copyAllButton.style.color = "#e5e7eb";
    copyAllButton.style.fontSize = "11px";
    copyAllButton.style.cursor = "pointer";
    copyAllButton.addEventListener("click", () => {
      copyAllGizmosToClipboard();
      const original = copyAllButton.textContent;
      copyAllButton.textContent = "已复制";
      setTimeout(() => {
        copyAllButton.textContent = original;
      }, 600);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "删除当前";
    deleteButton.style.padding = "3px 8px";
    deleteButton.style.borderRadius = "4px";
    deleteButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    deleteButton.style.background = "rgba(127, 29, 29, 1)";
    deleteButton.style.color = "#fecaca";
    deleteButton.style.fontSize = "11px";
    deleteButton.style.cursor = "pointer";
    deleteButton.addEventListener("click", () => {
      deleteSelectedObject();
    });

    const groupButton = document.createElement("button");
    groupButton.type = "button";
    groupButton.textContent = "成组";
    groupButton.style.padding = "3px 8px";
    groupButton.style.borderRadius = "4px";
    groupButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    groupButton.style.background = "rgba(15, 23, 42, 1)";
    groupButton.style.color = "#e5e7eb";
    groupButton.style.fontSize = "11px";
    groupButton.style.cursor = "pointer";
    groupButton.addEventListener("click", () => {
      const created = createGroupFromSelection();
      const original = groupButton.textContent;
      groupButton.textContent = created ? "已成组" : "需多选";
      setTimeout(() => {
        groupButton.textContent = original;
      }, 700);
      renderSceneObjectList();
    });

    const ungroupButton = document.createElement("button");
    ungroupButton.type = "button";
    ungroupButton.textContent = "拆组";
    ungroupButton.style.padding = "3px 8px";
    ungroupButton.style.borderRadius = "4px";
    ungroupButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    ungroupButton.style.background = "rgba(15, 23, 42, 1)";
    ungroupButton.style.color = "#e5e7eb";
    ungroupButton.style.fontSize = "11px";
    ungroupButton.style.cursor = "pointer";
    ungroupButton.addEventListener("click", () => {
      const count = ungroupSelectedGroups();
      const original = ungroupButton.textContent;
      ungroupButton.textContent = count > 0 ? "已拆组" : "非组";
      setTimeout(() => {
        ungroupButton.textContent = original;
      }, 700);
      renderSceneObjectList();
    });

    gizmoButtonsRow.appendChild(applyGizmoButton);
    gizmoButtonsRow.appendChild(duplicateButton);
    gizmoButtonsRow.appendChild(copySelectedButton);
    gizmoButtonsRow.appendChild(copyAllButton);
    gizmoButtonsRow.appendChild(deleteButton);
    gizmoButtonsRow.appendChild(groupButton);
    gizmoButtonsRow.appendChild(ungroupButton);
    detailDiv.appendChild(gizmoButtonsRow);

    gizmoContainer.appendChild(detailDiv);
    controlsRoot.appendChild(gizmoContainer);

    const importContainer = document.createElement("div");
    importContainer.style.marginTop = "8px";
    importContainer.style.padding = "8px 10px";
    importContainer.style.borderRadius = "6px";
    importContainer.style.border = "1px solid rgba(148, 163, 184, 0.8)";
    importContainer.style.background = "rgba(15, 23, 42, 0.9)";
    importContainer.style.display = "flex";
    importContainer.style.flexDirection = "column";
    importContainer.style.gap = "6px";

    const importTitle = document.createElement("div");
    importTitle.textContent = "模型导入";
    importTitle.style.fontWeight = "600";
    importTitle.style.fontSize = "12px";
    importContainer.appendChild(importTitle);

    const importRow = document.createElement("div");
    importRow.style.display = "flex";
    importRow.style.flexDirection = "column";
    importRow.style.gap = "4px";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".glb,.gltf,.obj,model/gltf-binary,model/gltf+json";
    fileInput.style.fontSize = "11px";
    fileInput.style.color = "#e5e7eb";
    fileInput.style.cursor = "pointer";
    fileInput.style.display = "none";

    fileInput.addEventListener("change", () => {
      const files = fileInput.files;
      if (!files || files.length === 0) return;
      const file = files[0]!;
      importModelFromFile(file);
      fileInput.value = "";
    });

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "打开模型文件…";
    openButton.style.padding = "3px 10px";
    openButton.style.borderRadius = "4px";
    openButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    openButton.style.background = "rgba(15, 23, 42, 1)";
    openButton.style.color = "#e5e7eb";
    openButton.style.fontSize = "11px";
    openButton.style.cursor = "pointer";
    openButton.addEventListener("click", () => {
      fileInput.click();
    });

    const importHint = document.createElement("div");
    importHint.textContent = "支持 glb / gltf / obj";
    importHint.style.fontSize = "10px";
    importHint.style.opacity = "0.8";

    importRow.appendChild(openButton);
    importRow.appendChild(fileInput);
    importRow.appendChild(importHint);
    importContainer.appendChild(importRow);

    const projectRow = document.createElement("div");
    projectRow.style.display = "flex";
    projectRow.style.justifyContent = "flex-end";
    projectRow.style.gap = "6px";

    const exportProjectButton = document.createElement("button");
    exportProjectButton.type = "button";
    exportProjectButton.textContent = "导出工程包";
    exportProjectButton.style.padding = "3px 10px";
    exportProjectButton.style.borderRadius = "4px";
    exportProjectButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    exportProjectButton.style.background = "rgba(15, 23, 42, 1)";
    exportProjectButton.style.color = "#e5e7eb";
    exportProjectButton.style.fontSize = "11px";
    exportProjectButton.style.cursor = "pointer";

    const importProjectInput = document.createElement("input");
    importProjectInput.type = "file";
    importProjectInput.accept = ".zip,application/zip";
    importProjectInput.style.display = "none";

    const importProjectButton = document.createElement("button");
    importProjectButton.type = "button";
    importProjectButton.textContent = "导入工程包…";
    importProjectButton.style.padding = "3px 10px";
    importProjectButton.style.borderRadius = "4px";
    importProjectButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    importProjectButton.style.background = "rgba(15, 23, 42, 1)";
    importProjectButton.style.color = "#e5e7eb";
    importProjectButton.style.fontSize = "11px";
    importProjectButton.style.cursor = "pointer";
    importProjectButton.addEventListener("click", () => {
      importProjectInput.click();
    });

    importProjectInput.addEventListener("change", () => {
      const files = importProjectInput.files;
      if (!files || files.length === 0) return;
      const f = files[0]!;
      importProjectButton.textContent = "导入中…";
      f.arrayBuffer()
        .then((buf) => importProjectPackage(new Uint8Array(buf)))
        .then(() => {
          importProjectButton.textContent = "已导入";
          setTimeout(() => {
            importProjectButton.textContent = "导入工程包…";
          }, 800);
        })
        .catch(() => {
          importProjectButton.textContent = "导入失败";
          setTimeout(() => {
            importProjectButton.textContent = "导入工程包…";
          }, 1200);
        })
        .finally(() => {
          importProjectInput.value = "";
        });
    });

    exportProjectButton.addEventListener("click", () => {
      const original = exportProjectButton.textContent;
      exportProjectButton.textContent = "导出中…";
      exportProjectPackage()
        .then((bytes) => {
          const blob = new Blob([toOwnedArrayBuffer(bytes)], { type: "application/zip" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = makeProjectFileName();
          a.click();
          setTimeout(() => {
            URL.revokeObjectURL(url);
          }, 1000);
          exportProjectButton.textContent = "已导出";
          setTimeout(() => {
            exportProjectButton.textContent = original;
          }, 800);
        })
        .catch(() => {
          exportProjectButton.textContent = "导出失败";
          setTimeout(() => {
            exportProjectButton.textContent = original;
          }, 1200);
        });
    });

    projectRow.appendChild(importProjectInput);
    projectRow.appendChild(importProjectButton);
    projectRow.appendChild(exportProjectButton);
    importContainer.appendChild(projectRow);

    const assetTitle = document.createElement("div");
    assetTitle.textContent = "模型库";
    assetTitle.style.marginTop = "6px";
    assetTitle.style.fontWeight = "600";
    assetTitle.style.fontSize = "12px";
    importContainer.appendChild(assetTitle);

    const assetListDiv = document.createElement("div");
    assetListDiv.style.display = "flex";
    assetListDiv.style.flexDirection = "column";
    assetListDiv.style.gap = "4px";
    importContainer.appendChild(assetListDiv);
    controlsRoot.appendChild(importContainer);

    gizmoListContainer = listDiv;
    gizmoDetailContainer = detailDiv;
    gizmoTypeSelect = typeSelect;
    sceneObjectListContainer = sceneListDiv;
    importedAssetListContainer = assetListDiv;
    gizmoDetailTitle = detailTitle;
    gizmoPosInputs = [gizmoPosX, gizmoPosY, gizmoPosZ];
    gizmoRotInputs = [gizmoRotX, gizmoRotY, gizmoRotZ];
    gizmoScaleInputs = [gizmoScaleX, gizmoScaleY, gizmoScaleZ];

    if (gizmoPosInputs) {
      for (const input of gizmoPosInputs) {
        input.addEventListener("input", () => {
          applyGizmoFromInputs();
        });
      }
    }
    if (gizmoRotInputs) {
      for (const input of gizmoRotInputs) {
        input.addEventListener("input", () => {
          applyGizmoFromInputs();
        });
      }
    }
    if (gizmoScaleInputs) {
      for (const input of gizmoScaleInputs) {
        input.addEventListener("input", () => {
          applyGizmoFromInputs();
        });
      }
    }

    renderGizmoList();
    renderImportedAssetLibrary();
  }

  const fanRpm = 100;
  const fanRadPerSec = (fanRpm * Math.PI * 2) / 60;

  const pressedCodes = new Set<string>();
  const tempForward = new THREE.Vector3();
  const tempRight = new THREE.Vector3();
  const tempUp = new THREE.Vector3(0, 1, 0);
  const tempMove = new THREE.Vector3();
  const cameraTransitionStartPos = new THREE.Vector3();
  const cameraTransitionMidPos = new THREE.Vector3();
  const cameraTransitionEndPos = new THREE.Vector3();
  const cameraTransitionTempPos = new THREE.Vector3();
  const sunDir = new THREE.Vector3(); // 预创建太阳方向向量
  const cropsPos = new THREE.Vector3(); // 预创建作物位置向量
  const screenPos = new THREE.Vector3(); // 预创建屏幕位置向量
  let lastUiUpdate = 0; // UI更新时间戳
  const uiUpdateInterval = 100; // UI更新间隔(ms)
  let isPointerDown = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let yaw = camera.rotation.y;
  let pitch = camera.rotation.x;
  const maxPitch = THREE.MathUtils.degToRad(89);
  const lookSensitivity = 0.0025;
  let cameraTransitionActive = false;
  let cameraTransitionDuration = 1;
  let cameraTransitionElapsed = 0;
  let cameraTransitionStartYaw = 0;
  let cameraTransitionStartPitch = 0;
  let cameraTransitionEndYaw = 0;
  let cameraTransitionEndPitch = 0;
  type ControlMode = "camera" | "object";
  let controlMode: ControlMode = "camera";
  let transformDragging = false;
  let multiDragStartProxyPos = new THREE.Vector3();
  const multiDragStartById = new Map<string, THREE.Vector3>();

  let cameraInputEnabled = true;
  let cameraPanelRoot: HTMLDivElement | null = null;
  let cameraModeSpan: HTMLSpanElement | null = null;
  let cameraLockButton: HTMLButtonElement | null = null;
  
  // 数据卡片相关
  let dataCard: HTMLDivElement | null = null;
  let dataCardVisible = false;
  let cropsObject: THREE.Object3D | null = null;

  // 顶部控制栏和功能面板
  let topControls: HTMLDivElement | null = null;
  let functionPanels: HTMLDivElement[] = [];

  function setHudText(text: string): void {
    options.hud.textContent = text;
  }

  function createTopControls() {
    // 先添加CSS样式，确保样式在元素创建前已加载
    const style = document.createElement('style');
    style.textContent = `
      #top-controls {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1000;
        background: rgba(15, 23, 42, 0.9);
        padding: 10px 20px;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.8);
      }
      
      .control-buttons {
        display: flex;
        gap: 10px;
      }
      
      .control-btn {
        padding: 8px 16px;
        border: 1px solid rgba(148, 163, 184, 0.9);
        background: rgba(15, 23, 42, 1);
        color: #e5e7eb;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.3s ease;
      }
      
      .control-btn:hover {
        background: rgba(30, 41, 59, 1);
      }
      
      .control-btn.active {
        background: rgba(59, 130, 246, 0.8);
        border-color: rgba(59, 130, 246, 1);
      }
      
      #function-panels {
        position: fixed;
        top: 80px;
        right: 20px;
        z-index: 999;
        width: 300px;
      }
      
      .function-panel {
        background: rgba(15, 23, 42, 0.95);
        border: 1px solid rgba(148, 163, 184, 0.8);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 10px;
        display: none;
      }
      
      .function-panel.active {
        display: block;
      }
      
      .function-panel h3 {
        margin-top: 0;
        color: #e5e7eb;
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 12px;
      }
      
      .panel-content {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      
      .data-card {
        background: rgba(30, 41, 59, 0.8);
        padding: 12px;
        border-radius: 6px;
        border: 1px solid rgba(51, 65, 85, 1);
      }
      
      .data-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      
      .data-icon {
        width: 16px;
        height: 16px;
        object-fit: contain;
      }
      
      .data-card h4 {
        margin: 0;
        color: #94a3b8;
        font-size: 12px;
        font-weight: 500;
      }
      
      .data-value {
        color: #e5e7eb;
        font-size: 18px;
        font-weight: 600;
        margin-bottom: 4px;
      }
      
      .threshold-warning {
        font-size: 10px;
        color: #94a3b8;
        margin-bottom: 8px;
      }
      
      .threshold-warning.warning {
        color: #f59e0b;
      }
      
      .threshold-warning.error {
        color: #ef4444;
      }
      
      .trend-chart {
        margin-bottom: 8px;
      }
      
      .chart-canvas {
        width: 100%;
        height: 100px;
        background: rgba(30, 41, 59, 0.5);
        border-radius: 4px;
      }
      
      .time-range {
        display: flex;
        gap: 4px;
      }
      
      .time-btn {
        flex: 1;
        padding: 4px 8px;
        border: 1px solid rgba(148, 163, 184, 0.6);
        background: rgba(30, 41, 59, 0.8);
        color: #94a3b8;
        border-radius: 4px;
        cursor: pointer;
        font-size: 10px;
        transition: all 0.3s ease;
      }
      
      .time-btn:hover {
        background: rgba(51, 65, 85, 0.8);
      }
      
      .time-btn.active {
        background: rgba(59, 130, 246, 0.8);
        border-color: rgba(59, 130, 246, 1);
        color: #e5e7eb;
      }
      
      .crop-item, .device-item {
        background: rgba(30, 41, 59, 0.8);
        padding: 12px;
        border-radius: 6px;
        border: 1px solid rgba(51, 65, 85, 1);
      }
      
      .crop-item h4, .device-item h4 {
        margin: 0 0 8px 0;
        color: #94a3b8;
        font-size: 12px;
        font-weight: 500;
      }
      
      .crop-info {
        color: #e5e7eb;
        font-size: 11px;
        line-height: 1.4;
      }
      
      .device-control {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      
      .device-control span {
        color: #94a3b8;
        font-size: 11px;
      }
      
      .toggle-switch {
        width: 40px;
        height: auto;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      
      .toggle-switch:hover {
        opacity: 0.8;
      }
    `;
    document.head.appendChild(style);

    // 创建顶部控制栏
    topControls = document.createElement('div');
    topControls.id = 'top-controls';
    topControls.innerHTML = `
      <div class="control-buttons">
        <button class="control-btn active" data-panel="environment">环境监测</button>
        <button class="control-btn" data-panel="crops">作物管理</button>
        <button class="control-btn" data-panel="devices">设备管理</button>
        <button class="control-btn" id="day-night-toggle">日/夜模式</button>
      </div>
    `;
    document.body.appendChild(topControls);

    // 创建功能面板容器
    const panelsContainer = document.createElement('div');
    panelsContainer.id = 'function-panels';
    document.body.appendChild(panelsContainer);

    // 创建环境监测面板
    const environmentPanel = document.createElement('div');
    environmentPanel.id = 'environment-panel';
    environmentPanel.className = 'function-panel active';
    environmentPanel.innerHTML = `
      <h3>环境监测与控制</h3>
      <div class="panel-content">
        <div class="data-card">
          <div class="data-header">
            <img src="/大气温度.png" class="data-icon" alt="温度">
            <h4>温度</h4>
          </div>
          <div class="data-value">25.5°C</div>
          <div class="threshold-warning">
            <span>阈值: 15-30°C</span>
          </div>
          <div class="trend-chart">
            <canvas class="chart-canvas" width="260" height="100"></canvas>
          </div>
          <div class="time-range">
            <button class="time-btn active">1小时</button>
            <button class="time-btn">24小时</button>
            <button class="time-btn">7天</button>
          </div>
        </div>
        <div class="data-card">
          <div class="data-header">
            <img src="/土壤湿度.png" class="data-icon" alt="湿度">
            <h4>湿度</h4>
          </div>
          <div class="data-value">65%</div>
          <div class="threshold-warning">
            <span>阈值: 40-70%</span>
          </div>
          <div class="trend-chart">
            <canvas class="chart-canvas" width="260" height="100"></canvas>
          </div>
          <div class="time-range">
            <button class="time-btn active">1小时</button>
            <button class="time-btn">24小时</button>
            <button class="time-btn">7天</button>
          </div>
        </div>
        <div class="data-card">
          <div class="data-header">
            <img src="/co2.png" class="data-icon" alt="CO2">
            <h4>CO2</h4>
          </div>
          <div class="data-value">450ppm</div>
          <div class="threshold-warning">
            <span>阈值: 300-1000ppm</span>
          </div>
          <div class="trend-chart">
            <canvas class="chart-canvas" width="260" height="100"></canvas>
          </div>
          <div class="time-range">
            <button class="time-btn active">1小时</button>
            <button class="time-btn">24小时</button>
            <button class="time-btn">7天</button>
          </div>
        </div>
      </div>
    `;
    panelsContainer.appendChild(environmentPanel);

    // 创建作物管理面板
    const cropsPanel = document.createElement('div');
    cropsPanel.id = 'crops-panel';
    cropsPanel.className = 'function-panel';
    cropsPanel.innerHTML = `
      <h3>作物管理</h3>
      <div class="panel-content">
        <div class="crop-item">
          <h4>番茄</h4>
          <div class="crop-info">
            <div>生长阶段: 结果期</div>
            <div>土壤湿度: 60%</div>
            <div>PH值: 6.5</div>
          </div>
        </div>
        <div class="crop-item">
          <h4>萝卜</h4>
          <div class="crop-info">
            <div>生长阶段: 肉质根膨大期</div>
            <div>土壤湿度: 70%</div>
            <div>PH值: 6.2</div>
          </div>
        </div>
        <div class="crop-item">
          <h4>南瓜</h4>
          <div class="crop-info">
            <div>生长阶段: 坐果期</div>
            <div>土壤湿度: 65%</div>
            <div>PH值: 6.0</div>
          </div>
        </div>
        <div class="crop-item">
          <h4>毛豆</h4>
          <div class="crop-info">
            <div>生长阶段: 结荚期</div>
            <div>土壤湿度: 55%</div>
            <div>PH值: 6.8</div>
          </div>
        </div>
      </div>
    `;
    panelsContainer.appendChild(cropsPanel);

    // 创建设备管理面板
    const devicesPanel = document.createElement('div');
    devicesPanel.id = 'devices-panel';
    devicesPanel.className = 'function-panel';
    devicesPanel.innerHTML = `
      <h3>设备管理</h3>
      <div class="panel-content">
        <div class="device-item">
          <h4>遮阳棚</h4>
          <div class="device-control">
            <span>打开/关闭：</span>
            <img id="shade-btn" class="toggle-switch" src="/开关1.png" alt="开关">
          </div>
        </div>
        <div class="device-item">
          <h4>风机</h4>
          <div class="device-control">
            <span>正常/大风：</span>
            <img id="wind-btn" class="toggle-switch" src="/开关1.png" alt="开关">
          </div>
        </div>
      </div>
    `;
    panelsContainer.appendChild(devicesPanel);

    // 存储功能面板引用
    functionPanels = [environmentPanel, cropsPanel, devicesPanel];

    // 立即绑定事件监听器（使用内联样式后无需等待CSS加载）
    const bindControlEvents = () => {
      // 添加按钮点击事件
      const controlButtons = document.querySelectorAll('.control-btn');
      controlButtons.forEach(button => {
        button.addEventListener('click', () => {
          const targetPanel = button.getAttribute('data-panel');
          
          // 更新按钮状态
          controlButtons.forEach(btn => btn.classList.remove('active'));
          button.classList.add('active');
          
          // 隐藏所有功能面板
          const allPanels = document.querySelectorAll('.function-panel');
          allPanels.forEach(panel => {
            panel.classList.remove('active');
            (panel as HTMLElement).style.display = 'none';
          });
          
          // 显示目标面板
          const targetElement = document.getElementById(`${targetPanel}-panel`);
          if (targetElement) {
            targetElement.classList.add('active');
            targetElement.style.display = 'block';
          }
        });
      });

      // 设备控制按钮事件
      const shadeBtn = document.getElementById('shade-btn') as HTMLImageElement;
      const windBtn = document.getElementById('wind-btn') as HTMLImageElement;
      
      // 日夜切换按钮事件
      const dayNightToggle = document.getElementById('day-night-toggle');
      if (dayNightToggle) {
        dayNightToggle.addEventListener('click', toggleDayNight);
      }

      if (shadeBtn) {
        shadeBtn.addEventListener('click', () => {
          isShadeOpen = !isShadeOpen;
          // 切换开关图片
          shadeBtn.src = isShadeOpen ? '/开关2.png' : '/开关1.png';
          
          // 控制遮阳棚动画
          if (isShadeOpen) {
            // 打开遮阳棚
            shadeActions.forEach(action => {
              action.reset();
              action.timeScale = 1;
              action.paused = false;
              action.play();
              
              const clip = action.getClip();
              if (clip) {
                const openTime = clip.duration / 2;
                const checkOpenState = () => {
                  if (action.time >= openTime) {
                    action.paused = true;
                    action.time = openTime;
                  } else {
                    requestAnimationFrame(checkOpenState);
                  }
                };
                checkOpenState();
              }
            });
          } else {
            // 关闭遮阳棚
            shadeActions.forEach(action => {
              action.reset();
              action.time = action.getClip()?.duration / 2 || 0;
              action.timeScale = 1;
              action.paused = false;
              action.play();
              
              const clip = action.getClip();
              if (clip) {
                const closeTime = clip.duration;
                const checkCloseState = () => {
                  if (action.time >= closeTime) {
                    action.paused = true;
                    action.time = 0;
                  } else {
                    requestAnimationFrame(checkCloseState);
                  }
                };
                checkCloseState();
              }
            });
          }
        });
      }

      if (windBtn) {
        windBtn.addEventListener('click', () => {
          isHighWind = !isHighWind;
          // 切换开关图片
          windBtn.src = isHighWind ? '/开关2.png' : '/开关1.png';
          // 控制风机速度
          fanActions.forEach(a => a.timeScale = isHighWind ? 3 : 1);
        });
      }

      // 环境监测功能
      function initEnvironmentMonitoring() {
        // 绘制趋势图表
        function drawTrendChart(canvas: HTMLCanvasElement, data: number[], color: string) {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          const width = canvas.width;
          const height = canvas.height;
          const padding = 10;
          const innerWidth = width - padding * 2;
          const innerHeight = height - padding * 2;

          ctx.clearRect(0, 0, width, height);

          // 计算数据范围
          const min = Math.min(...data);
          const max = Math.max(...data);
          const range = max - min || 1;

          // 绘制网格
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
          ctx.lineWidth = 1;
          
          // 水平网格线
          for (let i = 0; i <= 4; i++) {
            const y = padding + (i / 4) * innerHeight;
            ctx.beginPath();
            ctx.moveTo(padding, y);
            ctx.lineTo(width - padding, y);
            ctx.stroke();
          }

          // 垂直网格线
          for (let i = 0; i <= 6; i++) {
            const x = padding + (i / 6) * innerWidth;
            ctx.beginPath();
            ctx.moveTo(x, padding);
            ctx.lineTo(x, height - padding);
            ctx.stroke();
          }

          // 绘制数据线条
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();

          data.forEach((value, index) => {
            const x = padding + (index / (data.length - 1)) * innerWidth;
            const y = padding + innerHeight - ((value - min) / range) * innerHeight;

            if (index === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }
          });

          ctx.stroke();

          // 绘制数据点
          ctx.fillStyle = color;
          data.forEach((value, index) => {
            const x = padding + (index / (data.length - 1)) * innerWidth;
            const y = padding + innerHeight - ((value - min) / range) * innerHeight;

            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
          });
        }

        // 生成模拟数据
        function generateMockData(length: number, base: number, variance: number) {
          return Array.from({ length }, () => base + (Math.random() - 0.5) * variance);
        }

        // 初始化图表
        const chartCanvases = document.querySelectorAll('.chart-canvas');
        chartCanvases.forEach((canvas, index) => {
          let data: number[];
          let color: string;

          switch (index % 3) {
            case 0: // 温度
              data = generateMockData(20, 25.5, 2);
              color = '#ef4444';
              break;
            case 1: // 湿度
              data = generateMockData(20, 65, 5);
              color = '#3b82f6';
              break;
            case 2: // CO2
              data = generateMockData(20, 450, 50);
              color = '#10b981';
              break;
            default:
              data = generateMockData(20, 50, 10);
              color = '#6366f1';
          }

          drawTrendChart(canvas as HTMLCanvasElement, data, color);
        });

        // 时间范围切换
        const timeBtns = document.querySelectorAll('.time-btn');
        timeBtns.forEach(btn => {
          btn.addEventListener('click', () => {
            timeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // 可以根据选择的时间范围重新生成数据并更新图表
            const timeRange = btn.textContent;
            console.log('Selected time range:', timeRange);

            const chartCanvases = document.querySelectorAll('.chart-canvas');
            chartCanvases.forEach((canvas, index) => {
              let data: number[];
              let color: string;

              switch (index % 3) {
                case 0: // 温度
                  data = generateMockData(20, 25.5, 2);
                  color = '#ef4444';
                  break;
                case 1: // 湿度
                  data = generateMockData(20, 65, 5);
                  color = '#3b82f6';
                  break;
                case 2: // CO2
                  data = generateMockData(20, 450, 50);
                  color = '#10b981';
                  break;
                default:
                  data = generateMockData(20, 50, 10);
                  color = '#6366f1';
              }

              drawTrendChart(canvas as HTMLCanvasElement, data, color);
            });
          });
        });

        function checkThresholds() {
          // 这里可以根据实际数据检查阈值
          const mockData = [
            { value: 25.5, min: 15, max: 30, element: document.querySelectorAll('.threshold-warning')[0] },
            { value: 65, min: 40, max: 70, element: document.querySelectorAll('.threshold-warning')[1] },
            { value: 450, min: 300, max: 1000, element: document.querySelectorAll('.threshold-warning')[2] }
          ];

          mockData.forEach(item => {
            const { value, min, max, element } = item;
            if (!element) return;

            // 移除所有警告类
            element.classList.remove('warning', 'error');

            // 检查阈值
            if (value < min || value > max) {
              element.classList.add('error');
            } else if (value < min + (max - min) * 0.1 || value > max - (max - min) * 0.1) {
              element.classList.add('warning');
            }
          });
        }

        // 初始检查阈值
        checkThresholds();
      }

      // 初始化环境监测功能
      initEnvironmentMonitoring();
    };
    
    bindControlEvents();
  }

  // 日夜切换功能
  let isDaytime = true;
  
  async function loadSkyBoxTexture(url: string): Promise<void> {
    try {
      const textureLoader = new THREE.TextureLoader();
      const texture = await new Promise<THREE.Texture>((resolve, reject) => {
        textureLoader.load(
          url,
          resolve,
          undefined,
          reject
        );
      });
      
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      scene.background = texture;
      backgroundTexture = texture;

      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const env = pmrem.fromEquirectangular(texture).texture;
      scene.environment = env;
      environmentTexture = env;
      pmrem.dispose();
    } catch (error) {
      console.error('Failed to load skybox texture:', error);
    }
  }
  
  function toggleDayNight() {
    isDaytime = !isDaytime;
    
    // 切换天空盒
    if (isDaytime) {
      loadSkyBoxTexture('/sky.jpg'); 
    } else {
      loadSkyBoxTexture('/sky_evening.png'); 
    }
    
    // 调整太阳光
    if (isDaytime) {
      sunLight.intensity = 3.2;
      sunLight.color.set(0xfff1df); // 白天阳光色
      sunBillboard.visible = true;
    } else {
      sunLight.intensity = 2.5; // 增加月光强度
      sunLight.color.set(0x8899cc); 
      sunBillboard.visible = false;
    }
    
    // 调整环境光
    if (isDaytime) {
      hemiLight.intensity = 0.35;
      hemiLight.color.set(0xf2f6ff); // 白天环境光
      hemiLight.groundColor.set(0x223344);
    } else {
      hemiLight.intensity = 0.3; 
      hemiLight.color.set(0x445577);
      hemiLight.groundColor.set(0x222233);
    }
    
    // 按钮状态
    const toggleBtn = document.getElementById('day-night-toggle');
    if (toggleBtn) {
      toggleBtn.textContent = isDaytime ? '日/夜模式' : '夜/日模式';
      toggleBtn.classList.toggle('active', !isDaytime);
    }
  }

  function setCameraInputEnabled(enabled: boolean): void {
    cameraInputEnabled = enabled;
    if (!enabled) {
      pressedCodes.clear();
      isPointerDown = false;
    }
    if (cameraModeSpan) {
      cameraModeSpan.textContent = enabled ? "模式: 自由" : "模式: 锁定";
    }
    if (cameraLockButton) {
      cameraLockButton.textContent = enabled ? "切换为锁定" : "切换为自由";
    }
  }

  // 创建温室介绍面板
  const greenhouseIntroPanel = document.createElement("div");
  greenhouseIntroPanel.style.position = "fixed";
  greenhouseIntroPanel.style.left = "20px";
  greenhouseIntroPanel.style.top = "100px";
  greenhouseIntroPanel.style.padding = "20px";
  greenhouseIntroPanel.style.borderRadius = "8px";
  greenhouseIntroPanel.style.background = "rgba(15, 23, 42, 0.95)";
  greenhouseIntroPanel.style.color = "#e5e7eb";
  greenhouseIntroPanel.style.fontFamily =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  greenhouseIntroPanel.style.fontSize = "12px";
  greenhouseIntroPanel.style.lineHeight = "1.4";
  greenhouseIntroPanel.style.pointerEvents = "auto";
  greenhouseIntroPanel.style.userSelect = "none";
  greenhouseIntroPanel.style.width = "350px";
  greenhouseIntroPanel.style.zIndex = "999";
  greenhouseIntroPanel.style.background = "rgba(15, 23, 42, 0.95)";
  greenhouseIntroPanel.style.backgroundImage = "url('/科技风面板背景.png')";
  greenhouseIntroPanel.style.backgroundSize =  "100% 100%"
  greenhouseIntroPanel.style.backgroundPosition = "center";
  greenhouseIntroPanel.style.backgroundRepeat = "no-repeat";

  const introTitle = document.createElement("div");
  introTitle.textContent = "智能工业温室系统介绍";
  introTitle.style.fontWeight = "700";
  introTitle.style.fontSize = "16px";
  introTitle.style.marginBottom = "12px";
  introTitle.style.textAlign = "left";
  greenhouseIntroPanel.appendChild(introTitle);

  const introImage = document.createElement("img");
  introImage.src = "/protected cultivation.jpg";
  introImage.style.width = "100%";
  introImage.style.borderRadius = "4px";
  introImage.style.marginBottom = "8px";
  greenhouseIntroPanel.appendChild(introImage);

  const introText = document.createElement("div");
  introText.textContent = "本项目打造的智能工业温室是一个融合现代信息技术与传统农业的创新解决方案，通过数字孪生技术实现对温室环境的全方位监测、控制与优化";
  introText.style.lineHeight = "1.5";
  greenhouseIntroPanel.appendChild(introText);

  document.body.appendChild(greenhouseIntroPanel);

  // 立即检查当前路由，如果是协议仪表盘则隐藏面板
  const currentPath = window.location.pathname;
  const currentHash = window.location.hash;
  if (currentPath.includes("/protocol") || currentHash.startsWith("#/protocol")) {
    greenhouseIntroPanel.style.display = "none";
  }

  if (!cameraPanelRoot) {
    cameraPanelRoot = document.createElement("div");
    cameraPanelRoot.style.position = "fixed";
    cameraPanelRoot.style.left = "12px";
    cameraPanelRoot.style.bottom = "12px";
    cameraPanelRoot.style.padding = "8px 10px";
    cameraPanelRoot.style.borderRadius = "8px";
    cameraPanelRoot.style.background = "rgba(0, 0, 0, 0.6)";
    cameraPanelRoot.style.color = "#fff";
    cameraPanelRoot.style.fontFamily =
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    cameraPanelRoot.style.fontSize = "12px";
    cameraPanelRoot.style.lineHeight = "1.4";
    cameraPanelRoot.style.pointerEvents = "auto";
    cameraPanelRoot.style.userSelect = "none";
    cameraPanelRoot.style.maxWidth = "260px";
    cameraPanelRoot.style.zIndex = "20";

    const title = document.createElement("div");
    title.textContent = "视角控制";
    title.style.fontWeight = "600";
    title.style.marginBottom = "4px";
    cameraPanelRoot.appendChild(title);

    const modeRow = document.createElement("div");
    modeRow.style.display = "flex";
    modeRow.style.alignItems = "center";
    modeRow.style.justifyContent = "space-between";
    modeRow.style.gap = "8px";

    cameraModeSpan = document.createElement("span");
    cameraModeSpan.textContent = "模式: 自由";

    cameraLockButton = document.createElement("button");
    cameraLockButton.type = "button";
    cameraLockButton.style.padding = "2px 8px";
    cameraLockButton.style.borderRadius = "4px";
    cameraLockButton.style.border = "1px solid rgba(148, 163, 184, 0.9)";
    cameraLockButton.style.background = "rgba(15, 23, 42, 1)";
    cameraLockButton.style.color = "#e5e7eb";
    cameraLockButton.style.fontSize = "11px";
    cameraLockButton.style.cursor = "pointer";
    cameraLockButton.addEventListener("click", () => {
      setCameraInputEnabled(!cameraInputEnabled);
    });

    modeRow.appendChild(cameraModeSpan);
    modeRow.appendChild(cameraLockButton);
    cameraPanelRoot.appendChild(modeRow);

    const presetsContainer = document.createElement("div");
    presetsContainer.style.display = "flex";
    presetsContainer.style.flexDirection = "column";
    presetsContainer.style.gap = "4px";
    presetsContainer.style.marginTop = "6px";

    function createPresetButton(
      label: string,
      position: [number, number, number],
      rotationDeg: [number, number, number]
    ): HTMLDivElement {
      const btn = document.createElement("div");
      btn.textContent = label;
      btn.style.padding = "2px 8px";
      btn.style.borderRadius = "4px";
      btn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      btn.style.background = "rgba(15, 23, 42, 1)";
      btn.style.color = "#e5e7eb";
      btn.style.fontSize = "11px";
      btn.style.cursor = "pointer";
      btn.style.textAlign = "left";
      btn.addEventListener("click", () => {
        applyCameraPreset(position, rotationDeg);
      });
      return btn;
    }

    const btnMonitor = createPresetButton("传感器监视面板", [-12, 3, 4.3], [0, -90, 0]);
    const btnTop = createPresetButton("俯视角", [0, 14, 1.7], [-90, 90, 0]);
    const btnInside = createPresetButton("大棚内视角", [0, 1.4, 1.7], [-27, 0, 0]);

    presetsContainer.appendChild(btnMonitor);
    presetsContainer.appendChild(btnTop);
    presetsContainer.appendChild(btnInside);
    cameraPanelRoot.appendChild(presetsContainer);

    document.body.appendChild(cameraPanelRoot);
    setCameraInputEnabled(true);
    
    // 创建数据卡片
    dataCard = document.createElement("div");
    dataCard.style.position = "fixed";
    dataCard.style.background = "rgba(15, 23, 42, 0.9)";
    dataCard.style.border = "1px solid rgba(148, 163, 184, 0.8)";
    dataCard.style.borderRadius = "6px";
    dataCard.style.padding = "10px";
    dataCard.style.color = "#e5e7eb";
    dataCard.style.fontSize = "11px";
    dataCard.style.zIndex = "1000";
    dataCard.style.display = "none";
    dataCard.style.pointerEvents = "auto";
    dataCard.style.minWidth = "150px";
    
    // 数据卡片内容
    const cardTitle = document.createElement("div");
    cardTitle.textContent = "作物信息";
    cardTitle.style.fontWeight = "600";
    cardTitle.style.marginBottom = "6px";
    dataCard.appendChild(cardTitle);
    
    const varietyRow = document.createElement("div");
    varietyRow.style.display = "flex";
    varietyRow.style.justifyContent = "space-between";
    varietyRow.style.marginBottom = "3px";
    varietyRow.innerHTML = "<span>品种：</span><span>番茄</span>";
    dataCard.appendChild(varietyRow);
    
    const stageRow = document.createElement("div");
    stageRow.style.display = "flex";
    stageRow.style.justifyContent = "space-between";
    stageRow.style.marginBottom = "3px";
    stageRow.innerHTML = "<span>生长阶段：</span><span>结果期</span>";
    dataCard.appendChild(stageRow);
    
    const humidityRow = document.createElement("div");
    humidityRow.style.display = "flex";
    humidityRow.style.justifyContent = "space-between";
    humidityRow.style.marginBottom = "3px";
    humidityRow.innerHTML = "<span>土壤湿度：</span><span>65%</span>";
    dataCard.appendChild(humidityRow);
    
    const phRow = document.createElement("div");
    phRow.style.display = "flex";
    phRow.style.justifyContent = "space-between";
    phRow.innerHTML = "<span>PH值：</span><span>6.5</span>";
    dataCard.appendChild(phRow);
    
    document.body.appendChild(dataCard);
    
    // 点击空白区域收起数据卡片
    document.addEventListener("click", (e) => {
      if (dataCard && !dataCard.contains(e.target as Node) && e.target !== cropsObject) {
        dataCard.style.display = "none";
        dataCardVisible = false;
      }
    });
  }

  type MonitorButton = {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
  };
  const monitorButtons: MonitorButton[] = [];

  function formatSensorValue(device: (typeof SENSOR_DEVICES)[number], entry: { value: number | boolean; ts: number } | undefined): string {
    if (!entry) return "-";
    const v = entry.value;
    if (typeof v === "boolean") return v ? "有" : "无";
    if (!Number.isFinite(v)) return "-";
    const numText = Number.isInteger(v) ? String(v) : v.toFixed(2);
    const unitText = device.unit ? ` ${device.unit}` : "";
    return `${numText}${unitText}`;
  }

  function drawMonitor(): void {
    const ctx = monitorCtx2d;
    const w = monitorCanvas.width;
    const h = monitorCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(8, 12, 20, 0.88)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(56, 189, 248, 0.6)";
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "600 18px \"Segoe UI\", sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("传感器监视器", 24, 34);
    ctx.font = "12px \"Segoe UI\", sans-serif";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(`socket: ${socketState}`, 24, 54);
    let latestTs = 0;
    for (const v of latestSensorValues.values()) latestTs = Math.max(latestTs, v.ts);
    const timeText = latestTs ? new Date(latestTs).toLocaleTimeString() : "-";
    ctx.fillText(`更新时间: ${timeText}`, 24, 70);

    const startY = 96;
    const rowH = 22;
    const colWidth = (w - 48) / 2;
    ctx.font = "13px \"Segoe UI\", sans-serif";
    for (let i = 0; i < SENSOR_DEVICES.length; i += 1) {
      const device = SENSOR_DEVICES[i]!;
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 24 + col * colWidth;
      const y = startY + row * rowH;
      const entry = latestSensorValues.get(device.id);
      const valueText = formatSensorValue(device, entry);
      ctx.fillStyle = "#e2e8f0";
      ctx.textAlign = "left";
      ctx.fillText(`${device.icon} ${device.name}`, x, y);
      ctx.fillStyle = entry ? "#38bdf8" : "#64748b";
      ctx.textAlign = "right";
      ctx.fillText(valueText, x + colWidth - 10, y);
    }

    const controlTop = startY + rowH * Math.ceil(SENSOR_DEVICES.length / 2) + 18;
    ctx.fillStyle = "#e2e8f0";
    ctx.textAlign = "left";
    ctx.font = "600 14px \"Segoe UI\", sans-serif";
    ctx.fillText("设备控制", 24, controlTop);

    monitorButtons.length = 0;
    const buttonW = (w - 56) / 2;
    const buttonH = 26;
    const buttonGapY = 10;
    ctx.font = "12px \"Segoe UI\", sans-serif";
    for (let i = 0; i < ACTUATOR_DEVICES.length; i += 1) {
      const device = ACTUATOR_DEVICES[i]!;
      const row = Math.floor(i / 2);
      const col = i % 2;
      const x = 24 + col * (buttonW + 8);
      const y = controlTop + 16 + row * (buttonH + buttonGapY);
      const active = actuatorStates.get(device.id) === true;
      ctx.fillStyle = active ? "rgba(16, 185, 129, 0.25)" : "rgba(51, 65, 85, 0.35)";
      ctx.strokeStyle = active ? "rgba(16, 185, 129, 0.8)" : "rgba(148, 163, 184, 0.6)";
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, buttonW, buttonH);
      ctx.strokeRect(x, y, buttonW, buttonH);
      ctx.fillStyle = "#e2e8f0";
      ctx.textAlign = "left";
      ctx.fillText(`${device.icon} ${device.name}`, x + 8, y + 17);
      ctx.textAlign = "right";
      const stateText = device.control.kind === "trigger" ? "触发" : active ? "开" : "关";
      ctx.fillStyle = active ? "#34d399" : "#94a3b8";
      ctx.fillText(stateText, x + buttonW - 8, y + 17);
      monitorButtons.push({ id: device.id, x, y, w: buttonW, h: buttonH });
    }
    monitorTexture.needsUpdate = true;
  }

  function createLoadingOverlay(): {
    show(title: string, items: Array<{ key: string; label: string }>): void;
    hide(): void;
    setProgress(key: string, loaded: number, total: number): void;
    setDone(key: string): void;
    setError(key: string, message?: string): void;
    dispose(): void;
  } {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(2, 6, 23, 0.92)";
    overlay.style.zIndex = "9999";
    overlay.style.display = "none";
    overlay.style.pointerEvents = "auto";

    const panel = document.createElement("div");
    panel.style.position = "absolute";
    panel.style.left = "50%";
    panel.style.top = "50%";
    panel.style.transform = "translate(-50%, -50%)";
    panel.style.width = "min(720px, calc(100vw - 48px))";
    panel.style.maxHeight = "min(640px, calc(100vh - 48px))";
    panel.style.overflow = "auto";
    panel.style.padding = "14px 14px";
    panel.style.borderRadius = "10px";
    panel.style.border = "1px solid rgba(148, 163, 184, 0.35)";
    panel.style.background = "rgba(15, 23, 42, 0.95)";
    panel.style.color = "#e5e7eb";
    panel.style.fontFamily =
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    overlay.appendChild(panel);

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "10px";
    panel.appendChild(header);

    const titleEl = document.createElement("div");
    titleEl.style.fontWeight = "700";
    titleEl.style.fontSize = "13px";
    titleEl.textContent = "Loading…";
    header.appendChild(titleEl);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "关闭";
    closeBtn.style.padding = "4px 10px";
    closeBtn.style.borderRadius = "6px";
    closeBtn.style.border = "1px solid rgba(148, 163, 184, 0.7)";
    closeBtn.style.background = "rgba(15, 23, 42, 1)";
    closeBtn.style.color = "#e5e7eb";
    closeBtn.style.fontSize = "11px";
    closeBtn.style.cursor = "pointer";
    closeBtn.addEventListener("click", () => {
      overlay.style.display = "none";
    });
    header.appendChild(closeBtn);

    const list = document.createElement("div");
    list.style.marginTop = "10px";
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "8px";
    panel.appendChild(list);

    type Row = {
      label: HTMLSpanElement;
      status: HTMLSpanElement;
      bar: HTMLDivElement;
      barFill: HTMLDivElement;
      pct: HTMLSpanElement;
      error: HTMLDivElement;
      total: number;
      loaded: number;
    };
    const rows = new Map<string, Row>();

    function ensureRow(key: string, labelText: string): Row {
      const existing = rows.get(key);
      if (existing) return existing;
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.flexDirection = "column";
      row.style.gap = "4px";
      row.style.padding = "8px 10px";
      row.style.borderRadius = "8px";
      row.style.border = "1px solid rgba(148, 163, 184, 0.25)";
      row.style.background = "rgba(2, 6, 23, 0.35)";

      const top = document.createElement("div");
      top.style.display = "flex";
      top.style.alignItems = "center";
      top.style.justifyContent = "space-between";
      top.style.gap = "10px";
      row.appendChild(top);

      const label = document.createElement("span");
      label.textContent = labelText;
      label.style.fontSize = "12px";
      label.style.opacity = "0.95";
      top.appendChild(label);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.alignItems = "center";
      right.style.gap = "10px";
      top.appendChild(right);

      const pct = document.createElement("span");
      pct.textContent = "0%";
      pct.style.fontSize = "11px";
      pct.style.opacity = "0.85";
      right.appendChild(pct);

      const status = document.createElement("span");
      status.textContent = "加载中";
      status.style.fontSize = "11px";
      status.style.opacity = "0.85";
      right.appendChild(status);

      const bar = document.createElement("div");
      bar.style.height = "6px";
      bar.style.borderRadius = "999px";
      bar.style.background = "rgba(148, 163, 184, 0.2)";
      bar.style.overflow = "hidden";
      row.appendChild(bar);

      const barFill = document.createElement("div");
      barFill.style.height = "100%";
      barFill.style.width = "0%";
      barFill.style.background = "rgba(56, 189, 248, 0.9)";
      barFill.style.transition = "width 120ms linear";
      bar.appendChild(barFill);

      const error = document.createElement("div");
      error.style.display = "none";
      error.style.color = "#fecaca";
      error.style.fontSize = "11px";
      error.style.opacity = "0.95";
      row.appendChild(error);

      list.appendChild(row);
      const info: Row = { label, status, bar, barFill, pct, error, total: 0, loaded: 0 };
      rows.set(key, info);
      return info;
    }

    function setProgress(key: string, loaded: number, total: number): void {
      const r = rows.get(key);
      if (!r) return;
      r.loaded = loaded;
      r.total = total;
      if (total > 0) {
        const pct = Math.min(100, Math.max(0, (loaded / total) * 100));
        r.barFill.style.width = `${pct.toFixed(1)}%`;
        r.pct.textContent = `${pct.toFixed(0)}%`;
      } else {
        r.barFill.style.width = "100%";
        r.pct.textContent = `${Math.max(0, Math.round(loaded / 1024))}KB`;
      }
    }

    function setDone(key: string): void {
      const r = rows.get(key);
      if (!r) return;
      r.status.textContent = "完成";
      r.pct.textContent = "100%";
      r.barFill.style.width = "100%";
    }

    function setError(key: string, message?: string): void {
      const r = rows.get(key);
      if (!r) return;
      r.status.textContent = "失败";
      r.error.textContent = message ? String(message) : "加载失败";
      r.error.style.display = "";
      r.barFill.style.background = "rgba(248, 113, 113, 0.9)";
      r.barFill.style.width = "100%";
    }

    function show(title: string, items: Array<{ key: string; label: string }>): void {
      titleEl.textContent = title;
      list.textContent = "";
      rows.clear();
      for (const item of items) {
        ensureRow(item.key, item.label);
      }
      overlay.style.display = "";
    }

    function hide(): void {
      overlay.style.display = "none";
    }

    function dispose(): void {
      overlay.remove();
      rows.clear();
    }

    document.body.appendChild(overlay);
    return { show, hide, setProgress, setDone, setError, dispose };
  }

  const loadingOverlay = createLoadingOverlay();

  function isUiInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    if (el instanceof HTMLInputElement) return true;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLSelectElement) return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    return false;
  }

  function updateCameraViewUi(): void {
    if (!cameraPosSpan || !cameraRotSpan) return;
    const pos = camera.position;
    const rot = camera.rotation;
    cameraPosSpan.textContent = `x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} z=${pos.z.toFixed(2)}`;
    const rx = THREE.MathUtils.radToDeg(rot.x);
    const ry = THREE.MathUtils.radToDeg(rot.y);
    const rz = THREE.MathUtils.radToDeg(rot.z);
    cameraRotSpan.textContent = `x=${rx.toFixed(1)} y=${ry.toFixed(1)} z=${rz.toFixed(1)}`;
  }

  function startCameraTransition(targetPos: THREE.Vector3, targetRot: THREE.Euler): void {
    cameraTransitionStartPos.copy(camera.position);
    cameraTransitionEndPos.copy(targetPos);

    const distance = cameraTransitionStartPos.distanceTo(cameraTransitionEndPos);
    const targetYaw = targetRot.y;
    const targetPitch = clampNumber(targetRot.x, -maxPitch, maxPitch);
    const yawDiff = normalizeAngle(targetYaw - yaw);
    const endYaw = yaw + yawDiff;

    const angleDiff = Math.abs(normalizeAngle(endYaw - yaw)) + Math.abs(targetPitch - pitch);

    if (distance < 1e-3 && angleDiff < 1e-3) {
      camera.position.copy(targetPos);
      yaw = endYaw;
      pitch = targetPitch;
      camera.rotation.set(pitch, yaw, 0);
      camera.updateMatrixWorld(true);
      updateCameraViewUi();
      syncCameraInputsFromCamera();
      cameraTransitionActive = false;
      return;
    }

    const center = new THREE.Vector3().addVectors(cameraTransitionStartPos, cameraTransitionEndPos).multiplyScalar(0.5);
    const fromStart = new THREE.Vector3().subVectors(cameraTransitionStartPos, center);
    const fromEnd = new THREE.Vector3().subVectors(cameraTransitionEndPos, center);
    const radiusStart = fromStart.length();
    const radiusEnd = fromEnd.length();
    const baseRadius = Math.max(radiusStart, radiusEnd, 1);
    const pullFactor = 1.4;

    let dir = fromStart;
    if (dir.lengthSq() < 1e-4) {
      dir = fromEnd;
    }
    if (dir.lengthSq() < 1e-4) {
      dir = new THREE.Vector3(0, 0, 1);
    }
    dir.normalize();
    cameraTransitionMidPos.copy(center).addScaledVector(dir, baseRadius * pullFactor);

    cameraTransitionStartYaw = yaw;
    cameraTransitionStartPitch = pitch;
    cameraTransitionEndYaw = endYaw;
    cameraTransitionEndPitch = targetPitch;

    cameraTransitionElapsed = 0;
    const minDuration = 0.6;
    const maxDuration = 1.4;
    const base = 0.5;
    const k = 0.06;
    const d = distance;
    cameraTransitionDuration = THREE.MathUtils.clamp(base + d * k, minDuration, maxDuration);
    cameraTransitionActive = true;
  }

  function syncCameraInputsFromCamera(): void {
    if (!cameraPosInputs || !cameraRotInputs) return;
    const pos = camera.position;
    const rot = camera.rotation;
    cameraPosInputs[0]!.value = pos.x.toFixed(2);
    cameraPosInputs[1]!.value = pos.y.toFixed(2);
    cameraPosInputs[2]!.value = pos.z.toFixed(2);
    cameraRotInputs[0]!.value = THREE.MathUtils.radToDeg(rot.x).toFixed(1);
    cameraRotInputs[1]!.value = THREE.MathUtils.radToDeg(rot.y).toFixed(1);
    cameraRotInputs[2]!.value = THREE.MathUtils.radToDeg(rot.z).toFixed(1);
  }

  function applyCameraPreset(position: [number, number, number], rotationDeg: [number, number, number]): void {
    const rx = THREE.MathUtils.degToRad(rotationDeg[0]);
    const ry = THREE.MathUtils.degToRad(rotationDeg[1]);
    const rz = THREE.MathUtils.degToRad(rotationDeg[2]);
    const targetPos = new THREE.Vector3(position[0], position[1], position[2]);
    const targetRot = new THREE.Euler(rx, ry, rz, "XYZ");
    startCameraTransition(targetPos, targetRot);
  }

  function getSelectedEditable():
    | {
      id: string;
      label: string;
      mesh: THREE.Object3D;
    }
    | null {
    if (selectedKind === "gizmo" && selectedGizmoId) {
      const g = gizmos.find((item) => item.id === selectedGizmoId);
      if (!g) return null;
      return {
        id: g.id,
        label: g.kind,
        mesh: g.mesh
      };
    }
    if (selectedKind === "scene" && selectedSceneObjectId) {
      const obj = objectsById.get(selectedSceneObjectId);
      if (!obj) return null;
      return {
        id: selectedSceneObjectId,
        label: selectedSceneObjectId,
        mesh: obj
      };
    }
    if (selectedKind === "sceneMulti") {
      return {
        id: `multi:${selectedSceneObjectIds.size}`,
        label: `多选(${selectedSceneObjectIds.size})`,
        mesh: multiSelectProxy
      };
    }
    return null;
  }

  function updateSelectedObjectInputs(): void {
    if (!gizmoPosInputs || !gizmoRotInputs || !gizmoScaleInputs || !gizmoDetailTitle) return;
    const item = getSelectedEditable();
    if (!item) {
      gizmoDetailTitle.textContent = "未选中物体";
      for (const input of gizmoPosInputs) input.value = "";
      for (const input of gizmoRotInputs) input.value = "";
      for (const input of gizmoScaleInputs) input.value = "";
      return;
    }
    gizmoDetailTitle.textContent = `${item.label} (${item.id})`;
    const p = item.mesh.position;
    const r = item.mesh.rotation;
    const s = item.mesh.scale;
    gizmoPosInputs[0]!.value = p.x.toFixed(2);
    gizmoPosInputs[1]!.value = p.y.toFixed(2);
    gizmoPosInputs[2]!.value = p.z.toFixed(2);
    gizmoRotInputs[0]!.value = THREE.MathUtils.radToDeg(r.x).toFixed(1);
    gizmoRotInputs[1]!.value = THREE.MathUtils.radToDeg(r.y).toFixed(1);
    gizmoRotInputs[2]!.value = THREE.MathUtils.radToDeg(r.z).toFixed(1);
    gizmoScaleInputs[0]!.value = s.x.toFixed(2);
    gizmoScaleInputs[1]!.value = s.y.toFixed(2);
    gizmoScaleInputs[2]!.value = s.z.toFixed(2);
    syncTransformControls();
  }

  function updateMultiProxyFromSelection(): void {
    if (selectedSceneObjectIds.size === 0) return;
    const center = new THREE.Vector3();
    let count = 0;
    for (const id of selectedSceneObjectIds) {
      const obj = objectsById.get(id);
      if (!obj) continue;
      center.add(obj.position);
      count += 1;
    }
    if (count === 0) return;
    center.multiplyScalar(1 / count);
    multiSelectProxy.position.copy(center);
    multiSelectProxy.rotation.set(0, 0, 0);
    multiSelectProxy.scale.set(1, 1, 1);
    multiSelectProxy.updateMatrixWorld(true);
  }

  function getTreeParentIdById(id: string): string | null {
    const obj = objectsById.get(id);
    if (!obj) return null;
    const parent = obj.parent;
    if (!parent || parent === rootGroup) return null;
    if (objectsById.get(parent.name) === parent) return parent.name;
    return null;
  }

  function setSceneSelectionSingle(id: string): void {
    selectedGizmoId = null;
    selectedSceneObjectIds.clear();
    selectedSceneObjectIds.add(id);
    syncSceneSelectionFromSet();
  }

  function addSceneSelection(id: string): void {
    selectedGizmoId = null;
    if (selectedSceneObjectIds.size === 0) {
      selectedSceneObjectIds.add(id);
      syncSceneSelectionFromSet();
      return;
    }
    const currentFirst = selectedSceneObjectIds.values().next().value as string | undefined;
    const currentParent = currentFirst ? getTreeParentIdById(currentFirst) : null;
    const nextParent = getTreeParentIdById(id);
    if (currentParent !== nextParent) {
      selectedSceneObjectIds.clear();
      selectedSceneObjectIds.add(id);
      syncSceneSelectionFromSet();
      return;
    }
    selectedSceneObjectIds.add(id);
    syncSceneSelectionFromSet();
  }

  function removeSceneSelection(id: string): void {
    selectedSceneObjectIds.delete(id);
    syncSceneSelectionFromSet();
  }

  function applyMultiMoveDelta(delta: THREE.Vector3): void {
    if (delta.lengthSq() < 1e-12) return;
    for (const id of selectedSceneObjectIds) {
      const obj = objectsById.get(id);
      if (!obj) continue;
      obj.position.add(delta);
      obj.updateMatrixWorld(true);
    }
  }

  function syncSceneSelectionFromSet(): void {
    if (selectedSceneObjectIds.size === 0) {
      if (selectedKind === "scene" || selectedKind === "sceneMulti") {
        selectedKind = null;
        selectedSceneObjectId = null;
      }
      syncTransformControls();
      updateSelectedObjectInputs();
      renderSceneObjectList();
      return;
    }

    if (selectedSceneObjectIds.size === 1) {
      const only = selectedSceneObjectIds.values().next().value as string | undefined;
      selectedKind = "scene";
      selectedSceneObjectId = only ?? null;
      syncTransformControls();
      updateSelectedObjectInputs();
      renderSceneObjectList();
      return;
    }

    selectedKind = "sceneMulti";
    selectedSceneObjectId = null;
    updateMultiProxyFromSelection();
    syncTransformControls();
    updateSelectedObjectInputs();
    renderSceneObjectList();
  }

  function syncTransformControls(): void {
    const item = getSelectedEditable();
    if (!engineeringMode || controlMode !== "object" || !item) {
      transformControls.detach();
      transformControls.enabled = false;
      transformControls.visible = false;
      return;
    }
    transformControls.attach(item.mesh);
    transformControls.enabled = true;
    transformControls.visible = true;
  }

  function createGizmoMesh(kind: GizmoKind): THREE.Mesh {
    let geometry: THREE.BufferGeometry;
    if (kind === "sphere") {
      geometry = new THREE.SphereGeometry(0.4, 20, 20);
    } else if (kind === "plane") {
      geometry = new THREE.PlaneGeometry(1, 1);
    } else if (kind === "box") {
      geometry = new THREE.BoxGeometry(1, 1, 1);
    } else {
      geometry = new THREE.SphereGeometry(0.2, 16, 16);
    }
    const material = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.9,
      side: kind === "plane" ? THREE.DoubleSide : THREE.FrontSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  function addGizmo(kind: GizmoKind): void {
    const mesh = createGizmoMesh(kind);
    mesh.position.set(0, 1, 0);
    gizmoGroup.add(mesh);
    const id = `g${Date.now().toString(36)}${gizmos.length}`;
    gizmos.push({ id, kind, mesh });
    selectedKind = "gizmo";
    selectedGizmoId = id;
    selectedSceneObjectId = null;
    renderGizmoList();
    updateSelectedObjectInputs();
  }

  function renderGizmoList(): void {
    if (!gizmoListContainer) return;
    gizmoListContainer.textContent = "";
    gizmos.forEach((g, index) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      const label = document.createElement("span");
      label.textContent = `${index + 1}. ${g.kind}`;
      label.style.fontSize = "11px";
      const btns = document.createElement("div");
      btns.style.display = "flex";
      btns.style.gap = "4px";
      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.textContent = "选中";
      selectBtn.style.padding = "2px 6px";
      selectBtn.style.borderRadius = "4px";
      selectBtn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      selectBtn.style.background = "rgba(15, 23, 42, 1)";
      selectBtn.style.color = "#e5e7eb";
      selectBtn.style.fontSize = "10px";
      selectBtn.style.cursor = "pointer";
      selectBtn.addEventListener("click", () => {
        selectedKind = "gizmo";
        selectedGizmoId = g.id;
        selectedSceneObjectId = null;
        updateSelectedObjectInputs();
      });
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "删除";
      deleteBtn.style.padding = "2px 6px";
      deleteBtn.style.borderRadius = "4px";
      deleteBtn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      deleteBtn.style.background = "rgba(127, 29, 29, 1)";
      deleteBtn.style.color = "#fecaca";
      deleteBtn.style.fontSize = "10px";
      deleteBtn.style.cursor = "pointer";
      deleteBtn.addEventListener("click", () => {
        gizmoGroup.remove(g.mesh);
        const idx = gizmos.indexOf(g);
        if (idx >= 0) gizmos.splice(idx, 1);
        if (selectedGizmoId === g.id) {
          selectedGizmoId = null;
        }
        renderGizmoList();
        updateSelectedObjectInputs();
      });
      btns.appendChild(selectBtn);
      btns.appendChild(deleteBtn);
      row.appendChild(label);
      row.appendChild(btns);
      gizmoListContainer.appendChild(row);
    });
  }

  function renderSceneObjectList(): void {
    if (!sceneObjectListContainer) return;
    sceneObjectListContainer.textContent = "";
    const parentIdById = new Map<string, string | null>();
    const childrenByParent = new Map<string | null, string[]>();

    const getParentId = (id: string, obj: THREE.Object3D): string | null => {
      const parent = obj.parent;
      if (!parent || parent === rootGroup) return null;
      if (objectsById.get(parent.name) === parent) return parent.name;
      return null;
    };

    for (const [id, obj] of objectsById) {
      const parentId = getParentId(id, obj);
      parentIdById.set(id, parentId);
      const list = childrenByParent.get(parentId) ?? [];
      list.push(id);
      childrenByParent.set(parentId, list);
    }

    const sortIds = (ids: string[]) => {
      ids.sort((a, b) => {
        const ao = objectsById.get(a);
        const bo = objectsById.get(b);
        const ag = isGroupObject(ao);
        const bg = isGroupObject(bo);
        if (ag !== bg) return ag ? -1 : 1;
        return a.localeCompare(b);
      });
    };

    for (const ids of childrenByParent.values()) sortIds(ids);

    const renderNode = (id: string, depth: number): void => {
      const obj = objectsById.get(id);
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "6px";

      const left = document.createElement("div");
      left.style.display = "flex";
      left.style.alignItems = "center";
      left.style.gap = "6px";
      left.style.minWidth = "0";
      if (depth > 0) left.style.paddingLeft = `${depth * 12}px`;

      const isGroup = isGroupObject(obj);
      const childIds = childrenByParent.get(id) ?? [];
      const hasChildren = childIds.length > 0;
      const expander = document.createElement("button");
      expander.type = "button";
      expander.textContent = hasChildren ? (collapsedGroupIds.has(id) ? "▸" : "▾") : " ";
      expander.style.width = "18px";
      expander.style.padding = "0";
      expander.style.border = "none";
      expander.style.background = "transparent";
      expander.style.color = "#e5e7eb";
      expander.style.cursor = hasChildren ? "pointer" : "default";
      expander.style.opacity = hasChildren ? "0.9" : "0.25";
      expander.addEventListener("click", () => {
        if (!hasChildren) return;
        if (collapsedGroupIds.has(id)) collapsedGroupIds.delete(id);
        else collapsedGroupIds.add(id);
        renderSceneObjectList();
      });
      left.appendChild(expander);

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedSceneObjectIds.has(id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) addSceneSelection(id);
        else removeSceneSelection(id);
      });
      left.appendChild(checkbox);

      const label = document.createElement("span");
      label.textContent = isGroup ? `[组] ${id}` : id;
      label.style.fontSize = "11px";
      label.style.opacity =
        (selectedKind === "scene" && selectedSceneObjectId === id) || (selectedKind === "sceneMulti" && selectedSceneObjectIds.has(id))
          ? "1"
          : "0.85";
      label.style.whiteSpace = "nowrap";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      left.appendChild(label);

      const btns = document.createElement("div");
      btns.style.display = "flex";
      btns.style.gap = "4px";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.textContent = "选中";
      selectBtn.style.padding = "2px 6px";
      selectBtn.style.borderRadius = "4px";
      selectBtn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      selectBtn.style.background = "rgba(15, 23, 42, 1)";
      selectBtn.style.color = "#e5e7eb";
      selectBtn.style.fontSize = "10px";
      selectBtn.style.cursor = "pointer";
      selectBtn.addEventListener("click", () => {
        setSceneSelectionSingle(id);
      });

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.textContent = "改名";
      renameBtn.style.padding = "2px 6px";
      renameBtn.style.borderRadius = "4px";
      renameBtn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      renameBtn.style.background = "rgba(15, 23, 42, 1)";
      renameBtn.style.color = "#e5e7eb";
      renameBtn.style.fontSize = "10px";
      renameBtn.style.cursor = "pointer";
      renameBtn.addEventListener("click", () => {
        const next = window.prompt("输入新名称", id);
        if (!next) return;
        const newId = renameSceneObjectId(id, next);
        if (newId) {
          const original = renameBtn.textContent;
          renameBtn.textContent = "已改名";
          setTimeout(() => {
            renameBtn.textContent = original;
          }, 600);
        }
      });

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "复制";
      copyBtn.style.padding = "2px 6px";
      copyBtn.style.borderRadius = "4px";
      copyBtn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      copyBtn.style.background = "rgba(15, 23, 42, 1)";
      copyBtn.style.color = "#e5e7eb";
      copyBtn.style.fontSize = "10px";
      copyBtn.style.cursor = "pointer";
      copyBtn.addEventListener("click", () => {
        setSceneSelectionSingle(id);
        duplicateSelectedObject();
        const original = copyBtn.textContent;
        copyBtn.textContent = "已复制";
        setTimeout(() => {
          copyBtn.textContent = original;
        }, 600);
        renderSceneObjectList();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "删除";
      deleteBtn.style.padding = "2px 6px";
      deleteBtn.style.borderRadius = "4px";
      deleteBtn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      deleteBtn.style.background = "rgba(127, 29, 29, 1)";
      deleteBtn.style.color = "#fecaca";
      deleteBtn.style.fontSize = "10px";
      deleteBtn.style.cursor = "pointer";
      deleteBtn.addEventListener("click", () => {
        setSceneSelectionSingle(id);
        deleteSelectedObject();
        renderSceneObjectList();
      });

      btns.appendChild(selectBtn);
      btns.appendChild(renameBtn);
      btns.appendChild(copyBtn);
      btns.appendChild(deleteBtn);
      row.appendChild(left);
      row.appendChild(btns);
      sceneObjectListContainer.appendChild(row);

      if (!hasChildren) return;
      if (collapsedGroupIds.has(id)) return;
      for (const childId of childIds) {
        renderNode(childId, depth + 1);
      }
    };

    const roots = childrenByParent.get(null) ?? [];
    for (const id of roots) renderNode(id, 0);
  }

  function applyGizmoFromInputs(): void {
    const item = getSelectedEditable();
    if (!item || !gizmoPosInputs || !gizmoRotInputs || !gizmoScaleInputs) return;
    const p = item.mesh.position;
    const r = item.mesh.rotation;
    const s = item.mesh.scale;
    const px = Number.parseFloat(gizmoPosInputs[0]!.value);
    const py = Number.parseFloat(gizmoPosInputs[1]!.value);
    const pz = Number.parseFloat(gizmoPosInputs[2]!.value);
    const rxDeg = Number.parseFloat(gizmoRotInputs[0]!.value);
    const ryDeg = Number.parseFloat(gizmoRotInputs[1]!.value);
    const rzDeg = Number.parseFloat(gizmoRotInputs[2]!.value);
    const sx = Number.parseFloat(gizmoScaleInputs[0]!.value);
    const sy = Number.parseFloat(gizmoScaleInputs[1]!.value);
    const sz = Number.parseFloat(gizmoScaleInputs[2]!.value);
    const posX = Number.isFinite(px) ? px : p.x;
    const posY = Number.isFinite(py) ? py : p.y;
    const posZ = Number.isFinite(pz) ? pz : p.z;
    const rotX = Number.isFinite(rxDeg) ? THREE.MathUtils.degToRad(rxDeg) : r.x;
    const rotY = Number.isFinite(ryDeg) ? THREE.MathUtils.degToRad(ryDeg) : r.y;
    const rotZ = Number.isFinite(rzDeg) ? THREE.MathUtils.degToRad(rzDeg) : r.z;
    const scaleX = Number.isFinite(sx) ? sx : s.x;
    const scaleY = Number.isFinite(sy) ? sy : s.y;
    const scaleZ = Number.isFinite(sz) ? sz : s.z;
    if (selectedKind === "sceneMulti") {
      const nextPos = new THREE.Vector3(posX, posY, posZ);
      const delta = nextPos.sub(multiSelectProxy.position);
      applyMultiMoveDelta(delta);
      multiSelectProxy.position.add(delta);
      multiSelectProxy.updateMatrixWorld(true);
      updateSelectedObjectInputs();
      renderSceneObjectList();
      return;
    }
    p.set(posX, posY, posZ);
    r.set(rotX, rotY, rotZ);
    s.set(scaleX, scaleY, scaleZ);
  }

  function copySelectedGizmoToClipboard(): void {
    const item = getSelectedEditable();
    if (!item) return;
    const p = item.mesh.position;
    const r = item.mesh.rotation;
    const s = item.mesh.scale;
    const data = {
      id: item.id,
      kind: item.label,
      position: [p.x, p.y, p.z],
      rotationDeg: [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)],
      scale: [s.x, s.y, s.z]
    };
    const text = JSON.stringify(data, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function duplicateSelectedObject(): void {
    if (selectedKind !== "scene" || !selectedSceneObjectId) return;
    const source = objectsById.get(selectedSceneObjectId);
    if (!source) return;
    const clone = source.clone(true);
    clone.position.x += 1;
    clone.position.z += 1;
    const baseName = `${selectedSceneObjectId}_copy`;
    let index = 1;
    let id = `${baseName}_${index}`;
    while (objectsById.has(id)) {
      index += 1;
      id = `${baseName}_${index}`;
    }
    const importedAssetId = importedAssetIdByObjectId.get(selectedSceneObjectId);
    if (importedAssetId) {
      importedAssetIdByObjectId.set(id, importedAssetId);
    }
    const spec = objectSpecById.get(selectedSceneObjectId);
    if (spec) {
      objectSpecById.set(id, spec);
    }
    registerObjectId(clone, id);
    rootGroup.add(clone);
    clone.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    populateSceneObjectSelect();
    selectedKind = "scene";
    selectedSceneObjectId = id;
    selectedGizmoId = null;
    updateSelectedObjectInputs();
  }

  function isGroupObject(obj: THREE.Object3D | undefined): boolean {
    if (!obj) return false;
    const ud = (obj as { userData?: Record<string, unknown> }).userData;
    return Boolean(ud && ud["__isGroup"]);
  }

  function createGroupFromSelection(): string | null {
    if (selectedSceneObjectIds.size < 2) return null;
    const members: THREE.Object3D[] = [];
    for (const id of selectedSceneObjectIds) {
      const obj = objectsById.get(id);
      if (obj) members.push(obj);
    }
    if (members.length < 2) return null;

    const baseParent = members[0]!.parent ?? rootGroup;
    for (const m of members) {
      if ((m.parent ?? rootGroup) !== baseParent) {
        setHudText("成组失败：请只选择同一层级（同一父节点）的物体");
        return null;
      }
    }
    if (baseParent !== rootGroup && !isGroupObject(baseParent)) {
      setHudText("成组失败：只支持在根节点或组内成组");
      return null;
    }

    const center = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    for (const m of members) {
      m.getWorldPosition(tmp);
      center.add(tmp);
    }
    center.multiplyScalar(1 / members.length);
    const group = new THREE.Group();
    (group as { userData?: Record<string, unknown> }).userData = { ...(group as { userData?: Record<string, unknown> }).userData, __isGroup: true };
    (baseParent as THREE.Object3D).add(group);
    const localCenter = (baseParent as THREE.Object3D).worldToLocal(center.clone());
    group.position.copy(localCenter);
    group.updateMatrixWorld(true);
    const groupId = `group_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    registerObjectId(group, groupId);

    for (const m of members) {
      group.attach(m);
    }

    selectedSceneObjectIds.clear();
    selectedSceneObjectIds.add(groupId);
    selectedKind = "scene";
    selectedSceneObjectId = groupId;
    updateSelectedObjectInputs();
    renderSceneObjectList();
    return groupId;
  }

  function ungroupSelectedGroups(): number {
    const targets = new Set<string>();
    if (selectedKind === "scene" && selectedSceneObjectId) targets.add(selectedSceneObjectId);
    if (selectedKind === "sceneMulti") {
      for (const id of selectedSceneObjectIds) targets.add(id);
    }
    if (targets.size === 0) return 0;

    const nextSelection = new Set<string>();
    let ungrouped = 0;
    for (const id of targets) {
      const group = objectsById.get(id);
      if (!group || !isGroupObject(group)) continue;
      const parent = group.parent ?? rootGroup;
      const children = [...group.children];
      for (const child of children) {
        parent.attach(child);
        if (child.name && objectsById.get(child.name) === child) {
          nextSelection.add(child.name);
        }
      }
      parent.remove(group);
      objectsById.delete(id);
      objectSpecById.delete(id);
      importedAssetIdByObjectId.delete(id);
      selectedSceneObjectIds.delete(id);
      ungrouped += 1;
    }

    selectedSceneObjectIds.clear();
    for (const id of nextSelection) selectedSceneObjectIds.add(id);
    syncSceneSelectionFromSet();
    return ungrouped;
  }

  function renameSceneObjectId(oldId: string, desired: string): string | null {
    const obj = objectsById.get(oldId);
    if (!obj) return null;
    const nextBase = desired.trim();
    if (!nextBase) return null;
    if (nextBase === oldId) return oldId;
    let next = nextBase;
    if (objectsById.has(next)) {
      let i = 1;
      while (objectsById.has(`${nextBase}_${i}`)) i += 1;
      next = `${nextBase}_${i}`;
    }
    objectsById.delete(oldId);
    objectsById.set(next, obj);
    obj.name = next;

    const spec = objectSpecById.get(oldId);
    if (spec) {
      objectSpecById.delete(oldId);
      objectSpecById.set(next, spec);
    }
    const importedAssetId = importedAssetIdByObjectId.get(oldId);
    if (importedAssetId) {
      importedAssetIdByObjectId.delete(oldId);
      importedAssetIdByObjectId.set(next, importedAssetId);
    }

    if (selectedSceneObjectId === oldId) selectedSceneObjectId = next;
    if (selectedSceneObjectIds.has(oldId)) {
      selectedSceneObjectIds.delete(oldId);
      selectedSceneObjectIds.add(next);
    }
    if (selectedKind === "sceneMulti") {
      updateMultiProxyFromSelection();
    }
    renderSceneObjectList();
    updateSelectedObjectInputs();
    return next;
  }

  function deleteSelectedObject(): void {
    const item = getSelectedEditable();
    if (!item) return;
    if (selectedKind === "gizmo" && selectedGizmoId) {
      const gIndex = gizmos.findIndex((g) => g.id === selectedGizmoId);
      if (gIndex >= 0) {
        const current = gizmos[gIndex]!;
        const mesh = current.mesh;
        gizmoGroup.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          for (const m of mesh.material) {
            m.dispose();
          }
        } else if (mesh.material) {
          mesh.material.dispose();
        }
        gizmos.splice(gIndex, 1);
      }
      selectedGizmoId = null;
    } else if (selectedKind === "scene" && selectedSceneObjectId) {
      const root = objectsById.get(selectedSceneObjectId);
      if (root) {
        const idsToRemove: string[] = [];
        root.traverse((o) => {
          if (!o.name) return;
          if (objectsById.get(o.name) === o) idsToRemove.push(o.name);
        });
        (root.parent ?? rootGroup).remove(root);
        disposeObjectTree(root);
        for (const id of idsToRemove) {
          objectsById.delete(id);
          objectSpecById.delete(id);
          importedAssetIdByObjectId.delete(id);
          selectedSceneObjectIds.delete(id);
          if (selectedSceneObjectId === id) selectedSceneObjectId = null;
        }
      }
      selectedSceneObjectId = null;
      populateSceneObjectSelect();
    }
    selectedKind = null;
    selectedGizmoId = null;
    updateSelectedObjectInputs();
    renderGizmoList();
    renderSceneObjectList();
    renderImportedAssetLibrary();
  }

  function removeSceneObjectTreeById(rootId: string): void {
    const root = objectsById.get(rootId);
    if (!root) return;
    const idsToRemove: string[] = [];
    root.traverse((o) => {
      if (!o.name) return;
      if (objectsById.get(o.name) === o) idsToRemove.push(o.name);
    });
    (root.parent ?? rootGroup).remove(root);
    disposeObjectTree(root);
    for (const id of idsToRemove) {
      objectsById.delete(id);
      objectSpecById.delete(id);
      importedAssetIdByObjectId.delete(id);
      selectedSceneObjectIds.delete(id);
      if (selectedSceneObjectId === id) selectedSceneObjectId = null;
    }
  }

  function getImportedAssetUsageIds(assetId: string): string[] {
    const ids: string[] = [];
    for (const [objectId, aId] of importedAssetIdByObjectId) {
      if (aId === assetId && objectsById.has(objectId)) ids.push(objectId);
    }
    ids.sort((a, b) => a.localeCompare(b));
    return ids;
  }

  async function addObjectFromImportedAsset(assetId: string): Promise<void> {
    const asset = importedAssetsById.get(assetId);
    if (!asset) return;
    const parent = selectedKind === "scene" && selectedSceneObjectId ? objectsById.get(selectedSceneObjectId) : null;
    const host = parent && isGroupObject(parent) ? parent : rootGroup;
    const url = URL.createObjectURL(asset.file);
    const mtlUrl = asset.mtlFile ? URL.createObjectURL(asset.mtlFile) : null;
    try {
      let obj: THREE.Object3D;
      if (asset.kind === "gltf") {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        obj = gltf.scene;
      } else {
        const objLoader = new OBJLoader();
        if (mtlUrl) {
          const mtlLoader = new MTLLoader();
          const materials = await mtlLoader.loadAsync(mtlUrl);
          materials.preload();
          objLoader.setMaterials(materials);
        }
        obj = await objLoader.loadAsync(url);
      }
      host.add(obj);
      applyPreNormalizeTransform(obj, undefined);
      normalizeObject(obj, "centerGround");
      applyPostNormalizePosition(obj, undefined);
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      const base = makeSafeFileName(asset.name).replace(/\.[^.]+$/, "");
      const baseName = base.length ? base : `asset_${assetId}`;
      const id = registerImportedObject(obj, baseName);
      importedAssetIdByObjectId.set(id, assetId);
      populateSceneObjectSelect();
    } catch (err) {
      setHudText(`add model failed\n${String(err)}`);
    } finally {
      URL.revokeObjectURL(url);
      if (mtlUrl) URL.revokeObjectURL(mtlUrl);
    }
  }

  function deleteImportedAsset(assetId: string): void {
    const usage = getImportedAssetUsageIds(assetId);
    if (usage.length > 0) {
      const ok = window.confirm(`该模型正在被 ${usage.length} 个场景物体使用，删除将同时删除这些物体。继续？`);
      if (!ok) return;
      for (const objectId of usage) {
        removeSceneObjectTreeById(objectId);
      }
    }
    importedAssetsById.delete(assetId);
    for (const [key, id] of importedAssetIdByKey) {
      if (id === assetId) importedAssetIdByKey.delete(key);
    }
    for (const [objId, id] of importedAssetIdByObjectId) {
      if (id === assetId) importedAssetIdByObjectId.delete(objId);
    }
    renderSceneObjectList();
    renderImportedAssetLibrary();
    updateSelectedObjectInputs();
  }

  function renderImportedAssetLibrary(): void {
    if (!importedAssetListContainer) return;
    importedAssetListContainer.textContent = "";
    const assets = Array.from(importedAssetsById.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (assets.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "暂无导入模型";
      empty.style.fontSize = "11px";
      empty.style.opacity = "0.8";
      importedAssetListContainer.appendChild(empty);
      return;
    }
    for (const asset of assets) {
      const used = getImportedAssetUsageIds(asset.id).length;
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "6px";

      const label = document.createElement("span");
      label.textContent = `${asset.name} (${asset.kind})  used=${used}`;
      label.style.fontSize = "11px";
      label.style.whiteSpace = "nowrap";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      label.style.flex = "1";

      const btns = document.createElement("div");
      btns.style.display = "flex";
      btns.style.gap = "4px";

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.textContent = "添加";
      addBtn.style.padding = "2px 6px";
      addBtn.style.borderRadius = "4px";
      addBtn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      addBtn.style.background = "rgba(15, 23, 42, 1)";
      addBtn.style.color = "#e5e7eb";
      addBtn.style.fontSize = "10px";
      addBtn.style.cursor = "pointer";
      addBtn.addEventListener("click", () => {
        const original = addBtn.textContent;
        addBtn.textContent = "添加中…";
        addObjectFromImportedAsset(asset.id)
          .then(() => {
            addBtn.textContent = "已添加";
            setTimeout(() => {
              addBtn.textContent = original;
            }, 700);
          })
          .catch(() => {
            addBtn.textContent = "失败";
            setTimeout(() => {
              addBtn.textContent = original;
            }, 900);
          })
          .finally(() => {
            renderImportedAssetLibrary();
          });
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "删除";
      delBtn.style.padding = "2px 6px";
      delBtn.style.borderRadius = "4px";
      delBtn.style.border = "1px solid rgba(148, 163, 184, 0.9)";
      delBtn.style.background = "rgba(127, 29, 29, 1)";
      delBtn.style.color = "#fecaca";
      delBtn.style.fontSize = "10px";
      delBtn.style.cursor = "pointer";
      delBtn.addEventListener("click", () => {
        deleteImportedAsset(asset.id);
      });

      btns.appendChild(addBtn);
      btns.appendChild(delBtn);
      row.appendChild(label);
      row.appendChild(btns);
      importedAssetListContainer.appendChild(row);
    }
  }

  function copyAllGizmosToClipboard(): void {
    if (!gizmos.length && objectsById.size === 0) return;
    const gizmoObjects = gizmos.map((g) => {
      const p = g.mesh.position;
      const r = g.mesh.rotation;
      const s = g.mesh.scale;
      return {
        id: g.id,
        kind: g.kind,
        position: [p.x, p.y, p.z],
        rotationDeg: [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)],
        scale: [s.x, s.y, s.z]
      };
    });
    const sceneObjects: unknown[] = [];
    for (const [id, obj] of objectsById) {
      const p = obj.position;
      const r = obj.rotation;
      const s = obj.scale;
      sceneObjects.push({
        id,
        position: [p.x, p.y, p.z],
        rotationDeg: [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)],
        scale: [s.x, s.y, s.z]
      });
    }
    const payload: Record<string, unknown> = {
      gizmos: gizmoObjects,
      sceneObjects
    };
    (payload as { objects: unknown }).objects = gizmoObjects;
    const text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function populateSceneObjectSelect(): void {
    renderSceneObjectList();
  }

  transformControls.addEventListener("objectChange", () => {
    if (selectedKind === "sceneMulti") {
      const delta = new THREE.Vector3().subVectors(multiSelectProxy.position, multiDragStartProxyPos);
      for (const id of selectedSceneObjectIds) {
        const start = multiDragStartById.get(id);
        const obj = objectsById.get(id);
        if (!start || !obj) continue;
        obj.position.copy(start).add(delta);
        obj.updateMatrixWorld(true);
      }
      updateSelectedObjectInputs();
      renderSceneObjectList();
      return;
    }
    updateSelectedObjectInputs();
  });

  transformControls.addEventListener("dragging-changed", (event) => {
    const e = event as unknown as { value?: boolean };
    transformDragging = Boolean(e.value);
    if (selectedKind === "sceneMulti") {
      if (transformDragging) {
        multiDragStartProxyPos.copy(multiSelectProxy.position);
        multiDragStartById.clear();
        for (const id of selectedSceneObjectIds) {
          const obj = objectsById.get(id);
          if (!obj) continue;
          multiDragStartById.set(id, obj.position.clone());
        }
      } else {
        multiDragStartById.clear();
        updateMultiProxyFromSelection();
        syncTransformControls();
        updateSelectedObjectInputs();
        renderSceneObjectList();
      }
    }
  });


  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.isComposing) return;
    if (ev.code === "F2") {
      ev.preventDefault();
      engineeringMode = !engineeringMode;
      if (controlsRoot) {
        controlsRoot.style.display = engineeringMode ? "" : "none";
      }
      syncTransformControls();
      return;
    }
    if (ev.code === "KeyM") {
      ev.preventDefault();
      controlMode = controlMode === "camera" ? "object" : "camera";
      syncTransformControls();
      return;
    }
    if (cameraTransitionActive) return;
    if (!cameraInputEnabled) return;
    pressedCodes.add(ev.code);
  }

  function onKeyUp(ev: KeyboardEvent): void {
    if (cameraTransitionActive) return;
    if (!cameraInputEnabled) return;
    pressedCodes.delete(ev.code);
  }

  function onWindowBlur(): void {
    pressedCodes.clear();
    isPointerDown = false;
  }

  function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeAngle(angle: number): number {
    const twoPi = Math.PI * 2;
    angle %= twoPi;
    if (angle <= -Math.PI) {
      angle += twoPi;
    } else if (angle > Math.PI) {
      angle -= twoPi;
    }
    return angle;
  }

  const monitorRaycaster = new THREE.Raycaster();
  const monitorPointer = new THREE.Vector2();

  const sensorMarkerRaycaster = new THREE.Raycaster();
  const sensorMarkerPointer = new THREE.Vector2();

  function hexToFrame(hex: string): Bytes | null {
    const clean = hex.replace(/[^0-9a-fA-F]/g, "");
    if (clean.length !== 32) return null;
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) {
      const part = clean.slice(i * 2, i * 2 + 2);
      const n = Number.parseInt(part, 16);
      if (!Number.isFinite(n)) return null;
      out[i] = n;
    }
    return out;
  }

  function sendActuatorControl(deviceId: string, value: boolean): void {
    const device = ACTUATOR_DEVICES.find((d) => d.id === deviceId);
    if (!device) return;
    const hex =
      device.control.kind === "trigger"
        ? device.control.fire
        : value
          ? device.control.on
          : device.control.off;
    const frame = hexToFrame(hex);
    if (!frame) return;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(frame.buffer);
    if (device.control.kind === "toggle") {
      actuatorStates.set(deviceId, value);
    } else {
      actuatorStates.set(deviceId, false);
    }
    monitorDirty = true;
  }

  function handleMonitorClick(ev: PointerEvent): boolean {
    const bounds = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - bounds.left) / bounds.width) * 2 - 1;
    const y = -((ev.clientY - bounds.top) / bounds.height) * 2 + 1;
    monitorPointer.set(x, y);
    monitorRaycaster.setFromCamera(monitorPointer, camera);
    const hits = monitorRaycaster.intersectObject(monitorMesh, false);
    if (hits.length === 0) return false;
    const hit = hits[0]!;
    if (!hit.uv) return false;
    const canvasX = hit.uv.x * monitorCanvas.width;
    const canvasY = (1 - hit.uv.y) * monitorCanvas.height;
    for (const btn of monitorButtons) {
      if (canvasX >= btn.x && canvasX <= btn.x + btn.w && canvasY >= btn.y && canvasY <= btn.y + btn.h) {
        const device = ACTUATOR_DEVICES.find((d) => d.id === btn.id);
        if (!device) return true;
        if (device.control.kind === "trigger") {
          sendActuatorControl(device.id, true);
        } else {
          const next = !actuatorStates.get(device.id);
          sendActuatorControl(device.id, next);
        }
        return true;
      }
    }
    return false;
  }

  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    if (isUiInputFocused()) return;
    if (transformDragging) return;
    if (handleMonitorClick(ev)) return;
    if (cameraTransitionActive) return;
    if (!cameraInputEnabled) return;
    ev.preventDefault();
    
    // 检测是否点击了作物
    if (cropsObject) {
      const bounds = renderer.domElement.getBoundingClientRect();
      const x = ((ev.clientX - bounds.left) / bounds.width) * 2 - 1;
      const y = -((ev.clientY - bounds.top) / bounds.height) * 2 + 1;
      
      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2(x, y);
      raycaster.setFromCamera(mouse, camera);
      
      const hits = raycaster.intersectObject(cropsObject, true);
      if (hits.length > 0) {
        // 显示数据卡片
        if (dataCard) {
          dataCard.style.display = "block";
          dataCardVisible = true;
        }
        return;
      }
    }
    
    isPointerDown = true;
    lastPointerX = ev.clientX;
    lastPointerY = ev.clientY;
    const target = ev.target as HTMLElement;
    if (target && target.setPointerCapture) {
      target.setPointerCapture(ev.pointerId);
    }
  }

  function onPointerUp(ev: PointerEvent): void {
    if (!isPointerDown) return;
    isPointerDown = false;
    const target = ev.target as HTMLElement;
    if (target && target.releasePointerCapture) {
      target.releasePointerCapture(ev.pointerId);
    }
  }

  function onPointerMove(ev: PointerEvent): void {
    if (cameraTransitionActive) return;
    if (!cameraInputEnabled) return;
    if (!isPointerDown) return;
    if (transformDragging) return;
    const dx = ev.clientX - lastPointerX;
    const dy = ev.clientY - lastPointerY;
    lastPointerX = ev.clientX;
    lastPointerY = ev.clientY;
    yaw -= dx * lookSensitivity;
    pitch -= dy * lookSensitivity;
    pitch = clampNumber(pitch, -maxPitch, maxPitch);
    camera.rotation.set(pitch, yaw, 0);
  }

  function onDragOver(ev: DragEvent): void {
    ev.preventDefault();
  }

  function onWindowDrop(ev: DragEvent): void {
    ev.preventDefault();
  }

  function onDrop(ev: DragEvent): void {
    ev.preventDefault();
    const items = ev.dataTransfer?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) continue;
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          importModelFromFile(file);
        }
      }
    }
  }


  function loadTextureWithProgress(url: string, key: string): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        url,
        (texture) => {
          loadingOverlay.setDone(key);
          resolve(texture);
        },
        (ev) => {
          const loaded = typeof ev.loaded === "number" ? ev.loaded : 0;
          const total = typeof ev.total === "number" ? ev.total : 0;
          loadingOverlay.setProgress(key, loaded, total);
        },
        (err) => {
          loadingOverlay.setError(key, String(err));
          reject(err);
        }
      );
    });
  }

  function loadGltfWithProgress(url: string, key: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          loadingOverlay.setDone(key);
          resolve({ scene: gltf.scene, animations: gltf.animations });
        },
        (ev) => {
          const loaded = typeof ev.loaded === "number" ? ev.loaded : 0;
          const total = typeof ev.total === "number" ? ev.total : 0;
          loadingOverlay.setProgress(key, loaded, total);
        },
        (err) => {
          loadingOverlay.setError(key, String(err));
          reject(err);
        }
      );
    });
  }

  function loadMtlWithProgress(url: string, key: string): Promise<MTLLoader.MaterialCreator> {
    return new Promise((resolve, reject) => {
      const loader = new MTLLoader();
      loader.load(
        url,
        (materials) => {
          loadingOverlay.setDone(key);
          resolve(materials);
        },
        (ev) => {
          const loaded = typeof ev.loaded === "number" ? ev.loaded : 0;
          const total = typeof ev.total === "number" ? ev.total : 0;
          loadingOverlay.setProgress(key, loaded, total);
        },
        (err) => {
          loadingOverlay.setError(key, String(err));
          reject(err);
        }
      );
    });
  }

  function loadObjWithProgress(url: string, materials: MTLLoader.MaterialCreator | null, key: string): Promise<THREE.Object3D> {
    return new Promise((resolve, reject) => {
      const loader = new OBJLoader();
      if (materials) {
        materials.preload();
        loader.setMaterials(materials);
      }
      loader.load(
        url,
        (obj) => {
          loadingOverlay.setDone(key);
          resolve(obj);
        },
        (ev) => {
          const loaded = typeof ev.loaded === "number" ? ev.loaded : 0;
          const total = typeof ev.total === "number" ? ev.total : 0;
          loadingOverlay.setProgress(key, loaded, total);
        },
        (err) => {
          loadingOverlay.setError(key, String(err));
          reject(err);
        }
      );
    });
  }

  async function loadSkyBox(): Promise<void> {
    const url = "/sky.jpg";
    const texture = await loadTextureWithProgress(url, "skybox");
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;
    backgroundTexture = texture;

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const env = pmrem.fromEquirectangular(texture).texture;
    scene.environment = env;
    environmentTexture = env;
    pmrem.dispose();
  }

  function connectSocket(): void {
    try {
      socketState = "connecting";
      socket = new WebSocket(options.socketUrl);

      socket.binaryType = "arraybuffer";

      socket.addEventListener("open", () => {
        socketState = "connected";
        monitorDirty = true;
      });

      socket.addEventListener("close", () => {
        socketState = "disconnected";
        socket = null;
        monitorDirty = true;
        setTimeout(connectSocket, 800);
      });

      socket.addEventListener("error", () => {
        socketState = "disconnected";
        socket?.close();
        monitorDirty = true;
      });

      socket.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") return;
        if (!(ev.data instanceof ArrayBuffer)) return;

        const buffer: Bytes = new Uint8Array(ev.data);
        const result = unpackFrame(buffer);
        if (!result || !result.crcOk) return;

        const { frame } = result;
        const subType = getSubType(frame);
        const device = [...SENSOR_DEVICES, ...ACTUATOR_DEVICES].find(
          (d) =>
            d.mainType === frame.addr.mainType &&
            d.subType === subType &&
            (d.index === undefined || d.index === frame.addr.index)
        );

        if (!device) return;
        const value = decodeFrameValue(frame);
        if (value === null) return;

        if (!latestTelemetry) {
          latestTelemetry = { ts: Date.now() };
        }
        latestTelemetry.ts = Date.now();

        if (device.id === "airTemp" && typeof value === "number") latestTelemetry.temperatureC = value;
        if (device.id === "airHumi" && typeof value === "number") latestTelemetry.humidityPct = value;
        if (device.id === "co2" && typeof value === "number") latestTelemetry.co2ppm = value;

        if (SENSOR_DEVICES.some((d) => d.id === device.id)) {
          latestSensorValues.set(device.id, { value, ts: Date.now() });
        } else {
          actuatorStates.set(device.id, Boolean(value));
        }
        monitorDirty = true;
      });
    } catch {
      socketState = "disconnected";
      socket = null;
      setTimeout(connectSocket, 1200);
    }
  }

  async function loadOneModel(spec: ModelSpec): Promise<{ object: THREE.Object3D; animations: THREE.AnimationClip[] }> {
    if (spec.kind === "gltf") {
      const key = `model:${spec.id ?? spec.url}`;
      const result = await loadGltfWithProgress(spec.url, key);
      return { object: result.scene, animations: result.animations };
    }

    const objKey = `model:${spec.id ?? spec.objUrl}`;
    let materials: MTLLoader.MaterialCreator | null = null;
    if (spec.mtlUrl) {
      const mtlKey = `${objKey}:mtl`;
      materials = await loadMtlWithProgress(spec.mtlUrl, mtlKey);
    }
    const object = await loadObjWithProgress(spec.objUrl, materials, objKey);
    return { object, animations: [] };
  }

  function registerImportedObject(obj: THREE.Object3D, baseName: string): string {
    importedObjectCount += 1;
    const id = `${baseName}_${importedObjectCount}`;
    registerObjectId(obj, id);
    return id;
  }

  function registerObjectId(obj: THREE.Object3D, id: string | undefined): void {
    if (!id) return;
    obj.name = id;
    objectsById.set(id, obj);
  }

  function applyPreNormalizeTransform(obj: THREE.Object3D, transform: ModelSpec["transform"] | undefined): void {
    if (!transform) return;

    if (typeof transform.scale === "number") {
      obj.scale.setScalar(transform.scale);
    } else if (transform.scale) {
      obj.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
    }

    if (transform.rotation) {
      obj.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2]);
    }
  }

  function applyPostNormalizePosition(obj: THREE.Object3D, transform: ModelSpec["transform"] | undefined): void {
    if (!transform?.position) return;
    obj.position.add(new THREE.Vector3(transform.position[0], transform.position[1], transform.position[2]));
  }

  function getObjectBounds(obj: THREE.Object3D): { size: THREE.Vector3; center: THREE.Vector3 } {
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    return { size, center };
  }

  function normalizeObject(obj: THREE.Object3D, mode: ModelSpec["normalize"] | undefined): { size: THREE.Vector3; center: THREE.Vector3 } {
    const bounds = getObjectBounds(obj);
    if (mode === "none") return bounds;

    obj.position.sub(bounds.center);
    obj.position.y += bounds.size.y * 0.5;
    return bounds;
  }

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function encodeUtf8(text: string): Uint8Array {
    return textEncoder.encode(text);
  }

  function decodeUtf8(data: Uint8Array): string {
    return textDecoder.decode(data);
  }

  function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out.buffer;
  }

  let crcTable: Uint32Array | null = null;

  function getCrcTable(): Uint32Array {
    if (crcTable) return crcTable;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    crcTable = table;
    return table;
  }

  function crc32(data: Uint8Array): number {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i += 1) {
      crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function getDosDateTime(date: Date): { time: number; date: number } {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);
    const dosTime = (hours << 11) | (minutes << 5) | seconds;
    const dosDate = ((year - 1980) << 9) | (month << 5) | day;
    return { time: dosTime & 0xffff, date: dosDate & 0xffff };
  }

  function writeU16(view: DataView, offset: number, value: number): void {
    view.setUint16(offset, value & 0xffff, true);
  }

  function writeU32(view: DataView, offset: number, value: number): void {
    view.setUint32(offset, value >>> 0, true);
  }

  function concatBytes(chunks: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const c of chunks) {
      out.set(c, cursor);
      cursor += c.length;
    }
    return out;
  }

  function buildZip(files: Array<{ path: string; data: Uint8Array }>): Uint8Array {
    const now = getDosDateTime(new Date());
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let localOffset = 0;

    for (const file of files) {
      const nameBytes = encodeUtf8(file.path);
      const data = file.data;
      const crc = crc32(data);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lview = new DataView(localHeader.buffer);
      writeU32(lview, 0, 0x04034b50);
      writeU16(lview, 4, 20);
      writeU16(lview, 6, 0);
      writeU16(lview, 8, 0);
      writeU16(lview, 10, now.time);
      writeU16(lview, 12, now.date);
      writeU32(lview, 14, crc);
      writeU32(lview, 18, data.length);
      writeU32(lview, 22, data.length);
      writeU16(lview, 26, nameBytes.length);
      writeU16(lview, 28, 0);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cview = new DataView(centralHeader.buffer);
      writeU32(cview, 0, 0x02014b50);
      writeU16(cview, 4, 20);
      writeU16(cview, 6, 20);
      writeU16(cview, 8, 0);
      writeU16(cview, 10, 0);
      writeU16(cview, 12, now.time);
      writeU16(cview, 14, now.date);
      writeU32(cview, 16, crc);
      writeU32(cview, 20, data.length);
      writeU32(cview, 24, data.length);
      writeU16(cview, 28, nameBytes.length);
      writeU16(cview, 30, 0);
      writeU16(cview, 32, 0);
      writeU16(cview, 34, 0);
      writeU16(cview, 36, 0);
      writeU32(cview, 38, 0);
      writeU32(cview, 42, localOffset);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      localOffset += localHeader.length + data.length;
    }

    const central = concatBytes(centralParts);
    const local = concatBytes(localParts);
    const end = new Uint8Array(22);
    const eview = new DataView(end.buffer);
    writeU32(eview, 0, 0x06054b50);
    writeU16(eview, 4, 0);
    writeU16(eview, 6, 0);
    writeU16(eview, 8, files.length);
    writeU16(eview, 10, files.length);
    writeU32(eview, 12, central.length);
    writeU32(eview, 16, local.length);
    writeU16(eview, 20, 0);
    return concatBytes([local, central, end]);
  }

  function findEocdIndex(data: Uint8Array): number {
    for (let i = data.length - 22; i >= 0; i -= 1) {
      if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function parseZip(data: Uint8Array): Map<string, Uint8Array> {
    const eocdIndex = findEocdIndex(data);
    if (eocdIndex < 0) return new Map();
    const eview = new DataView(data.buffer, data.byteOffset + eocdIndex, 22);
    const totalEntries = eview.getUint16(10, true);
    const centralOffset = eview.getUint32(16, true);
    const out = new Map<string, Uint8Array>();
    let cursor = centralOffset;
    for (let i = 0; i < totalEntries; i += 1) {
      const sig = new DataView(data.buffer, data.byteOffset + cursor, 4).getUint32(0, true);
      if (sig !== 0x02014b50) break;
      const view = new DataView(data.buffer, data.byteOffset + cursor, 46);
      const compMethod = view.getUint16(10, true);
      const compressedSize = view.getUint32(20, true);
      const nameLen = view.getUint16(28, true);
      const extraLen = view.getUint16(30, true);
      const commentLen = view.getUint16(32, true);
      const localHeaderOffset = view.getUint32(42, true);
      const nameStart = cursor + 46;
      const nameBytes = data.slice(nameStart, nameStart + nameLen);
      const name = decodeUtf8(nameBytes);
      cursor = nameStart + nameLen + extraLen + commentLen;
      if (compMethod !== 0) continue;

      const lview = new DataView(data.buffer, data.byteOffset + localHeaderOffset, 30);
      const lNameLen = lview.getUint16(26, true);
      const lExtraLen = lview.getUint16(28, true);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      const fileBytes = data.slice(dataStart, dataStart + compressedSize);
      out.set(name, fileBytes);
    }
    return out;
  }

  function getTransformSnapshot(obj: THREE.Object3D): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } {
    return {
      position: [obj.position.x, obj.position.y, obj.position.z],
      rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
      scale: [obj.scale.x, obj.scale.y, obj.scale.z]
    };
  }

  async function fetchBytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  function getFileNameFromUrl(url: string): string {
    try {
      const u = new URL(url, window.location.href);
      const path = u.pathname;
      const name = path.split("/").pop() || "asset";
      return name;
    } catch {
      const parts = url.split("/");
      return parts[parts.length - 1] || "asset";
    }
  }

  function makeSafeFileName(name: string): string {
    const cleaned = name.replace(/[^\w.\-]+/g, "_");
    return cleaned.length ? cleaned : "asset";
  }

  function makeProjectFileName(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `greenhouse_project_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
  }

  async function exportProjectPackage(): Promise<Uint8Array> {
    type AssetEntry =
      | { id: string; kind: "gltf"; file: string; originalName: string }
      | { id: string; kind: "obj"; objFile: string; mtlFile?: string; originalName: string };
    type ObjectEntry =
      | {
        id: string;
        kind: "gltf";
        parentId: string | null;
        assetId: string;
        normalize: "centerGround" | "none";
        transform: ReturnType<typeof getTransformSnapshot>;
      }
      | {
        id: string;
        kind: "obj";
        parentId: string | null;
        assetId: string;
        normalize: "centerGround" | "none";
        transform: ReturnType<typeof getTransformSnapshot>;
      }
      | {
        id: string;
        kind: "group";
        parentId: string | null;
        transform: ReturnType<typeof getTransformSnapshot>;
      };
    type GizmoEntry = {
      id: string;
      kind: GizmoKind;
      transform: ReturnType<typeof getTransformSnapshot>;
    };
    type Manifest = {
      version: 2;
      createdAt: number;
      assets: AssetEntry[];
      objects: ObjectEntry[];
      gizmos: GizmoEntry[];
    };

    const assetKeyToId = new Map<string, string>();
    const assetEntries: AssetEntry[] = [];
    const assetFiles: Array<{ path: string; data: Uint8Array }> = [];

    const ensureAssetFromImportedFile = async (entry: { kind: "gltf" | "obj"; file: File; mtlFile?: File }): Promise<string> => {
      const key = `file:${entry.kind}:${entry.file.name}:${entry.file.size}:${entry.file.lastModified}:${entry.mtlFile?.name ?? ""}:${entry.mtlFile?.size ?? ""}:${entry.mtlFile?.lastModified ?? ""}`;
      const existing = assetKeyToId.get(key);
      if (existing) return existing;
      const assetId = `a${assetKeyToId.size + 1}`;
      assetKeyToId.set(key, assetId);
      const bytes = new Uint8Array(await entry.file.arrayBuffer());
      const safeName = makeSafeFileName(entry.file.name);
      const path = `assets/${assetId}_${safeName}`;
      assetFiles.push({ path, data: bytes });
      if (entry.kind === "gltf") {
        assetEntries.push({ id: assetId, kind: "gltf", file: path, originalName: entry.file.name });
      } else {
        let mtlPath: string | undefined;
        if (entry.mtlFile) {
          const mtlBytes = new Uint8Array(await entry.mtlFile.arrayBuffer());
          const safeMtlName = makeSafeFileName(entry.mtlFile.name);
          mtlPath = `assets/${assetId}_${safeMtlName}`;
          assetFiles.push({ path: mtlPath, data: mtlBytes });
        }
        assetEntries.push({ id: assetId, kind: "obj", objFile: path, mtlFile: mtlPath, originalName: entry.file.name });
      }
      return assetId;
    };

    const ensureAssetFromUrl = async (kind: "gltf" | "obj", url: string, mtlUrl?: string): Promise<string> => {
      const key = `url:${kind}:${url}:${mtlUrl ?? ""}`;
      const existing = assetKeyToId.get(key);
      if (existing) return existing;
      const assetId = `a${assetKeyToId.size + 1}`;
      assetKeyToId.set(key, assetId);
      if (kind === "gltf") {
        const bytes = await fetchBytes(url);
        const safeName = makeSafeFileName(getFileNameFromUrl(url));
        const path = `assets/${assetId}_${safeName}`;
        assetFiles.push({ path, data: bytes });
        assetEntries.push({ id: assetId, kind: "gltf", file: path, originalName: safeName });
        return assetId;
      }
      const objBytes = await fetchBytes(url);
      const objName = makeSafeFileName(getFileNameFromUrl(url));
      const objPath = `assets/${assetId}_${objName}`;
      assetFiles.push({ path: objPath, data: objBytes });
      let mtlPath: string | undefined;
      if (mtlUrl) {
        const mtlBytes = await fetchBytes(mtlUrl);
        const mtlName = makeSafeFileName(getFileNameFromUrl(mtlUrl));
        mtlPath = `assets/${assetId}_${mtlName}`;
        assetFiles.push({ path: mtlPath, data: mtlBytes });
      }
      assetEntries.push({ id: assetId, kind: "obj", objFile: objPath, mtlFile: mtlPath, originalName: objName });
      return assetId;
    };

    const ensureAssetFromLibrary = async (assetId: string): Promise<string> => {
      const key = `lib:${assetId}`;
      const existing = assetKeyToId.get(key);
      if (existing) return existing;
      const asset = importedAssetsById.get(assetId);
      if (!asset) throw new Error(`missing asset ${assetId}`);
      assetKeyToId.set(key, assetId);

      const bytes = new Uint8Array(await asset.file.arrayBuffer());
      const safeName = makeSafeFileName(asset.name);
      const path = `assets/${assetId}_${safeName}`;
      assetFiles.push({ path, data: bytes });
      if (asset.kind === "gltf") {
        assetEntries.push({ id: assetId, kind: "gltf", file: path, originalName: asset.name });
        return assetId;
      }

      let mtlPath: string | undefined;
      if (asset.mtlFile) {
        const mtlBytes = new Uint8Array(await asset.mtlFile.arrayBuffer());
        const safeMtlName = makeSafeFileName(asset.mtlFile.name);
        mtlPath = `assets/${assetId}_${safeMtlName}`;
        assetFiles.push({ path: mtlPath, data: mtlBytes });
      }
      assetEntries.push({ id: assetId, kind: "obj", objFile: path, mtlFile: mtlPath, originalName: asset.name });
      return assetId;
    };

    const objects: ObjectEntry[] = [];
    const getParentId = (obj: THREE.Object3D): string | null => {
      const parent = obj.parent;
      if (!parent) return null;
      if (objectsById.get(parent.name) === parent) return parent.name;
      return null;
    };
    for (const [id, obj] of objectsById) {
      if (isGroupObject(obj)) {
        objects.push({ id, kind: "group", parentId: getParentId(obj), transform: getTransformSnapshot(obj) });
        continue;
      }
      const importedAssetId = importedAssetIdByObjectId.get(id);
      if (importedAssetId) {
        const asset = importedAssetsById.get(importedAssetId);
        if (!asset) continue;
        const assetId = await ensureAssetFromLibrary(importedAssetId);
        objects.push({
          id,
          kind: asset.kind,
          parentId: getParentId(obj),
          assetId,
          normalize: "centerGround",
          transform: getTransformSnapshot(obj)
        } as ObjectEntry);
        continue;
      }
      const spec = objectSpecById.get(id);
      if (!spec) continue;
      if (spec.kind === "gltf") {
        const assetId = await ensureAssetFromUrl("gltf", spec.url);
        objects.push({ id, kind: "gltf", parentId: getParentId(obj), assetId, normalize: spec.normalize ?? "none", transform: getTransformSnapshot(obj) });
      } else {
        const assetId = await ensureAssetFromUrl("obj", spec.objUrl, spec.mtlUrl);
        objects.push({ id, kind: "obj", parentId: getParentId(obj), assetId, normalize: spec.normalize ?? "none", transform: getTransformSnapshot(obj) });
      }
    }

    const gizmoEntries: GizmoEntry[] = gizmos.map((g) => ({ id: g.id, kind: g.kind, transform: getTransformSnapshot(g.mesh) }));
    const manifest: Manifest = { version: 2, createdAt: Date.now(), assets: assetEntries, objects, gizmos: gizmoEntries };
    const manifestBytes = encodeUtf8(JSON.stringify(manifest));
    const zipBytes = buildZip([{ path: "manifest.json", data: manifestBytes }, ...assetFiles]);
    return zipBytes;
  }

  function disposeObjectTree(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as unknown;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          (m as { dispose: () => void }).dispose();
        }
      } else if (mat && typeof (mat as { dispose?: unknown }).dispose === "function") {
        (mat as { dispose: () => void }).dispose();
      }
    });
  }

  function clearProjectScene(): void {
    transformControls.detach();
    transformControls.enabled = false;
    transformControls.visible = false;

    for (const obj of rootGroup.children) {
      disposeObjectTree(obj);
    }
    rootGroup.clear();
    objectsById.clear();
    objectSpecById.clear();
    importedAssetsById.clear();
    importedAssetIdByKey.clear();
    importedAssetIdByObjectId.clear();
    importedObjectCount = 0;

    for (const g of gizmos) {
      gizmoGroup.remove(g.mesh);
      if (g.mesh.geometry) g.mesh.geometry.dispose();
      const mat = g.mesh.material as unknown;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          (m as { dispose: () => void }).dispose();
        }
      } else if (mat && typeof (mat as { dispose?: unknown }).dispose === "function") {
        (mat as { dispose: () => void }).dispose();
      }
    }
    gizmos.length = 0;
    gizmoGroup.clear();

    selectedKind = null;
    selectedGizmoId = null;
    selectedSceneObjectId = null;
    renderSceneObjectList();
    renderGizmoList();
    updateSelectedObjectInputs();
  }

  async function importProjectPackage(zipBytes: Uint8Array): Promise<void> {
    const files = parseZip(zipBytes);
    const manifestBytes = files.get("manifest.json");
    if (!manifestBytes) {
      setHudText("project import failed\nmissing manifest.json");
      return;
    }
    const manifest = JSON.parse(decodeUtf8(manifestBytes)) as {
      version: number;
      assets: Array<
        | { id: string; kind: "gltf"; file: string; originalName: string }
        | { id: string; kind: "obj"; objFile: string; mtlFile?: string; originalName: string }
      >;
      objects: Array<
        | {
          id: string;
          kind: "group";
          parentId: string | null;
          transform: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] };
        }
        | {
          id: string;
          kind: "gltf" | "obj";
          parentId: string | null;
          assetId: string;
          normalize: "centerGround" | "none";
          transform: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] };
        }
      >;
      gizmos: Array<{
        id: string;
        kind: GizmoKind;
        transform: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] };
      }>;
    };
    if (manifest.version !== 1 && manifest.version !== 2) {
      setHudText(`project import failed\nunsupported version ${String(manifest.version)}`);
      return;
    }

    const blobUrlByPath = new Map<string, string>();
    const fileByAssetId = new Map<string, { kind: "gltf" | "obj"; file: File; mtlFile?: File }>();
    for (const asset of manifest.assets) {
      if (asset.kind === "gltf") {
        const bytes = files.get(asset.file);
        if (!bytes) continue;
        const blob = new Blob([toOwnedArrayBuffer(bytes)], { type: "model/gltf-binary" });
        blobUrlByPath.set(asset.file, URL.createObjectURL(blob));
        fileByAssetId.set(asset.id, { kind: "gltf", file: new File([toOwnedArrayBuffer(bytes)], asset.originalName, { type: "model/gltf-binary" }) });
      } else {
        const objBytes = files.get(asset.objFile);
        if (!objBytes) continue;
        const objBlob = new Blob([toOwnedArrayBuffer(objBytes)], { type: "text/plain" });
        blobUrlByPath.set(asset.objFile, URL.createObjectURL(objBlob));
        let mtlFile: File | undefined;
        if (asset.mtlFile) {
          const mtlBytes = files.get(asset.mtlFile);
          if (mtlBytes) {
            const mtlBlob = new Blob([toOwnedArrayBuffer(mtlBytes)], { type: "text/plain" });
            blobUrlByPath.set(asset.mtlFile, URL.createObjectURL(mtlBlob));
            mtlFile = new File([toOwnedArrayBuffer(mtlBytes)], `${asset.id}.mtl`, { type: "text/plain" });
          }
        }
        fileByAssetId.set(asset.id, { kind: "obj", file: new File([toOwnedArrayBuffer(objBytes)], asset.originalName, { type: "text/plain" }), mtlFile });
      }
    }

    clearProjectScene();

    try {
      importedAssetsById.clear();
      importedAssetIdByKey.clear();
      for (const asset of manifest.assets) {
        const entry = fileByAssetId.get(asset.id);
        if (!entry) continue;
        const imported: ImportedAsset = {
          id: asset.id,
          kind: entry.kind,
          file: entry.file,
          mtlFile: entry.mtlFile,
          name: asset.kind === "gltf" ? asset.originalName : asset.originalName,
          createdAt: Date.now()
        };
        importedAssetsById.set(asset.id, imported);
        importedAssetIdByKey.set(`manifest:${asset.id}`, asset.id);
      }

      const groupEntries = manifest.objects.filter((o) => o.kind === "group") as Array<{
        id: string;
        kind: "group";
        parentId: string | null;
        transform: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] };
      }>;

      for (const g of groupEntries) {
        const group = new THREE.Group();
        (group as { userData?: Record<string, unknown> }).userData = { ...(group as { userData?: Record<string, unknown> }).userData, __isGroup: true };
        rootGroup.add(group);
        registerObjectId(group, g.id);
      }

      for (const g of groupEntries) {
        const group = objectsById.get(g.id);
        if (!group) continue;
        const parentId = (g as unknown as { parentId?: string | null }).parentId ?? null;
        const parent = parentId ? objectsById.get(parentId) : null;
        if (parent && isGroupObject(parent)) {
          parent.add(group);
        } else {
          rootGroup.add(group);
        }
        group.position.set(g.transform.position[0], g.transform.position[1], g.transform.position[2]);
        group.rotation.set(g.transform.rotation[0], g.transform.rotation[1], g.transform.rotation[2]);
        group.scale.set(g.transform.scale[0], g.transform.scale[1], g.transform.scale[2]);
        group.updateMatrixWorld(true);
      }

      for (const objEntry of manifest.objects) {
        if (objEntry.kind === "group") continue;
        const asset = manifest.assets.find((a) => a.id === objEntry.assetId);
        if (!asset) continue;
        let obj: THREE.Object3D;
        if (asset.kind === "gltf") {
          const url = blobUrlByPath.get(asset.file);
          if (!url) continue;
          const loader = new GLTFLoader();
          const gltf = await loader.loadAsync(url);
          obj = gltf.scene;
        } else {
          const objUrl = blobUrlByPath.get(asset.objFile);
          if (!objUrl) continue;
          const objLoader = new OBJLoader();
          if (asset.mtlFile) {
            const mtlUrl = blobUrlByPath.get(asset.mtlFile);
            if (mtlUrl) {
              const mtlLoader = new MTLLoader();
              const materials = await mtlLoader.loadAsync(mtlUrl);
              materials.preload();
              objLoader.setMaterials(materials);
            }
          }
          obj = await objLoader.loadAsync(objUrl);
        }

        const parentId = (objEntry as unknown as { parentId?: string | null }).parentId ?? null;
        const parent = parentId ? objectsById.get(parentId) : null;
        if (parent && isGroupObject(parent)) parent.add(obj);
        else rootGroup.add(obj);

        registerObjectId(obj, objEntry.id);
        importedObjectCount += 1;
        importedAssetIdByObjectId.set(objEntry.id, objEntry.assetId);
        obj.position.set(objEntry.transform.position[0], objEntry.transform.position[1], objEntry.transform.position[2]);
        obj.rotation.set(objEntry.transform.rotation[0], objEntry.transform.rotation[1], objEntry.transform.rotation[2]);
        obj.scale.set(objEntry.transform.scale[0], objEntry.transform.scale[1], objEntry.transform.scale[2]);
        obj.updateMatrixWorld(true);
        obj.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });
      }

      for (const g of manifest.gizmos) {
        const mesh = createGizmoMesh(g.kind);
        mesh.position.set(g.transform.position[0], g.transform.position[1], g.transform.position[2]);
        mesh.rotation.set(g.transform.rotation[0], g.transform.rotation[1], g.transform.rotation[2]);
        mesh.scale.set(g.transform.scale[0], g.transform.scale[1], g.transform.scale[2]);
        gizmoGroup.add(mesh);
        gizmos.push({ id: g.id, kind: g.kind, mesh });
      }

      populateSceneObjectSelect();
      renderGizmoList();
      renderImportedAssetLibrary();
      updateSelectedObjectInputs();
    } finally {
      for (const url of blobUrlByPath.values()) {
        URL.revokeObjectURL(url);
      }
    }
  }

  async function importModelFromFile(file: File): Promise<void> {
    const name = file.name.toLowerCase();
    const isGltf = name.endsWith(".glb") || name.endsWith(".gltf");
    const isObj = name.endsWith(".obj");
    if (!isGltf && !isObj) {
      setHudText(`unsupported model: ${file.name}`);
      return;
    }
    const kind: "gltf" | "obj" = isGltf ? "gltf" : "obj";
    const assetKey = `file:${kind}:${file.name}:${file.size}:${file.lastModified}`;
    let assetId = importedAssetIdByKey.get(assetKey);
    if (!assetId) {
      assetId = `imp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
      importedAssetIdByKey.set(assetKey, assetId);
      importedAssetsById.set(assetId, { id: assetId, kind, file, name: file.name, createdAt: Date.now() });
    }
    const url = URL.createObjectURL(file);
    try {
      let obj: THREE.Object3D;
      if (isGltf) {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(url);
        obj = gltf.scene;
      } else {
        const loader = new OBJLoader();
        obj = await loader.loadAsync(url);
      }
      const parent = selectedKind === "scene" && selectedSceneObjectId ? objectsById.get(selectedSceneObjectId) : null;
      if (parent && isGroupObject(parent)) parent.add(obj);
      else rootGroup.add(obj);
      applyPreNormalizeTransform(obj, undefined);
      normalizeObject(obj, "centerGround");
      applyPostNormalizePosition(obj, undefined);
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      const baseName = isGltf ? "imported_gltf" : "imported_obj";
      const id = registerImportedObject(obj, baseName);
      importedAssetIdByObjectId.set(id, assetId);
      populateSceneObjectSelect();
      renderImportedAssetLibrary();
    } catch (err) {
      setHudText(`import failed\n${String(err)}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function loadModels(): Promise<{ mainSize: THREE.Vector3 }> {
    const mainResult = await loadOneModel(options.model);
    const main = mainResult.object;
    rootGroup.add(main);
    registerObjectId(main, options.model.id);
    if (options.model.id) objectSpecById.set(options.model.id, options.model);
    applyPreNormalizeTransform(main, options.model.transform);
    const mainInfo = normalizeObject(main, options.model.normalize);
    applyPostNormalizePosition(main, options.model.transform);

    main.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });

    console.log('Number of animations:', mainResult.animations.length);
    if (mainResult.animations.length > 0) {
      mixer = new THREE.AnimationMixer(main);
      
      mainResult.animations.forEach((clip) => {
        console.log('Animation clip name:', clip.name, 'duration:', clip.duration);
        const action = mixer!.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;

        if (clip.name.startsWith("fan_") || clip.name.startsWith("wind_")) {
          console.log('Adding fan animation:', clip.name);
          fanActions.push(action);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
        } else if (clip.name.startsWith("shade_") || clip.name.startsWith("pole_")) {
          console.log('Adding shade/pole animation:', clip.name);
          shadeActions.push(action);
          // 暂停动画，初始状态为关闭
          action.paused = true;
          action.time = 0;
        }
      });
      
      console.log('Final shadeActions length:', shadeActions.length);
      console.log('Final fanActions length:', fanActions.length);
    }

    const extras = options.extras ?? [];
    if (extras.length) {
      for (let i = 0; i < extras.length; i++) {
        const spec = extras[i];
        if (!spec) continue;
        const extraResult = await loadOneModel(spec);
        const extra = extraResult.object;
        rootGroup.add(extra);
        registerObjectId(extra, spec.id);
        if (spec.id) objectSpecById.set(spec.id, spec);
        applyPreNormalizeTransform(extra, spec.transform);
        const info = normalizeObject(extra, spec.normalize);
        
        // 保存作物对象引用
        if (i === 0) {
          cropsObject = extra;
        }
        
        if (spec.transform?.position) {
          applyPostNormalizePosition(extra, spec.transform);
        } else {
          // 调整作物和树木的位置
          if (i === 0) {
            extra.position.set( -0.2, 0.3,-1.15);
          } else if (i === 1) {
          extra.position.set( -0.2, 0.3,-0.1);
          }
        }

        extra.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });
      }
    }

    const shadowRadius = Math.max(20, Math.max(mainInfo.size.x, mainInfo.size.z) * 1.1);
    const cam = sunLight.shadow.camera as THREE.OrthographicCamera;
    cam.left = -shadowRadius;
    cam.right = shadowRadius;
    cam.top = shadowRadius;
    cam.bottom = -shadowRadius;
    cam.near = 0.5;
    cam.far = 500;
    cam.updateProjectionMatrix();

    const maxDim = Math.max(mainInfo.size.x, mainInfo.size.y, mainInfo.size.z);
    const dist = maxDim * 1.4 + 3;
    camera.position.set(dist, dist * 0.6, dist);
    camera.lookAt(0, mainInfo.size.y * 0.5, 0);
    yaw = camera.rotation.y;
    pitch = camera.rotation.x;

    populateSceneObjectSelect();

    return { mainSize: mainInfo.size };
  }

  function resize(): void {
    const { clientWidth, clientHeight } = renderer.domElement;
    if (clientWidth === 0 || clientHeight === 0) return;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight, false);
  }

  function renderLoop(): void {
    resize();
    const dt = Math.min(0.05, clock.getDelta());

    if (mixer) {
      mixer.update(dt);
    }

    if (cameraTransitionActive) {
      cameraTransitionElapsed += dt;
      let t = cameraTransitionElapsed / cameraTransitionDuration;
      if (t >= 1) {
        t = 1;
      }
      const inv = 1 - t;
      cameraTransitionTempPos.set(0, 0, 0);
      cameraTransitionTempPos.addScaledVector(cameraTransitionStartPos, inv * inv);
      cameraTransitionTempPos.addScaledVector(cameraTransitionMidPos, 2 * inv * t);
      cameraTransitionTempPos.addScaledVector(cameraTransitionEndPos, t * t);
      camera.position.copy(cameraTransitionTempPos);

      const currentYaw =
        cameraTransitionStartYaw + (cameraTransitionEndYaw - cameraTransitionStartYaw) * t;
      const currentPitch =
        cameraTransitionStartPitch + (cameraTransitionEndPitch - cameraTransitionStartPitch) * t;
      yaw = currentYaw;
      pitch = clampNumber(currentPitch, -maxPitch, maxPitch);
      camera.rotation.set(pitch, yaw, 0);

      if (t === 1) {
        cameraTransitionActive = false;
        updateCameraViewUi();
        syncCameraInputsFromCamera();
      }
    }

    if (!cameraTransitionActive && !isUiInputFocused() && cameraInputEnabled) {
      const forwardAmount = (pressedCodes.has("KeyW") ? 1 : 0) + (pressedCodes.has("KeyS") ? -1 : 0);
      const rightAmount = (pressedCodes.has("KeyD") ? 1 : 0) + (pressedCodes.has("KeyA") ? -1 : 0);
      const upAmount = (pressedCodes.has("KeyE") ? 1 : 0) + (pressedCodes.has("KeyQ") ? -1 : 0);

      if (forwardAmount !== 0 || rightAmount !== 0 || upAmount !== 0) {
        camera.getWorldDirection(tempForward);
        tempForward.y = 0;
        if (tempForward.lengthSq() < 1e-8) {
          tempForward.set(0, 0, -1);
        } else {
          tempForward.normalize();
        }
        tempRight.crossVectors(tempForward, tempUp).normalize();

        tempMove.set(0, 0, 0);
        tempMove.addScaledVector(tempForward, forwardAmount);
        tempMove.addScaledVector(tempRight, rightAmount);
        tempMove.addScaledVector(tempUp, upAmount);
        if (tempMove.lengthSq() > 1e-8) {
          tempMove.normalize();
        }

        const baseSpeed = 6;
        const speedMul = pressedCodes.has("ShiftLeft") || pressedCodes.has("ShiftRight") ? 3 : 1;
        const step = baseSpeed * speedMul * dt;
        camera.position.addScaledVector(tempMove, step);
        if (camera.position.y < 0.05) {
          const dy = 0.05 - camera.position.y;
          camera.position.y += dy;
        }
      }
    }

    for (const [id, obj] of objectsById) {
      if (id.startsWith("fan")) {
        obj.rotation.z += fanRadPerSec * dt;
      }

      if (id == "Wind_Generator1") {
        obj.rotation.z += 1 * dt;
      }

      if (id == "Wind_Generator2") {
        obj.rotation.z += -1 * dt;
      }
    }

    // 使用预创建的向量对象
    sunDir.subVectors(sunLight.position, sunTarget.position).normalize();
    const sunDistance = 900;
    sunBillboard.position.copy(camera.position).addScaledVector(sunDir, sunDistance);
    sunBillboard.quaternion.copy(camera.quaternion);
    const size = Math.max(25, sunDistance * 0.03);
    sunBillboard.scale.set(size, size, 1);

    // monitorMesh.quaternion.copy(camera.quaternion);
    const now = performance.now();
    if (monitorDirty || now - lastMonitorDraw > 500) {
      drawMonitor();
      monitorDirty = false;
      lastMonitorDraw = now;
    }
    
    if (cropsObject && dataCard) {
      // 使用预创建的向量对象
      cropsObject.getWorldPosition(cropsPos);
      
      screenPos.copy(cropsPos).project(camera);
      
      const canvas = renderer.domElement;
      const x = (screenPos.x * 0.5 + 0.5) * canvas.clientWidth;
      const y = (-screenPos.y * 0.5 + 0.5) * canvas.clientHeight;

      dataCard.style.left = `${x}px`;
      dataCard.style.top = `${y - 100}px`; 
    }

    // 优化UI更新频率
    if (cameraPosSpan && cameraRotSpan) {
      if (now - lastUiUpdate > uiUpdateInterval) {
        updateCameraViewUi();
        lastUiUpdate = now;
      }
    }

    renderer.render(scene, camera);

    const t = latestTelemetry;
    const telemetryText = t
      ? `telemetry.ts=${new Date(t.ts).toLocaleTimeString()}\nT=${t.temperatureC ?? "-"}°C  RH=${t.humidityPct ?? "-"}%  CO2=${t.co2ppm ?? "-"}ppm`
      : "telemetry: -";

    const mainModelText = options.model.kind === "gltf" ? options.model.url : options.model.objUrl;
    const extrasCount = options.extras?.length ?? 0;
    setHudText(`socket=${socketState}\nmodel=${mainModelText}\nextras=${extrasCount}\n${telemetryText}`);
    rafId = window.requestAnimationFrame(renderLoop);
  }

  let disposed = false;
  let shadeBtn: HTMLButtonElement | null = null;
  let windBtn: HTMLButtonElement | null = null;

  return {
    start() {
      if (disposed) return;
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";

      connectSocket();
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("drop", onWindowDrop);
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointerup", onPointerUp);
      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("dragover", onDragOver);
      renderer.domElement.addEventListener("drop", onDrop);



      const loadingItems: Array<{ key: string; label: string }> = [];
      loadingItems.push({ key: "skybox", label: "SkyBox" });
      const allSpecs = [options.model, ...(options.extras ?? [])];
      for (const spec of allSpecs) {
        if (spec.kind === "gltf") {
          const key = `model:${spec.id ?? spec.url}`;
          const label = `GLTF: ${spec.id ?? getFileNameFromUrl(spec.url)}`;
          loadingItems.push({ key, label });
        } else {
          const key = `model:${spec.id ?? spec.objUrl}`;
          const label = `OBJ: ${spec.id ?? getFileNameFromUrl(spec.objUrl)}`;
          loadingItems.push({ key, label });
          if (spec.mtlUrl) {
            loadingItems.push({ key: `${key}:mtl`, label: `MTL: ${getFileNameFromUrl(spec.mtlUrl)}` });
          }
        }
      }
      loadingOverlay.show("资源加载中", loadingItems);

      Promise.allSettled([loadSkyBox(), loadModels()]).then((results) => {
        const modelResult = results[1];
        if (modelResult.status === "rejected") {
          setHudText(`model load failed\n${String(modelResult.reason)}`);
        }
        if (results.every((r) => r.status === "fulfilled")) {
          loadingOverlay.hide();
        }
        syncCameraInputsFromCamera();
        clock.start();
        if (controlsRoot && engineeringMode) {
          controlsRoot.style.display = "";
        }
        
        // 创建顶部控制栏
        createTopControls();
        
        rafId = window.requestAnimationFrame(renderLoop);
      });
    },
    dispose() {
      disposed = true;
      window.cancelAnimationFrame(rafId);

      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onWindowDrop);
      pressedCodes.clear();

      if (cameraPanelRoot && cameraPanelRoot.parentElement) {
        cameraPanelRoot.parentElement.removeChild(cameraPanelRoot);
      }
      cameraPanelRoot = null;
      cameraModeSpan = null;
      cameraLockButton = null;

      socket?.close();
      socket = null;
      scene.background = fallbackBackground;
      scene.environment = null;
      backgroundTexture?.dispose();
      environmentTexture?.dispose();
      backgroundTexture = null;
      environmentTexture = null;
      gizmos.length = 0;
      gizmoGroup.clear();
      objectsById.clear();
      importedAssetsById.clear();
      importedAssetIdByKey.clear();
      importedAssetIdByObjectId.clear();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("dragover", onDragOver);
      renderer.domElement.removeEventListener("drop", onDrop);
      monitorGeometry.dispose();
      monitorMaterial.dispose();
      monitorTexture.dispose();
      renderer.dispose();
      rootGroup.clear();
      loadingOverlay.dispose();

      if (shadeBtn) {
        shadeBtn.remove();
        shadeBtn = null;
      }
      if (windBtn) {
        windBtn.remove();
        windBtn = null;
      }
      
      if (topControls) {
        topControls.remove();
        topControls = null;
      }
      const panelsContainer = document.getElementById('function-panels');
      if (panelsContainer) {
        panelsContainer.remove();
      }
      
      const greenhouseIntroPanel = document.querySelector('div[style*="智能工业温室系统介绍"]');
      if (greenhouseIntroPanel) {
        greenhouseIntroPanel.remove();
      }
      
      const style = document.querySelector('style');
      if (style) {
        style.remove();
      }
    }
  };
}
