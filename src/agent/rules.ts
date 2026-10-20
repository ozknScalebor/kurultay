import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { globToRegExp } from '../index/scanner.js';
import { tokenize } from '../index/bm25.js';

export interface RuleDoc {
  name: string;
  source: string;
  description: string;
  /** glob(s) of files this rule applies to; empty = always */
  appliesTo: string[];
  body: string;
}

export interface ProjectRules {
  rules: RuleDoc[];
  skills: RuleDoc[];
  review: RuleDoc[];
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

function loadDoc(path: string, source: string): RuleDoc | undefined {
  try {
    const { meta, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    const name = meta.name ?? path.split(/[\\/]/).pop()!.replace(/\.md$/i, '');
    const applies = (meta.applies_to ?? meta.globs ?? meta.applyto ?? '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
    return { name, source, description: meta.description ?? firstLine.slice(0, 160), appliesTo: applies, body: body.trim() };
  } catch {
    return undefined;
  }
}

function mdFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Collect project rules. Kurultay reads its own folders AND the conventions of
 * other agents (AGENTS.md, CLAUDE.md, .cursorrules, .clinerules, copilot) so
 * existing rule files work without migration.
 */
export function loadProjectRules(root: string, stateDir: string): ProjectRules {
  const rules: RuleDoc[] = [];
  const skills: RuleDoc[] = [];
  const review: RuleDoc[] = [];
  const add = (list: RuleDoc[], p: string, src: string) => {
    const d = loadDoc(p, src);
    if (d && d.body) list.push(d);
  };
  for (const f of ['AGENTS.md', 'KURULTAY.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md']) {
    const p = join(root, f);
    if (existsSync(p) && statSync(p).isFile()) add(rules, p, f);
  }
  for (const dir of [join(stateDir, 'rules'), join(root, '.clinerules'), join(root, '.cursor', 'rules'), join(root, 'rules')]) {
    for (const p of mdFiles(dir)) {
      if (/review/i.test(p.split(/[\\/]/).pop()!)) add(review, p, p.slice(root.length + 1));
      else add(rules, p, p.slice(root.length + 1));
    }
  }
  for (const dir of [join(stateDir, 'skills'), join(root, 'skills')]) for (const p of mdFiles(dir)) add(skills, p, p.slice(root.length + 1));
  for (const f of ['review_rules.md', 'REVIEW_RULES.md', join('.kurultay', 'review_rules.md')]) {
    const p = join(root, f);
    if (existsSync(p) && !review.some((r) => r.source === f)) add(review, p, f);
  }
  return { rules, skills, review };
}

/** Rules relevant to a set of target files (rules without globs always apply). */
export function selectRules(rules: RuleDoc[], files: string[]): RuleDoc[] {
  return rules.filter((r) => {
    if (!r.appliesTo.length) return true;
    if (!files.length) return true;
    const res = r.appliesTo.map(globToRegExp);
    return files.some((f) => res.some((re) => re.test(f)));
  });
}

/** Skills whose name/description overlap with the task text. */
export function selectSkills(skills: RuleDoc[], task: string, max = 3): RuleDoc[] {
  const words = new Set(tokenize(task));
  return skills
    .map((s) => {
      const toks = tokenize(`${s.name} ${s.description}`);
      const overlap = toks.filter((t) => words.has(t) && t.length > 2).length;
      return { s, score: overlap / Math.max(3, toks.length) };
    })
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.s);
}

export function renderRules(docs: RuleDoc[], title: string): string {
  if (!docs.length) return '';
  return `## ${title}\n${docs.map((d) => `### ${d.name} (${d.source})\n${d.body}`).join('\n\n')}`;
}
