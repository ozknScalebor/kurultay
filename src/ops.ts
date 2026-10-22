import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from './app.js';
import type { ProjectIndex } from './index/project-index.js';
import { councilAnswer } from './orchestrator/council.js';
import { focusTerms } from './orchestrator/orchestrator.js';

export interface AskTurn {
  question: string;
  answer: string;
}

/** Answer a question about the project with a council of models (shared by `kurultay ask` and the console). */
export async function askProject(
  app: App,
  index: ProjectIndex,
  question: string,
  opts: { members?: number; history?: AskTurn[]; signal?: AbortSignal } = {},
): Promise<{ answer: string; members: string[]; chair?: string }> {
  const arch = join(app.stateDir, 'ARCHITECTURE.md');
  const notes = join(app.stateDir, 'PROJECT_NOTES.md');
  // follow-up questions ("peki bunu nerede çağırıyor?") need the previous turns for retrieval too
  const recent = (opts.history ?? []).slice(-3);
  const retrieval = [...recent.map((t) => t.question), question].join('\n');
  const focus = focusTerms(retrieval);
  const hits = index.search(retrieval, 6);
  const ctx = [
    existsSync(arch) ? `# ARCHITECTURE\n${readFileSync(arch, 'utf8')}` : '',
    existsSync(notes) ? `# PROJECT NOTES\n${readFileSync(notes, 'utf8')}` : '',
    `# REPO MAP\n${index.repoMap(1500, { files: hits.map((h) => h.path), identifiers: focus.identifiers })}`,
    `# RELEVANT CODE\n${hits.map((h) => `## ${h.path}:${h.startLine}-${h.endLine}\n${h.text}`).join('\n\n')}`,
    recent.length ? `# EARLIER IN THIS CONVERSATION\n${recent.map((t) => `Q: ${t.question}\nA: ${t.answer.slice(0, 1500)}`).join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const minWin = Math.min(...app.router.list().map((h) => h.caps.contextWindow));
  return councilAnswer(app.router, question, ctx, {
    members: opts.members ?? Math.min(3, app.router.size),
    contextTokens: Math.floor(minWin * 0.5),
    bus: app.bus,
    signal: opts.signal,
    language: app.config.language === 'tr' ? 'Turkish' : 'English',
  });
}
