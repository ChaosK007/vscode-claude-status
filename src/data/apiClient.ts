import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Actual structure of ~/.claude/.credentials.json (verified against Claude Code v2.1.x)
// macOS stores these in Keychain under service "Claude Code-credentials" with the same JSON format.
interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string
    expiresAt: number
  }
}

export type ClaudeProvider = 'claude-ai' | 'aws-bedrock' | 'api-key' | 'unknown';

export interface RateLimitData {
  utilization5h: number
  utilization7d: number
  resetIn5h: number
  resetIn7d: number
  limitStatus: 'allowed' | 'allowed_warning' | 'denied'
  has7dLimit: boolean
}

export async function detectProvider(customCredPath?: string | null): Promise<ClaudeProvider> {
  // 1. Check for OAuth credentials (Claude.ai subscription)
  try {
    await readCredentials(customCredPath);
    return 'claude-ai';
  } catch {
    // No valid OAuth token — check other providers
  }

  // 2. Check for AWS Bedrock-specific env vars
  if (
    process.env['ANTHROPIC_BEDROCK_BASE_URL'] ??
    process.env['AWS_BEDROCK_RUNTIME_URL'] ??
    process.env['CLAUDE_AWS_REGION']
  ) {
    return 'aws-bedrock';
  }

  // 3. Check for direct Anthropic API key
  if (process.env['ANTHROPIC_API_KEY']) {
    return 'api-key';
  }

  return 'unknown';
}

// On macOS, Claude Code stores credentials in Keychain under this service name
// instead of (or in addition to) ~/.claude/.credentials.json.
const MACOS_KEYCHAIN_SERVICE = 'Claude Code-credentials';

async function readCredentialsFromKeychain(): Promise<string> {
  const { stdout } = await execAsync(
    `/usr/bin/security find-generic-password -s "${MACOS_KEYCHAIN_SERVICE}" -w`
  );
  const creds = JSON.parse(stdout.trim()) as ClaudeCredentials;
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error('No OAuth access token in macOS Keychain');
  }
  return token;
}

async function readCredentials(customPath?: string | null): Promise<string> {
  const credPath = customPath ?? path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const content = await fs.readFile(credPath, 'utf-8');
    const creds = JSON.parse(content) as ClaudeCredentials;
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) {
      throw new Error('No OAuth access token found in credentials file');
    }
    return token;
  } catch {
    // On macOS with no credentials file, fall back to Keychain (Claude Code v2.x+)
    if (process.platform === 'darwin' && (customPath === null || customPath === undefined)) {
      return readCredentialsFromKeychain();
    }
    throw new Error('No Claude.ai credentials found');
  }
}

// ===== CK-fork: local statusline-JSON rate-limit source — 2026-07-03 (#118 finding #10) =====
// Replaces the removed fetchRateLimitData(). Anthropic banned consumer-OAuth tokens in
// non-Claude-Code clients (began Jan 2026, formal notice ~2026-02-19, server-enforced), so
// the old POST https://api.anthropic.com/v1/messages call — made purely to read
// anthropic-ratelimit-unified-* response headers — is now both a ToS/account-ban risk and
// technically rejected. Claude Code's statusline already writes the same numbers locally to
// /tmp/claude-status.json on every render: free, local, sanctioned, zero token spend.
//
// Trust model: /tmp/claude-status.json is predictable and world-readable/writable. Treat it
// as trusted local IPC (same trust level as the local Claude Code process that writes it). A
// local actor could spoof the displayed rate numbers — cosmetic only (no code exec, no data
// leak). The statusJson.path setting is scope:machine so a workspace .vscode/settings.json
// cannot redirect this fs.readFile target. See planning/10_replace_banned_oauth_ratelimit.md.
//
// detectProvider / readCredentials / readCredentialsFromKeychain are KEPT: they are local
// file/keychain reads (not the banned network call) and still classify provider='claude-ai'.
interface StatusJson {
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number }
    seven_day?: { used_percentage?: number; resets_at?: number }
  }
}

export async function readRateLimitData(
  statusJsonPath: string,
): Promise<{ data: RateLimitData; mtimeMs: number }> {
  const stat = await fs.stat(statusJsonPath);
  const content = await fs.readFile(statusJsonPath, 'utf-8');
  const parsed = JSON.parse(content) as StatusJson;

  const fiveHour = parsed.rate_limits?.five_hour;
  if (fiveHour?.used_percentage === undefined) {
    // No usable rate-limit data — let the caller degrade gracefully to cost-only.
    throw new Error('No rate_limits.five_hour.used_percentage in statusline JSON');
  }
  const sevenDay = parsed.rate_limits?.seven_day;

  // used_percentage is a whole number (e.g. 21 → 0.21). 7d bar now shows whenever the
  // seven_day field exists (documented behaviour change from the old header-presence check).
  const utilization5h = fiveHour.used_percentage / 100;
  const utilization7d = (sevenDay?.used_percentage ?? 0) / 100;
  const has7dLimit = sevenDay !== undefined;

  // resets_at values are Unix timestamps in seconds (absolute).
  const nowSec = Date.now() / 1000;
  const resetIn5h = fiveHour.resets_at ? Math.max(0, fiveHour.resets_at - nowSec) : 0;
  const resetIn7d = sevenDay?.resets_at ? Math.max(0, sevenDay.resets_at - nowSec) : 0;

  // Mirrors the old header-derived logic (>=1 denied, >=0.75 warning).
  let limitStatus: 'allowed' | 'allowed_warning' | 'denied';
  if (utilization5h >= 1) {
    limitStatus = 'denied';
  } else if (utilization5h >= 0.75 || (has7dLimit && utilization7d >= 0.75)) {
    limitStatus = 'allowed_warning';
  } else {
    limitStatus = 'allowed';
  }

  return {
    data: { utilization5h, utilization7d, resetIn5h, resetIn7d, limitStatus, has7dLimit },
    mtimeMs: stat.mtimeMs,
  };
}
// ===== END CK-fork =====
