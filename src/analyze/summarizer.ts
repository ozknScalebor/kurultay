import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { KurultayConfig } from '../config.js';
import type { ProjectIndex, IndexedFile, ModuleGroup } from '../index/project-index.js';
import type { Router } from '../llm/router.js';
import { errorMessage, mapLimit, settle } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { estimateTokens, slug, truncateTokens, tryExtractJson } from '../util/text.js';
import { FILE_SUMMARY_SCHEMA, FLOWS_SCHEMA } from '../llm/schemas.js';

export interface AnalyzeOptions {
  /** re-summarize everything even if hashes match */
  force?: boolean;
  /** number of independent architecture drafts merged by a chairman (council). 0/1 = single */
  architectureDrafts?: number;
  /** how many key flows to document (DeepWiki-style pages); 0 disables. default 6 */
  flows?: number;
  /** write PROJECT_NOTES.md (Serena-style onboarding). default true */
  notes?: boolean;
  signal?: AbortSignal;
}

export interface AnalyzeResult {
  filesSummarized: number;
  modules: number;
  architecturePath: string;
  notesPath?: string;
  flowPaths: string[];
  modelsUsed: Record<string, number>;
  failures: number;
}

const LANG_NAME: Record<string, string> = { tr: 'Turkish', en: 'English', de: 'German' };

function langName(code: string): string {
  return LANG_NAME[code] ?? code;
}

const SKIP_SUMMARY_LANGS = new Set(['json', 'xml', 'text', 'yaml', 'toml', 'ini']);

/**
 * Hierarchical, map-reduce project analysis spread over ALL available models:
 *   1) file summaries (batched, every model works in parallel)
 *   2) module summaries (parallel)
 *   3) architecture document (N independent drafts + chairman synthesis)
 */
export class ProjectAnalyzer {
  private readonly usage: Record<string, number> = {};
  private failures = 0;

  constructor(
    private readonly index: ProjectIndex,
    private readonly router: Router,
    private readonly cfg: KurultayConfig,
    private readonly bus?: EventBus,
  ) {}

  private track(model: string) {
    this.usage[model] = (this.usage[model] ?? 0) + 1;
  }

  private get lang(): string {
    return langName(this.cfg.index.summaryLanguage);
  }

  /** Smallest context window among live models – batches must fit everywhere. */
  private batchBudget(): number {
    const windows = this.router.list().map((h) => h.caps.contextWindow);
    const minWin = windows.length ? Math.min(...windows) : 8192;
    return Math.max(1500, Math.min(12_000, Math.floor(minWin * 0.45)));
  }

  async run(opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    const todo = (opts.force ? this.index.files : this.index.needsSummary()).filter(
      (f) => !SKIP_SUMMARY_LANGS.has(f.lang) || /(^|\/)(package\.json|pom\.xml|CMakeLists\.txt|build\.gradle|Cargo\.toml|go\.mod|pyproject\.toml)$/.test(f.path),
    );
    this.bus?.emitEvent('analyze.start', { message: `${todo.length} files to summarise`, data: { files: todo.length, models: this.router.size } });

    await this.summarizeFiles(todo, opts.signal);
    this.index.save();

    const modules = this.index.modules();
    const moduleDocs = await this.summarizeModules(modules, opts.signal);

    const archPath = await this.writeArchitecture(modules, moduleDocs, opts.architectureDrafts ?? Math.min(3, this.router.size), opts.signal);
    this.writeIndexMarkdown(modules);
    let notesPath: string | undefined;
    if (opts.notes !== false) {
      try {
        notesPath = await this.writeProjectNotes(moduleDocs, modules, opts.signal);
      } catch (e) {
        this.failures++;
        this.bus?.warn('analyze', `could not write PROJECT_NOTES: ${errorMessage(e)}`);
      }
    }
    let flowPaths: string[] = [];
    const nFlows = opts.flows ?? 6;
    if (nFlows > 0) {
      try {
        flowPaths = await this.writeFlows(modules, moduleDocs, nFlows, opts.signal);
        if (flowPaths.length) appendFileSync(archPath, `\n## Flow Documents\n\n${flowPaths.map((p) => `- [${basename(p, '.md')}](flows/${basename(p)})`).join('\n')}\n`);
      } catch (e) {
        this.failures++;
        this.bus?.warn('analyze', `could not write the flow documents: ${errorMessage(e)}`);
      }
    }
    this.bus?.emitEvent('analyze.done', { data: { usage: this.usage, failures: this.failures } });
    this.router.learned?.save();
    return {
      filesSummarized: todo.length,
      modules: modules.length,
      architecturePath: archPath,
      notesPath,
      flowPaths,
      modelsUsed: { ...this.usage },
      failures: this.failures,
    };
  }

