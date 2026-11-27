import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, type Yaml } from './yaml.js';

/**
 * Build and test commands from the project's CI pipeline: the pipeline already says how the
 * project is built and tested (.gitlab-ci.yml, GitHub/Gitea/Forgejo workflows, Azure Pipelines,
 * Bitbucket Pipelines, Drone/Woodpecker). Only commands of known build/test tools are taken;
 * deploying, publishing, pushing, container and network steps and installs are left out, and
 * the pipeline's variables are filled in.
 */
export interface PipelineVerify {
  build: string;
  test: string;
  /** the file the commands come from */
  source: string;
}

const FILES = ['.gitlab-ci.yml', '.gitlab-ci.yaml', 'azure-pipelines.yml', 'azure-pipelines.yaml', 'bitbucket-pipelines.yml', '.drone.yml', '.woodpecker.yml'];
const DIRS = ['.github/workflows', '.gitea/workflows', '.forgejo/workflows', '.woodpecker'];
/** keys that hold shell commands */
const SCRIPT_KEYS = new Set(['script', 'before_script', 'run', 'bash', 'commands', 'pwsh', 'powershell']);
/** keys that hold variables */
const VAR_KEYS = new Set(['variables', 'env']);

/** build and test tools (a command must start with one, after VAR=value prefixes) */
const TOOL = /^(?:\.[\\/])?(?:mvnw?|gradlew?|ant|make|gmake|cmake|ctest|ninja|meson|npm|yarn|pnpm|dotnet|msbuild|go|cargo|pytest|tox|nox|bazel|bazelisk|sbt|qmake|scons|phpunit|jest|vitest|python3?\s+-m\s+(?:pytest|unittest|tox|build)|eclipsec?(?:\.exe)?|xvfb-run)(?:\.(?:bat|cmd|exe))?(?:\s|$)/i;
/** never run as a check: they change something outside the work tree, or need the network */
const UNSAFE = /\brelease:\S|semantic-release|\brun\s+release\b|\b(?:deploy|publish|upload|push|docker|podman|buildah|kaniko|kubectl|helm|scp|ssh|rsync|curl|wget|sonar\S*|twine|terraform|gcloud|aws|az|gh|jfrog|nexus|artifactory|install\s+-g|login)\b|\b(?:npm|yarn|pnpm)\s+(?:ci|install|i|add)\b|\bpip3?\s+install\b|\bapt(?:-get)?\b|\byum\b|\bdnf\b|\bapk\b|\bchoco\b|\bsudo\b|\brm\s+-rf\s+\//i;
/** jobs and steps that are not about building or testing */
const OTHER_JOB = /\b(?:deploy\S*|release|publish|pages|docker|container|image|sonar\S*|security|sast|dast|scan|lint|format|docs?|upload|notify|cleanup)\b/i;
const TEST = /\b(?:test|tests|verify|check|ctest|pytest|tox|nox|jest|vitest|phpunit|unittest|integration-test)\b/;
const NO_TESTS = /skipTests|maven\.test\.skip|-x\s+test\b|--exclude-task\s+test/;
/** a command that says it builds (the job name only decides when the command does not) */
const BUILD = /\b(?:build|compile|package|assemble|install|configure)\b|^cmake\s+-S|^(?:\.\/)?(?:g?make|ninja|msbuild)(?:\s+(?!test|check)\S+)*\s*$/;

interface Script {
  context: string;
  lines: string[];
  cwd?: string;
}

function asLines(v: Yaml): string[] {
  if (typeof v === 'string') return v.split('\n');
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' ? x.split('\n') : []));
  return [];
}

