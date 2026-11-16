/**
 * Vue 3D du Jumeau Numérique — modèle urbain "Secteur – ville nouvelle"
 *
 * Reprend exactement la scène du fichier "Modèle urbain 3D.html" :
 * mêmes maillages (50 matériaux), mêmes couleurs, même éclairage (hémisphérique + soleil),
 * mêmes contrôles (orbite, Maj+glisser / clic droit = déplacer, molette = zoom),
 * mêmes vues (aérienne, plan, hôtel / mosquée, école, niveau rue) et option « Ombres ».
 *
 * Par-dessus ce modèle, l'application superpose la simulation multi-agents (états S/I/R,
 * lignes de contact < 2 m), la mesure de distance et la sélection d'objets.
 */

import React, { useEffect, useImperativeHandle, useRef, forwardRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { Agent, ScenarioConfig, SpatialLayout, StepMetric } from '../../types/simulation';
import {
  BUILDING_MATERIALS,
  createLabelSprite,
  createSiteGroup,
  createSiteRenderer,
  createSiteScene,
  GROUND_Y,
  loadSiteModel,
  modelToSim,
  SiteModelData,
  SiteOrbit,
  SITE_LABELS,
  SiteViewKey,
  setShadows,
  simToModel,
  TREE_MATERIALS,
} from '../../engine/siteModel';

export interface SelectedObjectInfo {
  type: 'building' | 'agent' | 'market' | 'tree' | 'gate' | 'point' | 'furniture' | 'street';
  id: string;
  name: string;
  details: Record<string, string | number>;
  position: { x: number; y: number; z?: number };
}

type CameraPreset = 'isometric' | 'topDown' | 'pedestrian' | 'market' | 'northGate' | 'baseChinoise' | 'ecole' | 'mosque';

export interface ThreeUrbanSceneRef {
  resetCamera: () => void;
  setCameraPreset: (preset: CameraPreset) => void;
  captureScreenshot: () => string;
  exportGLTF: (filename?: string) => Promise<void>;
  toggleVariedHeights?: () => void;
  toggleTrees?: () => void;
  toggleLabels?: () => void;
  toggleShadows?: () => void;
}

interface ThreeUrbanSceneProps {
  layout: SpatialLayout;
  agents: Agent[];
  config: ScenarioConfig;
  stepMetric: StepMetric | null;
  scientificMode?: boolean;
  measurementMode?: boolean;
  onMeasurementDone?: (distanceMeters: number, p1: { x: number; y: number }, p2: { x: number; y: number }) => void;
  onSelectObject?: (info: SelectedObjectInfo | null) => void;
  showProximityLines?: boolean;
  showHeatmapDensity?: boolean;
  onHoverCoords?: (coords: { x: number; y: number } | null) => void;
  objModelScale?: number;
  objModelRotY?: number;
  objModelPosX?: number;
  objModelPosZ?: number;
  objModelPosY?: number;
  showObjModel?: boolean;
  showProceduralBuildings?: boolean;
  /** Si défini, pilote l'affichage des arbres depuis l'extérieur. */
  showTrees?: boolean;
  onMoveMarket?: (x: number, y: number) => void;
  isMarketSelected?: boolean;
  isMarketLocked?: boolean;
}

const PRESET_TO_VIEW: Record<CameraPreset, SiteViewKey> = {
  isometric: 'iso',
  topDown: 'top',
  pedestrian: 'rue',
  ecole: 'ecole',
  mosque: 'hotel',
  baseChinoise: 'base',
  market: 'marche',
  northGate: 'iso',
};

const MAX_AGENTS = 20000;
const AGENT_SCALES = [1, 3, 6] as const;

export const ThreeUrbanScene = forwardRef<ThreeUrbanSceneRef, ThreeUrbanSceneProps>(
  (
    {
      layout,
      agents,
      config,
      measurementMode = false,
      onMeasurementDone,
      onSelectObject,
      showProximityLines = true,
      onHoverCoords,
      showTrees: showTreesProp,
      onMoveMarket,
      isMarketSelected = false,
      isMarketLocked = false,
    },
    ref
  ) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const orbitRef = useRef<SiteOrbit | null>(null);
    const sunRef = useRef<THREE.DirectionalLight | null>(null);
    const modelRef = useRef<SiteModelData | null>(null);
    const meshesRef = useRef<Record<string, THREE.Mesh>>({});
    const treeMeshesRef = useRef<THREE.Mesh[]>([]);
    const labelsGroupRef = useRef<THREE.Group | null>(null);
    const markersGroupRef = useRef<THREE.Group | null>(null);
    const marketGroupRef = useRef<THREE.Group | null>(null);
    const marketPadRef = useRef<THREE.Mesh | null>(null);
    const marketLabelRef = useRef<THREE.Sprite | null>(null);
    const marketRingRef = useRef<THREE.Mesh | null>(null);
    const instancedAgentsRef = useRef<THREE.InstancedMesh | null>(null);
    const proximityLinesRef = useRef<THREE.LineSegments | null>(null);
    const measurementPointsRef = useRef<THREE.Vector3[]>([]);
    const measurementLineRef = useRef<THREE.Line | null>(null);
    const needsRenderRef = useRef<boolean>(true);

    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [areTreesVisible, setAreTreesVisible] = useState<boolean>(true);
    const [areLabelsVisible, setAreLabelsVisible] = useState<boolean>(true);
    const [shadowsOn, setShadowsOn] = useState<boolean>(false);
    const [agentScaleIdx, setAgentScaleIdx] = useState<number>(1);
    const agentScale = AGENT_SCALES[agentScaleIdx];

    const propsRef = useRef({
      layout,
      agents,
      config,
      measurementMode,
      onMeasurementDone,
      onSelectObject,
      onHoverCoords,
      showProximityLines,
      onMoveMarket,
      isMarketSelected,
      isMarketLocked,
    });
    propsRef.current = {
      layout,
      agents,
      config,
      measurementMode,
      onMeasurementDone,
      onSelectObject,
      onHoverCoords,
      showProximityLines,
      onMoveMarket,
      isMarketSelected,
      isMarketLocked,
    };

    const requestRender = () => {
      needsRenderRef.current = true;
    };

    const setCameraPreset = (preset: CameraPreset) => {
      if (preset === 'market' && orbitRef.current) {
        const p = propsRef.current;
        const mk = p.config.marketRelocated ? p.config.marketPosition : { x: p.layout.market.x, y: p.layout.market.y };
        const mm = simToModel(mk.x, mk.y);
        orbitRef.current.tgt.set(mm.x, 2, mm.z);
        orbitRef.current.az = 1.9;
        orbitRef.current.el = 0.48;
        orbitRef.current.dist = 75;
        orbitRef.current.onChange();
      } else {
        orbitRef.current?.setView(PRESET_TO_VIEW[preset] || 'iso');
      }
      requestRender();
    };

    const resetCamera = () => setCameraPreset('isometric');

    const captureScreenshot = (): string => {
      const r = rendererRef.current;
      const s = sceneRef.current;
      const c = cameraRef.current;
      if (!r || !s || !c) return '';
      orbitRef.current?.apply(c);
      r.render(s, c);
      return r.domElement.toDataURL('image/png');
    };

    const exportGLTF = (filename = 'Cite3D_Maquette_Numerique.glb'): Promise<void> => {
      return new Promise((resolve, reject) => {
        if (!sceneRef.current) {
          reject(new Error('Scène 3D non disponible'));
          return;
        }
        const exporter = new GLTFExporter();
        exporter.parse(
          sceneRef.current,
          (gltf) => {
            const isBinary = gltf instanceof ArrayBuffer;
            const blob = isBinary
              ? new Blob([gltf], { type: 'model/gltf-binary' })
              : new Blob([JSON.stringify(gltf, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = isBinary ? filename : filename.replace('.glb', '.gltf');
            a.click();
            URL.revokeObjectURL(url);
            resolve();
          },
          (err) => {
            console.error('Erreur exportation GLTF:', err);
            reject(err);
          },
          { binary: true }
        );
      });
    };

    const toggleTrees = () => setAreTreesVisible((v) => !v);
    const toggleLabels = () => setAreLabelsVisible((v) => !v);
    const toggleShadows = () => setShadowsOn((v) => !v);

    useImperativeHandle(ref, () => ({
      resetCamera,
      setCameraPreset,
      captureScreenshot,
      exportGLTF,
      toggleTrees,
      toggleLabels,
      toggleShadows,
    }));

    useEffect(() => {
      if (showTreesProp !== undefined) setAreTreesVisible(showTreesProp);
    }, [showTreesProp]);

    // Marché (petit volume 3D couvert + étals + étiquette) — position mise à jour sans recréer le maillage
    useEffect(() => {
      const scene = sceneRef.current;
      if (!scene) return;
      if (!marketGroupRef.current) {
        const mg = new THREE.Group();
        const makeLambert = (hex: number) =>
          new THREE.MeshLambertMaterial({ color: new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace) });

        // Socle / esplanade du marché (15m × 15m)
        const pad = new THREE.Mesh(new THREE.BoxGeometry(15, 0.45, 15), makeLambert(0xd97706));
        pad.position.set(0, GROUND_Y + 0.225, 0);
        pad.castShadow = pad.receiveShadow = true;
        pad.userData = { isMarket: true };
        mg.add(pad);

        // Petit volume principal (halle couverte 10.5m × 3.2m × 9.5m)
        const hall = new THREE.Mesh(new THREE.BoxGeometry(10.5, 3.2, 9.5), makeLambert(0xf3ead8));
        hall.position.set(0, GROUND_Y + 0.45 + 1.6, 0);
        hall.castShadow = hall.receiveShadow = true;
        hall.userData = { isMarket: true };
        mg.add(hall);

        // Bandeau / auvent périphérique orange
        const awning = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.35, 11.4), makeLambert(0xf97316));
        awning.position.set(0, GROUND_Y + 3.05, 0);
        awning.castShadow = awning.receiveShadow = true;
        awning.userData = { isMarket: true };
        mg.add(awning);

        // Toiture à 4 pans (pavillon de marché)
        const roof = new THREE.Mesh(new THREE.ConeGeometry(8.5, 2.0, 4), makeLambert(0xea580c));
        roof.rotation.y = Math.PI / 4;
        roof.scale.set(1.06, 1, 0.96);
        roof.position.set(0, GROUND_Y + 4.45, 0);
        roof.castShadow = roof.receiveShadow = true;
        roof.userData = { isMarket: true };
        mg.add(roof);

        // Lanterneau supérieur de ventilation
        const lantern = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.6, 2.8), makeLambert(0xfaf5eb));
        lantern.position.set(0, GROUND_Y + 5.1, 0);
        lantern.castShadow = lantern.receiveShadow = true;
        lantern.userData = { isMarket: true };
        mg.add(lantern);

        const lanternCap = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.22, 3.3), makeLambert(0xc2410c));
        lanternCap.position.set(0, GROUND_Y + 5.45, 0);
        lanternCap.castShadow = lanternCap.receiveShadow = true;
        lanternCap.userData = { isMarket: true };
        mg.add(lanternCap);

        // 3 petits étals extérieurs devant la façade
        const stallColors = [0xf97316, 0x16a34a, 0xf59e0b];
        [-3.4, 0, 3.4].forEach((sx, idx) => {
          const table = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.85, 1.3), makeLambert(0x92400e));
          table.position.set(sx, GROUND_Y + 0.45 + 0.425, 5.75);
          table.castShadow = table.receiveShadow = true;
          table.userData = { isMarket: true };
          mg.add(table);

          const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.18, 1.6), makeLambert(stallColors[idx]));
          canopy.position.set(sx, GROUND_Y + 2.15, 5.75);
          canopy.rotation.x = 0.18;
          canopy.castShadow = canopy.receiveShadow = true;
          canopy.userData = { isMarket: true };
          mg.add(canopy);
        });

        const mLabel = createLabelSprite('Marché', 0.7);
        mLabel.position.set(0, 14, 0);
        mLabel.userData = { isMarket: true };
        mg.add(mLabel);

        const ring = new THREE.Mesh(
          new THREE.RingGeometry(10.5, 12.2, 32),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color().setHex(0x38bdf8, THREE.LinearSRGBColorSpace),
            side: THREE.DoubleSide,
          })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, GROUND_Y + 0.25, 0);
        ring.visible = false;
        mg.add(ring);

        scene.add(mg);
        marketGroupRef.current = mg;
        marketPadRef.current = pad;
        marketLabelRef.current = mLabel;
        marketRingRef.current = ring;
      }

      const mk = config.marketRelocated ? config.marketPosition : { x: layout.market.x, y: layout.market.y };
      const mm = simToModel(mk.x, mk.y);
      marketGroupRef.current.position.set(mm.x, 0, mm.z);
      if (marketRingRef.current) {
        marketRingRef.current.visible = Boolean(isMarketSelected);
      }
      requestRender();
    }, [layout.market.x, layout.market.y, config.marketRelocated, config.marketPosition, isMarketSelected, isLoading]);

    // Portes d'accès (cyan) de la simulation
    useEffect(() => {
      const scene = sceneRef.current;
      if (!scene) return;
      if (markersGroupRef.current) {
        scene.remove(markersGroupRef.current);
        markersGroupRef.current.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
          const mat = m.material as THREE.Material | undefined;
          if (mat) mat.dispose();
        });
      }
      const g = new THREE.Group();
      layout.visitorGates.forEach((gate) => {
        const gm = simToModel(gate.position.x, gate.position.y);
        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(2.2, 2.2, 9, 12),
          new THREE.MeshBasicMaterial({ color: new THREE.Color().setHex(0x06b6d4, THREE.LinearSRGBColorSpace) })
        );
        pillar.position.set(gm.x, GROUND_Y + 4.5, gm.z);
        g.add(pillar);
      });

      scene.add(g);
      markersGroupRef.current = g;
      requestRender();
    }, [layout.visitorGates, isLoading]);

    // Visibilité des arbres / étiquettes
    useEffect(() => {
      treeMeshesRef.current.forEach((m) => (m.visible = areTreesVisible));
      requestRender();
    }, [areTreesVisible, isLoading]);

    useEffect(() => {
      if (labelsGroupRef.current) labelsGroupRef.current.visible = areLabelsVisible;
      requestRender();
    }, [areLabelsVisible, isLoading]);

    // Ombres (case « Ombres » du HTML)
    useEffect(() => {
      const r = rendererRef.current;
      const sun = sunRef.current;
      const model = modelRef.current;
      if (!r || !sun || !model) return;
      setShadows(r, sun, model, shadowsOn);
      requestRender();
    }, [shadowsOn, isLoading]);

    // Montage de la scène Three.js
    useEffect(() => {
      const container = mountRef.current;
      if (!container) return;
      let disposed = false;

      const width = container.clientWidth || 800;
      const height = container.clientHeight || 550;

      const { scene, sun } = createSiteScene();
      sceneRef.current = scene;
      sunRef.current = sun;

      const camera = new THREE.PerspectiveCamera(40, width / height, 1, 4000);
      cameraRef.current = camera;

      const renderer = createSiteRenderer();
      renderer.setSize(width, height);
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      const orbit = new SiteOrbit(renderer.domElement);
      orbit.onChange = requestRender;
      orbit.setView('iso');
      orbitRef.current = orbit;

      // Agents de simulation (capsules instanciées)
      const agentGeo = new THREE.CapsuleGeometry(0.3, 1.1, 4, 8);
      const agentMat = new THREE.MeshBasicMaterial();
      const instancedAgents = new THREE.InstancedMesh(agentGeo, agentMat, MAX_AGENTS);
      instancedAgents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      instancedAgents.frustumCulled = false;
      instancedAgents.count = 0;
      scene.add(instancedAgents);
      instancedAgentsRef.current = instancedAgents;

      // Lignes de contact (< 2 m)
      const proximityLines = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.85 })
      );
      proximityLines.frustumCulled = false;
      scene.add(proximityLines);
      proximityLinesRef.current = proximityLines;

      // Chargement du modèle
      loadSiteModel()
        .then((model) => {
          if (disposed) return;
          modelRef.current = model;
          const { group, byMaterial } = createSiteGroup(model);
          scene.add(group);
          meshesRef.current = byMaterial;
          treeMeshesRef.current = TREE_MATERIALS.map((n) => byMaterial[n]).filter(Boolean);

          const labels = new THREE.Group();
          SITE_LABELS.forEach((l) => {
            const s = createLabelSprite(l.text);
            s.position.set(l.x, l.y, l.z);
            labels.add(s);
          });
          scene.add(labels);
          labelsGroupRef.current = labels;

          setIsLoading(false);
          requestRender();
        })
        .catch((err) => {
          if (disposed) return;
          console.error(err);
          setLoadError(err?.message || 'Impossible de charger le modèle urbain');
          setIsLoading(false);
        });

      // Interactions
      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2();
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GROUND_Y);
      let downPos: { x: number; y: number } | null = null;
      let marketDrag3D: { offsetX: number; offsetZ: number; moved: boolean } | null = null;
      let justDraggedMarket3D = false;
      let lastHoverKey = '';

      const setMouseFromEvent = (e: MouseEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        orbit.apply(camera);
        camera.updateMatrixWorld();
        raycaster.setFromCamera(mouse, camera);
      };

      const buildMarketInfo3D = (x: number, y: number): SelectedObjectInfo => {
        const mkt = propsRef.current.layout.market;
        return {
          type: 'market',
          id: mkt.id,
          name: mkt.name || 'Marché',
          details: {
            Entité: 'Marché',
            'Nombre d’étals': mkt.stallCount,
            Dimensions: `${mkt.width}m × ${mkt.height}m`,
            Orientation: `${mkt.rotation || 0}°`,
            'Facteur d’attraction': mkt.attractionFactor,
            'Coordonnées UV9': `X: ${x}m, Y: ${y}m`,
          },
          position: { x, y, z: GROUND_Y + 0.5 },
        };
      };

      const hitMarket3D = (e: MouseEvent) => {
        const mg = marketGroupRef.current;
        if (!mg) return false;
        setMouseFromEvent(e);
        const hits = raycaster.intersectObject(mg, true);
        return hits.some((h) => h.object !== marketRingRef.current);
      };

      const handleCaptureDown = (e: PointerEvent) => {
        justDraggedMarket3D = false;
        downPos = { x: e.clientX, y: e.clientY };
        if (
          !propsRef.current.measurementMode &&
          !propsRef.current.isMarketLocked &&
          e.button === 0 &&
          !e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          hitMarket3D(e)
        ) {
          const p = new THREE.Vector3();
          if (raycaster.ray.intersectPlane(groundPlane, p)) {
            const pr = propsRef.current;
            const mk = pr.config.marketRelocated ? pr.config.marketPosition : { x: pr.layout.market.x, y: pr.layout.market.y };
            const mm = simToModel(mk.x, mk.y);
            marketDrag3D = { offsetX: p.x - mm.x, offsetZ: p.z - mm.z, moved: false };
            e.stopPropagation();
            renderer.domElement.setPointerCapture(e.pointerId);
            renderer.domElement.style.cursor = 'grabbing';
            pr.onSelectObject?.(buildMarketInfo3D(mk.x, mk.y));
          }
        }
      };

      const handleCaptureMove = (e: PointerEvent) => {
        if (!marketDrag3D) return;
        e.stopPropagation();
        if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 3) {
          marketDrag3D.moved = true;
        }
        setMouseFromEvent(e);
        const p = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(groundPlane, p)) {
          const sim = modelToSim(p.x - marketDrag3D.offsetX, p.z - marketDrag3D.offsetZ);
          propsRef.current.onMoveMarket?.(sim.simX, sim.simY);
          propsRef.current.onHoverCoords?.({ x: sim.simX, y: sim.simY });
        }
      };

      const handleCaptureUp = (e: PointerEvent) => {
        if (!marketDrag3D) return;
        e.stopPropagation();
        if (marketDrag3D.moved) justDraggedMarket3D = true;
        marketDrag3D = null;
        renderer.domElement.style.cursor = '';
        if (renderer.domElement.hasPointerCapture(e.pointerId)) {
          renderer.domElement.releasePointerCapture(e.pointerId);
        }
      };

      const handleClick = (e: MouseEvent) => {
        if (justDraggedMarket3D) {
          justDraggedMarket3D = false;
          return;
        }
        // Ignorer les clics issus d'un glissement (orbite / déplacement)
        if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) return;
        setMouseFromEvent(e);

        // Mode mesure : distance réelle en mètres entre deux points du sol
        if (propsRef.current.measurementMode) {
          const p = new THREE.Vector3();
          if (raycaster.ray.intersectPlane(groundPlane, p)) {
            measurementPointsRef.current.push(p);
            if (measurementPointsRef.current.length === 2) {
              const [p1, p2] = measurementPointsRef.current;
              const distMeters = p1.distanceTo(p2);
              const s1 = modelToSim(p1.x, p1.z);
              const s2 = modelToSim(p2.x, p2.z);

              if (measurementLineRef.current) scene.remove(measurementLineRef.current);
              const mLine = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([p1, p2]),
                new THREE.LineBasicMaterial({ color: 0xf59e0b })
              );
              scene.add(mLine);
              measurementLineRef.current = mLine;
              requestRender();

              propsRef.current.onMeasurementDone?.(
                distMeters,
                { x: s1.simX, y: s1.simY },
                { x: s2.simX, y: s2.simY }
              );
              measurementPointsRef.current = [];
            }
          }
          return;
        }

        // Sélection : Marché, agents, puis éléments bâtis du modèle
        const onSelect = propsRef.current.onSelectObject;
        if (!onSelect) return;

        if (hitMarket3D(e)) {
          const pr = propsRef.current;
          const mk = pr.config.marketRelocated ? pr.config.marketPosition : { x: pr.layout.market.x, y: pr.layout.market.y };
          onSelect(buildMarketInfo3D(mk.x, mk.y));
          return;
        }

        const agentMesh = instancedAgentsRef.current;
        if (agentMesh && agentMesh.count > 0) {
          const hit = raycaster.intersectObject(agentMesh, false)[0];
          if (hit && hit.instanceId !== undefined) {
            const ag = propsRef.current.agents[hit.instanceId];
            if (ag) {
              const demLabel =
                ag.demographic === 'elderly'
                  ? 'Personne Âgée (Vulnérable)'
                  : ag.demographic === 'child'
                  ? 'Enfant (Élève / Jeune)'
                  : 'Adulte / Jeune Parent';
              onSelect({
                type: 'agent',
                id: `agent_${ag.id}`,
                name: `Piéton 3D #${ag.id} — ${demLabel}`,
                details: {
                  'Groupe Démographique': demLabel,
                  'Cellule Familiale': `Famille #${ag.familyId || 1} (Foyer intergénérationnel)`,
                  'Statut Sanitaire':
                    ag.state === 'I'
                      ? 'Infecté (Contagieux)'
                      : ag.state === 'R'
                      ? 'Rétabli (Immunisé)'
                      : 'Sain (Susceptible)',
                  'Port du Masque': ag.maskWearing ? 'Oui (Atténuation 65%)' : 'Non',
                  Vitesse: `${ag.speed.toFixed(2)} m/s`,
                  'Contacts Rapprochés (<2m)': ag.cumulativeContacts,
                  'Vecteur Contamination':
                    ag.transmissionPathway === 'fomite'
                      ? 'Surfaces / Étal de marché'
                      : ag.transmissionPathway === 'aerosol'
                      ? 'Aérosol (Microclimat ENVI-met)'
                      : 'Sain / Non infecté',
                  'Coordonnées UV9': `X: ${ag.x.toFixed(1)}m, Y: ${ag.y.toFixed(1)}m`,
                },
                position: { x: ag.x, y: ag.y, z: 1.7 },
              });
              return;
            }
          }
        }

        const targets = Object.keys(BUILDING_MATERIALS)
          .map((n) => meshesRef.current[n])
          .filter(Boolean);
        const hit = raycaster.intersectObjects(targets, false)[0];
        if (hit) {
          const matName = (hit.object.userData?.siteMaterial as string) || hit.object.name;
          const label = BUILDING_MATERIALS[matName] || matName;
          const sim = modelToSim(hit.point.x, hit.point.z);
          onSelect({
            type: 'building',
            id: `${matName}_${Math.round(hit.point.x)}_${Math.round(hit.point.z)}`,
            name: label,
            details: {
              Élément: label,
              Matériau: matName,
              'Altitude du point': `${hit.point.y.toFixed(1)} m`,
              'Position modèle': `X: ${hit.point.x.toFixed(1)} m, Z: ${hit.point.z.toFixed(1)} m`,
              'Coordonnées UV9': `X: ${sim.simX}m, Y: ${sim.simY}m`,
            },
            position: { x: sim.simX, y: sim.simY, z: hit.point.y },
          });
        } else {
          onSelect(null);
        }
      };

      const handlePointerMove = (e: MouseEvent) => {
        if (marketDrag3D) return;
        if (!propsRef.current.measurementMode) {
          renderer.domElement.style.cursor = hitMarket3D(e)
            ? propsRef.current.isMarketLocked
              ? 'pointer'
              : 'grab'
            : '';
        }
        if (!propsRef.current.onHoverCoords) return;
        setMouseFromEvent(e);
        const p = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(groundPlane, p)) {
          const sim = modelToSim(p.x, p.z);
          const key = `${sim.simX}_${sim.simY}`;
          if (key !== lastHoverKey) {
            lastHoverKey = key;
            propsRef.current.onHoverCoords({ x: sim.simX, y: sim.simY });
          }
        }
      };

      renderer.domElement.addEventListener('pointerdown', handleCaptureDown, { capture: true });
      renderer.domElement.addEventListener('pointermove', handleCaptureMove, { capture: true });
      renderer.domElement.addEventListener('pointerup', handleCaptureUp, { capture: true });
      renderer.domElement.addEventListener('click', handleClick);
      renderer.domElement.addEventListener('mousemove', handlePointerMove);

      const handleResize = () => {
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 550;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        requestRender();
      };
      window.addEventListener('resize', handleResize);
      const resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(container);
      handleResize();

      // Boucle de rendu à la demande (le modèle compte ~800 000 triangles)
      let animId = 0;
      const animate = () => {
        animId = requestAnimationFrame(animate);
        if (!needsRenderRef.current) return;
        needsRenderRef.current = false;
        orbit.apply(camera);
        renderer.render(scene, camera);
      };
      animate();

      return () => {
        disposed = true;
        cancelAnimationFrame(animId);
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
        renderer.domElement.removeEventListener('pointerdown', handleCaptureDown, { capture: true });
        renderer.domElement.removeEventListener('pointermove', handleCaptureMove, { capture: true });
        renderer.domElement.removeEventListener('pointerup', handleCaptureUp, { capture: true });
        renderer.domElement.removeEventListener('click', handleClick);
        renderer.domElement.removeEventListener('mousemove', handlePointerMove);
        orbit.dispose();
        agentGeo.dispose();
        agentMat.dispose();
        instancedAgents.dispose();
        proximityLines.geometry.dispose();
        if (marketGroupRef.current) {
          marketGroupRef.current.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.geometry) m.geometry.dispose();
            const mat = m.material as THREE.Material | undefined;
            if (mat) {
              const sMat = mat as THREE.SpriteMaterial;
              if (sMat.map) sMat.map.dispose();
              mat.dispose();
            }
          });
          marketGroupRef.current = null;
          marketPadRef.current = null;
          marketLabelRef.current = null;
          marketRingRef.current = null;
        }
        // Géométries et matériaux du modèle sont partagés (cache) : on ne les libère pas.
        if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
        renderer.dispose();
        rendererRef.current = null;
        sceneRef.current = null;
        cameraRef.current = null;
        orbitRef.current = null;
        sunRef.current = null;
        instancedAgentsRef.current = null;
        proximityLinesRef.current = null;
      };
    }, []);

    // Synchronisation des agents et des lignes de contact
    useEffect(() => {
      const instanced = instancedAgentsRef.current;
      if (!instanced) return;

      const dummy = new THREE.Object3D();
      const col = new THREE.Color();
      const count = Math.min(agents.length, MAX_AGENTS);
      instanced.count = count;

      const COLOR_S = 0x22c55e; // Vert : sain
      const COLOR_I = 0xef4444; // Rouge : infecté
      const COLOR_R = 0xeab308; // Jaune : rétabli / exposé
      const half = 0.85 * agentScale; // demi-hauteur de la capsule mise à l'échelle

      for (let i = 0; i < count; i++) {
        const a = agents[i];
        const p = simToModel(a.x, a.y);
        dummy.position.set(p.x, GROUND_Y + half, p.z);

        if (a.targetX !== undefined && a.targetY !== undefined) {
          const dx = a.targetX - a.x;
          const dy = a.targetY - a.y;
          if (dx * dx + dy * dy > 0.1) dummy.rotation.y = -Math.atan2(dy, dx) + Math.PI / 2;
        }

        dummy.scale.setScalar(agentScale);
        dummy.updateMatrix();
        instanced.setMatrixAt(i, dummy.matrix);

        const hex = a.state === 'I' ? COLOR_I : a.state === 'R' ? COLOR_R : COLOR_S;
        col.setHex(hex, THREE.LinearSRGBColorSpace);
        instanced.setColorAt(i, col);
      }
      instanced.instanceMatrix.needsUpdate = true;
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;

      const lines = proximityLinesRef.current;
      if (lines) {
        if (!showProximityLines) {
          lines.visible = false;
        } else {
          lines.visible = true;
          const linePts: number[] = [];
          const thresholdSq = (config.contamination.contactDistanceThresholdMeters || 2.0) ** 2;
          const y = GROUND_Y + 1.2 * agentScale;
          const addLine = (a1: Agent, a2: Agent) => {
            const p1 = simToModel(a1.x, a1.y);
            const p2 = simToModel(a2.x, a2.y);
            linePts.push(p1.x, y, p1.z, p2.x, y, p2.z);
          };

          if (agents.length <= 350) {
            outer: for (let i = 0; i < agents.length; i++) {
              for (let j = i + 1; j < agents.length; j++) {
                const dx = agents[i].x - agents[j].x;
                const dy = agents[i].y - agents[j].y;
                if (dx * dx + dy * dy <= thresholdSq) {
                  addLine(agents[i], agents[j]);
                  if (linePts.length >= 6000) break outer;
                }
              }
            }
          } else {
            const cellSize = 5.0;
            const grid = new Map<string, number[]>();
            const maxEvaluated = Math.min(agents.length, 10000);
            for (let i = 0; i < maxEvaluated; i++) {
              const a = agents[i];
              const key = `${Math.floor(a.x / cellSize)}_${Math.floor(a.y / cellSize)}`;
              const list = grid.get(key);
              if (list) list.push(i);
              else grid.set(key, [i]);
            }
            outerGrid: for (const [, idx] of grid) {
              for (let i = 0; i < idx.length; i++) {
                for (let j = i + 1; j < idx.length; j++) {
                  const a1 = agents[idx[i]];
                  const a2 = agents[idx[j]];
                  const dx = a1.x - a2.x;
                  const dy = a1.y - a2.y;
                  if (dx * dx + dy * dy <= thresholdSq) {
                    addLine(a1, a2);
                    if (linePts.length >= 6000) break outerGrid;
                  }
                }
              }
            }
          }

          lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
          lines.geometry.computeBoundingSphere();
        }
      }
      requestRender();
    }, [agents, showProximityLines, config, agentScale]);

    return (
      <div className="w-full h-full relative group">
        <div ref={mountRef} className="w-full h-full min-h-[550px] cursor-grab active:cursor-grabbing" />

        {isLoading && (
          <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/80 text-slate-200 text-sm">
            Chargement du modèle…
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/90 text-rose-300 text-sm px-6 text-center">
            {loadError}
          </div>
        )}

        {/* Commandes rapides (case « Ombres » du modèle d'origine + calques) */}
        <div className="absolute top-9 left-2 z-20 flex flex-wrap items-center gap-1.5 max-w-[calc(100%-22rem)] bg-slate-900/85 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-700/80 text-xs shadow-lg">
          <button
            onClick={toggleShadows}
            className={`px-2 py-0.5 rounded font-medium transition ${
              shadowsOn ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            title="Activer ou désactiver les ombres portées du soleil"
          >
            Ombres
          </button>
          <button
            onClick={toggleTrees}
            className={`px-2 py-0.5 rounded font-medium transition ${
              areTreesVisible ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            title="Afficher ou masquer les arbres (troncs, feuillages, conifères, palmiers)"
          >
            Arbres
          </button>
          <button
            onClick={toggleLabels}
            className={`px-2 py-0.5 rounded font-medium transition ${
              areLabelsVisible ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            title="Afficher ou masquer les étiquettes repères"
          >
            Étiquettes
          </button>
          <button
            onClick={() => setAgentScaleIdx((i) => (i + 1) % AGENT_SCALES.length)}
            className="px-2 py-0.5 rounded font-medium transition bg-purple-600 text-white hover:bg-purple-500"
            title="Taille d'affichage des agents (le secteur fait ~520 m de large)"
          >
            Agents ×{agentScale}
          </button>
        </div>

        <div className="absolute bottom-3 right-3 z-20 max-w-[420px] text-[11px] leading-snug text-slate-200 bg-slate-900/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-700/80">
          Glisser : orbite · Maj+glisser / clic droit : déplacer · Molette : zoom. Hauteurs des bâtiments estimées
          (absentes du DWG).
        </div>
      </div>
    );
  }
);
