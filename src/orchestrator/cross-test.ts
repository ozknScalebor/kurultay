import type { KurultayConfig } from '../config.js';
import type { Materializer, Overlay } from '../agent/workspace.js';
import type { EventBus } from '../util/events.js';
import { verifyOverlay } from './verify.js';

/**
 * Test-based selection between candidates (Agentless, CodeMonkeys).
 *
 * Every candidate is asked to write a test for its change. A candidate's tests only
 * count when they FAIL on the original code (they reproduce the issue – Agentless keeps
 * only such tests), then every other candidate is run against them. The candidate that
 * passes the most of its rivals' reproducing tests is the most likely to be right.
 * Agentless: majority voting alone fixed 77 issues, + regression tests 81, + reproduction
 * tests 96 (SWE-bench Lite). CodeMonkeys: model-written tests vote on the candidates.
 */

/** Paths that look like test files in the common layouts (src/test, tests/, *_test.go, FooTest.java…). */
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|testing)\/|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+$|Tests?\.(java|kt|cs|scala)$/i;

export function testFilesOf(o: Overlay): string[] {
  return o.ownChanges().filter((p) => TEST_PATH.test(p) && o.read(p) !== undefined);
}

export interface CrossTestResult {
  /** per candidate id: rival test suites passed / rival suites that reproduce the issue */
  scores: Map<string, { passed: number; total: number }>;
  /** per candidate id that wrote tests: do they fail on the original code? */
  suites: Array<{ from: string; files: string[]; reproduces: boolean }>;
  /** test runs executed */
  runs: number;
}

export async function crossTest(
  candidates: Array<{ id: string; overlay: Overlay }>,
  base: Overlay,
  materializer: Materializer,
  cfg: KurultayConfig,
  opts: { signal?: AbortSignal; bus?: EventBus; source?: string } = {},
): Promise<CrossTestResult | undefined> {
  if (!cfg.verify.test?.trim() || candidates.length < 2) return undefined;
  // build + test only: lint has nothing to say about behaviour
  const testCfg: KurultayConfig = { ...cfg, verify: { ...cfg.verify, lint: '' } };
  let n = 0;
  const run = async (target: Overlay, from: Overlay, files: string[]) => {
    const view = target.fork(`${target.id}~xt${++n}`);
    for (const f of files) view.write(f, from.read(f)!);
    const v = await verifyOverlay(view, materializer, testCfg, opts.signal);
    return v.ok;
  };

  const suites: CrossTestResult['suites'] = [];
  for (const c of candidates) {
    const files = testFilesOf(c.overlay);
    if (!files.length) continue;
    // a test that already passes on the original code does not tell the candidates apart
    const reproduces = !(await run(base, c.overlay, files));
    suites.push({ from: c.id, files, reproduces });
  }
  const useful = suites.filter((s) => s.reproduces);
  if (!useful.length) {
    opts.bus?.debug(opts.source ?? 'cross-test', suites.length ? 'no candidate test fails on the original code – tests cannot pick a winner' : 'no candidate wrote a test – tests cannot pick a winner');
    return { scores: new Map(), suites, runs: n };
  }
  const scores = new Map<string, { passed: number; total: number }>();
  for (const c of candidates) {
    let passed = 0;
    let total = 0;
    for (const s of useful) {
      if (s.from === c.id) continue;
      total++;
      const from = candidates.find((x) => x.id === s.from)!.overlay;
      if (await run(c.overlay, from, s.files)) passed++;
    }
    scores.set(c.id, { passed, total });
  }
  opts.bus?.info(opts.source ?? 'cross-test', `rival tests: ${[...scores].map(([id, s]) => `${id} ${s.passed}/${s.total}`).join(', ')}`);
  return { scores, suites, runs: n };
}
