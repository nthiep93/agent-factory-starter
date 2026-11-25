// Reads the Dependencies section that taskToIssue writes into issue bodies.
// Bodies are untrusted (anyone who can edit the issue can change them), so
// matching is strict and only ever yields numbers or task ids.

const LINKED = /^[-*] Depends on #([1-9]\d*)\b/i;
const UNLINKED = /^[-*] Depends on (T\d+) \(no issue yet/i;

const lines = (body: string): string[] => String(body ?? "").split(/\r?\n/);

/** Issue numbers from `- Depends on #N` bullet lines, deduped, in first-seen order. */
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
