/** Areas a task may touch. Each maps to one place in the monorepo. */
export const TASK_AREAS = ["api", "web", "shared", "docs", "infra"] as const;
export type TaskArea = (typeof TASK_AREAS)[number];

/** Risk levels, matching the Risk dropdown of the Agent task issue form. */
export const TASK_RISKS = ["low", "medium", "high"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

/** Where each area lives, used for the "In scope" line of an issue. */
export const AREA_PATHS: Readonly<Record<TaskArea, string>> = {
  api: "apps/api",
  web: "apps/web",
  shared: "packages/shared",
  docs: "docs",
  infra: "infrastructure and tooling (scripts, config)",
};

/**
 * One task parsed from tasks.md. `area` and `risk` keep the raw text so that
 * `validateTasks` can report unknown values with their line number.
 */
export interface Task {
  /** `T<number>`, unique within the file. */
  id: string;
  title: string;
  goal: string;
  area: string;
  risk: string;
  /** Ids of tasks that must be done first. Empty for `depends: none`. */
  depends: string[];
  inScope: string | null;
  outOfScope: string | null;
  acceptance: string[];
  /** 1-based line of the `## T1: Title` heading. */
  line: number;
}

export interface ParseError {
  /** 1-based line number in tasks.md. */
  line: number;
  message: string;
}

export interface ParseResult {
  tasks: Task[];
  errors: ParseError[];
}

export type ValidationCode =
  | "duplicate-id"
  | "unknown-dependency"
  | "dependency-cycle"
  | "empty-acceptance"
  | "unknown-area"
  | "unknown-risk"
  | "agent-mention";

export interface ValidationError {
  code: ValidationCode;
  taskId: string;
  /** Line of the offending task's heading. */
  line: number;
  message: string;
}

export const isTaskArea = (value: string): value is TaskArea =>
  (TASK_AREAS as readonly string[]).includes(value);

export const isTaskRisk = (value: string): value is TaskRisk =>
  (TASK_RISKS as readonly string[]).includes(value);
