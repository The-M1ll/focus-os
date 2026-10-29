import { z } from 'zod';
import { isDayKey } from './time';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);
const dayKeySchema = z.string().refine(isDayKey, 'expected YYYY-MM-DD');
const ms = z.number().int().nonnegative();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const SettingsSchema = z.object({
  id: z.literal('main').default('main'),
  onboarded: z.boolean().default(false),
  displayName: z.string().max(60).default(''),
  timeZone: z.string().default('UTC'),
  resetHour: z.number().int().min(0).max(23).default(4),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  motion: z.enum(['system', 'reduce', 'full']).default('system'),
  homeFocus: z.enum(['plan', 'learn', 'limits']).default('plan'),
  ambient: z.boolean().default(true),
  appEnforcement: z.enum(['close', 'remind', 'off']).default('close'),
  focus: z
    .object({
      focusMin: z.number().int().min(1).max(180).default(25),
      shortBreakMin: z.number().int().min(1).max(60).default(5),
      longBreakMin: z.number().int().min(1).max(90).default(15),
      cyclesBeforeLong: z.number().int().min(2).max(8).default(4),
    })
    .default({ focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLong: 4 }),
  capacityMin: z.number().int().min(15).max(960).default(150),
  newCardsPerDay: z.number().int().min(0).max(100).default(10),
  maxReviewsPerDay: z.number().int().min(5).max(500).default(60),
  wellness: z
    .object({
      eyeRest: z.object({ enabled: z.boolean(), everyMin: z.number().int().min(10).max(120) }).default({ enabled: true, everyMin: 20 }),
      movement: z.object({ enabled: z.boolean(), everyMin: z.number().int().min(20).max(240) }).default({ enabled: false, everyMin: 50 }),
      quiet: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).default({ enabled: true, start: '22:00', end: '07:00' }),
      delivery: z.enum(['in-app', 'system', 'off']).default('in-app'),
    })
    .default({
      eyeRest: { enabled: true, everyMin: 20 },
      movement: { enabled: false, everyMin: 50 },
      quiet: { enabled: true, start: '22:00', end: '07:00' },
      delivery: 'in-app',
    }),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SubjectSchema = z.object({
  id,
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#C8F169'),
  archived: z.boolean().default(false),
  createdAt: ms,
});
export type Subject = z.infer<typeof SubjectSchema>;

export const TopicSchema = z.object({
  id,
  subjectId: id,
  name: z.string().trim().min(1).max(80),
  archived: z.boolean().default(false),
  createdAt: ms,
});
export type Topic = z.infer<typeof TopicSchema>;

export const NoteSchema = z.object({
  id,
  subjectId: id,
  topicId: id.optional(),
  title: z.string().max(120).default(''),
  body: z.string().max(500_000).default(''),
  createdAt: ms,
  updatedAt: ms,
  deletedAt: ms.optional(),
});
export type Note = z.infer<typeof NoteSchema>;

export const SrsSchema = z.object({
  state: z.enum(['new', 'learning', 'review', 'relearning']),
  ease: z.number().min(1.3).max(5),
  interval: z.number().int().min(0).max(365),
  reps: z.number().int().min(0),
  lapses: z.number().int().min(0),
  due: dayKeySchema,
  lastReviewed: dayKeySchema.optional(),
});

export const CardSchema = z.object({
  id,
  subjectId: id,
  topicId: id.optional(),
  front: z.string().trim().min(1).max(4000),
  back: z.string().trim().min(1).max(4000),
  source: z.enum(['manual', 'quiz-mistake']).default('manual'),
  suspended: z.boolean().optional(),
  createdAt: ms,
  srs: SrsSchema,
});
export type Card = z.infer<typeof CardSchema>;

export const ReviewLogSchema = z.object({
  id,
  cardId: id,
  at: ms,
  day: dayKeySchema,
  grade: z.enum(['again', 'hard', 'good', 'easy']),
  intervalBefore: z.number().int().min(0),
  intervalAfter: z.number().int().min(0),
  /** The card had never been reviewed before this answer (counts toward the daily new-card budget). */
  wasNew: z.boolean().default(false),
});
export type ReviewLog = z.infer<typeof ReviewLogSchema>;

const QuestionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mc'), id, prompt: z.string().max(2000), choices: z.array(z.string().max(500)).min(2).max(8), answerIndex: z.number().int().min(0), explanation: z.string().max(2000).optional() }),
  z.object({ type: z.literal('short'), id, prompt: z.string().max(2000), answers: z.array(z.string().max(500)).min(1).max(10), explanation: z.string().max(2000).optional() }),
]);

