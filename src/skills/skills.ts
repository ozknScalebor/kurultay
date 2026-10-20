import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { tokenize } from '../index/bm25.js';
import { globToRegExp } from '../index/scanner.js';
import { fmBool, fmList, fmString, parseFrontmatter } from '../util/frontmatter.js';
import { estimateTokens, truncateTokens } from '../util/text.js';

/**
 * Agent Skills (https://agentskills.io) compatible skill system.
 *
 *  - A skill is a folder with SKILL.md (+ optional scripts/, references/, assets/)
 *    or – legacy – a single markdown file with a `description` front-matter.
 *  - Progressive disclosure (Pi, omp, Codex): only name + description go into the
 *    prompt; the body is loaded on demand with the `skill` tool; supporting files
 *    with `skill_file`.
 *  - Discovery roots are shared with other agents so existing skills just work:
 *    .kurultay, .agents, .claude, .codex, .qwen, .goose, .opencode, .github, skills/.
 *  - Selection: explicit (`--skill`, `$name` mentions – Codex), `always`,
 *    `keywords` (OpenHands KeywordTrigger), `paths`/`globs` conditional activation
 *    (Qwen Code), planner choice per subtask, lexical fallback.
 */

export interface Skill {
  name: string;
  description: string;
  /** absolute path of SKILL.md (or the legacy .md file) */
  path: string;
  /** directory resources are resolved against */
  dir: string;
  /** e.g. ".claude/skills" or "~/.agents/skills" */
  source: string;
  scope: 'project' | 'user' | 'config';
  format: 'folder' | 'file';
  /** conditional activation globs (paths / globs / applies_to) */
  paths: string[];
  keywords: string[];
  always: boolean;
  /** disable-model-invocation / hide: only explicit selection may load it */
  hidden: boolean;
  argumentHint?: string;
  allowedTools: string[];
  /** supporting files relative to dir (folder skills only) */
  files: string[];
}

export interface SkillDiagnostic {
  level: 'warning' | 'error';
  path: string;
  message: string;
}

export interface DiscoverOptions {
  /** extra skill directories or SKILL.md/.md files (config skills.paths) */
  extraPaths?: string[];
  /** skill names to ignore */
  disabled?: string[];
  /** include ~/.kurultay/skills, ~/.agents/skills, ~/.claude/skills (default true) */
  includeUser?: boolean;
  /** override home directory (tests) */
  home?: string;
}

export const PROJECT_SKILL_ROOTS = [
  '.kurultay/skills',
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.qwen/skills',
  '.goose/skills',
  '.opencode/skills',
  '.opencode/skill',
  '.github/skills',
  'skills',
];
export const USER_SKILL_ROOTS = ['.kurultay/skills', '.agents/skills', '.claude/skills'];

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);

function listFiles(dir: string, limit = 60): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || out.length >= limit) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && !(d === dir && e.name === 'SKILL.md')) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir, 0);
  return out;
}

