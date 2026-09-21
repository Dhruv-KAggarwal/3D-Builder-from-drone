import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class ModelViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87b4cc);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 80000);
    this.camera.position.set(140, 90, 160);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 8;
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.hemi = new THREE.HemisphereLight(0xd7ecff, 0x3f4a32, 0.78);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d2, 1.55);
    this.sun.position.set(80, 140, 50);
    this.scene.add(this.sun);
    this.fill = new THREE.DirectionalLight(0x8fb7ff, 0.28);
    this.fill.position.set(-90, 40, -70);
    this.scene.add(this.fill);
    this.grid = new THREE.GridHelper(400, 24, 0x4d6f7a, 0x2a4a52);
    this.scene.add(this.grid);
    this.measure = { a: null, b: null, markers: [] };
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.onMeasure = null;
    this.onProgress = null;
    this.layers = { terrain: true, points: false, grid: true };
    this.resize();
    this.canvas.addEventListener('pointerdown', (event) => this.pick(event));
    window.addEventListener('resize', () => this.resize());
    this.loop();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(2, rect.width);
    const height = Math.max(2, rect.height);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  clearModel() {
    while (this.root.children.length) {
      const child = this.root.children[0];
      child.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) {
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          materials.forEach((material) => {
            material.map?.dispose();
            material.dispose();
          });
        }
      });
      this.root.remove(child);
    }
    this.clearMeasure();
  }

  async loadGlb(url) {
    this.clearModel();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not fetch model (${response.status})`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      this.onProgress?.(total ? Math.round((loaded / total) * 100) : 0, loaded, total);
    }
    const packed = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      packed.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(packed.buffer, '', resolve, reject);
    });
    gltf.scene.traverse((node) => {
      if (node.isMesh) {
        const hasMap = Boolean(node.material?.map);
        if (hasMap) {
          node.material.map.colorSpace = THREE.SRGBColorSpace;
          node.material.map.anisotropy = 8;
          node.material.map.needsUpdate = true;
        }
        const material = new THREE.MeshStandardMaterial({
          map: hasMap ? node.material.map : null,
          vertexColors: !hasMap,
          color: 0xffffff,
          metalness: 0.02,
          roughness: 0.9,
          side: THREE.DoubleSide,
          flatShading: false,
          envMapIntensity: 0.2,
        });
        node.material = material;
        node.castShadow = false;
        node.receiveShadow = false;
      }
      if (node.isPoints) {
        node.material.size = 1.6;
        node.material.sizeAttenuation = true;
        node.material.vertexColors = true;
        node.material.transparent = true;
        node.material.opacity = 0.92;
        node.material.depthWrite = false;
      }
    });
    this.root.add(gltf.scene);
    this.fit(gltf.scene);
    this.applyLayers();
    return gltf;
  }

  fit(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const horiz = Math.max(size.x, size.z, 8);
    const radius = Math.max(horiz, size.y, 8);
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y + size.y * 0.85 + horiz * 0.22, center.z + horiz * 0.95);
    this.camera.near = Math.max(0.05, radius / 500);
    this.camera.far = radius * 40;
    this.camera.updateProjectionMatrix();
    this.scene.fog = new THREE.Fog(0x87b4cc, radius * 1.6, radius * 8);
    this.grid.position.set(center.x, box.min.y, center.z);
    this.grid.scale.setScalar(Math.max(1, horiz / 140));
    this.sun.position.set(center.x + horiz * 0.6, center.y + radius, center.z + horiz * 0.25);
    this.root.traverse((node) => {
      if (node.isPoints && node.material) node.material.size = Math.max(0.9, horiz / 180);
    });
    this.controls.update();
  }

  setLayers(layers) {
    this.layers = { ...this.layers, ...layers };
    this.applyLayers();
  }

  applyLayers() {
    this.grid.visible = this.layers.grid !== false;
    this.root.traverse((node) => {
      if (node.isMesh) node.visible = this.layers.terrain !== false;
      if (node.isPoints) node.visible = this.layers.points === true;
    });
  }

  pick(event) {
    if (event.button !== 0 || !event.shiftKey) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    if (!hits.length) return;
    const point = hits[0].point.clone();
    if (!this.measure.a || this.measure.b) {
      this.clearMeasure();
      this.measure.a = point;
      this.addMarker(point);
      this.onMeasure?.({ meters: null, message: 'First point locked. Shift-click a second point.' });
      return;
    }
    this.measure.b = point;
    this.addMarker(point);
    const meters = this.measure.a.distanceTo(this.measure.b);
    this.onMeasure?.({ meters, message: `${meters.toFixed(2)} m between sampled points` });
  }

  addMarker(point) {
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 12), new THREE.MeshBasicMaterial({ color: 0xc9f26b }));
    marker.position.copy(point);
    this.scene.add(marker);
    this.measure.markers.push(marker);
  }

  clearMeasure() {
    this.measure.markers.forEach((marker) => {
      this.scene.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    });
    this.measure = { a: null, b: null, markers: [] };
  }

  loop() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.loop());
  }
}
