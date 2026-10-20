import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { globToRegExp } from '../index/scanner.js';
import { fmList, fmString, parseFrontmatter } from '../util/frontmatter.js';

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
  review: RuleDoc[];
}

function loadDoc(path: string, source: string): RuleDoc | undefined {
  try {
    const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    const name = fmString(data.name) ?? path.split(/[\\/]/).pop()!.replace(/\.md$/i, '');
    const applies = fmList(data.applies_to ?? data.globs ?? data.applyTo ?? data.applyto ?? data.paths);
    const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
    return { name, source, description: fmString(data.description) ?? firstLine.slice(0, 160), appliesTo: applies, body: body.trim() };
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
export function loadProjectRules(root: string, stateDir: string, nestedRuleFiles?: string[]): ProjectRules {
  const rules: RuleDoc[] = [];
  const review: RuleDoc[] = [];
  // the same physical file can be reached under several names (case-insensitive filesystems, symlinks)
  const seen = new Set<string>();
  const add = (list: RuleDoc[], p: string, src: string) => {
    let key: string;
    try {
      key = realpathSync.native(p).toLowerCase();
    } catch {
      key = p.toLowerCase();
    }
    if (seen.has(key)) return;
    seen.add(key);
    const d = loadDoc(p, src.split(sep).join('/'));
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
  for (const f of ['review_rules.md', 'REVIEW_RULES.md', join('.kurultay', 'review_rules.md')]) {
    const p = join(root, f);
    if (existsSync(p)) add(review, p, f);
  }
  // directory-scoped AGENTS.md / CLAUDE.md (Pi ancestors, OMO directory injector):
  // a sub-folder's file applies to the files inside that folder
  for (const rel of nestedRuleFiles ?? []) {
    const dir = rel.split('/').slice(0, -1).join('/');
    if (!dir || /(^|\/)(node_modules|\.git|\.kurultay)(\/|$)/.test(dir)) continue;
    const before = rules.length;
    add(rules, join(root, rel), rel);
    if (rules.length > before) {
      const d = rules[rules.length - 1];
      d.appliesTo = [`${dir}/**`];
      d.name = `${dir}/${rel.split('/').pop()}`;
    }
  }
  return { rules, review };
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

export function renderRules(docs: RuleDoc[], title: string): string {
  if (!docs.length) return '';
  return `## ${title}\n${docs.map((d) => `### ${d.name} (${d.source})\n${d.body}`).join('\n\n')}`;
}
