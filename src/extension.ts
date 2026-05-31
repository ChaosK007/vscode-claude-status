import * as vscode from 'vscode';
import { DataManager, ClaudeUsageData, PredictionData } from './data/dataManager';
import { StatusBarManager } from './statusBar';
import { config } from './config';
import { logger } from './logger';

// --- Notification system ---
// Deduplication: keys are cleared when the 5h rate-limit window resets
const notifiedKeys = new Set<string>();
let prevResetIn5h = 0;

function checkWindowReset(resetIn5h: number): void {
  // If resetIn5h increased by more than 1 hour, the window has reset
  if (resetIn5h > prevResetIn5h + 3600) {
    notifiedKeys.clear();
  }
  prevResetIn5h = resetIn5h;
}

async function checkAndNotify(data: ClaudeUsageData, prediction: PredictionData | null): Promise<void> {
  checkWindowReset(data.resetIn5h);
  if (!prediction) { return; }
  // ===== CK-fork: master notifications gate (claudeStatus.notifications.enabled, default false) — 2026-05-16 =====
  // Upstream default fires popups for rate-limit warnings. CK prefers silent status-bar color coding.
  // Original: no gate here — always ran the notification checks below.
  if (!config.notificationsEnabled) { return; }
  // ===== END CK-fork =====

  const { estimatedExhaustionIn } = prediction;

  // Rate limit warnings
  if (config.rateLimitWarning && estimatedExhaustionIn !== null) {
    const minRemaining = Math.round(estimatedExhaustionIn / 60);
    if (estimatedExhaustionIn < 600 && !notifiedKeys.has('ratelimit-critical')) {
      notifiedKeys.add('ratelimit-critical'); // mark before await to prevent duplicates
      logger.info(`Notification: rate limit CRITICAL in ~${minRemaining} min (exhaustionIn=${Math.round(estimatedExhaustionIn)}s)`);
      const action = await vscode.window.showErrorMessage(
        vscode.l10n.t('Claude Code: Rate limit in ~{0} min', minRemaining),
        vscode.l10n.t('Open Dashboard'), vscode.l10n.t('Dismiss')
      );
      if (action === vscode.l10n.t('Open Dashboard')) {
        vscode.commands.executeCommand('vscode-claude-status.openDashboard');
      }
    } else if (
      estimatedExhaustionIn < config.rateLimitWarningThresholdMinutes * 60 &&
      !notifiedKeys.has('ratelimit-warning')
    ) {
      notifiedKeys.add('ratelimit-warning');
      logger.info(`Notification: rate limit warning in ~${minRemaining} min`);
      vscode.window.showWarningMessage(
        vscode.l10n.t('Claude Code: Rate limit in ~{0} min', minRemaining)
      );
    }
  }

  // Budget warning
  if (config.budgetWarning && prediction.budgetRemaining !== null && config.dailyBudget !== null) {
    const remainingPct = (prediction.budgetRemaining / config.dailyBudget) * 100;
    if (remainingPct <= (100 - config.budgetAlertThreshold) && !notifiedKeys.has('budget')) {
      notifiedKeys.add('budget');
      const used = (config.dailyBudget - prediction.budgetRemaining).toFixed(2);
      logger.info(`Notification: daily budget ${config.budgetAlertThreshold}% used ($${used} / $${config.dailyBudget})`);
      vscode.window.showWarningMessage(
        vscode.l10n.t('Claude Code: Daily budget {0}% used (${1} / ${2})', config.budgetAlertThreshold, used, config.dailyBudget)
      );
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  logger.init(context);
  logger.info('Extension activating');
  const dataManager = DataManager.getInstance();
  const statusBar = new StatusBarManager();

  // Helper: update status bar with latest usage + project costs
  function updateStatusBar(): void {
    const data = dataManager.getLastData();
    if (data) {
      statusBar.update(data, dataManager.getLastProjectCosts());
    }
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-claude-status.openDashboard', () => {
      logger.debug('Command: openDashboard');
      import(/* webpackChunkName: "panel" */ './webview/panel.js')
        .then(({ DashboardPanel }) => DashboardPanel.createOrShow(dataManager))
        .catch(e => logger.error('openDashboard failed to load panel', e));
    }),
    vscode.commands.registerCommand('vscode-claude-status.refresh', async () => {
      logger.debug('Command: refresh (force)');
      await dataManager.forceRefresh();
    }),
    vscode.commands.registerCommand('vscode-claude-status.toggleDisplayMode', async () => {
      const next = config.displayMode === 'percent' ? 'cost' : 'percent';
      logger.debug(`Command: toggleDisplayMode -> ${next}`);
      await config.setDisplayMode(next);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('vscode-claude-status.showLog', () => {
      logger.show();
    }),
    vscode.commands.registerCommand('vscode-claude-status.openLogFile', async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logger.filePath));
        await vscode.window.showTextDocument(doc);
      } catch (e) {
        vscode.window.showWarningMessage(
          vscode.l10n.t('No log file yet at {0}', logger.filePath)
        );
        logger.warn(`openLogFile: could not open ${logger.filePath}`, e);
      }
    }),
    vscode.commands.registerCommand('vscode-claude-status.setBudget', async () => {
      const current = config.dailyBudget;
      const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Set daily budget in USD (leave empty to disable)'),
        value: current !== null ? String(current) : '',
        placeHolder: vscode.l10n.t('e.g. 20'),
        validateInput: (v) => {
          if (v === '') { return null; }
          const n = parseFloat(v);
          if (isNaN(n) || n < 0) { return vscode.l10n.t('Enter a non-negative number, or leave empty to disable'); }
          return null;
        },
      });
      if (input === undefined) { return; } // cancelled
      const value = input === '' ? null : parseFloat(input);
      logger.debug(`Command: setBudget -> ${value === null ? 'disabled' : '$' + value}`);
      await config.setDailyBudget(value);
      vscode.window.showInformationMessage(
        value === null
          ? vscode.l10n.t('Daily budget disabled.')
          : vscode.l10n.t('Daily budget set to ${0}.', value.toFixed(2))
      );
    }),
  );

  // React to data updates (usage + project costs are refreshed together)
  context.subscriptions.push(
    dataManager.onDidUpdate(data => {
      statusBar.update(data, dataManager.getLastProjectCosts());
      // Check for rate limit / budget notifications
      const prediction = dataManager.getLastPrediction();
      checkAndNotify(data, prediction).catch(() => {});
    })
  );

  // Re-render on settings change without restart
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeStatus')) {
        logger.debug('Config changed (claudeStatus.*) — re-rendering status bar');
        updateStatusBar();
      }
    })
  );

  // Re-fetch project costs when workspace folders change
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      logger.debug('Workspace folders changed — refreshing project costs');
      dataManager.refreshProjectCosts().then(() => updateStatusBar())
        .catch(e => logger.warn('refreshProjectCosts (workspace change) failed', e));
    })
  );

  // Start JSONL file watcher
  dataManager.startWatching();

  // Initial load: usage data + project costs (no API call — cache first)
  Promise.all([
    dataManager.getUsageData(),
    dataManager.refreshProjectCosts(),
  ]).then(([data]) => {
    statusBar.update(data, dataManager.getLastProjectCosts());
    logger.info('Initial load complete');
  }).catch(e => {
    // graceful degradation: status bar stays in "loading..." state
    logger.warn('Initial load failed (status bar stays in loading state)', e);
  });

  // Timer: re-render every 60 seconds from cache
  const timer = setInterval(() => {
    dataManager.getUsageData()
      .then(data => statusBar.update(data, dataManager.getLastProjectCosts()))
      .catch(e => logger.warn('60s refresh tick failed', e));
  }, 60_000);

  logger.info('Extension activated');

  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    { dispose: () => statusBar.dispose() },
    { dispose: () => dataManager.dispose() },
  );
}

export function deactivate() {
  logger.info('Extension deactivating');
  // Fire-and-forget: webpack returns the cached module synchronously if already loaded
  import('./webview/panel.js').then(({ DashboardPanel }) => DashboardPanel.dispose()).catch(() => {});
}
