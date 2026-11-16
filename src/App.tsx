/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { ActiveTab, Navigation } from './components/Navigation';
import { Dashboard } from './components/Dashboard';
import { DocumentationView } from './components/DocumentationView';
import { ImportExportView } from './components/ImportExportView';
import { ReplicationsView } from './components/ReplicationsView';
import { ScenarioComparison } from './components/ScenarioComparison';
import { SensitivityView } from './components/SensitivityView';
import { SpatialViewer } from './components/SpatialViewer';
import { ValidationView } from './components/ValidationView';
import { UrbanDigitalTwinView } from './components/DigitalTwin/UrbanDigitalTwinView';
import { SketchfabHub } from './components/Sketchfab/SketchfabHub';
import { LicensesView } from './components/LicensesView';
import { SiteModelingView } from './components/SiteModeling/SiteModelingView';
import { PdfReportsView } from './components/Reports/PdfReportsView';
import { DetailedSimulationReportModal } from './components/Reports/DetailedSimulationReportModal';
import { INITIAL_SPATIAL_LAYOUT } from './engine/spatial';
import { SCENARIO_PRESETS } from './engine/scenarios';
import { SimulationInstance } from './engine/simulationEngine';
import { parseObjTo2DLayout } from './services/objToSpatialLayout';
import {
  HourlyClimateData,
  ScenarioConfig,
  ScenarioId,
  ScenarioReplicationStats,
  SimulationResult,
  SpatialLayout,
  StepMetric,
} from './types/simulation';

const MARKET_POS_STORAGE_KEY = 'urban_market_saved_position_v2';
const MARKET_LOCK_STORAGE_KEY = 'urban_market_locked_v2';
const FIXED_MARKET_DEFAULT_POS = { x: 387, y: 222 };

function loadSavedMarketPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(MARKET_POS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        return {
          x: Math.round(Math.max(0, Math.min(520, parsed.x))),
          y: Math.round(Math.max(0, Math.min(525, parsed.y))),
        };
      }
    }
  } catch {
    // ignore storage errors
  }
  return { ...FIXED_MARKET_DEFAULT_POS };
}