function loadSkillFile(file: string, source: string, scope: Skill['scope'], diagnostics: SkillDiagnostic[]): Skill | undefined {
  const isFolder = basename(file) === 'SKILL.md';
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    diagnostics.push({ level: 'warning', path: file, message: `okunamadı: ${(e as Error).message}` });
    return undefined;
  }
  const fm = parseFrontmatter(text);
  const d = fm.data;
  if (fmBool(d.enabled) === false) return undefined;
  const dir = dirname(file);
  const fallbackName = isFolder ? basename(dir) : basename(file).replace(/\.md$/i, '');
  const name = (fmString(d.name) ?? fallbackName).trim();
  const description = (fmString(d.description) ?? '').trim();
  if (!description) {
    // a plain markdown file without description is not a skill (no warning);
    // a declared SKILL.md must have one.
    if (isFolder) diagnostics.push({ level: 'error', path: file, message: 'description zorunlu (Agent Skills spesifikasyonu)' });
    if (!isFolder || !fm.body.trim()) return undefined;
  }
  if (name.length > MAX_NAME) diagnostics.push({ level: 'warning', path: file, message: `name ${MAX_NAME} karakteri aşıyor` });
  if (!NAME_RE.test(name)) diagnostics.push({ level: 'warning', path: file, message: `name yalnızca küçük harf, rakam ve tek tire içermeli: "${name}"` });
  if (isFolder && fmString(d.name) && name !== basename(dir)) diagnostics.push({ level: 'warning', path: file, message: `name ("${name}") klasör adıyla ("${basename(dir)}") aynı olmalı` });
  if (description.length > MAX_DESC) diagnostics.push({ level: 'warning', path: file, message: `description ${MAX_DESC} karakteri aşıyor` });
  const tokens = estimateTokens(fm.body);
  if (tokens > 5000) diagnostics.push({ level: 'warning', path: file, message: `gövde ~${tokens} token; spesifikasyon 5000 altını öneriyor (ayrıntıyı references/ altına taşıyın)` });
  return {
    name,
    description: description || fm.body.trim().split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 200) || name,
    path: file,
    dir,
    source,
    scope,
    format: isFolder ? 'folder' : 'file',
    paths: [...fmList(d.paths), ...fmList(d.globs), ...fmList(d.applies_to)],
    keywords: fmList(d.keywords ?? d.triggers).map((k) => k.toLowerCase()),
    always: fmBool(d.always) ?? fmBool(d.alwaysApply) ?? fmBool(d['always-apply']) ?? false,
    hidden: fmBool(d['disable-model-invocation']) ?? fmBool(d.disableModelInvocation) ?? fmBool(d.hide) ?? false,
    argumentHint: fmString(d['argument-hint']),
    allowedTools: fmList(d['allowed-tools']).flatMap((t) => t.split(/\s+/)).filter(Boolean),
    files: isFolder ? listFiles(dir) : [],
  };
}

/** Pi discovery rules: SKILL.md marks a skill root (no deeper recursion); top-level .md files with description are legacy skills. */
function scanRoot(root: string, source: string, scope: Skill['scope'], diagnostics: SkillDiagnostic[]): Skill[] {
  const out: Skill[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (existsSync(join(dir, 'SKILL.md'))) {
      const s = loadSkillFile(join(dir, 'SKILL.md'), source, scope, diagnostics);
      if (s) out.push(s);
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = statSync(p);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) walk(p, depth + 1);
      else if (isFile && depth === 0 && /\.md$/i.test(e.name) && !/^(readme|license|changelog)\.md$/i.test(e.name)) {
        const s = loadSkillFile(p, source, scope, diagnostics);
        if (s) out.push(s);
      }
    }
  };
  walk(root, 0);
  return out;
}

export class SkillRegistry {
  constructor(
    readonly skills: Skill[],
    readonly diagnostics: SkillDiagnostic[],
  ) {}

  static empty(): SkillRegistry {
    return new SkillRegistry([], []);
  }

