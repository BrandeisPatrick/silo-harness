import type { QuestionAnswer, UserQuestion } from '../../shared/types';
import type { Tool } from './types';

// ask_user, as Claude Code's AskUserQuestion: one to four multiple-choice questions on a card, the run waiting for
// the answers like an approval. "Other" (the user's own words) is always offered by the card, never by the model.
// Offered in every mode, Plan included; it needs no approval.

export const MAX_QUESTIONS = 4;
export const MAX_HEADER = 12;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
/** What the model reads when the user skips the card (Skip or Esc) */
export const SKIPPED = 'The user skipped the question.';
const INTERRUPTED = 'Tool call was interrupted before it produced a result.';
const MAX_OTHER = 2000;

const clean = (v: unknown, max: number): string => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * The questions of an ask_user call, checked. Throws an Error whose message tells the model what to fix. An option
 * the model called "Other" is left out (the card always has one).
 */
export function parseQuestions(args: unknown): UserQuestion[] {
  const raw = args && typeof args === 'object' ? (args as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(raw) || !raw.length) throw new Error('questions must be a list of 1 to 4 questions.');
  if (raw.length > MAX_QUESTIONS) throw new Error(`Ask at most ${MAX_QUESTIONS} questions at a time (got ${raw.length}).`);
  const headers = new Set<string>();
  return raw.map((q, i) => {
    const n = `Question ${i + 1}`;
    if (!q || typeof q !== 'object') throw new Error(`${n} must be an object with question, header, options and multiSelect.`);
    const o = q as Record<string, unknown>;
    const question = clean(o.question, 500);
    if (!question) throw new Error(`${n} has no question text.`);
    const header = clean(o.header, 100);
    if (!header) throw new Error(`${n} has no header (a short label of at most ${MAX_HEADER} characters, such as "Library").`);
    if ([...header].length > MAX_HEADER) throw new Error(`${n}: the header "${header}" is longer than ${MAX_HEADER} characters.`);
    if (headers.has(header.toLowerCase())) throw new Error(`Two questions have the header "${header}"; give each its own.`);
    headers.add(header.toLowerCase());
    if (!Array.isArray(o.options)) throw new Error(`${n} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`);
    const labels = new Set<string>();
    const options: UserQuestion['options'] = [];
    o.options.forEach((p, k) => {
      const po = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      const label = clean(typeof p === 'string' ? p : po.label, 80);
      if (!label) throw new Error(`${n}, option ${k + 1} has no label.`);
      if (/^other$/i.test(label)) return;
      if (labels.has(label.toLowerCase())) throw new Error(`${n} has the option "${label}" twice.`);
      labels.add(label.toLowerCase());
      options.push({ label, description: clean(po.description, 300) });
    });
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      throw new Error(`${n} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options (got ${options.length}); the user can always answer in their own words, so leave "Other" out.`);
    }
    return { question, header, options, multiSelect: o.multiSelect === true || o.multiSelect === 'true' };
  });
}

/**
 * The answers the window sent, made to fit the questions: one per question, only labels the question offers (one for
 * a single-choice question), the typed text cut to a sane length. Anything else in the input is ignored.
 */
export function cleanAnswers(questions: UserQuestion[], input: unknown): QuestionAnswer[] {
  const list = Array.isArray(input) ? input : [];
  return questions.map((q, i) => {
    const raw = (list[i] && typeof list[i] === 'object' ? list[i] : {}) as { selected?: unknown; other?: unknown };
    const wanted = Array.isArray(raw.selected) ? raw.selected.map((s) => String(s)) : [];
    let selected = q.options.map((o) => o.label).filter((l) => wanted.includes(l));
    if (!q.multiSelect) selected = selected.slice(0, 1);
    const other = typeof raw.other === 'string' ? raw.other.trim().slice(0, MAX_OTHER) : '';
    // A single-choice question has one answer: typed text replaces a picked option
    if (!q.multiSelect && other) selected = [];
    return other ? { selected, other } : { selected };
  });
}

/** One answer in words: the labels, then what was typed ("Auth, Search, and in their own words: “…”"). */
export function answerWords(a: QuestionAnswer | undefined): string {
  const picked = a?.selected ?? [];
  const typed = a?.other ? `in their own words: "${a.other}"` : '';
  if (!picked.length) return typed || '(no answer)';
  return typed ? `${picked.join(', ')}, and ${typed}` : picked.join(', ');
}

/** What the model reads: each question's header and the answer, or that the user skipped. */
export function answerText(questions: UserQuestion[], answers: QuestionAnswer[] | null): string {
  if (!answers) return SKIPPED;
  const lines = questions.map((q, i) => `- ${q.header}: ${answerWords(answers[i])}`);
  return `The user answered ${questions.length === 1 ? 'your question' : 'your questions'}:\n${lines.join('\n')}`;
}

export const askUser: Tool = {
  name: 'ask_user',
  description:
    'Ask the user 1–4 multiple-choice questions and wait for the answers. Use it when a choice is genuinely the user\'s: a preference, an unclear requirement, which of several reasonable approaches to take. Not for what you can find out with the other tools, and not to ask permission (actions that need it ask on their own). Each question has a header of at most 12 characters. The user can always answer in their own words, so add no "Other" option. Put a recommended option first and end its label with "(Recommended)". If the user skips, go on with your best judgement and say what you assumed.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The complete question, ending with a question mark' },
            header: { type: 'string', description: 'A chip label of at most 12 characters, e.g. "Library"' },
            options: {
              type: 'array',
              minItems: MIN_OPTIONS,
              maxItems: MAX_OPTIONS,
              items: {
                type: 'object',
                properties: { label: { type: 'string', description: '1–5 words' }, description: { type: 'string', description: 'What choosing it means' } },
                required: ['label', 'description'],
              },
            },
            multiSelect: { type: 'boolean', description: 'true to allow more than one option' },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
        },
      },
    },
    required: ['questions'],
  },
  async run(args, ctx) {
    const questions = parseQuestions(args);
    if (!ctx.askUser) throw new Error('Questions cannot be asked in this session; go on with your best judgement.');
    const answers = await ctx.askUser(questions);
    if (ctx.signal?.aborted) return { content: INTERRUPTED };
    return { content: answerText(questions, answers) };
  },
};
