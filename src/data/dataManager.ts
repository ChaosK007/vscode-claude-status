import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { readAllUsage, wasJsonlUpdatedRecently } from './jsonlReader';
import { fetchRateLimitData, detectProvider, RateLimitData, ClaudeProvider } from './apiClient';
import { readCache, writeCache, isCacheValid, getCacheAge } from './cache';
import { getAllProjectCosts, ProjectCostData } from './projectCost';
import { computePrediction, PredictionData } from './prediction';
import { getHeatmapData as computeHeatmapData, HeatmapData } from '../webview/heatmap';
import { config } from '../config';
import { logger } from '../logger';

export { PredictionData, HeatmapData };

export interface ClaudeUsageData {
  // From API / cache
  utilization5h: number
  utilization7d: number
  resetIn5h: number
  resetIn7d: number
  limitStatus: 'allowed' | 'allowed_warning' | 'denied'

  // From local JSONL
  cost5h: number
  costDay: number
  cost7d: number
  tokensIn5h: number
  tokensOut5h: number
  tokensCacheRead5h: number
  tokensCacheCreate5h: number

  // Rate limit metadata
  has7dLimit: boolean      // false for plans without a 7d window or non-Claude.ai providers
  providerType: ClaudeProvider

  // Metadata
  lastUpdated: Date
  cacheAge: number
  dataSource: 'api' | 'cache' | 'stale' | 'no-credentials' | 'no-data' | 'local-only'

  // ===== CK-fork: model name + context window approximation — 2026-05-16 =====
  // model: e.g. 'claude-sonnet-4-6' from most recent JSONL assistant entry
  // ctxApproxUtil: approximate context window utilisation (0–1).
  //   Method: latestMsgInputTokens / MODEL_CONTEXT_WINDOW[model]
  //   Why approximate: input_tokens of the last message ≈ full accumulated conversation context.
  //   Limitation: lags by one JSONL poll cycle; does NOT reflect tokens added mid-turn.
  model: string
  ctxApproxUtil: number
  // ===== END CK-fork =====
}

export { ProjectCostData };

// ===== CK-fork: model context window sizes — 2026-05-16 =====
// Source: Anthropic docs (https://docs.anthropic.com/en/docs/about-claude/models)
// Last verified: 2026-05-16. Update when Anthropic changes context window sizes.
// All Claude 3.x and Claude 4.x models currently have 200k token context windows.
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'claude-opus-4-7':    200_000,
  'claude-opus-4-5':    200_000,
  'claude-sonnet-4-6':  200_000,
  'claude-sonnet-4-5':  200_000,
  'claude-haiku-4-5':   200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022':  200_000,
  'claude-3-opus-20240229':     200_000,
};
const DEFAULT_CONTEXT_TOKENS = 200_000; // safe fallback for unknown models

function computeCtxUtil(model: string, inputTokens: number): number {
  const windowSize = MODEL_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
  return Math.min(1, inputTokens / windowSize);
}
// ===== END CK-fork =====

export class DataManager {
  private static instance: DataManager;
  private readonly _onDidUpdate = new vscode.EventEmitter<ClaudeUsageData>();
  readonly onDidUpdate: vscode.Event<ClaudeUsageData> = this._onDidUpdate.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private lastData: ClaudeUsageData | undefined;
  private lastProjectCosts: ProjectCostData[] = [];
  private lastPrediction: PredictionData | null = null;
  private lastHeatmapData: HeatmapData | null = null;
  private heatmapComputedAt = 0;
  private readonly heatmapTtlMs = 5 * 60 * 1000; // 5-minute in-memory TTL
  private heatmapPending = false;

  private constructor() {}

  static getInstance(): DataManager {
    if (!DataManager.instance) {
      DataManager.instance = new DataManager();
    }
    return DataManager.instance;
  }

