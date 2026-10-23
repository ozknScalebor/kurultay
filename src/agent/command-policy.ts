import { execFileSync } from 'node:child_process';
import type { ToolsConfig } from '../config.js';

/**
 * Safety net for commands written by models (run_command). Three layers, all
 * offline and dependency-free:
 *
 *  1. Policy: "deny" (default) refuses known-dangerous patterns; "allow" only
 *     accepts commands whose every segment (split on && || ; |) matches an
 *     allow-list entry – Codex / Claude Code style allow-lists for locked-down
 *     machines. Command substitution is refused in allow mode.
 *  2. Environment scrubbing: API keys, tokens and passwords of the user's shell
 *     are not passed to model commands (they can be printed back into prompts).
 *  3. OS sandbox (Linux bubblewrap): read-only system, writable sandbox copy and
 *     /tmp only, no network. "auto" uses it when bwrap is installed.
 */

export const DEFAULT_ALLOW = [
  // build systems / compilers
  '^(make|gmake|ninja|cmake|ctest|meson|scons|bazel|mvn|mvnw|\\./mvnw|gradle|gradlew|\\./gradlew|ant|sbt|cargo|go|dotnet|msbuild)\\b',
  '^(gcc|g\\+\\+|cc|c\\+\\+|clang|clang\\+\\+|javac|java|jar|javap|kotlinc|rustc|tsc|python3?|node|npx|npm|pnpm|yarn|pytest|ruff|eslint|prettier|clang-format|clang-tidy|cppcheck|valgrind|gdb)\\b',
  // read-only inspection
  '^(ls|cat|head|tail|wc|grep|rg|find|sed\\s+-n|awk|sort|uniq|diff|cmp|file|stat|du|tree|pwd|echo|printf|true|false|test|which|env|date|basename|dirname|realpath|xxd|od|nm|objdump|readelf|strings)\\b',
  '^git\\s+(status|diff|log|show|blame|ls-files|rev-parse|grep)\\b',
  // file housekeeping inside the sandbox
  '^(mkdir|touch|cp|mv|rm\\s+(-[rf]+\\s+)?(build|out|target|bin|obj|tmp|\\./)|chmod\\s+\\+x)\\b',
  '^(\\./|bin/|build/|out/|target/|scripts/)[\\w./-]+',
  '^cd\\s+[\\w./-]+$',
];

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}

/** Split a shell line into simple command segments (outside quotes). */
export function commandSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length) {
        cur += ch;
        i++;
        cur += cmd[i];
        continue;
      }
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === '\\') {
      cur += ch + (cmd[++i] ?? '');
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if (ch === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>' || /\d/.test(cmd[i + 1] ?? ''))) {
        cur += ch; // 2>&1, &>file
        continue;
      }
      if ((ch === '|' || ch === '&') && cmd[i + 1] === ch) i++; // && ||
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  // strip leading env assignments (FOO=1 make) and redirections; drop empties
  return out.map((s) => s.trim().replace(/^(\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '').trim()).filter(Boolean);
}

export function checkCommand(cmd: string, tools: Pick<ToolsConfig, 'denyPatterns' | 'commandPolicy' | 'allowPatterns'>): PolicyResult {
  for (const pat of tools.denyPatterns) {
    if (new RegExp(pat, 'i').test(cmd)) return { ok: false, reason: `safety rule (${pat})` };
  }
  if ((tools.commandPolicy ?? 'deny') !== 'allow') return { ok: true };
  if (/\$\(|`|<\(|>\(/.test(cmd)) return { ok: false, reason: 'command substitution ($(…), `…`) is not allowed in allow-list mode' };
  if (/(^|[^<>&\d])>{1,2}\s*\/(?!dev\/null|tmp\/)/.test(cmd)) return { ok: false, reason: 'redirecting outside the project is not allowed in allow-list mode' };
  const allow = [...DEFAULT_ALLOW, ...(tools.allowPatterns ?? [])].map((p) => new RegExp(p));
  for (const seg of commandSegments(cmd)) {
    const bare = seg.replace(/^(sudo|exec|time|nice|timeout\s+\S+)\s+/, (m) => (m.startsWith('sudo') ? m : ''));
    if (!allow.some((re) => re.test(bare))) return { ok: false, reason: `not in the allow list: "${bare.slice(0, 80)}" (add it with tools.allowPatterns)` };
  }
  return { ok: true };
}

const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION)/i;
const SAFE = new Set(['SSH_AUTH_SOCK_DISABLED', 'XAUTHORITY']);

/** Copy of the environment without secrets (names listed in keep are preserved). */
export function scrubEnv(env: NodeJS.ProcessEnv, keep: string[] = []): { env: NodeJS.ProcessEnv; removed: string[] } {
  const out: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (SECRET.test(k) && !SAFE.has(k) && !keep.includes(k)) removed.push(k);
    else out[k] = v;
  }
  return { env: out, removed };
}

let bwrapOk: boolean | undefined;
export function bwrapAvailable(): boolean {
  if (bwrapOk === undefined) {
    if (process.platform !== 'linux') bwrapOk = false;
    else {
      try {
        // a real smoke test: user namespaces may be disabled even when the binary exists
        execFileSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', 'true'], { stdio: 'ignore', timeout: 5000 });
        bwrapOk = true;
      } catch {
        bwrapOk = false;
      }
    }
  }
  return bwrapOk;
}

/** bubblewrap argv that runs `bash -lc cmd` with only `cwd` (+extra) writable and no network. */
export function bwrapArgs(cmd: string, cwd: string, opts: { network?: boolean; writable?: string[] } = {}): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', cwd, cwd];
  for (const w of opts.writable ?? []) args.push('--bind-try', w, w);
  if (!opts.network) args.push('--unshare-net');
  args.push('--unshare-pid', '--die-with-parent', '--new-session', '--chdir', cwd, 'bash', '-lc', cmd);
  return args;
}

/** How a model command must be launched under the configured OS sandbox. */
export function osSandboxFor(tools: Pick<ToolsConfig, 'osSandbox'>): { use: boolean; error?: string } {
  const mode = tools.osSandbox ?? 'off';
  if (mode === 'off') return { use: false };
  if (bwrapAvailable()) return { use: true };
  return mode === 'bwrap' ? { use: false, error: 'tools.osSandbox="bwrap" but bubblewrap cannot run (not installed or user namespaces disabled)' } : { use: false };
}

/** Test hook. */
export function _setBwrapAvailable(v: boolean | undefined): void {
  bwrapOk = v;
}
