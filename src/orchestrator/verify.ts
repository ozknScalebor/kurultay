import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KurultayConfig, VerifyConfig } from '../config.js';
import { runShell } from '../agent/tools.js';
import type { Materializer, Overlay } from '../agent/workspace.js';
import { truncateMiddle } from '../util/text.js';

export interface VerifyStep {
  name: 'build' | 'test' | 'lint';
  command: string;
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
  ms: number;
}

export interface VerifyResult {
  /** no commands configured */
  skipped: boolean;
  ok: boolean;
  /** 0..1 */
  score: number;
  steps: VerifyStep[];
}

const WEIGHTS = { build: 0.5, test: 0.4, lint: 0.1 } as const;

/** Run build → test → lint against an overlay (applied in place, serialised). */
export async function verifyOverlay(overlay: Overlay, materializer: Materializer, cfg: KurultayConfig, signal?: AbortSignal): Promise<VerifyResult> {
  const cmds = (['build', 'test', 'lint'] as const).map((name) => ({ name, command: (cfg.verify[name] ?? '').trim() })).filter((c) => c.command);
  if (!cmds.length) return { skipped: true, ok: true, score: 0, steps: [] };
  return materializer.execute(
    overlay,
    async (cwd) => {
      const steps: VerifyStep[] = [];
      for (const c of cmds) {
        const t0 = Date.now();
        const r = await runShell(c.command, cwd, cfg.verify.timeoutMs ?? 15 * 60_000, signal);
        steps.push({ name: c.name, command: c.command, ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, output: truncateMiddle(materializer.rewriteOutput(r.output), 8000), ms: Date.now() - t0 });
        if (c.name === 'build' && !(r.code === 0 && !r.timedOut)) break; // no point testing a broken build
      }
      const total = cmds.reduce((s, c) => s + WEIGHTS[c.name], 0);
      const got = steps.filter((s) => s.ok).reduce((s, st) => s + WEIGHTS[st.name], 0);
      return { skipped: false, ok: steps.length === cmds.length && steps.every((s) => s.ok), score: total ? got / total : 0, steps };
    },
    signal,
  );
}

export function renderVerify(v: VerifyResult): string {
  if (v.skipped) return 'No verification commands configured.';
  return v.steps.map((s) => `- ${s.name}: ${s.ok ? '✅' : '❌'} \`${s.command}\` (${(s.ms / 1000).toFixed(1)} s${s.timedOut ? ', timed out' : ''})`).join('\n');
}

export function verifyFailureText(v: VerifyResult): string {
  return v.steps
    .filter((s) => !s.ok)
    .map((s) => `$ ${s.command} (exit ${s.code})\n${truncateMiddle(s.output, 4000)}`)
    .join('\n\n');
}

/** Guess verification commands for common build systems (used by `kurultay init`). */
export function detectVerifyCommands(root: string): VerifyConfig {
  const has = (f: string) => existsSync(join(root, f));
  const v: VerifyConfig = { build: '', test: '', lint: '' };
  if (has('CMakeLists.txt')) {
    v.build = 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build --config Debug -j';
    v.test = 'ctest --test-dir build -C Debug --output-on-failure';
  } else if (has('meson.build')) {
    v.build = 'meson setup build --reconfigure >/dev/null 2>&1 || meson setup build; meson compile -C build';
    v.test = 'meson test -C build';
  } else if (has('pom.xml')) {
    v.build = 'mvn -o -q compile';
    v.test = 'mvn -o -q test';
  } else if (has('gradlew')) {
    v.build = './gradlew --offline -q compileJava';
    v.test = './gradlew --offline -q test';
  } else if (has('build.gradle') || has('build.gradle.kts')) {
    v.build = 'gradle --offline -q compileJava';
    v.test = 'gradle --offline -q test';
  } else if (has('Cargo.toml')) {
    v.build = 'cargo build --offline';
    v.test = 'cargo test --offline';
  } else if (has('go.mod')) {
    v.build = 'go build ./...';
    v.test = 'go test ./...';
  } else if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) v.build = 'npm run build';
      if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) v.test = 'npm test';
      if (pkg.scripts?.lint) v.lint = 'npm run lint';
    } catch {
      /* ignore */
    }
  } else if (has('pyproject.toml') || has('setup.py') || has('pytest.ini')) {
    v.test = 'python -m pytest -q';
  } else if (has('Makefile') || has('makefile')) {
    v.build = 'make -j';
    try {
      if (/^test\s*:/m.test(readFileSync(join(root, has('Makefile') ? 'Makefile' : 'makefile'), 'utf8'))) v.test = 'make test';
    } catch {
      /* ignore */
    }
  }
  return v;
}
