/**
 * PLY sequence viewer with synced input video.
 * Each card: left = input video; right = Three.js scene of current frame + timeline slider.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

// Two independent galleries: 16-frame and 32-frame sequences.
const GALLERIES = [
    { gridId: 'results-grid-16', cfg: window.RESULTS_CONFIG_16 || [] },
    { gridId: 'results-grid-32', cfg: window.RESULTS_CONFIG_32 || [] },
];

const loader = new PLYLoader();
const material = new THREE.MeshStandardMaterial({
    color: 0xcbd2d9,
    roughness: 0.45,
    metalness: 0.12,
    side: THREE.DoubleSide,
    flatShading: false
});

const scenes = [];

function axisRotation(axis) {
    // Three.js default camera is Y-up, so Y-up meshes render correctly with no rotation.
    // Only rotate for non-Y conventions.
    const m = new THREE.Matrix4();
    if (!axis || axis === 'y') return m;                  // Y-up: no rotation (default)
    if (axis === 'z') return m.makeRotationX(Math.PI/2);  // Z-up -> Y-up
    if (axis === 'x') return m.makeRotationZ(Math.PI/2);  // X-up -> Y-up
    return m;
}

function createCard(cfg, idx, grid) {
    const card = document.createElement('div');
    card.className = 'result-card';

    const maxFrame = (cfg.num_frames || 8) - 1;
    const filePrefix = cfg.file_prefix || 'frame_';

    const videoHtml = cfg.input_video
        ? `<span class="panel-label">Input Video</span>
           <video muted playsinline preload="metadata" src="${cfg.input_video}"></video>`
        : `<span class="panel-label">Input</span>
           <div style="color:#888;font-size:12px;">No video provided</div>`;

    const rightHtml = cfg.turntable
        ? `<span class="panel-label right">Ours (Turntable)</span>
           <video muted playsinline autoplay loop src="${cfg.turntable}"
                  style="width:100%;height:100%;object-fit:contain;"></video>`
        : `<span class="panel-label right">Ours (Mesh)</span>
           <div class="scene-area" data-card-idx="${idx}"></div>`;

    card.innerHTML = `
        <div class="result-card-header">${cfg.label || cfg.id}</div>
        <div class="result-card-body">
            <div class="input-col">${videoHtml}</div>
            <div class="mesh-col">${rightHtml}</div>
            <div class="card-controls">
                <span class="frame-num">0 / ${maxFrame}</span>
                <input type="range" min="0" max="${maxFrame}" step="1" value="0">
                <button class="play-btn">▶ Play</button>
            </div>
        </div>
    `;
    grid.appendChild(card);

    const slider = card.querySelector('input[type=range]');
    const label = card.querySelector('.frame-num');
    const videoEl = card.querySelector('.input-col video');
    const playBtn = card.querySelector('.play-btn');

    const state = {
        cfg,
        slider, label, videoEl,
        currentFrame: 0,
        playing: false,
        playTimer: null,
        maxFrame,
        filePrefix,
        cache: {},
        mesh: null,
        scene: null,
        camera: null,
        controls: null,
        renderer: null,
        sceneArea: card.querySelector('.scene-area')
    };

    // Interactive mesh viewer only if no turntable video provided
    if (!cfg.turntable && state.sceneArea) {
        setupScene(state);
    }

    slider.addEventListener('input', (e) => {
        setFrame(state, parseInt(e.target.value));
    });

    playBtn.addEventListener('click', () => {
        if (state.playing) stopPlayback(state, playBtn);
        else startPlayback(state, playBtn);
    });

    if (videoEl) {
        videoEl.addEventListener('loadedmetadata', () => {
            videoEl.currentTime = 0;
            videoEl.pause();
        });
    }

    // preload first frame
    setFrame(state, 0);

    return state;
}

function setupScene(state) {
    const container = state.sceneArea;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.5);
    dl.position.set(2, 5, 5);
    scene.add(dl);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    state.renderer = renderer;
    state.scene = scene;
    state.camera = camera;
    state.controls = controls;
    state.fitted = false;

    scenes.push(state);
}

function loadPLY(state, idx) {
    return new Promise((resolve, reject) => {
        if (state.cache[idx]) return resolve(state.cache[idx]);
        const id = state.cfg.id;
        const prefix = state.filePrefix;
        const url = `static/meshes/${id}/${prefix}${String(idx).padStart(4, '0')}.ply`;
        loader.load(url, (geometry) => {
            geometry.computeVertexNormals();
            geometry.applyMatrix4(axisRotation(state.cfg.axis_up || 'y'));
            geometry.center();
            state.cache[idx] = geometry;
            resolve(geometry);
        }, undefined, (err) => {
            console.warn('[Sculpt4D] failed to load', url, err);
            reject(err);
        });
    });
}

function setFrame(state, idx) {
    state.currentFrame = idx;
    state.label.textContent = `${idx} / ${state.maxFrame}`;
    state.slider.value = idx;

    // sync video
    if (state.videoEl && state.videoEl.duration && !isNaN(state.videoEl.duration)) {
        state.videoEl.pause();
        const progress = idx / state.maxFrame;
        state.videoEl.currentTime = Math.min(
            progress * state.videoEl.duration,
            state.videoEl.duration - 0.01
        );
    }

    // update mesh
    if (!state.cfg.turntable && state.scene) {
        loadPLY(state, idx).then(geom => {
            if (state.mesh) state.scene.remove(state.mesh);
            state.mesh = new THREE.Mesh(geom, material);
            state.scene.add(state.mesh);
            if (!state.fitted) {
                fitCamera(state.camera, state.mesh, state.controls);
                state.fitted = true;
            }
        }).catch(() => {});
    }
}

function fitCamera(camera, mesh, controls) {
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraZ *= 1.7;
    // Pure front view: camera directly in front along +Z, matches old html.
    camera.position.set(0, 0, cameraZ + maxDim);
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
}

function startPlayback(state, btn) {
    state.playing = true;
    btn.textContent = '⏸ Pause';
    const fps = 8;
    state.playTimer = setInterval(() => {
        let next = state.currentFrame + 1;
        if (next > state.maxFrame) next = 0;
        setFrame(state, next);
    }, 1000 / fps);
}

function stopPlayback(state, btn) {
    state.playing = false;
    btn.textContent = '▶ Play';
    if (state.playTimer) {
        clearInterval(state.playTimer);
        state.playTimer = null;
    }
}

// Global render loop for all three.js scenes
function animate() {
    requestAnimationFrame(animate);
    scenes.forEach(s => {
        if (!s.renderer || !s.scene || !s.camera) return;
        const el = s.sceneArea;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (s.renderer.domElement.width !== w * window.devicePixelRatio ||
            s.renderer.domElement.height !== h * window.devicePixelRatio) {
            s.renderer.setSize(w, h, false);
            s.camera.aspect = w / h;
            s.camera.updateProjectionMatrix();
        }
        s.controls.update();
        s.renderer.render(s.scene, s.camera);
    });
}

// ============ Init ============
let anyCards = false;
GALLERIES.forEach(({ gridId, cfg }) => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    if (!cfg || cfg.length === 0) {
        // Hide the entire section if no cases configured for this length
        const section = grid.closest('section');
        if (section) section.style.display = 'none';
        return;
    }
    cfg.forEach((c, i) => createCard(c, i, grid));
    anyCards = true;
});
if (anyCards) animate();