  // ---------- 1) file summaries ----------

  private makeBatches(files: IndexedFile[]): IndexedFile[][] {
    const budget = this.batchBudget();
    const batches: IndexedFile[][] = [];
    let cur: IndexedFile[] = [];
    let curTok = 0;
    // keep files of the same directory together → better summaries
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    for (const f of sorted) {
      const t = Math.min(estimateTokens(this.index.read(f.path) ?? ''), budget);
      if (cur.length && (curTok + t > budget || cur.length >= 12)) {
        batches.push(cur);
        cur = [];
        curTok = 0;
      }
      cur.push(f);
      curTok += t;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  private async summarizeFiles(files: IndexedFile[], signal?: AbortSignal): Promise<void> {
    if (!files.length) return;
    const batches = this.makeBatches(files);
    const budget = this.batchBudget();
    let done = 0;
    const parallel = Math.max(1, this.router.totalCapacity());
    this.bus?.info('analyze', `summarising ${files.length} file${files.length === 1 ? '' : 's'} in ${batches.length} batch${batches.length === 1 ? '' : 'es'} on ${parallel} parallel slots`);

    await mapLimit(batches, parallel, async (batch) => {
      const perFile = Math.floor(budget / batch.length);
      const body = batch
        .map((f) => {
          const content = this.index.read(f.path) ?? '';
          const defs = f.defs.slice(0, 40).map((d) => `${d.kind} ${d.parent ? d.parent + '.' : ''}${d.name} (line ${d.line})`).join('; ');
          return `### FILE: ${f.path} (${f.lang}, ${f.lines} lines)\nDefinitions: ${defs || '-'}\n\`\`\`\n${truncateTokens(content, perFile)}\n\`\`\``;
        })
        .join('\n\n');
      const prompt = `Summarize each source file below for a software architect who has never seen this project.
For every file give 2-4 sentences in ${this.lang}: its responsibility, the most important types/functions, and how it interacts with other parts (callers, callees, data it owns, hardware/IO, threads, protocols).
Return ONLY JSON: {"files":[{"path":"<exact path>","summary":"...","tags":["short","keywords"]}]}

${body}`;
      try {
        const r = await this.router.chat(
          { messages: [{ role: 'user', content: prompt }], temperature: 0.1, jsonMode: true, jsonSchema: FILE_SUMMARY_SCHEMA, purpose: 'summary.file', signal, maxTokens: Math.min(4096, 300 * batch.length + 400) },
          { role: 'summarizer' },
        );
        this.track(r.model);
        const parsed = tryExtractJson<{ files?: Array<{ path?: string; summary?: string; tags?: string[] }> }>(r.content);
        const list = parsed?.files ?? (Array.isArray(parsed) ? (parsed as Array<{ path?: string; summary?: string }>) : []);
        this.router.recordOutcome(r.model, 'summarizer', batch.filter((f) => list.some((x) => x.path && x.summary && (x.path === f.path || f.path.endsWith(x.path)))).length / batch.length);
        for (const f of batch) {
          const hit = list.find((x) => x.path === f.path) ?? list.find((x) => x.path && f.path.endsWith(x.path)) ?? (batch.length === 1 ? list[0] : undefined);
          if (hit?.summary) {
            f.summary = hit.summary.trim();
            f.summaryHash = f.hash;
            f.summaryModel = r.model;
          }
        }
      } catch (e) {
        this.failures++;
        this.bus?.warn('analyze', `summary batch failed: ${errorMessage(e)}`, { files: batch.map((f) => f.path) });
      }
      done += batch.length;
      this.bus?.emitEvent('analyze.progress', { data: { phase: 'files', done, total: files.length } });
      if (done % 50 < batch.length) this.index.save(); // checkpoint for resumability
    });
  }

  // ---------- 2) module summaries ----------

  private moduleDeps(modules: ModuleGroup[]): Map<string, Map<string, { w: number; via: Set<string> }>> {
    const owner = new Map<string, string>();
    for (const m of modules) for (const f of m.files) owner.set(f, m.name);
    const out = new Map<string, Map<string, { w: number; via: Set<string> }>>();
    for (const e of this.index.data.edges) {
      const a = owner.get(e.from);
      const b = owner.get(e.to);
      if (a === undefined || b === undefined || a === b) continue;
      const row = out.get(a) ?? new Map();
      const cell = row.get(b) ?? { w: 0, via: new Set<string>() };
      cell.w += e.weight;
      for (const v of e.via) if (cell.via.size < 8) cell.via.add(v);
      row.set(b, cell);
      out.set(a, row);
    }
    return out;
  }

  private async summarizeModules(modules: ModuleGroup[], signal?: AbortSignal): Promise<Map<string, string>> {
    const deps = this.moduleDeps(modules);
    const docs = new Map<string, string>();
    const dir = join(this.index.stateDir, 'modules');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const budget = this.batchBudget();

    await mapLimit(modules, Math.max(1, this.router.totalCapacity()), async (m) => {
      const name = m.name || '(root)';
      const fileLines = m.files.map((p) => {
        const f = this.index.file(p)!;
        const defs = f.defs.filter((d) => d.kind !== 'macro').slice(0, 8).map((d) => d.name).join(', ');
        return `- ${p}: ${f.summary ?? '(no summary)'}${defs ? ` [${defs}]` : ''}`;
      });
      const outgoing = [...(deps.get(m.name)?.entries() ?? [])].sort((a, b) => b[1].w - a[1].w).slice(0, 10).map(([to, c]) => `- → ${to || '(root)'} via ${[...c.via].join(', ')}`);
      const incoming = [...deps.entries()].filter(([, row]) => row.has(m.name)).map(([from, row]) => `- ← ${from || '(root)'} via ${[...row.get(m.name)!.via].join(', ')}`).slice(0, 10);
      const prompt = `You are documenting module "${name}" of a software project. Write concise Markdown in ${this.lang} with these sections:
## Purpose
## Sorumluluklar
## Main components (most important files/types/functions)
## Dependencies and interactions (which modules it uses / is used by, and for what)
## Flow (how data/control flows through this module; threads, events, IO if relevant)
Be specific; use only facts from the input. Do not add a top-level title.

Files in module:
${truncateTokens(fileLines.join('\n'), budget)}

Uses other modules:
${outgoing.join('\n') || '- none'}

Used by:
${incoming.join('\n') || '- none'}`;
      try {
        const r = await this.router.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0.2, purpose: 'summary.module', signal, maxTokens: 2048 }, { role: 'summarizer' });
        this.track(r.model);
        const md = `# Module: ${name}\n\n> ${m.files.length} files · summarised by ${r.model}\n\n${r.content.trim()}\n\n## Files\n\n${fileLines.join('\n')}\n`;
        docs.set(m.name, r.content.trim());
        writeFileSync(join(dir, `${slug(m.name || 'root')}.md`), md);
      } catch (e) {
        this.failures++;
        this.bus?.warn('analyze', `module summary failed (${name}): ${errorMessage(e)}`);
        docs.set(m.name, fileLines.join('\n'));
      }
      this.bus?.emitEvent('analyze.progress', { data: { phase: 'modules', module: name } });
    });
    return docs;
  }