function loadMarketLocked(): boolean {
  try {
    const raw = localStorage.getItem(MARKET_LOCK_STORAGE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('digitalTwin');
  const [activeScenarioId, setActiveScenarioId] = useState<ScenarioId>('S0');

  // Simulation state
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [simulationSpeed, setSimulationSpeed] = useState<number>(5); // 1x, 5x, 20x
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [metricsHistory, setMetricsHistory] = useState<StepMetric[]>([]);
  const [latestMetric, setLatestMetric] = useState<StepMetric | null>(null);
  const [finalResult, setFinalResult] = useState<SimulationResult | null>(null);
  const [isDetailedReportOpen, setIsDetailedReportOpen] = useState<boolean>(false);

  // Saved & locked market position (starts fixed & locked at the requested position)
  const [savedMarketPos, setSavedMarketPos] = useState<{ x: number; y: number } | null>(() => loadSavedMarketPos());
  const [isMarketLocked, setIsMarketLocked] = useState<boolean>(() => loadMarketLocked());

  // Spatial layout state (can be edited in SiteModelingView)
  const [spatialLayout, setSpatialLayout] = useState(() => {
    const saved = loadSavedMarketPos();
    return { ...INITIAL_SPATIAL_LAYOUT, market: { ...INITIAL_SPATIAL_LAYOUT.market, x: saved.x, y: saved.y } };
  });
  const [currentConfig, setCurrentConfig] = useState<ScenarioConfig>(() => {
    const cfg: ScenarioConfig = JSON.parse(JSON.stringify(SCENARIO_PRESETS.S0));
    const saved = loadSavedMarketPos();
    cfg.marketPosition = { ...saved };
    return cfg;
  });

  // Engine instance ref
  const engineRef = useRef<SimulationInstance | null>(null);
  const timerRef = useRef<number | null>(null);

  // Live agents for spatial visualization
  const [agents, setAgents] = useState(() => {
    const saved = loadSavedMarketPos();
    const cfg: ScenarioConfig = JSON.parse(JSON.stringify(SCENARIO_PRESETS.S0));
    const layoutInit = { ...INITIAL_SPATIAL_LAYOUT, market: { ...INITIAL_SPATIAL_LAYOUT.market, x: saved.x, y: saved.y } };
    cfg.marketPosition = { ...saved };
    const inst = new SimulationInstance(cfg, 1, undefined, layoutInit);
    engineRef.current = inst;
    return [...inst.agents];
  });

  // Replications stats tracker
  const [replicationsCompletedCount, setReplicationsCompletedCount] = useState<number>(0);
  const [allScenarioStats, setAllScenarioStats] = useState<ScenarioReplicationStats[]>([]);

  // Initialize or re-initialize simulation instance when scenario changes
  const initSimulation = (
    scenarioId: ScenarioId,
    customConfig?: ScenarioConfig,
    forcedMarketPosOverride?: { x: number; y: number } | null
  ) => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsSimulating(false);

    const cfg: ScenarioConfig = customConfig || JSON.parse(JSON.stringify(SCENARIO_PRESETS[scenarioId]));
    const forcedPos = forcedMarketPosOverride !== undefined ? forcedMarketPosOverride : savedMarketPos;
    let layoutForSim: SpatialLayout | undefined;

    if (forcedPos) {
      cfg.marketPosition = { ...forcedPos };
      layoutForSim = {
        ...spatialLayout,
        market: { ...spatialLayout.market, x: forcedPos.x, y: forcedPos.y },
      };
    }

    setCurrentConfig(cfg);
    setActiveScenarioId(scenarioId);

    const newInstance = new SimulationInstance(cfg, 1, undefined, layoutForSim);
    engineRef.current = newInstance;

    setCurrentStep(0);
    setMetricsHistory([]);
    setLatestMetric(null);
    setFinalResult(null);
    setAgents([...newInstance.agents]);
  };

  const handleScenarioChange = (newId: ScenarioId) => {
    setActiveScenarioId(newId);
    initSimulation(newId);
  };

  // Run single step
  const executeStep = () => {
    if (!engineRef.current) return;
    const metric = engineRef.current.step();
    if (metric) {
      setCurrentStep(metric.step);
      setLatestMetric(metric);
      setMetricsHistory((prev) => [...prev, metric]);
      setAgents([...engineRef.current.agents]);
    } else {
      // Finished 540 steps
      setIsSimulating(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const finalRes = engineRef.current.getFinalResult();
      setFinalResult(finalRes);
      // Automatically open detailed report on simulation completion
      setIsDetailedReportOpen(true);
    }
  };

  // Animation loop controlled by speed
  useEffect(() => {
    if (isSimulating) {
      const intervalMs = simulationSpeed === 20 ? 15 : simulationSpeed === 5 ? 60 : 250;
      timerRef.current = window.setInterval(() => {
        executeStep();
      }, intervalMs);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isSimulating, simulationSpeed]);

  const handleStart = () => {
    if (currentStep >= 540) return;
    setIsSimulating(true);
  };

  const handlePause = () => {
    setIsSimulating(false);
  };

  const handleReset = () => {
    initSimulation(activeScenarioId);
  };

  const handleRunToCompletion = () => {
    if (!engineRef.current) return;
    setIsSimulating(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const result = engineRef.current.runToCompletion();
    setCurrentStep(result.totalSteps);
    setMetricsHistory(result.metrics);
    setLatestMetric(result.metrics[result.metrics.length - 1]);
    setAgents([...engineRef.current.agents]);
    setFinalResult(result);
    // Automatically open detailed report after full-day simulation
    setIsDetailedReportOpen(true);
  };

  const handleNewSimulation = () => {
    // Generate a fresh seed
    const newSeed = Math.floor(Math.random() * 900000) + 10000;
    const updatedCfg: ScenarioConfig = {
      ...JSON.parse(JSON.stringify(SCENARIO_PRESETS[activeScenarioId])),
      seed: newSeed,
    };
    initSimulation(activeScenarioId, updatedCfg);
  };

  // Population & Initial Infection configuration handler
  const handleUpdatePopulationParams = (totalPop: number, initialInfected: number) => {
    const updatedCfg: ScenarioConfig = {
      ...currentConfig,
      initialPopulation: totalPop,
      initialInfectedCount: initialInfected,
    };
    initSimulation(activeScenarioId, updatedCfg);
  };

  // Microclimate update handler from CSV import
  const handleUpdateClimateData = (newData: HourlyClimateData[]) => {
    const updatedCfg: ScenarioConfig = {
      ...currentConfig,
      climate: {
        ...currentConfig.climate,
        observations: newData,
      },
    };
    initSimulation(activeScenarioId, updatedCfg);
  };

  const handleNotifyReplicationsDone = (count: number, stats: ScenarioReplicationStats[]) => {
    setReplicationsCompletedCount((prev) => prev + count);
    setAllScenarioStats(stats);
  };

  // Single source of truth for moving the Market entity across 2D, 3D, and simulation engine
  const persistMarketPos = (pos: { x: number; y: number }) => {
    setSavedMarketPos(pos);
    try {
      localStorage.setItem(MARKET_POS_STORAGE_KEY, JSON.stringify(pos));
    } catch {
      // ignore storage errors
    }
  };

  const handleMoveMarket = (x: number, y: number) => {
    if (isMarketLocked) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const clampedX = Math.round(Math.max(0, Math.min(520, x)));
    const clampedY = Math.round(Math.max(0, Math.min(525, y)));
    const newPos = { x: clampedX, y: clampedY };
    persistMarketPos(newPos);
    setSpatialLayout((prev) => ({
      ...prev,
      market: { ...prev.market, x: clampedX, y: clampedY },
    }));
    setCurrentConfig((prev) => ({
      ...prev,
      marketPosition: newPos,
    }));
    if (engineRef.current) {
      engineRef.current.layout.market.x = clampedX;
      engineRef.current.layout.market.y = clampedY;
      engineRef.current.config.marketPosition = newPos;
    }
  };

  const handleSaveAndLockMarket = () => {
    const activePos = currentConfig.marketRelocated
      ? currentConfig.marketPosition
      : { x: spatialLayout.market.x, y: spatialLayout.market.y };
    const clampedPos = {
      x: Math.round(Math.max(0, Math.min(520, activePos.x))),
      y: Math.round(Math.max(0, Math.min(525, activePos.y))),
    };
    persistMarketPos(clampedPos);
    setIsMarketLocked(true);
    try {
      localStorage.setItem(MARKET_LOCK_STORAGE_KEY, 'true');
    } catch {
      // ignore
    }
    setSpatialLayout((prev) => ({
      ...prev,
      market: { ...prev.market, x: clampedPos.x, y: clampedPos.y },
    }));
    setCurrentConfig((prev) => ({
      ...prev,
      marketPosition: clampedPos,
    }));
    if (engineRef.current) {
      engineRef.current.layout.market.x = clampedPos.x;
      engineRef.current.layout.market.y = clampedPos.y;
      engineRef.current.config.marketPosition = clampedPos;
    }
  };

  const handleUnlockMarket = () => {
    setIsMarketLocked(false);
    try {
      localStorage.setItem(MARKET_LOCK_STORAGE_KEY, 'false');
    } catch {
      // ignore
    }
  };

  const handleResetMarketPosition = () => {
    const fixedPos = { ...FIXED_MARKET_DEFAULT_POS };
    setIsMarketLocked(true);
    setSavedMarketPos(fixedPos);
    try {
      localStorage.removeItem(MARKET_POS_STORAGE_KEY);
      localStorage.setItem(MARKET_LOCK_STORAGE_KEY, 'true');
    } catch {
      // ignore
    }
    setSpatialLayout((prev) => ({
      ...prev,
      market: { ...prev.market, x: fixedPos.x, y: fixedPos.y },
    }));
    setCurrentConfig((prev) => ({
      ...prev,
      marketPosition: fixedPos,
    }));
    if (engineRef.current) {
      engineRef.current.layout.market.x = fixedPos.x;
      engineRef.current.layout.market.y = fixedPos.y;
      engineRef.current.config.marketPosition = fixedPos;
    }
  };

  const handleUpdateSpatialLayoutGuarded = (newLayout: SpatialLayout) => {
    if (isMarketLocked) {
      setSpatialLayout({
        ...newLayout,
        market: { ...newLayout.market, x: spatialLayout.market.x, y: spatialLayout.market.y },
      });
      return;
    }
    setSpatialLayout(newLayout);
    if (newLayout.market.x !== spatialLayout.market.x || newLayout.market.y !== spatialLayout.market.y) {
      const pos = { x: Math.round(newLayout.market.x), y: Math.round(newLayout.market.y) };
      persistMarketPos(pos);
      setCurrentConfig((prev) => ({ ...prev, marketPosition: pos }));
    }
  };

  const clockTime = currentStep >= 540 ? '18:00' : latestMetric?.clockTime || '09:00';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-600 selection:text-white">
      {/* Header and Nav */}
      <Navigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        activeScenarioId={activeScenarioId}
        onScenarioChange={handleScenarioChange}
        isSimulating={isSimulating}
        clockTime={clockTime}
        step={currentStep}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {activeTab === 'digitalTwin' && (
          <UrbanDigitalTwinView
            layout={spatialLayout}
            agents={agents}
            config={currentConfig}
            stepMetric={latestMetric}
            currentStep={currentStep}
            isSimulating={isSimulating}
            simulationSpeed={simulationSpeed}
            onSpeedChange={setSimulationSpeed}
            onStart={handleStart}
            onPause={handlePause}
            onReset={handleReset}
            onRunToCompletion={handleRunToCompletion}
            onScenarioChange={handleScenarioChange}
            onUpdateSpatialLayout={handleUpdateSpatialLayoutGuarded}
            onMoveMarket={handleMoveMarket}
            isMarketLocked={isMarketLocked}
            onSaveAndLockMarket={handleSaveAndLockMarket}
            onUnlockMarket={handleUnlockMarket}
            onResetMarketPosition={handleResetMarketPosition}
            onNavigateTab={setActiveTab}
            onOpenDetailedReport={() => setIsDetailedReportOpen(true)}
            onUpdatePopulationParams={handleUpdatePopulationParams}
            metricsHistory={metricsHistory}
          />
        )}

        {activeTab === 'siteModeling' && (
          <SiteModelingView
            layout={spatialLayout}
            onUpdateSpatialLayout={setSpatialLayout}
            activeScenarioId={activeScenarioId}
            onScenarioChange={handleScenarioChange}
            onNavigateTab={setActiveTab}
          />
        )}

        {activeTab === 'pdfReports' && (
          <PdfReportsView
            config={currentConfig}
            metrics={metricsHistory}
            result={finalResult}
            replicationsStats={allScenarioStats}
          />
        )}

        {activeTab === 'sketchfab' && (
          <SketchfabHub
            layout={spatialLayout}
            onUpdateSpatialLayout={setSpatialLayout}
            onNavigateTab={(tab) => setActiveTab(tab as any)}
          />
        )}

        {activeTab === 'licenses' && <LicensesView />}

        {activeTab === 'dashboard' && (
          <Dashboard
            config={currentConfig}
            currentStep={currentStep}
            isSimulating={isSimulating}
            simulationSpeed={simulationSpeed}
            onSpeedChange={setSimulationSpeed}
            onStart={handleStart}
            onPause={handlePause}
            onReset={handleReset}
            onRunToCompletion={handleRunToCompletion}
            onNewSimulation={handleNewSimulation}
            onNavigateTab={setActiveTab}
            latestMetric={latestMetric}
            metricsHistory={metricsHistory}
            replicationsCompletedCount={replicationsCompletedCount}
            finalResult={finalResult}
            onUpdatePopulationParams={handleUpdatePopulationParams}
          />
        )}

        {activeTab === 'spatial' && (
          <SpatialViewer
            layout={INITIAL_SPATIAL_LAYOUT}
            agents={agents}
            config={currentConfig}
            stepMetric={latestMetric}
            currentStep={currentStep}
          />
        )}

        {activeTab === 'comparison' && (
          <ScenarioComparison
            onSelectScenario={handleScenarioChange}
            activeScenarioId={activeScenarioId}
            replicationsStats={allScenarioStats}
          />
        )}

        {activeTab === 'replications' && (
          <ReplicationsView
            onNotifyReplicationsDone={handleNotifyReplicationsDone}
            sharedScenarioStats={allScenarioStats}
          />
        )}

        {activeTab === 'sensitivity' && <SensitivityView />}

        {activeTab === 'validation' && <ValidationView />}

        {activeTab === 'importExport' && (
          <ImportExportView
            currentConfig={currentConfig}
            onUpdateClimateData={handleUpdateClimateData}
            activeResult={finalResult}
            allScenarioStats={allScenarioStats}
          />
        )}

        {activeTab === 'documentation' && (
          <DocumentationView currentConfig={currentConfig} />
        )}
      </main>

      {/* Scientific Footer */}
      <footer className="bg-slate-950 border-t border-slate-800 text-slate-500 text-xs py-4 px-6">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-300">UrbanResilience SimLab</span>
            <span>·</span>
            <span>Unité de Voisinage 9, Ville Nouvelle Ali Mendjeli, Constantine</span>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <span className="text-amber-400/90 font-medium">
              Hypothèse illustrative non calibrée cliniquement — Comparaisons relatives
            </span>
            <span className="text-slate-600">|</span>
            <span className="font-mono text-slate-400">PRNG Mulberry32 déterministe</span>
          </div>
        </div>
      </footer>
      {/* Comprehensive Scientific Urban Resilience Detailed Report Modal */}
      <DetailedSimulationReportModal
        isOpen={isDetailedReportOpen}
        onClose={() => setIsDetailedReportOpen(false)}
        config={currentConfig}
        metrics={metricsHistory}
        result={finalResult}
        layout={spatialLayout}
        onNavigateTab={(tab) => {
          setIsDetailedReportOpen(false);
          setActiveTab(tab as any);
        }}
      />
    </div>
  );
}
