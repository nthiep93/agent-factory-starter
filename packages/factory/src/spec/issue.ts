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

/**
 * Renders one task as an issue that mirrors the Agent task form. The `agent`
 * label is added only when the task is ready to dispatch: its risk is low or
 * medium and every dependency already has an issue number.
 */
export function taskToIssue(task: Task, options: TaskToIssueOptions): IssueDraft {
  const dir = normaliseDir(options.specDir);
  const numbers = options.issueNumbersById;
  const hasIssue = (id: string) => Object.prototype.hasOwnProperty.call(numbers, id);

  const areaPath = isTaskArea(task.area) ? AREA_PATHS[task.area] : task.area;
  const inScope = task.inScope ? `\`${areaPath}\` (${task.inScope})` : `\`${areaPath}\``;
  const outOfScope = task.outOfScope ?? "anything not needed for the acceptance criteria above";
  const riskText = isTaskRisk(task.risk) ? RISK_TEXT[task.risk] : task.risk;

  const dependencies =
    task.depends.length === 0
      ? ["None."]
      : task.depends.map((id) =>
          hasIssue(id)
            ? `- Depends on #${numbers[id]} (${id})`
            : `- Depends on ${id} (no issue yet; add the link when it exists)`,
        );

  const body = [
    `<!-- factory-task: ${dir}/tasks.md#${task.id} -->`,
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
  ].join("\n");

  const ready =
    (task.risk === "low" || task.risk === "medium") && task.depends.every((id) => hasIssue(id));
  const labels = [`risk:${task.risk}`, ...(ready ? [AGENT_LABEL] : [])];

  return { title: `[agent] ${task.title}`, body, labels };
}
