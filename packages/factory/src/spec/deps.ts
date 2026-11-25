// Reads the Dependencies section that taskToIssue writes into issue bodies.
// Bodies are untrusted (anyone who can edit the issue can change them), so
// matching is strict and only ever yields numbers or task ids.

const LINKED = /^[-*] Depends on #([1-9]\d*)\b/i;
const UNLINKED = /^[-*] Depends on (T\d+) \(no issue yet/i;

const SECTION = /^### Dependencies\s*$/;
const NEXT_SECTION = /^### /;

/**
 * Lines of the first `### Dependencies` section, up to the next `### ` heading.
 * Lines elsewhere (for example an acceptance bullet that starts with
 * "Depends on #5") are ignored.
 */
const lines = (body: string): string[] => {
  const all = String(body ?? "").split(/\r?\n/);
  const start = all.findIndex((line) => SECTION.test(line));
  if (start === -1) return [];
  const rest = all.slice(start + 1);
  const end = rest.findIndex((line) => NEXT_SECTION.test(line));
  return end === -1 ? rest : rest.slice(0, end);
};

/** Issue numbers from `- Depends on #N` bullets in the Dependencies section, deduped, in first-seen order. */
export function parseDependencyRefs(body: string): number[] {
  const refs: number[] = [];
  for (const line of lines(body)) {
    const match = LINKED.exec(line);
    const ref = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(ref) && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** Task ids listed as `- Depends on T3 (no issue yet...)`: the task cannot be unblocked yet. */
export function parseUnlinkedDependencies(body: string): string[] {
  const ids: string[] = [];
  for (const line of lines(body)) {
    const id = UNLINKED.exec(line)?.[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