/** Every script in the document, with the names around it (job, stage, step) as context. */
function collect(doc: Yaml, vars: Record<string, string>): Script[] {
  const out: Script[] = [];
  const walk = (node: Yaml, context: string[], cwd?: string) => {
    if (Array.isArray(node)) {
      node.forEach((x) => walk(x, context, cwd));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const names = ['name', 'stage', 'displayName', 'job', 'task'].map((k) => node[k]).filter((x): x is string => typeof x === 'string');
    const here = [...context, ...names];
    const dir = typeof node['working-directory'] === 'string' ? node['working-directory'] : typeof node.workingDirectory === 'string' ? node.workingDirectory : cwd;
    for (const [k, v] of Object.entries(node)) {
      if (VAR_KEYS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [n, x] of Object.entries(v)) {
          const val = x && typeof x === 'object' && !Array.isArray(x) ? (x as { value?: Yaml }).value : x;
          if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') vars[n] ??= String(val);
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (SCRIPT_KEYS.has(k)) out.push({ context: here.join(' '), lines: asLines(v), cwd: dir });
      // Azure DevOps Maven / Gradle tasks
      else if (k === 'task' && typeof v === 'string' && node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs)) {
        const inp = node.inputs as Record<string, Yaml>;
        if (/^Maven@/i.test(v)) out.push({ context: here.join(' '), lines: [`mvn ${inp.mavenPomFile ? `-f ${String(inp.mavenPomFile)} ` : ''}${String(inp.goals ?? 'package')}`], cwd: dir });
        if (/^Gradle@/i.test(v)) out.push({ context: here.join(' '), lines: [`./gradlew ${String(inp.tasks ?? 'build')}`], cwd: dir });
      } else if (v && typeof v === 'object' && !VAR_KEYS.has(k)) walk(v, [...here, k], dir);
    }
  };
  walk(doc, []);
  return out;
}

/** Fill in $VAR, ${VAR} and $(VAR); the checkout folder becomes "." */
function expand(cmd: string, vars: Record<string, string>): string {
  const local = /^(?:CI_PROJECT_DIR|GITHUB_WORKSPACE|BITBUCKET_CLONE_DIR|CI_WORKSPACE|DRONE_WORKSPACE|Build\.SourcesDirectory|System\.DefaultWorkingDirectory|Pipeline\.Workspace)$/;
  const get = (n: string) => (local.test(n) ? '.' : vars[n]);
  let s = cmd;
  for (let round = 0; round < 3; round++) {
    s = s
      .replace(/\$\{\{\s*(?:env|vars)\.([A-Za-z_][\w.]*)\s*\}\}/g, (m, n: string) => get(n) ?? m)
      .replace(/\$\{([A-Za-z_][\w.]*)\}|\$\(([A-Za-z_][\w.]*)\)|\$([A-Za-z_]\w*)/g, (m, a?: string, b?: string, c?: string) => get(a ?? b ?? c ?? '') ?? m);
  }
  return s;
}

/** The commands of one script, with `cd` folded in and continuation lines joined. */
function commands(s: Script, vars: Record<string, string>): string[] {
  const joined: string[] = [];
  for (const raw of s.lines) {
    const line = raw.trim();
    if (joined.length && /\\$/.test(joined[joined.length - 1])) joined[joined.length - 1] = `${joined[joined.length - 1].slice(0, -1).trimEnd()} ${line}`;
    else if (line && !line.startsWith('#')) joined.push(line);
  }
  const out: string[] = [];
  let cwd = s.cwd && s.cwd !== '.' ? expand(s.cwd, vars) : undefined;
  for (const line of joined) {
    const cmd = expand(line, vars).replace(/\s+/g, ' ').trim();
    const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(cmd);
    if (cd) {
      const d = cd[1].replace(/^["']|["']$/g, '');
      cwd = d === '.' || d === './' ? undefined : cwd && !/^[\\/]|^[A-Za-z]:/.test(d) ? `${cwd}/${d}` : d;
      continue;
    }
    // VAR=value prefixes, then the tool
    const bare = cmd.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '');
    if (!TOOL.test(bare) || UNSAFE.test(cmd) || /\$[{(]?[A-Za-z_]/.test(bare)) continue;
    out.push(cwd ? `cd ${/\s/.test(cwd) ? `"${cwd}"` : cwd} && ${cmd}` : cmd);
  }
  return out;
}

const forPlatform = (cmd: string, platform: NodeJS.Platform) => (platform === 'win32' ? cmd.replace(/(^|&& )\.\/(gradlew|mvnw)\b/g, '$1$2') : cmd);

/** Build and test commands of one pipeline file (undefined: none found). */
export function verifyFromPipeline(text: string, source: string, platform: NodeJS.Platform = process.platform): PipelineVerify | undefined {
  let doc: Yaml;
  try {
    doc = parseYaml(text);
  } catch {
    return undefined;
  }
  const vars: Record<string, string> = {};
  const scripts = collect(doc, vars).filter((s) => !OTHER_JOB.test(s.context));
  const build: string[] = [];
  const test: string[] = [];
  for (const s of scripts) {
    for (const c of commands(s, vars)) {
      const own = c.replace(/^cd (?:"[^"]+"|\S+) && /, '');
      const isTest = !NO_TESTS.test(own) && (TEST.test(own) || (!BUILD.test(own) && /\btest/i.test(s.context)));
      const into = isTest ? test : build;
      if (!into.includes(c)) into.push(c);
    }
  }
  if (!build.length && !test.length) return undefined;
  const join3 = (xs: string[]) => xs.slice(0, 3).map((c) => forPlatform(c, platform)).join(' && ');
  return { build: join3(build), test: join3(test), source };
}

/** The first pipeline file of the project that has build or test commands. */
export function detectPipelineVerify(root: string, platform: NodeJS.Platform = process.platform): PipelineVerify | undefined {
  const files = [...FILES.filter((f) => existsSync(join(root, f)))];
  for (const d of DIRS) {
    try {
      for (const f of readdirSync(join(root, d)).sort()) if (/\.ya?ml$/i.test(f)) files.push(`${d}/${f}`);
    } catch {
      /* no such folder */
    }
  }
  for (const f of files) {
    try {
      const r = verifyFromPipeline(readFileSync(join(root, f), 'utf8'), f, platform);
      if (r) return r;
    } catch {
      /* unreadable: the next one */
    }
  }
  return undefined;
}