  async getUsageData(forceRefresh = false): Promise<ClaudeUsageData> {
    const stop = logger.startTimer(`getUsageData(forceRefresh=${forceRefresh})`);
    const [localUsage, cache] = await Promise.all([readAllUsage(config.tokenPricing), readCache()]);
    logger.debug(`Local JSONL read: cost5h=$${localUsage.cost5h.toFixed(4)} cost7d=$${localUsage.cost7d.toFixed(4)} ` +
      `model=${localUsage.latestModel} | cache=${cache ? 'present' : 'none'}`);

    // Determine provider type (user config or auto-detection)
    const configuredProvider = config.claudeProvider;
    const providerType: ClaudeProvider = configuredProvider === 'auto'
      ? await detectProvider(config.credentialsPath)
      : configuredProvider;
    logger.debug(`Provider: ${providerType} (config=${configuredProvider}) | rateLimitApiEnabled=${config.rateLimitApiEnabled}`);

    let rateLimitData: RateLimitData | null = null;
    let dataSource: ClaudeUsageData['dataSource'] = 'no-data';

    if (providerType === 'claude-ai' && config.rateLimitApiEnabled) {
      // Fetch rate limits from Anthropic API
      if (forceRefresh || (await this.shouldCallApi(cache))) {
        try {
          logger.info('Calling Anthropic API for rate-limit headers');
          rateLimitData = await fetchRateLimitData(config.credentialsPath);
          await writeCache(rateLimitData);
          dataSource = 'api';
          logger.info(`API ok: 5h=${(rateLimitData.utilization5h * 100).toFixed(1)}% ` +
            `7d=${(rateLimitData.utilization7d * 100).toFixed(1)}% status=${rateLimitData.limitStatus} ` +
            `has7d=${rateLimitData.has7dLimit}`);
        } catch (e) {
          // credentials missing or network error — fall back to cache
          if (cache) {
            rateLimitData = this.cacheToRateLimitData(cache.usageData);
            dataSource = isCacheValid(cache, config.cacheTtlSeconds) ? 'cache' : 'stale';
            logger.warn(`API call failed — falling back to ${dataSource} cache`, e);
          } else {
            dataSource = 'no-credentials';
            logger.warn('API call failed and no cache available (no-credentials)', e);
          }
        }
      } else if (cache) {
        rateLimitData = this.cacheToRateLimitData(cache.usageData);
        dataSource = isCacheValid(cache, config.cacheTtlSeconds) ? 'cache' : 'stale';
      }
    } else if (providerType === 'claude-ai' && cache) {
      // API disabled by user but cache exists — show stale rate limit data with age indicator
      rateLimitData = this.cacheToRateLimitData(cache.usageData);
      dataSource = 'stale';
    } else {
      // Non-claude-ai provider, or no cache — cost only from local JSONL
      const hasCostData = localUsage.cost7d > 0 || localUsage.cost5h > 0;
      dataSource = hasCostData ? 'local-only' : 'no-credentials';
    }

    const cacheAge = cache ? getCacheAge(cache) : 0;

    // ===== CK-fork: compute ctx approximation from JSONL data — 2026-05-16 =====
    const ctxApproxUtil = computeCtxUtil(localUsage.latestModel, localUsage.latestMsgInputTokens);
    // ===== END CK-fork =====

    const data: ClaudeUsageData = {
      utilization5h: rateLimitData?.utilization5h ?? 0,
      utilization7d: rateLimitData?.utilization7d ?? 0,
      resetIn5h: rateLimitData?.resetIn5h ?? 0,
      resetIn7d: rateLimitData?.resetIn7d ?? 0,
      limitStatus: rateLimitData?.limitStatus ?? 'allowed',
      has7dLimit: rateLimitData?.has7dLimit ?? false,
      providerType,
      ...localUsage,
      lastUpdated: new Date(),
      cacheAge,
      dataSource,
      // ===== CK-fork: model + ctx fields — 2026-05-16 =====
      model: localUsage.latestModel,
      ctxApproxUtil,
      // ===== END CK-fork =====
    };

    this.lastData = data;
    logger.debug(`getUsageData result: dataSource=${dataSource} cacheAge=${cacheAge}s ctxApprox=${(ctxApproxUtil * 100).toFixed(0)}%`);
    stop();
    return data;
  }

  private cacheToRateLimitData(usageData: {
    utilization5h: number
    utilization7d: number
    reset5hAt: number
    reset7dAt: number
    limitStatus: string
  }): RateLimitData {
    const nowSec = Date.now() / 1000;
    return {
      utilization5h: usageData.utilization5h,
      utilization7d: usageData.utilization7d,
      resetIn5h: Math.max(0, usageData.reset5hAt - nowSec),
      resetIn7d: Math.max(0, usageData.reset7dAt - nowSec),
      limitStatus: usageData.limitStatus as RateLimitData['limitStatus'],
      // Derive from cached reset timestamp: non-zero means a 7d limit exists
      has7dLimit: usageData.reset7dAt > 0,
    };
  }

