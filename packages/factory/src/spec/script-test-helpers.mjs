// Helpers for the end-to-end tests of scripts/*.mjs. Plain .mjs because the
// package has no @types/node; vitest runs *.test.mjs, tsc and the build skip them.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(here, "..", "..");
export const repoRoot = resolve(packageRoot, "..", "..");

/** Compiles the package into a fresh temp dir so parallel test files never share dist/. */
export function buildFactory() {
  const outDir = mkdtempSync(join(tmpdir(), "factory-dist-"));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(
    process.execPath,
    [tsc, "-p", join(packageRoot, "tsconfig.build.json"), "--outDir", outDir],
    { stdio: "pipe" },
  );
  return outDir;
}

// Fake gh: records each call's args (one per line) and the --body-file content,
// answers `label list` from $FAKE_GH_LABELS, `pr list` from the file $FAKE_GH_PRS,
// `issue list` from the file $FAKE_GH_ISSUES, else the JSON in $FAKE_GH_SEARCH, else
// every issue created so far (marker search), and `issue view <n>` from
// $FAKE_GH_STATES/<n>.json; `issue edit|comment <n>` fails when n = $FAKE_GH_FAIL_EDIT,
// and prints https://github.com/o/r/issues/<n> with n = 101, 102, ...
// $FAKE_GH_FAIL_AT=<n> makes the issue create that would get number n fail.
// Prints every issue created so far as [{ number, body }] (the search result).
const LIST_CREATED = [
  "const fs = require('fs'), path = require('path');",
  "const dir = path.join(process.argv[1], 'created');",
  "const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];",
  "const issues = files.map((f) => ({ number: Number(f.slice(0, -3)), body: fs.readFileSync(path.join(dir, f), 'utf8') }));",
  "process.stdout.write(JSON.stringify(issues));",
].join(" ");

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
d="$FAKE_GH_DIR"
LIST_CREATED="${LIST_CREATED}"
k=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 ))
echo "$k" > "$d/count"
printf '%s\\n' "$@" > "$d/call-$k.args"
prev=""
for a in "$@"; do
  if [ "$prev" = "--body-file" ]; then cp "$a" "$d/call-$k.body"; fi
  prev="$a"
done
case "\${1:-} \${2:-}" in
  "label list") echo "\${FAKE_GH_LABELS:-[]}" ;;
  "label create") ;;
  "pr list") cat "$FAKE_GH_PRS" ;;
  "issue list")
    if [ -n "\${FAKE_GH_ISSUES:-}" ]; then cat "$FAKE_GH_ISSUES"
    elif [ -n "\${FAKE_GH_SEARCH:-}" ]; then echo "$FAKE_GH_SEARCH"
    else node -e "$LIST_CREATED" "$d"
    fi
    ;;
  "issue view")
    f="$FAKE_GH_STATES/\${3:-}.json"
    if [ ! -f "$f" ]; then echo "GraphQL: Could not resolve to an issue (\${3:-})" >&2; exit 1; fi
    cat "$f"
    ;;
  "issue edit" | "issue comment")
    if [ "\${FAKE_GH_FAIL_EDIT:-}" = "\${3:-}" ]; then echo "HTTP 403: forbidden" >&2; exit 1; fi
    ;;
  "issue create")
    n=$(( $(cat "$d/issue" 2>/dev/null || echo 100) + 1 ))
    echo "$n" > "$d/issue"
    if [ "\${FAKE_GH_FAIL_AT:-}" = "$n" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    mkdir -p "$d/created" && cp "$d/call-$k.body" "$d/created/$n.md"
    echo "https://github.com/o/r/issues/$n"
    ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 64 ;;
esac
`;

/** Creates a temp bin dir with the fake gh and a dir where it records calls. */
export function fakeGh() {
  const root = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  mkdirSync(calls);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  return {
    bin,
    calls,
    /** Each recorded call as { args, body } in call order. */
    readCalls() {
      const count = existsSync(join(calls, "count"))
        ? Number(readFileSync(join(calls, "count"), "utf8"))
        : 0;
      return Array.from({ length: count }, (_, i) => {
        const base = join(calls, `call-${i + 1}`);
        const args = readFileSync(`${base}.args`, "utf8").replace(/\n$/, "").split("\n");
        const body = existsSync(`${base}.body`) ? readFileSync(`${base}.body`, "utf8") : null;
        return { args, body };
      });
    },
  };
}

/** Runs a repo script with node and returns { status, stdout, stderr }. */
export function runScript(script, args, { distDir, gh, env = {}, cwd = repoRoot } = {}) {
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FACTORY_DIST_DIR: distDir,
      PATH: gh ? `${gh.bin}:${process.env.PATH}` : process.env.PATH,
      FAKE_GH_DIR: gh ? gh.calls : "",
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Writes a spec folder (spec.md, plan.md, tasks.md) under a new temp dir. */
export function writeSpec(tasksMd, { withPlan = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "spec-"));
  const dir = join(cwd, "specs", "042-demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.md"), "# spec\n");
  if (withPlan) writeFileSync(join(dir, "plan.md"), "# plan\n");
  writeFileSync(join(dir, "tasks.md"), tasksMd);
  return { cwd, rel: "specs/042-demo" };
}
