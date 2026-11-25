import { AREA_PATHS, isTaskArea, isTaskRisk, type Task, type TaskRisk } from "./types";

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

export interface TaskToIssueOptions {
  /** Spec folder relative to the repo root, e.g. `specs/001-time-endpoint`. */
  specDir: string;
  /** Issue numbers of tasks that already exist as GitHub issues. */
  issueNumbersById: Readonly<Record<string, number>>;
}

/** The label that dispatches an issue to the Claude agent workflow. */
export const AGENT_LABEL = "agent";
/** Parks a task until every issue it depends on is closed. */
export const WAITING_LABEL = "waiting-on-deps";
/** Set by the unblock-tasks workflow when all dependencies are closed. */
export const READY_LABEL = "ready-for-agent";

const WAITING_NOTE =
  `Labeled \`${WAITING_LABEL}\`. Once every issue listed above is closed, the unblock-tasks ` +
  `workflow replaces it with \`${READY_LABEL}\`; a maintainer then adds the \`${AGENT_LABEL}\` label ` +
  "to start the agent.";
const HIGH_RISK_NOTE =
  "High risk: a human must implement this task, or explicitly dispatch it by adding the " +
  `\`${AGENT_LABEL}\` label after review. No workflow labels it automatically.`;

/** Same wording as the Risk dropdown in .github/ISSUE_TEMPLATE/agent-task.yml. */
const RISK_TEXT: Readonly<Record<TaskRisk, string>> = {
  low: "Low (tests, docs, small isolated feature)",
  medium: "Medium (touches shared types or several apps)",
  high: "High (auth, data, money, security) - do not label for the agent",
};

const normaliseDir = (dir: string): string =>
  dir
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");

/** Text inside the hidden marker; also the phrase spec-to-issues searches for. */
export const issueMarkerText = (specDir: string, taskId: string): string =>
  `factory-task: ${normaliseDir(specDir)}/tasks.md#${taskId}`;

/**
 * Hidden first line of every task issue. spec-to-issues looks for it before
 * creating an issue, so re-running --create reuses issues instead of duplicating them.
 */
export const issueMarker = (specDir: string, taskId: string): string =>
  `<!-- ${issueMarkerText(specDir, taskId)} -->`;

/**
 * Renders one task as an issue that mirrors the Agent task form. Labels:
 * always `risk:<level>`; plus `agent` for a low/medium task with no
 * dependencies (ready now), or `waiting-on-deps` for a low/medium task with
 * dependencies (the unblock-tasks workflow marks it `ready-for-agent` when
 * they are all closed). High-risk tasks get neither: a human decides.
 */
export function taskToIssue(task: Task, options: TaskToIssueOptions): IssueDraft {
  const dir = normaliseDir(options.specDir);
  const numbers = options.issueNumbersById;
  const hasIssue = (id: string) => Object.prototype.hasOwnProperty.call(numbers, id);

  const areaPath = isTaskArea(task.area) ? AREA_PATHS[task.area] : task.area;
  const inScope = task.inScope ? `\`${areaPath}\` (${task.inScope})` : `\`${areaPath}\``;
  const outOfScope = task.outOfScope ?? "anything not needed for the acceptance criteria above";
  const riskText = isTaskRisk(task.risk) ? RISK_TEXT[task.risk] : task.risk;

  const dispatchable = task.risk === "low" || task.risk === "medium";
  const dispatchLabel = task.depends.length === 0 ? AGENT_LABEL : WAITING_LABEL;
  const note =
    task.risk === "high"
      ? HIGH_RISK_NOTE
      : dispatchable && task.depends.length > 0
        ? WAITING_NOTE
        : null;

  const dependencies =
    task.depends.length === 0
      ? ["None."]
      : task.depends.map((id) =>
          hasIssue(id)
            ? `- Depends on #${numbers[id]} (${id})`
            : `- Depends on ${id} (no issue yet; add the link when it exists)`,
        );

  const body = [
    issueMarker(dir, task.id),
    "",
    "### Goal",
    "",
    task.goal,
    "",
    "### Acceptance criteria",
    "",
    ...task.acceptance.map((item) => `- ${item}`),
    "",
    "### In scope / out of scope",
    "",
    `- In scope: ${inScope}`,
    `- Out of scope: ${outOfScope}`,
    "",
    "### Risk",
    "",
    riskText,
    "",
    "### Spec",
    "",
    `- Spec: [spec.md](${dir}/spec.md)`,
    `- Plan: [plan.md](${dir}/plan.md)`,
    `- Task: ${task.id} in [tasks.md](${dir}/tasks.md)`,
    "",
    "### Dependencies",
    "",
    ...dependencies,
    "",
    ...(note ? [note, ""] : []),
  ].join("\n");

  const labels = [`risk:${task.risk}`, ...(dispatchable ? [dispatchLabel] : [])];

  return { title: `[agent] ${task.title}`, body, labels };
}
