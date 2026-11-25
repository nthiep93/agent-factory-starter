import type { ParseError, ParseResult, Task } from "./types";

const HEADING = /^##(?!#)/;
const TASK_HEADING = /^##\s+(T\d+):\s*(\S.*)$/;
const KEY_LINE = /^([A-Za-z][A-Za-z-]*):(.*)$/;
const BULLET = /^[-*](?:\s+(.*))?$/;
const TASK_ID = /^T\d+$/;

const REQUIRED_KEYS = ["goal", "area", "risk", "depends"] as const;
const VALUE_KEYS = [...REQUIRED_KEYS, "in-scope", "out-of-scope"] as const;
type ValueKey = (typeof VALUE_KEYS)[number];
const ALLOWED_KEYS_TEXT = `${VALUE_KEYS.join(", ")}, Acceptance`;

const isValueKey = (key: string): key is ValueKey =>
  (VALUE_KEYS as readonly string[]).includes(key);

interface Draft {
  id: string;
  title: string;
  line: number;
  values: Partial<Record<ValueKey, string>>;
  depends: string[];
  acceptance: string[];
  inAcceptance: boolean;
  sawAcceptance: boolean;
}

/**
 * Parses the tasks.md format (see docs/spec-workflow.md). Never throws: every
 * problem becomes a line-numbered entry in `errors`. A task missing a required
 * key is dropped; a task with other line-level errors is still returned so the
 * validator can report on it too.
 */
export function parseTasks(markdown: string): ParseResult {
  const tasks: Task[] = [];
  const errors: ParseError[] = [];
  const lines = String(markdown ?? "").split(/\r?\n/);
  let draft: Draft | null = null;
  let skipping = false;

  const fail = (line: number, message: string) => errors.push({ line, message });

  const finish = () => {
    if (!draft) return;
    const missing = REQUIRED_KEYS.filter((key) => draft?.values[key] === undefined);
    if (missing.length > 0) {
      fail(draft.line, `${draft.id} is missing required keys: ${missing.join(", ")}`);
    } else {
      tasks.push({
        id: draft.id,
        title: draft.title,
        goal: draft.values.goal ?? "",
        area: draft.values.area ?? "",
        risk: draft.values.risk ?? "",
        depends: draft.depends,
        inScope: draft.values["in-scope"] ?? null,
        outOfScope: draft.values["out-of-scope"] ?? null,
        acceptance: draft.acceptance,
        line: draft.line,
      });
    }
    draft = null;
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.replace(/\s+$/, "");

    if (HEADING.test(line)) {
      finish();
      const match = TASK_HEADING.exec(line);
      if (!match) {
        fail(lineNo, `Task heading must look like "## T1: Title", got "${line}"`);
        skipping = true;
        return;
      }
      skipping = false;
      draft = {
        id: match[1] ?? "",
        title: (match[2] ?? "").trim(),
        line: lineNo,
        values: {},
        depends: [],
        acceptance: [],
        inAcceptance: false,
        sawAcceptance: false,
      };
      return;
    }

    // Preamble before the first task, and the body of a rejected heading.
    if (!draft || skipping) return;
    const task: Draft = draft;
    if (line.trim() === "") return;

    const bullet = /^\S/.test(line) ? BULLET.exec(line) : null;
    if (bullet) {
      if (!task.inAcceptance) {
        fail(lineNo, `Bullet outside an "Acceptance:" block in ${task.id}`);
        return;
      }
      const text = (bullet[1] ?? "").trim();
      if (text === "") fail(lineNo, `Empty acceptance bullet in ${task.id}`);
      else task.acceptance.push(text);
      return;
    }

    if (/^\s/.test(line) && task.inAcceptance && task.acceptance.length > 0) {
      const last = task.acceptance.length - 1;
      task.acceptance[last] = `${task.acceptance[last]} ${line.trim()}`;
      return;
    }

    const keyMatch = /^\S/.test(line) ? KEY_LINE.exec(line) : null;
    if (!keyMatch) {
      fail(
        lineNo,
        `Expected "key: value", an "Acceptance:" bullet or a blank line in ${task.id}, got "${line.trim()}"`,
      );
      return;
    }

    const key = (keyMatch[1] ?? "").toLowerCase();
    const value = (keyMatch[2] ?? "").trim();
    task.inAcceptance = false;

    if (key === "acceptance") {
      if (task.sawAcceptance) fail(lineNo, `Duplicate key "Acceptance" in ${task.id}`);
      if (value !== "") {
        fail(
          lineNo,
          `"Acceptance:" takes no value in ${task.id}; list criteria as "- " bullets below it`,
        );
      }
      task.sawAcceptance = true;
      task.inAcceptance = true;
      return;
    }

    if (!isValueKey(key)) {
      fail(lineNo, `Unknown key "${keyMatch[1]}" in ${task.id} (allowed: ${ALLOWED_KEYS_TEXT})`);
      return;
    }
    if (task.values[key] !== undefined) {
      fail(lineNo, `Duplicate key "${key}" in ${task.id}`);
      return;
    }
    if (value === "") {
      fail(lineNo, `Key "${key}" in ${task.id} has an empty value`);
      return;
    }

    if (key === "depends") {
      const ids = value.toLowerCase() === "none" ? [] : value.split(",").map((id) => id.trim());
      const bad = ids.filter((id) => !TASK_ID.test(id));
      for (const id of bad) {
        fail(lineNo, `Invalid dependency "${id}" in ${task.id}: use task ids like T2, or "none"`);
      }
      task.depends = ids.filter((id) => TASK_ID.test(id));
    }
    task.values[key] = key === "area" || key === "risk" ? value.toLowerCase() : value;
  });

  finish();
  return { tasks, errors };
}
