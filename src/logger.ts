import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ===== CK addition: file + OutputChannel logger — 2026-05-31 =====
// Upstream vscode-claude-status had NO diagnostic logging (every failure was swallowed
// by a bare `catch {}`). This logger surfaces those, mirroring to the "Claude Status"
// Output panel AND to a findable file under ~/.claude/logs/.
//
// Performance contract (CK: "log it, but do not bring VS Code to a crawl"):
//   - emit() does only O(1) in-memory work (push to a buffer + appendLine to the channel).
//   - File I/O is BATCHED: the buffer is flushed asynchronously on a timer, never per-line
//     and never synchronously on a hot path. (Contrast: ck-vscode-toolkit uses appendFileSync.)
//   - Verbose is ON by default; turn it down via claudeStatus.logging.* if ever needed.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private channel: vscode.OutputChannel | undefined;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private fileReady = false;
  private resolvedPath = '';

  private readonly defaultPath = path.join(os.homedir(), '.claude', 'logs', 'vscode-claude-status.log');
  private readonly maxBytes = 5 * 1024 * 1024; // rotate at 5 MB (keeps one .1 backup)
  private readonly flushMs = 1500;             // batch window — keeps writes off hot paths

  /** Wire up the channel, log file, and flush timer. Call once from activate(). */
  init(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('Claude Status');
    context.subscriptions.push(this.channel);

    if (this.fileEnabled) {
      this.resolvedPath = this.resolveFilePath();
      try {
        fs.mkdirSync(path.dirname(this.resolvedPath), { recursive: true });
        this.fileReady = true;
      } catch (e) {
        this.channel.appendLine(`[WARN ] could not create log directory for ${this.resolvedPath}: ${String(e)}`);
      }
    }

    this.flushTimer = setInterval(() => this.flush(), this.flushMs);
    context.subscriptions.push({ dispose: () => this.dispose() });

    this.info('==================================================================');
    this.info(`Claude Status logger started | level=${this.level} verbose=${this.verbose} ` +
      `file=${this.fileReady ? this.resolvedPath : '(disabled)'}`);
  }

  /** Reveal the Output panel channel (backs the "Show Log" command). */
  show(): void {
    this.channel?.show(true);
  }

  /** Absolute path of the active log file (for the "Open Log File" command). */
  get filePath(): string {
    return this.resolvedPath || this.resolveFilePath();
  }

  // --- config (read live so changes apply without reload) ---
  private get cfg() { return vscode.workspace.getConfiguration('claudeStatus.logging'); }
  private get enabled(): boolean { return this.cfg.get('enabled', true); }
  private get fileEnabled(): boolean { return this.cfg.get('toFile', true); }
  private get verbose(): boolean { return this.cfg.get('verbose', true); }
  private get level(): LogLevel {
    // verbose forces debug; otherwise honor the configured floor
    return this.verbose ? 'debug' : this.cfg.get<LogLevel>('level', 'info');
  }
  private resolveFilePath(): string {
    const custom = this.cfg.get<string>('filePath', '');
    return custom && custom.trim() !== '' ? custom.trim() : this.defaultPath;
  }

  private ts(): string {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  private emit(level: LogLevel, msg: string, err?: unknown): void {
    if (!this.enabled) { return; }
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) { return; }
    const detail = err instanceof Error ? `: ${err.message}`
      : err !== undefined ? `: ${String(err)}` : '';
    const line = `[${this.ts()}] [${level.toUpperCase().padEnd(5)}] ${msg}${detail}`;
    this.channel?.appendLine(line);
    if (this.fileReady) { this.buffer.push(line); }
    if (err instanceof Error && err.stack) {
      const stackLine = `[${this.ts()}] [${level.toUpperCase().padEnd(5)}] ${err.stack}`;
      this.channel?.appendLine(stackLine);
      if (this.fileReady) { this.buffer.push(stackLine); }
    }
  }

  debug(msg: string, err?: unknown): void { this.emit('debug', msg, err); }
  info(msg: string, err?: unknown): void { this.emit('info', msg, err); }
  warn(msg: string, err?: unknown): void { this.emit('warn', msg, err); }
  error(msg: string, err?: unknown): void { this.emit('error', msg, err); }

  /** Returns a stop() that logs elapsed ms at debug — for timing hot operations cheaply. */
  startTimer(label: string): () => void {
    const t0 = Date.now();
    return () => this.debug(`${label} took ${Date.now() - t0}ms`);
  }

  /** Batched async write. Runs on the flush timer and once on dispose. Never throws. */
  private flush(): void {
    if (!this.fileReady || this.buffer.length === 0) { return; }
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer = [];
    const target = this.resolvedPath;
    try {
      let size = 0;
      try { size = fs.statSync(target).size; } catch { /* not created yet */ }
      if (size + chunk.length > this.maxBytes) {
        try { fs.renameSync(target, target + '.1'); } catch { /* best effort */ }
      }
      fs.appendFile(target, chunk, () => { /* fire-and-forget; ignore write errors */ });
    } catch {
      // logging must never break the extension
    }
  }

  dispose(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = undefined; }
    this.flush(); // final drain
  }
}

export const logger = new Logger();
// ===== END CK addition =====