  // ---------- 3) architecture ----------

  /** Deterministic Mermaid module graph from the dependency edges (no LLM guesswork). */
  mermaid(modules: ModuleGroup[], maxEdges = 40): string {
    const deps = this.moduleDeps(modules);
    const id = (n: string) => 'm_' + (slug(n || 'root').replace(/[^a-z0-9_]/g, '_') || 'root');
    const edges: Array<[string, string, number]> = [];
    for (const [a, row] of deps) for (const [b, c] of row) edges.push([a, b, c.w]);
    edges.sort((x, y) => y[2] - x[2]);
    const used = new Set<string>();
    const lines = ['flowchart LR'];
    for (const [a, b] of edges.slice(0, maxEdges)) {
      used.add(a);
      used.add(b);
      lines.push(`  ${id(a)} --> ${id(b)}`);
    }
    for (const m of modules) if (used.has(m.name) || modules.length <= 25) lines.splice(1, 0, `  ${id(m.name)}["${(m.name || '(root)').replace(/"/g, "'")} (${m.files.length})"]`);
    return lines.join('\n');
  }

  private entryPoints(): string[] {
    const out: string[] = [];
    for (const f of this.index.files) {
      for (const d of f.defs) {
        if (/^(main|wmain|WinMain|app_main|setup|loop|start_kernel|module_init)$/.test(d.name) || /\bstatic\s+void\s+main\s*\(/.test(d.signature)) out.push(`${f.path}:${d.line} ${d.signature}`);
      }
    }
    return out.slice(0, 20);
  }

  private async writeArchitecture(modules: ModuleGroup[], moduleDocs: Map<string, string>, drafts: number, signal?: AbortSignal): Promise<string> {
    const stats = this.index.stats();
    const budget = this.batchBudget();
    const perModule = Math.max(150, Math.floor((budget * 0.8) / Math.max(1, modules.length)));
    const readme = this.index.files.find((f) => /^readme(\.\w+)?$/i.test(f.path));
    const buildFiles = this.index.files.filter((f) => /(^|\/)(CMakeLists\.txt|Makefile|pom\.xml|build\.gradle|package\.json|Cargo\.toml|go\.mod|meson\.build|pyproject\.toml)$/.test(f.path)).slice(0, 6);
    const context = `Project statistics: ${stats.files} files, ${stats.lines} lines, languages ${JSON.stringify(stats.langs)}.
Entry points detected:
${this.entryPoints().join('\n') || '-'}

Directory tree:
${this.index.tree(60)}

Module dependency graph (mermaid, computed from code references):
${this.mermaid(modules)}

${readme ? `README excerpt:\n${truncateTokens(this.index.read(readme.path) ?? '', 600)}\n` : ''}${buildFiles.length ? `Build files: ${buildFiles.map((f) => f.path).join(', ')}\n` : ''}
Module summaries:
${modules.map((m) => `### ${m.name || '(root)'}\n${truncateTokens(moduleDocs.get(m.name) ?? '', perModule)}`).join('\n\n')}`;

    const ask = `Write the architecture document of this software project in ${this.lang}, as Markdown with these sections:
## Overview (what the system does, main technologies)
## Layers and Modules (role of each module, layering)
## Main Flows (step-by-step: startup/initialization, main data flows, control/event flows, error handling paths)
## Concurrency and Resources (threads, tasks, interrupts, timers, locks, memory/IO ownership – if applicable)
## External Interfaces (hardware, network protocols, files, APIs, CLI)
## Build, Test and Run
## Things to Watch When Changing (coupling hot-spots, invariants, risky areas)
Use only information supported by the input. Do not invent file names. Do not include a top-level title.`;

    const live = this.router.list().length;
    const n = Math.max(1, Math.min(drafts, live));
    let body: string;
    const chairmen: string[] = [];
    if (n <= 1) {
      const r = await this.router.chat({ messages: [{ role: 'user', content: `${ask}\n\n${context}` }], temperature: 0.2, purpose: 'summary.architecture', signal, maxTokens: 4096 }, { role: 'planner' });
      this.track(r.model);
      body = r.content.trim();
      chairmen.push(r.model);
    } else {
      // council: independent drafts from different models, then a chairman merges
      const authors = this.router.pick('summarizer', n);
      this.bus?.info('analyze', `${authors.length} independent drafts of the architecture document: ${authors.map((a) => a.caps.key).join(', ')}`);
      const results = await settle(
        authors.map((a) =>
          this.router.chat(
            { messages: [{ role: 'user', content: `${ask}\n\n${context}` }], temperature: 0.3, purpose: 'summary.architecture.draft', signal, maxTokens: 4096 },
            { prefer: [a.caps.key], fallback: true, role: 'summarizer' },
          ),
        ),
      );
      const ok = results.filter((r): r is { ok: true; value: Awaited<ReturnType<Router['chat']>> } => r.ok).map((r) => r.value);
      ok.forEach((r) => this.track(r.model));
      if (!ok.length) throw new Error('None of the architecture drafts could be produced');
      if (ok.length === 1) {
        body = ok[0].content.trim();
        chairmen.push(ok[0].model);
      } else {
        const draftsText = ok.map((r, i) => `<draft id="${String.fromCharCode(65 + i)}">\n${truncateTokens(r.content, Math.floor(budget / ok.length))}\n</draft>`).join('\n\n');
        const r = await this.router.chat(
          {
            messages: [
              {
                role: 'user',
                content: `${ask}

Several independent analysts wrote drafts of this document (below). Produce the single best final version: keep facts that are supported by the source context, resolve contradictions in favour of the source context, remove anything speculative, keep the required sections.

Source context:
${truncateTokens(context, Math.floor(budget * 0.6))}

${draftsText}`,
              },
            ],
            temperature: 0.1,
            purpose: 'summary.architecture.chair',
            signal,
            maxTokens: 4096,
          },
          { role: 'judge' },
        );
        this.track(r.model);
        body = r.content.trim();
        chairmen.push(...ok.map((x) => x.model), `${r.model} (merged)`);
      }
    }

    const doc = `# Architecture Summary

> Generated by Kurultay on ${new Date().toISOString()} · ${stats.files} files · ${stats.lines.toLocaleString('en')} lines · models: ${chairmen.join(', ')}

\`\`\`mermaid
${this.mermaid(modules)}
\`\`\`

${body}

## Module Documents

${modules.map((m) => `- [${m.name || '(root)'}](modules/${slug(m.name || 'root')}.md) – ${m.files.length} files`).join('\n')}
`;
    const path = join(this.index.stateDir, 'ARCHITECTURE.md');
    writeFileSync(path, doc);
    return path;
  }

  // ---------- 4) project notes (Serena onboarding memories) ----------

  private async writeProjectNotes(moduleDocs: Map<string, string>, modules: ModuleGroup[], signal?: AbortSignal): Promise<string> {
    const budget = this.batchBudget();
    const buildFiles = this.index.files
      .filter((f) => /(^|\/)(CMakeLists\.txt|Makefile|makefile|pom\.xml|build\.gradle(\.kts)?|package\.json|Cargo\.toml|go\.mod|meson\.build|pyproject\.toml|setup\.py|Dockerfile|\.gitlab-ci\.yml|Jenkinsfile)$/.test(f.path))
      .slice(0, 6);
    const readme = this.index.files.find((f) => /^readme(\.\w+)?$/i.test(f.path));
    const per = Math.floor((budget * 0.5) / Math.max(1, buildFiles.length + (readme ? 1 : 0)));
    const sources = [...buildFiles, ...(readme ? [readme] : [])].map((f) => `### ${f.path}\n\`\`\`\n${truncateTokens(this.index.read(f.path) ?? '', per)}\n\`\`\``).join('\n\n');
    const configured = [this.cfg.verify.build, this.cfg.verify.test, this.cfg.verify.lint].filter(Boolean);
    const sample = this.index.files
      .filter((f) => f.defs.length > 3 && f.lang !== 'markdown')
      .sort((a, b) => (this.index.data.ranks[b.path] ?? 0) - (this.index.data.ranks[a.path] ?? 0))
      .slice(0, 2)
      .map((f) => `### ${f.path}\n\`\`\`\n${truncateTokens(this.index.read(f.path) ?? '', Math.floor(budget * 0.15))}\n\`\`\``)
      .join('\n\n');
    const prompt = `You are onboarding onto a software project. Write durable, non-obvious notes that future coding agents will read before every task. Use ${this.lang} Markdown with EXACTLY these sections:
## Technology Stack (languages, frameworks, toolchains, target platforms, versions when stated)
## Komutlar (exact build / test / lint / run commands; mark guesses as "(guess)")
## Code Conventions (naming, formatting, error handling, logging, memory/ownership conventions actually visible in the code)
## Task Completion Checklist (what to run/check before a change is done)
## Invariants and Pitfalls (invariants, fragile areas, things that must not change)
Only state facts supported by the material. Be concise. No top-level title.

Configured verification commands: ${configured.join(' | ') || 'none'}
Directory tree:
${this.index.tree(50)}

Modules: ${modules.map((m) => `${m.name || '(root)'}: ${(moduleDocs.get(m.name) ?? '').split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 160) ?? ''}`).join('\n')}

${sources}

Representative source files:
${sample}`;
    const r = await this.router.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0.1, purpose: 'analyze.notes', signal, maxTokens: 2500 }, { role: 'planner' });
    this.track(r.model);
    const path = join(this.index.stateDir, 'PROJECT_NOTES.md');
    writeFileSync(path, `# Project Notes\n\n> Kurultay analysis · ${new Date().toISOString()} · model: ${r.model}. Edit freely; every worker gets this as context.\n\n${r.content.trim()}\n`);
    return path;
  }

  // ---------- 5) flow documents (DeepWiki two-phase: structure → grounded pages) ----------

  private async writeFlows(modules: ModuleGroup[], moduleDocs: Map<string, string>, maxFlows: number, signal?: AbortSignal): Promise<string[]> {
    const budget = this.batchBudget();
    const known = new Set(this.index.files.map((f) => f.path));
    const structurePrompt = `You are documenting how this software system WORKS at runtime. Identify the ${maxFlows} most important end-to-end flows (e.g. startup/initialisation, the main data path, command/request handling, error recovery, shutdown, a key algorithm or protocol). For each flow list the source files that implement it (use exact paths from the tree; 2–8 files).
Return ONLY JSON: {"flows":[{"title":"short title in ${this.lang}","description":"one sentence","files":["path", "..."],"importance":"high|medium|low"}]}

Entry points:
${this.entryPoints().join('\n') || '-'}

Module dependency graph:
${this.mermaid(modules)}

Modules:
${truncateTokens(modules.map((m) => `### ${m.name || '(root)'}\n${truncateTokens(moduleDocs.get(m.name) ?? '', 200)}`).join('\n'), Math.floor(budget * 0.5))}

Files:
${truncateTokens(this.index.files.map((f) => `${f.path}${f.summary ? ' — ' + f.summary.split('\n')[0].slice(0, 100) : ''}`).join('\n'), Math.floor(budget * 0.35))}`;
    const r = await this.router.chat({ messages: [{ role: 'user', content: structurePrompt }], temperature: 0.1, jsonMode: true, jsonSchema: FLOWS_SCHEMA, purpose: 'analyze.flows.structure', signal, maxTokens: 2500 }, { role: 'planner' });
    this.track(r.model);
    const parsed = tryExtractJson<{ flows?: Array<{ title?: string; description?: string; files?: string[]; importance?: string }> }>(r.content);
    const flows = (parsed?.flows ?? [])
      .map((f) => ({
        title: (f.title ?? '').trim(),
        description: (f.description ?? '').trim(),
        importance: f.importance ?? 'medium',
        files: [...new Set((f.files ?? []).map((p) => String(p).replace(/^\.?\//, '')).map((p) => (known.has(p) ? p : [...known].find((k) => k.endsWith('/' + p)) ?? '')).filter(Boolean))].slice(0, 8),
      }))
      .filter((f) => f.title && f.files.length)
      .slice(0, maxFlows);
    if (!flows.length) {
      this.bus?.warn('analyze', 'could not extract flows (no flow with existing files)');
      return [];
    }
    const dir = join(this.index.stateDir, 'flows');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.bus?.info('analyze', `writing ${flows.length} flow document${flows.length === 1 ? '' : 's'} on all models`);
    const paths = await mapLimit(flows, Math.max(1, this.router.totalCapacity()), async (f, i) => {
      const per = Math.floor((budget * 0.75) / f.files.length);
      const sources = f.files
        .map((p) => {
          const content = this.index.read(p) ?? '';
          const numbered = content.split('\n').map((l, n) => `${n + 1}: ${l}`).join('\n');
          return `### FILE ${p}\n\`\`\`\n${truncateTokens(numbered, per)}\n\`\`\``;
        })
        .join('\n\n');
      const prompt = `Write a technical documentation page in ${this.lang} Markdown about the flow "${f.title}" (${f.description}) of this project, based ONLY on the source files below (lines are numbered).
Structure:
1. Start with a <details><summary>Source files</summary> block listing the files used.
2. "# ${f.title}" then a short overview.
3. "## Step by Step" – numbered steps of the runtime flow; cite every step as \`path:line\`.
4. A Mermaid diagram (\`\`\`mermaid sequenceDiagram or flowchart) of the flow – only participants that exist in the code.
5. "## Errors and Edge Cases" – error paths, timeouts, concurrency/locking if present.
6. "## When Changing" – what a developer must keep consistent.
Do not invent functions or files that are not in the sources.

${sources}`;
      try {
        const page = await this.router.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0.2, purpose: 'analyze.flows.page', signal, maxTokens: 3000 }, { role: 'summarizer' });
        this.track(page.model);
        const path = join(dir, `${String(i + 1).padStart(2, '0')}-${slug(f.title)}.md`);
        writeFileSync(path, `${page.content.trim()}\n\n> Importance: ${f.importance} · written by ${page.model}\n`);
        return path;
      } catch (e) {
        this.failures++;
        this.bus?.warn('analyze', `flow page failed (${f.title}): ${errorMessage(e)}`);
        return '';
      }
    });
    return paths.filter(Boolean);
  }

  private writeIndexMarkdown(modules: ModuleGroup[]): void {
    const lines = ['# File Index', ''];
    for (const m of modules) {
      lines.push(`## ${m.name || '(root)'}`, '');
      for (const p of m.files) {
        const f = this.index.file(p)!;
        lines.push(`- **${p}** (${f.lang}, ${f.lines} lines)${f.summary ? ' – ' + f.summary.replace(/\n+/g, ' ') : ''}`);
      }
      lines.push('');
    }
    writeFileSync(join(this.index.stateDir, 'INDEX.md'), lines.join('\n'));
  }
}
