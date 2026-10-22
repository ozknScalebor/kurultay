import type { Router } from '../llm/router.js';
import { errorMessage, settle } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { truncateTokens, tryExtractJson } from '../util/text.js';
import { PLAN_SCHEMA } from '../llm/schemas.js';

export interface SubTask {
  id: string;
  title: string;
  description: string;
  files: string[];
  dependsOn: string[];
  /** worth racing several models on */
  critical: boolean;
  /** skills the planner wants preloaded for this subtask */
  skills?: string[];
}

export interface Plan {
  understanding: string;
  acceptance: string[];
  subtasks: SubTask[];
  /** models whose drafts went into the plan */
  authors: string[];
}

interface RawPlan {
  understanding?: string;
  acceptance_criteria?: string[];
  acceptance?: string[];
  subtasks?: Array<{ id?: string; title?: string; description?: string; files?: string[]; depends_on?: string[]; dependsOn?: string[]; critical?: boolean; skills?: string[] }>;
}

const PLAN_INSTRUCTIONS = `You are the planner of a team of AI coding agents working on the project described below.
Produce an implementation plan for the TASK. Break it into the FEWEST subtasks that can be implemented and verified independently by one engineer each (1 subtask is fine for small tasks; never more than 8). Subtasks that touch the same files should be merged or chained with depends_on.
Return ONLY JSON:
{
  "understanding": "one paragraph: what must change and why",
  "acceptance_criteria": ["observable, checkable criteria for the whole task"],
  "subtasks": [
    {"id": "T1", "title": "...", "description": "precise instructions incl. files, functions, edge cases", "files": ["paths likely touched"], "depends_on": [], "critical": true, "skills": []}
  ]
}
Mark "critical": true for subtasks with tricky logic where comparing several independent implementations is valuable.
If project skills are listed below, put the names of the skills a subtask needs in its "skills" array (only names from the list; [] when none apply).`;

function normalizePlan(raw: RawPlan | undefined, task: string): Omit<Plan, 'authors'> | undefined {
  if (!raw || !Array.isArray(raw.subtasks) || raw.subtasks.length === 0) return undefined;
  const subtasks: SubTask[] = raw.subtasks.slice(0, 8).map((s, i) => ({
    id: (s.id && String(s.id)) || `T${i + 1}`,
    title: s.title || `Alt görev ${i + 1}`,
    description: s.description || s.title || task,
    files: Array.isArray(s.files) ? s.files.filter((f) => typeof f === 'string') : [],
    dependsOn: (s.depends_on ?? s.dependsOn ?? []).map(String),
    critical: !!s.critical,
    skills: Array.isArray(s.skills) ? s.skills.filter((x) => typeof x === 'string').slice(0, 4) : undefined,
  }));
  // drop dangling / self dependencies and break cycles
  const ids = new Set(subtasks.map((s) => s.id));
  for (const s of subtasks) s.dependsOn = s.dependsOn.filter((d) => ids.has(d) && d !== s.id);
  const order = topoOrder(subtasks);
  if (!order) for (const s of subtasks) s.dependsOn = [];
  return {
    understanding: raw.understanding ?? '',
    acceptance: (raw.acceptance_criteria ?? raw.acceptance ?? []).filter((a) => typeof a === 'string'),
    subtasks,
  };
}

/** Kahn's algorithm; returns undefined if there is a cycle. */
export function topoOrder(tasks: SubTask[]): SubTask[] | undefined {
  const indeg = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const queue = tasks.filter((t) => t.dependsOn.length === 0);
  const out: SubTask[] = [];
  while (queue.length) {
    const t = queue.shift()!;
    out.push(t);
    for (const u of tasks) {
      if (u.dependsOn.includes(t.id)) {
        indeg.set(u.id, indeg.get(u.id)! - 1);
        if (indeg.get(u.id) === 0) queue.push(u);
      }
    }
  }
  return out.length === tasks.length ? out : undefined;
}

/**
 * Council planning: the best planners draft independently in parallel, a judge
 * merges them into one plan. Falls back to a single-subtask plan if all fail.
 */
export async function makePlan(
  router: Router,
  task: string,
  context: string,
  opts: { drafts: number; contextTokens: number; bus?: EventBus; signal?: AbortSignal; extra?: string; skillCatalogue?: string },
): Promise<Plan> {
  const skills = opts.skillCatalogue ? `\n\n${opts.skillCatalogue}` : '';
  const prompt = `${PLAN_INSTRUCTIONS}\n\n${truncateTokens(context, opts.contextTokens)}${skills}\n\n# TASK\n${task}${opts.extra ? '\n\n' + opts.extra : ''}`;
  const planners = router.pick('planner', Math.max(1, opts.drafts));
  opts.bus?.info('planner', `plan taslakları: ${planners.map((p) => p.caps.key).join(', ')}`);
  const results = await settle(
    planners.map((p) =>
      router.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0.2, jsonMode: true, jsonSchema: PLAN_SCHEMA, maxTokens: 3000, purpose: 'plan.draft', signal: opts.signal }, { prefer: [p.caps.key], role: 'planner' }),
    ),
  );
  const drafts: Array<{ model: string; plan: Omit<Plan, 'authors'>; raw: string }> = [];
  results.forEach((r, i) => {
    if (!r.ok) {
      opts.bus?.warn('planner', `plan taslağı başarısız: ${errorMessage(r.error)}`);
      router.recordOutcome(planners[i].caps.key, 'planner', false);
      return;
    }
    const plan = normalizePlan(tryExtractJson<RawPlan>(r.value.content), task);
    router.recordOutcome(r.value.model, 'planner', !!plan);
    if (plan) drafts.push({ model: r.value.model, plan, raw: r.value.content });
  });
  if (!drafts.length) {
    opts.bus?.warn('planner', 'geçerli plan üretilemedi; görev tek alt görev olarak çalıştırılacak');
    return { understanding: '', acceptance: [], subtasks: [{ id: 'T1', title: 'Görev', description: task, files: [], dependsOn: [], critical: true }], authors: [] };
  }
  if (drafts.length === 1) return { ...drafts[0].plan, authors: [drafts[0].model] };

  const labelled = drafts.map((d, i) => `<plan id="${String.fromCharCode(65 + i)}">\n${JSON.stringify(d.plan, null, 1)}\n</plan>`).join('\n');
  try {
    const judge = await router.chat(
      {
        messages: [
          {
            role: 'user',
            content: `${PLAN_INSTRUCTIONS}

Several planners proposed plans for the same task (below). Merge them into the single best plan: keep the most accurate understanding, the union of valid acceptance criteria, and the simplest correct subtask breakdown. Return ONLY the JSON plan.${skills}

# TASK
${task}

${labelled}`,
          },
        ],
        temperature: 0.1,
        jsonMode: true,
        jsonSchema: PLAN_SCHEMA,
        maxTokens: 3000,
        purpose: 'plan.judge',
        signal: opts.signal,
      },
      { role: 'judge' },
    );
    const merged = normalizePlan(tryExtractJson<RawPlan>(judge.content), task);
    router.recordOutcome(judge.model, 'judge', !!merged);
    if (merged) return { ...merged, authors: [...drafts.map((d) => d.model), `${judge.model} (birleştiren)`] };
  } catch (e) {
    opts.bus?.warn('planner', `plan birleştirme başarısız: ${errorMessage(e)}`);
  }
  return { ...drafts[0].plan, authors: [drafts[0].model] };
}