  static discover(projectRoot: string, opts: DiscoverOptions = {}): SkillRegistry {
    const diagnostics: SkillDiagnostic[] = [];
    const found: Skill[] = [];
    const home = opts.home ?? homedir();
    for (const r of PROJECT_SKILL_ROOTS) {
      const abs = join(projectRoot, r);
      if (existsSync(abs)) found.push(...scanRoot(abs, r, 'project', diagnostics));
    }
    for (const p of opts.extraPaths ?? []) {
      const abs = isAbsolute(p) ? p : resolve(projectRoot, p.replace(/^~(?=$|[\\/])/, home));
      if (!existsSync(abs)) {
        diagnostics.push({ level: 'warning', path: abs, message: 'skill yolu bulunamadı' });
        continue;
      }
      if (statSync(abs).isDirectory()) found.push(...scanRoot(abs, p, 'config', diagnostics));
      else {
        const s = loadSkillFile(abs, p, 'config', diagnostics);
        if (s) found.push(s);
      }
    }
    if (opts.includeUser !== false && normalize(home) !== normalize(projectRoot)) {
      for (const r of USER_SKILL_ROOTS) {
        const abs = join(home, r);
        if (existsSync(abs)) found.push(...scanRoot(abs, `~/${r}`, 'user', diagnostics));
      }
    }
    // de-duplicate: same physical file once; same name → first wins (project before user)
    const disabled = new Set((opts.disabled ?? []).map((d) => d.toLowerCase()));
    const seenReal = new Set<string>();
    const byName = new Map<string, Skill>();
    for (const s of found) {
      let real = s.path;
      try {
        real = realpathSync.native(s.path);
      } catch {
        /* keep path */
      }
      if (seenReal.has(real.toLowerCase())) continue;
      seenReal.add(real.toLowerCase());
      if (disabled.has(s.name.toLowerCase())) continue;
      const prev = byName.get(s.name);
      if (prev) {
        diagnostics.push({ level: 'warning', path: s.path, message: `"${s.name}" adı çakışıyor; ${prev.source} içindeki kullanılıyor` });
        continue;
      }
      byName.set(s.name, s);
    }
    return new SkillRegistry([...byName.values()], diagnostics);
  }

  get size(): number {
    return this.skills.length;
  }

  get(name: string): Skill | undefined {
    const n = name.trim().replace(/^[$/]/, '').replace(/^skill:/, '');
    return this.skills.find((s) => s.name === n) ?? this.skills.find((s) => s.name.toLowerCase() === n.toLowerCase());
  }

  /** Skills the model may discover by itself (not hidden). */
  visible(): Skill[] {
    return this.skills.filter((s) => !s.hidden);
  }

  /** Is a conditional skill active for these files? Unconditional skills always are. */
  static matchesFiles(s: Skill, files: string[]): boolean {
    if (!s.paths.length) return true;
    const res = s.paths.map(globToRegExp);
    return files.some((f) => res.some((r) => r.test(f)));
  }

