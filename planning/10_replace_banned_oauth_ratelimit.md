---
finding: "#10 (from CK-REPO CK_TODO_context/118_vscode_extension_security_remediation.md)"
severity: HIGH (compliance/functional)
created: 2026-07-03
status: PLAN LOCKED — folds from 2026-07-02 workflow adversarial review applied; CK decisions confirmed
ties: CK_TODO #75 (live 5h countdown), #118 finding #10, finding #11 (kept SEPARATE)
---

# #10 — Replace the banned consumer-OAuth rate-limit call with a local statusline-JSON read

## Problem
`src/data/apiClient.ts` `fetchRateLimitData()` reads the Claude.ai **consumer OAuth**
token from `~/.claude/.credentials.json` and POSTs a real `haiku` call to
`https://api.anthropic.com/v1/messages` purely to read `anthropic-ratelimit-unified-*`
response headers. Anthropic **banned consumer-OAuth tokens in non-Claude-Code clients**
(began Jan 2026, formal notice ~2026-02-19, server-enforced — sources: The Register
2026-02-20 "Anthropic clarifies ban on third-party Claude access"; `anthropics/claude-code`
issue #28091; OpenCode removed the feature on legal request). So the call is now both a
ToS/account-ban risk and technically rejected. This is the fork's headline 5h/7d bars
(ties #75).

## Decision (CK-confirmed 2026-07-03)
- **Data source: (a) local statusline JSON** — read `/tmp/claude-status.json`
  (`.rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`), which Claude Code's
  statusline writes locally each render. Free, local, sanctioned, zero token. Rejected (b)
  OpenTelemetry (needs a collector — KISS) and (c) drop-the-feature (loses the bars).
- **Freshness: DROP the `shouldCallApi` throttle** for the rate-limit path. The read is now
  a free local file op, so read it on **every poll**; derive `dataSource`/staleness from the
  file **mtime**, not from a cache-age throttle. (Unanimous lens fold: never write stale data
  to the cache; the throttle no longer earns its keep once there is no API call.)
- **Scope: keep finding #11 SEPARATE** (scope:machine on `credentials.path` + `logging.filePath`
  is its own one-file diff). This diff only touches `rateLimitApi.enabled` (already edited) and
  the new `statusJson.path` key.

## RateLimitData mapping (statusline JSON → existing contract)
The `RateLimitData` interface (`apiClient.ts:20-27`) is UNCHANGED, so `statusBar.ts`,
`cache.ts`, and the webview stay valid.

| RateLimitData field | Source |
|---|---|
| `utilization5h` | `rate_limits.five_hour.used_percentage / 100` |
| `utilization7d` | `rate_limits.seven_day.used_percentage / 100` (0 if absent) |
| `resetIn5h` | `max(0, rate_limits.five_hour.resets_at - nowSec)` |
| `resetIn7d` | `max(0, rate_limits.seven_day.resets_at - nowSec)` |
| `has7dLimit` | `rate_limits.seven_day` present (documented behaviour change: 7d bar now shows whenever the field exists) |
| `limitStatus` | `util5h>=1 → 'denied'`; `util5h>=0.75 || (has7d && util7d>=0.75) → 'allowed_warning'`; else `'allowed'` (mirrors the old header-derived logic) |

Throw if `rate_limits.five_hour.used_percentage` is absent → existing catch falls back to
cost-only (graceful degradation, per repo CLAUDE.md).

## Files touched
- `src/data/apiClient.ts` — DELETE `fetchRateLimitData()` (the banned fetch). ADD CK-fork-fenced
  `readRateLimitData(statusJsonPath): Promise<{data: RateLimitData; mtimeMs: number}>` (fs.stat +
  readFile + JSON.parse + the mapping above). KEEP `detectProvider` / `readCredentials` /
  `readCredentialsFromKeychain` / `ClaudeCredentials` — they are **local file reads, not the
  banned network call**, and still classify `provider='claude-ai'`.
- `src/data/dataManager.ts` — import swap; replace the `shouldCallApi`-gated fetch block
  (`:115-140`) with an unconditional `readRateLimitData(config.statusJsonPath)`; set
  `dataSource` from file mtime vs `cacheTtlSeconds` ('api' if fresh, 'stale' if old); still
  `writeCache` (survives reboot; `/tmp` does not) but only the freshly-read value. Log line
  reworded API→statusline. Add a comment: `dataSource='api'` now denotes a fresh local read,
  not a network call.
- `src/config.ts` — add `get statusJsonPath(): string` default `/tmp/claude-status.json`.
- `package.json` — add `claudeStatus.statusJson.path` (`scope: machine` — a SECURITY control:
  prevents a workspace `.vscode/settings.json` from redirecting the fs.readFile target) + add
  `"scope": "machine"` to the already-edited `rateLimitApi.enabled`; reword descriptions.
- `package.nls.json` — description strings (ja/zh nls = flagged i18n follow-up).
- `CHANGELOG.md` — `[Unreleased]` note incl. the has7dLimit behaviour change.

## Folds applied (2026-07-02 adversarial review)
- Drop throttle → read every poll (CK-confirmed); mtime drives staleness; **never writeCache stale**.
- `scope:machine` on `statusJson.path` is a non-optional security control (documented as such,
  not "portability").
- Keep `~/.claude` disk cache (survives reboot; `/tmp` cleared on reboot) — do NOT delete cache.ts.
- `#11` kept out of this diff (one security finding per committed diff).
- Comment the `dataSource='api'` enum reuse so it is documented, not a silent lie.
- Known limitation recorded: bars still require `~/.claude/.credentials.json` to exist for
  `detectProvider`→'claude-ai'; more-correct long-term signal is "statusline JSON has rate_limits".

## Security note
`/tmp/claude-status.json` is predictable and world-readable/writable. Treat it as **trusted
local IPC** (same trust level as the local Claude Code process that writes it). A local actor
could spoof the displayed rate numbers — **cosmetic only** (no code exec, no data leak). Stated
explicitly so the trust assumption is a decision, not an oversight.

## Verify
- `npm run compile` clean + `npm run lint`.
- Manual (NEPTUNE / installed VSIX, not F5 per `reference_neptune_vscode_ext_testing`): status bar
  shows 5h/7d % matching `/tmp/claude-status.json`; kill the file → graceful cost-only fallback +
  `[Xm ago]` staleness when the file is old.
- No network call fires (the point): confirm no `api.anthropic.com` request in the extension host.

## Out of scope / follow-ups
- Option B (delete cache scaffolding, treat JSON file AS cache) — deferred simplification.
- Switch the claude-ai signal from creds-read to "rate_limits present" — future correctness.
- ja/zh-cn nls strings — i18n follow-up (English functional).