export const QuizSchema = z.object({
  id,
  subjectId: id,
  topicId: id.optional(),
  title: z.string().trim().min(1).max(120),
  questions: z.array(QuestionSchema).max(200),
  createdAt: ms,
  updatedAt: ms,
});
export type Quiz = z.infer<typeof QuizSchema>;

export const QuizAttemptSchema = z.object({
  id,
  quizId: id,
  at: ms,
  verdicts: z.record(z.string(), z.enum(['correct', 'incorrect', 'close'])),
  correct: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type QuizAttempt = z.infer<typeof QuizAttemptSchema>;

export const TaskSchema = z.object({
  id,
  title: z.string().trim().min(1).max(200),
  subjectId: id.optional(),
  kind: z.enum(['homework', 'study', 'exam-prep', 'other']).default('homework'),
  due: dayKeySchema.optional(),
  plannedDay: dayKeySchema.optional(),
  estimateMin: z.number().int().min(5).max(960).default(30),
  actualMin: z.number().int().min(0).default(0),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  status: z.enum(['todo', 'done', 'dropped']).default('todo'),
  examId: id.optional(),
  notes: z.string().max(4000).optional(),
  createdAt: ms,
  completedAt: ms.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ExamSchema = z.object({
  id,
  subjectId: id.optional(),
  title: z.string().trim().min(1).max(120),
  date: dayKeySchema,
  topicIds: z.array(id).max(100).default([]),
  createdAt: ms,
});
export type Exam = z.infer<typeof ExamSchema>;

const SegmentSchema = z.object({ start: ms, end: ms.nullable() });
export const ActiveTimerSchema = z.object({
  id,
  kind: z.enum(['focus', 'break']),
  plannedMs: z.number().positive(),
  subjectId: id.optional(),
  taskId: id.optional(),
  label: z.string().max(200).optional(),
  status: z.enum(['running', 'paused', 'finished']),
  segments: z.array(SegmentSchema),
  lastHeartbeat: ms,
  pauseReason: z.enum(['user', 'interrupted']).optional(),
  reachedAt: ms.optional(),
});

export const SessionSchema = z.object({
  id,
  kind: z.enum(['focus', 'break']),
  subjectId: id.optional(),
  taskId: id.optional(),
  label: z.string().max(200).optional(),
  plannedMs: z.number().nonnegative(),
  activeMs: z.number().nonnegative(),
  startedAt: ms,
  endedAt: ms,
  segments: z.array(z.object({ start: ms, end: ms })),
  outcome: z.enum(['completed', 'stopped', 'interrupted']),
});

export const PersonalLimitSchema = z.object({
  id,
  platform: z.string().regex(/^[a-z0-9.-]{1,64}$/),
  dailyMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  allowedStart: z.number().int().min(0).max(1439).nullable().default(null),
  allowedEnd: z.number().int().min(1).max(1440).nullable().default(null),
  warnAtPct: z.number().int().min(10).max(100).default(80),
  enabled: z.boolean().default(true),
  pausedUntil: ms.optional(),
  createdAt: ms,
});
export type PersonalLimit = z.infer<typeof PersonalLimitSchema>;

export const CustomPlatformSchema = z.object({
  id: z.string().regex(/^[a-z0-9.-]{1,64}$/),
  name: z.string().trim().min(1).max(40),
  domains: z.array(z.string().regex(/^[a-z0-9.-]{3,100}$/)).min(1).max(10),
});
export type CustomPlatform = z.infer<typeof CustomPlatformSchema>;

export const ManualUsageSchema = z.object({ id, day: dayKeySchema, platform: z.string().regex(/^[a-z0-9.-]{1,64}$/), minutes: z.number().int().min(1).max(1440), at: ms });
export type ManualUsage = z.infer<typeof ManualUsageSchema>;

export const ReminderStateSchema = z.object({
  id: z.literal('state').default('state'),
  lastEyeAt: ms.default(0),
  lastMoveAt: ms.default(0),
  snoozedUntil: ms.default(0),
});
export type ReminderState = z.infer<typeof ReminderStateSchema>;

export const COLLECTIONS = {
  settings: SettingsSchema,
  subjects: SubjectSchema,
  topics: TopicSchema,
  notes: NoteSchema,
  cards: CardSchema,
  reviews: ReviewLogSchema,
  quizzes: QuizSchema,
  attempts: QuizAttemptSchema,
  tasks: TaskSchema,
  exams: ExamSchema,
  timer: ActiveTimerSchema,
  sessions: SessionSchema,
  limits: PersonalLimitSchema,
  platforms: CustomPlatformSchema,
  manual_usage: ManualUsageSchema,
  reminders: ReminderStateSchema,
} as const;
export type CollectionName = keyof typeof COLLECTIONS;