  private async shouldCallApi(cache: Awaited<ReturnType<typeof readCache>>): Promise<boolean> {
    if (!cache) { return true; }
    if (!isCacheValid(cache, config.cacheTtlSeconds)) {
      return await wasJsonlUpdatedRecently(300);
    }
    return false;
  }

  async refreshProjectCosts(): Promise<void> {
    try {
      this.lastProjectCosts = await getAllProjectCosts(config.tokenPricing);
      logger.debug(`Project costs refreshed: ${this.lastProjectCosts.length} project(s)`);
    } catch (e) {
      this.lastProjectCosts = [];
      logger.warn('refreshProjectCosts failed (cleared to empty)', e);
    }
  }

  getLastProjectCosts(): ProjectCostData[] {
    return this.lastProjectCosts;
  }

  async refresh(): Promise<void> {
    try {
      const [data] = await Promise.all([
        this.getUsageData(false),
        this.refreshProjectCosts(),
      ]);
      await this.getPrediction().catch(() => {});
      this._onDidUpdate.fire(data);

      // Heatmap is slow — compute in background, then fire a second update
      this.refreshHeatmapBackground();
    } catch (e) {
      logger.warn('refresh() failed', e);
    }
  }

  async forceRefresh(): Promise<void> {
    try {
      const [data] = await Promise.all([
        this.getUsageData(true),
        this.refreshProjectCosts(),
      ]);
      await this.getPrediction().catch(() => {});
      // Invalidate heatmap cache to force recompute on next access
      this.heatmapComputedAt = 0;
      this._onDidUpdate.fire(data);

      this.refreshHeatmapBackground();
    } catch (e) {
      logger.warn('forceRefresh() failed', e);
    }
  }

  private refreshHeatmapBackground(): void {
    if (this.heatmapPending) { return; }
    this.heatmapPending = true;
    this.getHeatmapData().then(() => {
      this.heatmapPending = false;
      const freshData = this.lastData;
      if (freshData) { this._onDidUpdate.fire(freshData); }
    }).catch(e => { this.heatmapPending = false; logger.warn('heatmap background compute failed', e); });
  }

  startWatching(): void {
    const watchDir = path.join(os.homedir(), '.claude', 'projects');
    const pattern = new vscode.RelativePattern(vscode.Uri.file(watchDir), '**/*.jsonl');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => { logger.debug('JSONL changed — refresh'); this.refresh(); });
    this.watcher.onDidCreate(() => { logger.debug('JSONL created — refresh'); this.refresh(); });
    logger.info(`Watching for JSONL changes under ${watchDir}`);
  }

  async getPrediction(): Promise<PredictionData | null> {
    if (!this.lastData) { return null; }
    try {
      const prediction = await computePrediction(
        this.lastData.utilization5h,
        this.lastData.resetIn5h,
        this.lastData.cost5h,
        this.lastData.costDay,
        config.dailyBudget,
      );
      this.lastPrediction = prediction;
      return prediction;
    } catch (e) {
      logger.warn('getPrediction failed (returning previous prediction)', e);
      return this.lastPrediction;
    }
  }

  getLastPrediction(): PredictionData | null {
    return this.lastPrediction;
  }

  async getHeatmapData(): Promise<HeatmapData | null> {
    const now = Date.now();
    if (this.lastHeatmapData && now - this.heatmapComputedAt < this.heatmapTtlMs) {
      return this.lastHeatmapData;
    }
    try {
      const stop = logger.startTimer('computeHeatmapData');
      const data = await computeHeatmapData(config.heatmapDays);
      stop();
      this.lastHeatmapData = data;
      this.heatmapComputedAt = now;
      return data;
    } catch (e) {
      logger.warn('getHeatmapData failed (returning stale heatmap)', e);
      return this.lastHeatmapData; // return stale on error
    }
  }

  getLastHeatmapData(): HeatmapData | null {
    return this.lastHeatmapData;
  }

  getLastData(): ClaudeUsageData | undefined {
    return this.lastData;
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidUpdate.dispose();
  }
}