  /** `$skill-name` mentions in free text (Codex). */
  mentioned(text: string): Skill[] {
    const out: Skill[] = [];
    for (const m of text.matchAll(/(?:^|[\s(`])\$([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
      const s = this.get(m[1]);
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }

  /** Keyword triggers (OpenHands): any keyword appearing in the text. */
  triggered(text: string): Skill[] {
    const lower = text.toLowerCase();
    return this.visible().filter((s) => s.keywords.some((k) => k && new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(lower)));
  }

  /** Lexical relevance of name + description + keywords to a text (0..1). */
  score(s: Skill, text: string): number {
    const words = new Set(tokenize(text).filter((t) => t.length > 2));
    const toks = [...new Set(tokenize(`${s.name} ${s.description} ${s.keywords.join(' ')}`).filter((t) => t.length > 2))];
    if (!toks.length || !words.size) return 0;
    // prefix match tolerates suffixes ("sürücü" ~ "sürücüsü", "driver" ~ "drivers")
    const hit = toks.filter((t) => words.has(t) || [...words].some((w) => (w.length >= 5 && t.length >= 5 && (w.startsWith(t.slice(0, 5)) || t.startsWith(w.slice(0, 5))))));
    return hit.length / Math.max(4, toks.length);
  }

  /** The <available_skills> catalogue for prompts (Agent Skills integration format). */
  catalogue(opts: { files?: string[]; exclude?: string[]; recommended?: string[] } = {}): string {
    const list = this.visible().filter((s) => !opts.exclude?.includes(s.name) && (!opts.files || SkillRegistry.matchesFiles(s, opts.files)));
    if (!list.length) return '';
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rec = opts.recommended?.length ? `\nRecommended for this task: ${opts.recommended.join(', ')}.` : '';
    return `## Skills
The following skills contain project-specific procedures. When your task matches a skill's description, call the \`skill\` tool with its name BEFORE doing that part of the work, then follow its instructions. Use \`skill_file\` to open files the skill references.${rec}
<available_skills>
${list.map((s) => `  <skill><name>${esc(s.name)}</name><description>${esc(s.description)}</description>${s.argumentHint ? `<arguments>${esc(s.argumentHint)}</arguments>` : ''}</skill>`).join('\n')}
</available_skills>`;
  }

  /** Full skill content as loaded into context (body without front-matter, args substituted). */
  render(s: Skill, args?: string, maxTokens = 6000): string {
    let body = parseFrontmatter(readFileSync(s.path, 'utf8')).body.trim();
    const a = (args ?? '').trim();
    body = body.replace(/\$ARGUMENTS|\{\{\s*args\s*\}\}/g, a);
    const files = s.files.length ? `\n\nSupporting files (open with skill_file, name="${s.name}"):\n${s.files.map((f) => `- ${f}`).join('\n')}` : '';
    return `<skill name="${s.name}" source="${s.source}">\n${truncateTokens(body, maxTokens)}${files}\n</skill>`;
  }

  /** Read a supporting file safely (must stay inside the skill folder). */
  readFile(s: Skill, path: string, maxTokens = 8000): string {
    const target = normalize(join(s.dir, path));
    const rel = relative(s.dir, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`skill klasörü dışındaki yol reddedildi: ${path}`);
    if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`skill dosyası yok: ${path}. Mevcut: ${s.files.join(', ') || '-'}`);
    return truncateTokens(readFileSync(target, 'utf8'), maxTokens);
  }
}

export interface SkillSelection {
  /** loaded into the worker context up front */
  preload: Skill[];
  /** advertised as recommended in the catalogue */
  recommended: string[];
  reasons: Record<string, string>;
}

/**
 * Decide which skills a worker starts with.
 * explicit (--skill / $mention) > always > keyword trigger > planner choice > lexical (recommend only).
 */
export function selectSkillsFor(reg: SkillRegistry, args: { text: string; files: string[]; explicit?: string[]; planned?: string[]; maxPreload?: number }): SkillSelection {
  const preload: Skill[] = [];
  const reasons: Record<string, string> = {};
  const add = (s: Skill | undefined, why: string) => {
    if (!s || preload.includes(s)) return;
    preload.push(s);
    reasons[s.name] = why;
  };
  for (const n of args.explicit ?? []) add(reg.get(n), 'açıkça seçildi');
  for (const s of reg.mentioned(args.text)) add(s, '$ ile anıldı');
  const max = args.maxPreload ?? 3;
  for (const s of reg.visible()) if (s.always && SkillRegistry.matchesFiles(s, args.files)) add(s, 'always');
  for (const s of reg.triggered(args.text)) if (preload.length < max + (args.explicit?.length ?? 0) && SkillRegistry.matchesFiles(s, args.files)) add(s, 'anahtar kelime');
  for (const n of args.planned ?? []) {
    const s = reg.get(n);
    if (s && !s.hidden && preload.length < max + (args.explicit?.length ?? 0)) add(s, 'planlayıcı seçti');
  }
  const recommended = reg
    .visible()
    .filter((s) => !preload.includes(s) && SkillRegistry.matchesFiles(s, args.files))
    .map((s) => ({ s, sc: reg.score(s, args.text) }))
    .filter((x) => x.sc >= 0.25)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 3)
    .map((x) => x.s.name);
  return { preload, recommended, reasons };
}

export const SKILL_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
# keywords: [anahtar, kelimeler]     # görevde geçerse otomatik yüklenir
# paths: ["src/drivers/**"]          # yalnızca bu dosyalarla çalışırken önerilir
# always: false                      # her çalışana baştan yükle
# disable-model-invocation: false    # true → yalnızca --skill veya $${name} ile
---
# ${name}

Bu skill'in ne zaman kullanılacağını ve adımlarını yazın.

## Adımlar
1. ...
2. ...

## Doğrulama
- Derleme ve testleri çalıştırın.

Ayrıntılı başvuru dokümanlarını \`references/\`, betikleri \`scripts/\`, şablonları \`assets/\` altına koyun; buradan göreli yolla anın.
`;
