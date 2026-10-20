import type { Router } from '../llm/router.js';
import { errorMessage, settle } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { truncateTokens, tryExtractJson } from '../util/text.js';

export interface Candidate {
  /** worker id */
  id: string;
  author: string;
  diff: string;
  summary: string;
  /** 0..1 from build/test (undefined = no verify configured) */
  verifyScore?: number;
  verifyOk?: boolean;
}

export interface Review {
  reviewer: string;
  ranking: string[]; // candidate ids, best first
  scores: Record<string, number>; // 0..10
  issues: Record<string, Array<{ text: string; blocking: boolean }>>;
}

export interface CouncilVerdict {
  winner?: Candidate;
  ranking: Array<{ id: string; author: string; points: number; verifyScore?: number }>;
  reviews: Review[];
  /** issues raised against the winner by any reviewer */
  winnerIssues: Array<{ reviewer: string; text: string; blocking: boolean }>;
}

const LABELS = 'ABCDEFGHIJ';

/**
 * Karpathy-style LLM council for code: every reviewer sees all candidate diffs
 * ANONYMISED (A, B, C…), ranks them and lists issues; Borda points are combined
 * with build/test results (objective evidence dominates).
 */
export async function councilReview(
  router: Router,
  args: {
    task: string;
    acceptance: string[];
    candidates: Candidate[];
    reviewRules?: string;
    reviewers: number;
    contextTokens: number;
    bus?: EventBus;
    signal?: AbortSignal;
  },
): Promise<CouncilVerdict> {
  const { candidates } = args;
  if (!candidates.length) return { ranking: [], reviews: [], winnerIssues: [] };
  // shuffle labels so position bias does not favour the first worker
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const labelOf = new Map(shuffled.map((c, i) => [c.id, LABELS[i]]));
  const byLabel = new Map(shuffled.map((c, i) => [LABELS[i], c]));
  const perDiff = Math.floor(args.contextTokens / (shuffled.length + 1));
  // scrub model identities from free text so reviewers cannot recognise authors
  const identities = [...new Set(candidates.flatMap((c) => [c.author, c.author.split('@')[0]]).filter((x) => x && x.length > 2))].sort((a, b) => b.length - a.length);
  const scrub = (t: string) => identities.reduce((acc, id) => acc.split(id).join('[model]'), t);
  const body = shuffled
    .map((c) => {
      const v = c.verifyScore === undefined ? 'not run' : c.verifyOk ? 'PASSED' : `FAILED (score ${c.verifyScore.toFixed(2)})`;
      return `<candidate id="${labelOf.get(c.id)}">\nBuild/tests: ${v}\nAuthor's note: ${scrub(c.summary.slice(0, 600))}\n\`\`\`diff\n${truncateTokens(c.diff || '(no changes)', perDiff)}\n\`\`\`\n</candidate>`;
    })
    .join('\n\n');
  const prompt = `You are a strict senior code reviewer in a review council. Several independent engineers implemented the same task. Evaluate each candidate for correctness, completeness against the acceptance criteria, safety (memory, concurrency, error handling), minimality and consistency with the codebase.
${args.reviewRules ? `\nProject review rules (mandatory):\n${args.reviewRules}\n` : ''}
# TASK
${args.task}
${args.acceptance.length ? `\n# ACCEPTANCE CRITERIA\n${args.acceptance.map((a) => `- ${a}`).join('\n')}\n` : ''}
${body}

Return ONLY JSON:
{"ranking": ["best id first", ...], "scores": {"A": 0-10, ...}, "issues": {"A": [{"text": "...", "blocking": true|false}], ...}}
"blocking" means the change must not be merged as-is.`;

  const authors = new Set(candidates.map((c) => c.author));
  // prefer reviewers that did not author a candidate; fill up with authors (anonymity still holds)
  let reviewers = router.pick('reviewer', args.reviewers, [...authors]);
  if (reviewers.length < args.reviewers) reviewers = [...reviewers, ...router.pick('reviewer', args.reviewers - reviewers.length, reviewers.map((r) => r.caps.key))];
  args.bus?.info('council', `${candidates.length} aday, ${reviewers.length} gözden geçiren: ${reviewers.map((r) => r.caps.key).join(', ')}`);

  const results = await settle(
    reviewers.map((r) =>
      router.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0, jsonMode: true, maxTokens: 2500, purpose: 'council.review', signal: args.signal }, { prefer: [r.caps.key], role: 'reviewer' }),
    ),
  );
  const reviews: Review[] = [];
  for (const r of results) {
    if (!r.ok) {
      args.bus?.warn('council', `inceleme başarısız: ${errorMessage(r.error)}`);
      continue;
    }
    const j = tryExtractJson<{ ranking?: string[]; scores?: Record<string, number>; issues?: Record<string, Array<{ text?: string; blocking?: boolean } | string>> }>(r.value.content);
    if (!j) continue;
    const toId = (label: string) => byLabel.get(String(label).trim().toUpperCase().replace(/[^A-J]/g, ''))?.id;
    const ranking = (j.ranking ?? []).map(toId).filter((x): x is string => !!x);
    const scores: Record<string, number> = {};
    for (const [k, v] of Object.entries(j.scores ?? {})) {
      const id = toId(k);
      if (id) scores[id] = Math.max(0, Math.min(10, Number(v) || 0));
    }
    const issues: Review['issues'] = {};
    for (const [k, list] of Object.entries(j.issues ?? {})) {
      const id = toId(k);
      if (!id || !Array.isArray(list)) continue;
      issues[id] = list.map((x) => (typeof x === 'string' ? { text: x, blocking: false } : { text: x.text ?? '', blocking: !!x.blocking })).filter((x) => x.text);
    }
    reviews.push({ reviewer: r.value.model, ranking, scores, issues });
  }

  // aggregate: verify evidence (0..10 scaled ×2) + Borda points + mean score
  const n = candidates.length;
  const points = new Map<string, number>(candidates.map((c) => [c.id, 0]));
  for (const c of candidates) {
    if (c.verifyScore !== undefined) points.set(c.id, points.get(c.id)! + c.verifyScore * 20 + (c.verifyOk ? 5 : 0));
    if (!c.diff.trim()) points.set(c.id, points.get(c.id)! - 50);
  }
  for (const rv of reviews) {
    rv.ranking.forEach((id, i) => points.set(id, (points.get(id) ?? 0) + (n - i)));
    for (const [id, s] of Object.entries(rv.scores)) points.set(id, (points.get(id) ?? 0) + s / 2);
    for (const [id, list] of Object.entries(rv.issues)) points.set(id, (points.get(id) ?? 0) - 3 * list.filter((x) => x.blocking).length);
  }
  const ranking = candidates
    .map((c) => ({ id: c.id, author: c.author, points: Math.round(points.get(c.id)! * 10) / 10, verifyScore: c.verifyScore }))
    .sort((a, b) => b.points - a.points);
  const winner = candidates.find((c) => c.id === ranking[0]?.id);
  const winnerIssues = winner
    ? reviews.flatMap((rv) => (rv.issues[winner.id] ?? []).map((i) => ({ reviewer: rv.reviewer, text: i.text, blocking: i.blocking })))
    : [];
  return { winner, ranking, reviews, winnerIssues };
}

/** Council Q&A over the project (kurultay ask): N answers → anonymous peer ranking → chairman. */
export async function councilAnswer(router: Router, question: string, context: string, opts: { members: number; contextTokens: number; bus?: EventBus; signal?: AbortSignal; language: string }): Promise<{ answer: string; members: string[]; chair?: string }> {
  const members = router.pick('reviewer', Math.max(1, opts.members));
  const prompt = `Answer the question about this software project using the project context. Be specific, cite file paths. Answer in ${opts.language}.\n\n${truncateTokens(context, opts.contextTokens)}\n\n# QUESTION\n${question}`;
  const res = await settle(members.map((m) => router.chat({ messages: [{ role: 'user', content: prompt }], temperature: 0.2, maxTokens: 2500, purpose: 'ask', signal: opts.signal }, { prefer: [m.caps.key], role: 'reviewer' })));
  const answers = res.filter((r): r is { ok: true; value: Awaited<ReturnType<Router['chat']>> } => r.ok).map((r) => r.value);
  if (!answers.length) throw new Error('Hiçbir model yanıt veremedi');
  if (answers.length === 1) return { answer: answers[0].content, members: [answers[0].model] };
  const labelled = answers.map((a, i) => `<answer id="${LABELS[i]}">\n${truncateTokens(a.content, 1500)}\n</answer>`).join('\n');
  const chair = await router.chat(
    {
      messages: [
        {
          role: 'user',
          content: `You chair a council of experts. Several members answered the question below independently (anonymised). Critically compare them, keep only claims supported by the project context, and write the single best final answer in ${opts.language}. Mention disagreements if they matter.\n\n# QUESTION\n${question}\n\n# PROJECT CONTEXT (abridged)\n${truncateTokens(context, Math.floor(opts.contextTokens / 2))}\n\n${labelled}`,
        },
      ],
      temperature: 0.1,
      maxTokens: 3000,
      purpose: 'ask.chair',
      signal: opts.signal,
    },
    { role: 'judge' },
  );
  return { answer: chair.content, members: answers.map((a) => a.model), chair: chair.model };
}
