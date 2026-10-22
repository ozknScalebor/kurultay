import type { Router } from '../llm/router.js';
import { REVIEW_SCHEMA } from '../llm/schemas.js';
import { errorMessage, settle } from '../util/async.js';
import type { EventBus } from '../util/events.js';
import { truncateTokens, tryExtractJson } from '../util/text.js';

export interface Candidate {
  /** worker id */
  id: string;
  author: string;
  /** every model that wrote part of this candidate (after failovers there can be several) */
  authors?: string[];
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
  /** true when no review came from a model that wrote the reviewed code */
  independent?: boolean;
}

const LABELS = 'ABCDEFGHIJ';

/** Parse "FINAL RANKING:\n1. Candidate B\n2. A" style text (karpathy/llm-council). */
export function parseTextRanking(text: string, n: number): string[] {
  const valid = LABELS.slice(0, Math.max(1, n));
  const idx = text.search(/FINAL RANKING\s*:/i);
  const tail = idx >= 0 ? text.slice(idx) : text;
  const out: string[] = [];
  const numbered = [...tail.matchAll(/^\s*\d+[.)]\s*(?:candidate|response|aday)?\s*["'(<]?([A-J])\b/gim)].map((m) => m[1].toUpperCase());
  const loose = idx >= 0 && !numbered.length ? [...tail.matchAll(/\b(?:candidate|response|aday)\s+([A-J])\b/gi)].map((m) => m[1].toUpperCase()) : [];
  for (const l of numbered.length ? numbered : loose) if (valid.includes(l) && !out.includes(l)) out.push(l);
  return out;
}

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

What counts as an issue (Codex review rubric):
- It is INTRODUCED by the candidate's diff (not pre-existing), discrete and actionable.
- It meaningfully affects correctness, safety, performance or maintainability – no style nits.
- Its impact is provable from the code shown; do not speculate about code you cannot see.
- Give each issue a priority: 0 = must never merge (breaks build/behaviour), 1 = serious bug, 2 = normal, 3 = minor; and a confidence 0.0-1.0.
- Prefer no issues over speculative ones.
${args.reviewRules ? `\nProject review rules (mandatory):\n${args.reviewRules}\n` : ''}
# TASK
${args.task}
${args.acceptance.length ? `\n# ACCEPTANCE CRITERIA\n${args.acceptance.map((a) => `- ${a}`).join('\n')}\n` : ''}
${body}

Return ONLY JSON:
{"ranking": ["best id first", ...], "scores": {"A": 0-10, ...}, "issues": {"A": [{"text": "...", "priority": 0-3, "confidence": 0.0-1.0}], ...}}
If you cannot produce JSON, write your evaluation and end with a line "FINAL RANKING:" followed by a numbered list such as "1. Candidate B".`;

  const authors = [...new Set(candidates.flatMap((c) => [c.author, ...(c.authors ?? [])]).filter(Boolean))];
  // Reviewers must not have written the code they judge. With several candidates the
  // council may fill up with authors (each still reviews anonymously, and other
  // candidates); a single candidate is never reviewed by its own author.
  const outsiders = router.pick('reviewer', args.reviewers, authors);
  let reviewers = outsiders;
  if (reviewers.length < args.reviewers && candidates.length > 1) reviewers = [...reviewers, ...router.pick('reviewer', args.reviewers - reviewers.length, reviewers.map((r) => r.caps.key))];
  if (!reviewers.length) {
    args.bus?.warn('council', `bağımsız gözden geçiren yok: kodu yazan model(ler) (${authors.join(', ')}) dışında kullanılabilir model kalmadı; inceleme atlandı`);
    return { ranking: candidates.map((c) => ({ id: c.id, author: c.author, points: 0, verifyScore: c.verifyScore })), reviews: [], winnerIssues: [], winner: candidates[0], independent: false };
  }
  args.bus?.info('council', `${candidates.length} aday, ${reviewers.length} gözden geçiren: ${reviewers.map((r) => r.caps.key).join(', ')}`);

  const results = await settle(
    reviewers.map((r) => {
      // a non-author reviewer that fails is replaced by another NON-author, never by the author
      const exclude = outsiders.includes(r) ? authors : undefined;
      return router.chat(
        { messages: [{ role: 'user', content: prompt }], temperature: 0, jsonMode: true, jsonSchema: REVIEW_SCHEMA, maxTokens: 2500, purpose: 'council.review', signal: args.signal },
        { prefer: [r.caps.key], role: 'reviewer', exclude },
      );
    }),
  );
  const reviews: Review[] = [];
  for (const [ri, r] of results.entries()) {
    if (!r.ok) {
      args.bus?.warn('council', `inceleme başarısız: ${errorMessage(r.error)}`);
      router.recordOutcome(reviewers[ri].caps.key, 'reviewer', false);
      continue;
    }
    let j = tryExtractJson<{ ranking?: string[]; scores?: Record<string, number>; issues?: Record<string, Array<{ text?: string; blocking?: boolean; priority?: number; confidence?: number } | string>> }>(r.value.content);
    if (j && Array.isArray(j.ranking)) router.recordOutcome(r.value.model, 'reviewer', true);
    else {
      // llm-council fallback: plain-text "FINAL RANKING:" list
      const ranking = parseTextRanking(r.value.content, shuffled.length);
      router.recordOutcome(r.value.model, 'reviewer', ranking.length > 0 ? 0.5 : false);
      if (!ranking.length) continue;
      j = { ranking, scores: {}, issues: {} };
    }
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
      issues[id] = list
        .map((x) =>
          typeof x === 'string'
            ? { text: x, blocking: false }
            : {
                text: `${typeof x.priority === 'number' ? `[P${x.priority}] ` : ''}${x.text ?? ''}`,
                // P0/P1 with reasonable confidence block the merge
                blocking: !!x.blocking || (typeof x.priority === 'number' && x.priority <= 1 && (typeof x.confidence !== 'number' || x.confidence >= 0.5)),
              },
        )
        .filter((x) => x.text.trim());
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
  const authorsOf = (id: string) => {
    const c = candidates.find((x) => x.id === id);
    return c ? [c.author, ...(c.authors ?? [])] : [];
  };
  for (const rv of reviews) {
    // a reviewer never votes for code it wrote itself (its issues still count)
    rv.ranking.filter((id) => !authorsOf(id).includes(rv.reviewer)).forEach((id, i) => points.set(id, (points.get(id) ?? 0) + (n - i)));
    for (const [id, s] of Object.entries(rv.scores)) if (!authorsOf(id).includes(rv.reviewer)) points.set(id, (points.get(id) ?? 0) + s / 2);
    for (const [id, list] of Object.entries(rv.issues)) points.set(id, (points.get(id) ?? 0) - 3 * list.filter((x) => x.blocking).length);
  }
  const ranking = candidates
    .map((c) => ({ id: c.id, author: c.author, points: Math.round(points.get(c.id)! * 10) / 10, verifyScore: c.verifyScore }))
    .sort((a, b) => b.points - a.points);
  const winner = candidates.find((c) => c.id === ranking[0]?.id);
  const winnerIssues = winner
    ? reviews.flatMap((rv) => (rv.issues[winner.id] ?? []).map((i) => ({ reviewer: rv.reviewer, text: i.text, blocking: i.blocking })))
    : [];
  const winnerAuthors = winner ? authorsOf(winner.id) : authors;
  const independent = reviews.length > 0 && reviews.every((rv) => !winnerAuthors.includes(rv.reviewer));
  return { winner, ranking, reviews, winnerIssues, independent };
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
