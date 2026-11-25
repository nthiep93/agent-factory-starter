import {
  TASK_AREAS,
  TASK_RISKS,
  isTaskArea,
  isTaskRisk,
  type Task,
  type ValidationError,
} from "./types";

// claude.yml starts the agent when a new issue's title or body mentions
// @claude, whatever its labels. A mention would bypass risk and dependency gating.
const AGENT_MENTION = /@claude/i;

const mentionField = (task: Task): string | null => {
  const fields: Array<[string, readonly (string | null)[]]> = [
    ["title", [task.title]],
    ["goal", [task.goal]],
    ["in-scope", [task.inScope]],
    ["out-of-scope", [task.outOfScope]],
    ["acceptance criteria", task.acceptance],
  ];
  const hit = fields.find(([, values]) => values.some((v) => v !== null && AGENT_MENTION.test(v)));
  return hit ? hit[0] : null;
};

/** Index of the first task with each id; later duplicates are not indexed. */
const firstById = (tasks: readonly Task[]): Map<string, Task> => {
  const byId = new Map<string, Task>();
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task);
  return byId;
};

/** Each cycle as a path that starts and ends at its first task in file order. */
function findCycles(tasks: readonly Task[]): Task[][] {
  const byId = firstById(tasks);
  const state = new Map<string, "visiting" | "done">();
  const stack: Task[] = [];
  const cycles: Task[][] = [];

  const visit = (task: Task) => {
    state.set(task.id, "visiting");
    stack.push(task);
    for (const depId of task.depends) {
      const dep = byId.get(depId);
      if (!dep) continue;
      const depState = state.get(dep.id);
      if (depState === "visiting") {
        const start = stack.indexOf(dep);
        cycles.push([...stack.slice(start), dep]);
      } else if (depState === undefined) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(task.id, "done");
  };

  for (const task of byId.values()) if (!state.has(task.id)) visit(task);
  return cycles;
}

/**
 * Checks a parsed task list as a whole: duplicate ids, unknown dependencies,
 * dependency cycles, empty acceptance lists, unknown area or risk values, and
 * "@claude" mentions (they would start the agent when the issue is created).
 * Returns an empty array when the list can be turned into issues.
 */
export function validateTasks(tasks: readonly Task[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const byId = firstById(tasks);

  for (const task of tasks) {
    const first = byId.get(task.id);
    if (first && first !== task) {
      errors.push({
        code: "duplicate-id",
        taskId: task.id,
        line: task.line,
        message: `Duplicate task id ${task.id} (first defined on line ${first.line})`,
      });
    }
    for (const depId of task.depends) {
      if (!byId.has(depId)) {
        errors.push({
          code: "unknown-dependency",
          taskId: task.id,
          line: task.line,
          message: `${task.id} depends on unknown task ${depId}`,
        });
      }
    }
    if (task.acceptance.length === 0) {
      errors.push({
        code: "empty-acceptance",
        taskId: task.id,
        line: task.line,
        message: `${task.id} has no acceptance criteria`,
      });
    }
    if (!isTaskArea(task.area)) {
      errors.push({
        code: "unknown-area",
        taskId: task.id,
        line: task.line,
        message: `${task.id} has unknown area "${task.area}" (allowed: ${TASK_AREAS.join(", ")})`,
      });
    }
    const mention = mentionField(task);
    if (mention) {
      errors.push({
        code: "agent-mention",
        taskId: task.id,
        line: task.line,
        message: `${task.id} mentions "@claude" in its ${mention}: GitHub would start the agent as soon as the issue is created. Remove the mention.`,
      });
    }
    if (!isTaskRisk(task.risk)) {
      errors.push({
        code: "unknown-risk",
        taskId: task.id,
        line: task.line,
        message: `${task.id} has unknown risk "${task.risk}" (allowed: ${TASK_RISKS.join(", ")})`,
      });
    }
  }

  for (const cycle of findCycles(tasks)) {
    // Rotate so the cycle starts at the task that comes first in the file.
    const ring = cycle.slice(0, -1);
    const startIndex = ring.reduce(
      (best, t, i) => (tasks.indexOf(t) < tasks.indexOf(ring[best] ?? t) ? i : best),
      0,
    );
    const rotated = [...ring.slice(startIndex), ...ring.slice(0, startIndex)];
    const head = rotated[0];
    if (!head) continue;
    errors.push({
      code: "dependency-cycle",
      taskId: head.id,
      line: head.line,
      message: `Dependency cycle: ${[...rotated, head].map((t) => t.id).join(" -> ")}`,
    });
  }

  return errors;
}

/**
 * Topological order: every task comes after the tasks it depends on. Stable:
 * whenever several tasks are ready, the one earliest in the file goes first.
 * Unknown dependencies are ignored (validateTasks reports them). Throws on a
 * cycle, so run validateTasks first.
 */
export function orderTasks(tasks: readonly Task[]): Task[] {
  const known = new Set(tasks.map((t) => t.id));
  const placed = new Set<string>();
  const remaining = [...tasks];
  const ordered: Task[] = [];

  while (remaining.length > 0) {
    const index = remaining.findIndex((t) =>
      t.depends.every((dep) => placed.has(dep) || !known.has(dep)),
    );
    if (index === -1) {
      const ids = [...new Set(remaining.map((t) => t.id))].join(", ");
      throw new Error(`Cannot order tasks: dependency cycle among ${ids}`);
    }
    const [next] = remaining.splice(index, 1);
    if (!next) break;
    ordered.push(next);
    placed.add(next.id);
  }
  return ordered;
}
