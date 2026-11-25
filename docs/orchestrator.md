# Orchestrator (Phase 4)

`apps/orchestrator` là một NestJS service biến GitHub issue thành pull request mà không cần người ngồi trước terminal: nhận webhook từ GitHub, đưa task vào BullMQ queue, chạy Claude Agent SDK trong một git worktree riêng cho mỗi issue, tự chạy lại `pnpm verify`, rồi push branch và mở PR.

Đây là phiên bản tự động của `scripts/worktree.sh` + `scripts/agent-run.sh` (Phase 1) và là phương án self-hosted thay cho `.github/workflows/claude.yml` (Phase 2).

## Kiến trúc

```
GitHub (issue được gắn label "agent")
   |
   |  POST /webhooks/github   (X-Hub-Signature-256 = HMAC-SHA256 của raw body)
   v
+----------------------------- apps/orchestrator (NestJS) ------------------------------+
|                                                                                       |
|  WebhooksController -> WebhooksService                                                |
|     verify signature (timingSafeEqual) -> lọc event/action/label                      |
|     -> TaskQueue.enqueue({ issueNumber, title, body, labels, deliveryId })            |
|        jobId = issue-<n>  (đang chờ/đang chạy => deduplicated)                        |
|                         |                                                             |
|                         v                                                             |
|                  Redis (BullMQ queue "agent-tasks", attempts = 1)                     |
|                         |                                                             |
|                         v                                                             |
|  TaskProcessor (WorkerHost, concurrency = AGENT_CONCURRENCY) -> TaskPipeline          |
|     1. GitHubClient.commentOnIssue("picked up")                                       |
|     2. Workspace.prepare(n): kiểm tra hooks/config của REPO_DIR, git fetch,           |
|        git worktree add -B agent/issue-<n> ... origin/main, sparse-checkout bỏ        |
|        holdout/, pnpm install --frozen-lockfile                                       |
|     3. AgentRunner.run(): Claude Agent SDK query() trong worktree                     |
|     4. Kiểm tra: tree sạch (dirty_tree), không đụng path protected                    |
|        (protected_paths), không đổi config của verify (verify_config_changed),       |
|        có commit (no_commits)                                                         |
|     5. Workspace.verify(): orchestrator tự chạy pnpm verify (verify_failed)           |
|     6. push -> createPullRequest ("Closes #n") -> comment link (pr_opened);           |
|        422 "already exists" -> link PR đang mở (pr_updated)                           |
|        bị chặn ở bước 4/5: comment lý do, không push, giữ branch local               |
|     7. finally: Workspace.cleanup() xoá thư mục worktree                              |
|                                                                                       |
|  GET /runs?limit=20  -> đọc job từ BullMQ (Bearer RUNS_API_TOKEN hoặc chỉ loopback)  |
|  GET /health         -> { status: "ok", service: "orchestrator", uptimeSeconds }      |
+---------------------------------------------------------------------------------------+
```

Mỗi feature một folder trong `apps/orchestrator/src/`:

| Folder       | Nội dung                                                                     |
| ------------ | ---------------------------------------------------------------------------- |
| `config/`    | `loadConfig(env)`: đọc và validate env, báo tất cả lỗi một lần               |
| `webhooks/`  | signature verification, controller, service lọc event                        |
| `tasks/`     | `TaskQueue` port + BullMQ adapter, prompt builder, `TaskPipeline`, processor |
| `agent/`     | `AgentRunner` port + `ClaudeAgentRunner` (Claude Agent SDK)                  |
| `workspace/` | `Workspace` port + `GitWorkspace` (git worktree, pnpm) + `CommandRunner`     |
| `github/`    | `GitHubClient` port + `RestGitHubClient` (REST qua global `fetch`)           |
| `runs/`      | `GET /runs`                                                                  |
| `health/`    | `GET /health`                                                                |
| `testing/`   | fakes của các port, chỉ dùng trong test (không build)                        |

Các port (`AGENT_RUNNER`, `WORKSPACE`, `GITHUB_CLIENT`, `TASK_QUEUE`) là DI token; test thay bằng fake, nên toàn bộ pipeline được test mà không cần GitHub hay Anthropic API.

## Biến môi trường

| Biến                         | Bắt buộc | Mặc định | Ý nghĩa                                                                                                                 |
| ---------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`      | có       |          | Secret đặt khi tạo webhook, dùng để verify `X-Hub-Signature-256`                                                        |
| `GITHUB_TOKEN`               | có       |          | Token để push branch, mở PR, comment. Chỉ orchestrator dùng                                                             |
| `GITHUB_REPOSITORY`          | có       |          | `owner/repo`. Webhook của repo khác bị bỏ qua                                                                           |
| `REDIS_URL`                  | có       |          | `redis://` hoặc `rediss://`                                                                                             |
| `REPO_DIR`                   | có       |          | Đường dẫn tuyệt đối tới một clone có sẵn (remote `origin` trỏ về GitHub)                                                |
| `WORKTREES_DIR`              | có       |          | Đường dẫn tuyệt đối, nơi tạo worktree `issue-<n>` (tự tạo nếu chưa có)                                                  |
| `TRIGGER_LABEL`              | không    | `agent`  | Label kích hoạt agent                                                                                                   |
| `AGENT_MAX_TURNS`            | không    | `40`     | `maxTurns` của SDK                                                                                                      |
| `AGENT_MAX_BUDGET_USD`       | không    | `3`      | `maxBudgetUsd` của SDK, trần chi phí cho một run                                                                        |
| `AGENT_CONCURRENCY`          | không    | `2`      | Số run chạy song song trên một instance                                                                                 |
| `PORT`                       | không    | `3100`   | HTTP port                                                                                                               |
| `ANTHROPIC_API_KEY`          | có       |          | SDK tự đọc. Orchestrator không bao giờ log key này hay bất kỳ token nào                                                 |
| `RUNS_API_TOKEN`             | không    |          | Nếu có: `GET /runs` cần `Authorization: Bearer <token>`. Nếu không: chỉ trả lời request từ loopback                     |
| `AGENT_SUBPROCESS_ENV_SCRUB` | không    | `auto`   | `1`/`0`/`auto`: bật `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` cho agent (cần bubblewrap); `auto` bật khi có `bwrap` trong PATH |

`GITHUB_REPOSITORY` phải khớp `^[\w.-]+/[\w.-]+$`; push luôn đi tới `https://github.com/<owner>/<repo>.git` dựng từ giá trị này, không dùng remote config của clone.

Kết quả của một run (`record.outcome` trong `GET /runs`): `pr_opened`, `pr_updated`, `agent_error`, `dirty_tree`, `protected_paths`, `verify_config_changed`, `no_commits`, `verify_failed`; lỗi bất ngờ làm job `failed` với `failedReason` đã redact.

Config sai thì process dừng ngay khi start với danh sách lỗi đầy đủ (chỉ tên biến, không in giá trị).

## Chạy local

```bash
# 1. Redis
redis-server --port 6379 --daemonize yes

# 2. Một clone riêng cho orchestrator (không dùng checkout bạn đang code)
git clone https://github.com/<owner>/<repo>.git /srv/factory/repo
mkdir -p /srv/factory/worktrees

# 3. Build và chạy
pnpm install
pnpm build --filter orchestrator
GITHUB_WEBHOOK_SECRET=... GITHUB_TOKEN=... GITHUB_REPOSITORY=<owner>/<repo> \
REDIS_URL=redis://localhost:6379 REPO_DIR=/srv/factory/repo WORKTREES_DIR=/srv/factory/worktrees \
ANTHROPIC_API_KEY=... pnpm --filter orchestrator start

curl localhost:3100/health
curl 'localhost:3100/runs?limit=20'
```

`pnpm --filter orchestrator dev` chạy `tsc --watch` + `node --watch` giống `apps/api`.

### Đưa webhook từ GitHub về máy local

GitHub không gọi được `localhost`, cần một tunnel:

- **smee.io**: tạo channel tại https://smee.io, rồi `npx smee-client --url https://smee.io/<channel> --target http://localhost:3100/webhooks/github`. Dùng URL smee làm Payload URL.
- **`gh webhook forward`** (extension `cli/gh-webhook`): `gh webhook forward --repo=<owner>/<repo> --events=issues --url=http://localhost:3100/webhooks/github --secret=$GITHUB_WEBHOOK_SECRET`. Lệnh này tự tạo webhook tạm thời.

Smee và `gh webhook forward` giữ nguyên raw body và header `X-Hub-Signature-256`, nên signature vẫn verify được.

### Tạo webhook trên GitHub

Repo -> Settings -> Webhooks -> Add webhook:

1. **Payload URL**: `https://<host>/webhooks/github` (hoặc URL smee).
2. **Content type**: `application/json` (bắt buộc; body dạng form bị từ chối với 400).
3. **Secret**: đúng giá trị `GITHUB_WEBHOOK_SECRET`.
4. **Which events**: "Let me select individual events" -> chỉ chọn **Issues**.
5. Lưu. GitHub gửi `ping` ngay, orchestrator trả 200; xem ở tab "Recent Deliveries".

Gắn label `agent` vào một issue: response là `202 { "jobId": "issue-<n>", "deduplicated": false }`. Gắn lại khi job đang chờ hoặc đang chạy trả về `deduplicated: true` và không tạo run mới. Gắn lại sau khi run đã xong (completed/failed) sẽ xoá job cũ khỏi queue và chạy lại từ đầu.

## Test

```bash
pnpm --filter orchestrator test                          # test Redis integration bị skip
redis-server --port 6390 --daemonize yes
REDIS_URL=redis://localhost:6390 pnpm --filter orchestrator test
redis-cli -p 6390 shutdown nosave
```

- `workspace/git-workspace.test.ts` dùng git thật: một bare repo làm `origin` và một clone làm `REPO_DIR` trong thư mục tạm; chỉ `pnpm` được stub.
- `app.integration.test.ts` dùng Redis + BullMQ thật với fake ports (`describe.skipIf(!process.env.REDIS_URL)`).
- Không có test nào gọi GitHub hay Anthropic thật; các adapter thật được test qua `fetch` và `query()` được inject.

## Vì sao chạy trên VM / Render / Fly, không phải Vercel

Orchestrator **không** deploy lên Vercel:

- **Worker chạy lâu**: một run có thể mất 10-30 phút (agent + `pnpm install` + `pnpm verify`). Vercel Functions có giới hạn thời gian và không có process sống liên tục để làm BullMQ worker.
- **Git worktree và filesystem**: cần một clone bền vững (`REPO_DIR`), tạo/xoá worktree, cài `node_modules`. Filesystem của serverless là tạm thời và read-only ngoài `/tmp`.
- **Redis connection lâu dài**: BullMQ worker giữ blocking connection tới Redis.
- **Claude Code subprocess**: SDK chạy Claude Code như một child process, cần môi trường Node đầy đủ.

### Docker

`apps/orchestrator/Dockerfile` (build context là root repo, BuildKit đọc `apps/orchestrator/Dockerfile.dockerignore`) cài `git` và `bubblewrap`, chạy bằng user không phải root (`factory`, uid 10001), và dùng volume `/data` cho `REPO_DIR=/data/repo`, `WORKTREES_DIR=/data/worktrees`:

```bash
docker build -f apps/orchestrator/Dockerfile -t agent-factory-orchestrator .
docker run --env-file orchestrator.env -v factory-data:/data -p 3100:3100 agent-factory-orchestrator
```

Dockerfile này chưa được build thử trong môi trường phát triển (không có Docker daemon); hãy build một lần trước khi deploy.

Nên chạy trên VM (systemd), Render "Background Worker"/"Web Service" có persistent disk, hoặc Fly.io Machine có volume, cùng với Redis (managed Redis của Render/Upstash/Fly, hoặc tự host). Một instance là đủ cho phần lớn repo; nếu chạy nhiều instance, mỗi instance cần `REPO_DIR`/`WORKTREES_DIR` riêng.

## Kiểm soát chi phí

- `AGENT_MAX_BUDGET_USD` (mặc định $3) -> `maxBudgetUsd` của SDK: run dừng với subtype `error_max_budget_usd`.
- `AGENT_MAX_TURNS` (mặc định 40) -> `maxTurns`: dừng với `error_max_turns`.
- `attempts: 1` và `maxStalledCount: 0`: không bao giờ tự retry một run, kể cả khi process chết giữa chừng (job chuyển sang failed). Muốn chạy lại thì gỡ và gắn lại label.
- `jobId = issue-<n>`: gắn label nhiều lần không nhân bản run.
- `AGENT_CONCURRENCY` giới hạn số run đồng thời, tức là chi phí tối đa song song = concurrency x budget.
- Cost và số turn của mỗi run nằm trong PR body, trong comment trên issue và trong `GET /runs` (`record.agent.costUsd`).

## Bảo mật

- **Issue text là untrusted.** Ai mở được issue đều viết được title/body. Orchestrator không execute hay parse lệnh từ đó; text chỉ được đưa vào prompt, bọc trong delimiter `<untrusted-issue-<nonce>>` với nonce ngẫu nhiên, kèm chỉ dẫn rằng đó là data chứ không phải instruction. Chuỗi giống delimiter trong issue bị thay thế. Chỉ người có quyền triage/write mới gắn được label, nên label chính là quyết định "cho phép chạy".
- **Webhook được xác thực**: HMAC-SHA256 trên raw body, so sánh bằng `crypto.timingSafeEqual`; thiếu hoặc sai signature -> 401 (kể cả `ping`). Payload không có `repository.full_name` khớp (không phân biệt hoa thường) với `GITHUB_REPOSITORY` bị bỏ qua.
- **Agent không push và không sửa CI.** `ClaudeAgentRunner` dùng `permissionMode: "acceptEdits"`, `settingSources: ["project"]` (nên `CLAUDE.md`, hooks `protect-files.sh` và deny rules trong `.claude/settings.json` vẫn áp dụng), `allowedTools` chỉ gồm `pnpm install --frozen-lockfile`, `pnpm verify|lint|typecheck|test|format`, `git add`, `git commit`; `disallowedTools` chặn `Edit/Write(.github/**)`, `Edit/Write(.claude/**)`, `Read/Edit/Write(holdout/**)`, `Bash(git push *)`, `Bash(gh *)`.
- **Orchestrator giữ GitHub token.** Agent process nhận env đã loại `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `REDIS_URL`, `RUNS_API_TOKEN`. `pnpm install`/`pnpm verify` (chạy code agent vừa viết) còn bị loại thêm `ANTHROPIC_API_KEY`. Token dùng cho `git push` được truyền qua `GIT_CONFIG_*` env (HTTP header), không nằm trong argv hay remote URL. Mọi lệnh chạy bằng `spawn` với mảng argument, không qua shell.
- **Không tin agent**: trước khi push, orchestrator yêu cầu tree sạch (`git status --porcelain` rỗng), liệt kê file thay đổi bằng `git diff --name-only origin/main...HEAD` và từ chối nếu có path dưới `.github/`, `.claude/`, `holdout/` hoặc `AGENTS.md`/`CLAUDE.md` ở bất kỳ cấp nào (`protected_paths`), hoặc file định nghĩa verify: mọi `package.json`, `turbo.json`, `pnpm-workspace.yaml`, `.npmrc`, `eslint.config.*`, `vitest.config.*`, `tsconfig*.json`, `.prettierrc*`, `.prettierignore`, `scripts/` (`verify_config_changed`; task cần thêm dependency vì vậy phải do người làm). Sau đó mới tự chạy `pnpm verify`. PR vẫn cần người review và CI `verify` job trước khi merge.
- **holdout/ không có trên đĩa của agent**: worktree dùng `git sparse-checkout set --no-cone '/*' '!/holdout/'`; file holdout là skip-worktree trong index nên commit của agent (kể cả `git add -A`) không xoá chúng khỏi branch.
- **Git được làm cứng**: mọi lệnh git chạy với `-c core.hooksPath=/dev/null -c core.fsmonitor=`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`; push dùng `--no-verify` tới URL tường minh. `prepare()` và `push()` từ chối chạy nếu `REPO_DIR` có hook thực thi được (không phải `*.sample`) hoặc config `core.hooksPath`, `core.fsmonitor`, `remote.*.pushurl`. Các lệnh thay đổi `REPO_DIR` (fetch, worktree add/remove/prune, sparse-checkout) chạy tuần tự qua một mutex trong process.
- **Redact ở mọi biên**: comment, PR body, giá trị trả về của job, `failedReason`, log và `GET /runs` đều đi qua `redactSecrets`: thay giá trị của `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `RUNS_API_TOKEN`, `ANTHROPIC_API_KEY` và mọi chuỗi dạng `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`, `sk-ant-` bằng `[REDACTED]`.
- **`GET /runs`**: đặt `RUNS_API_TOKEN` trên production. Khi không có token, endpoint chỉ trả lời địa chỉ socket loopback; sau reverse proxy mọi request đều trông như loopback, nên khi đó bắt buộc phải có token.
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`**: Claude Code CLI đi kèm SDK 0.3.332 có biến này; khi bật, subprocess của Bash tool chạy trong sandbox bubblewrap với env đã scrub, và CLI từ chối chạy nếu thiếu bubblewrap. `AGENT_SUBPROCESS_ENV_SCRUB=auto` (mặc định) chỉ bật khi có `bwrap`. Trong container, bubblewrap cần user namespaces; nếu runtime không cho phép, đặt `0`.
- **Giới hạn còn lại (quan trọng)**: agent và `pnpm install`/`pnpm verify` (chạy code agent vừa viết) chạy **cùng user OS** với orchestrator, nên code độc hại có thể đọc `/proc/<pid>/environ` của process orchestrator và lấy `GITHUB_TOKEN`, dù env của child đã được lọc. Trên production bắt buộc:
  1. Chạy worker trong container (hoặc VM) chỉ dành cho việc này, với user không phải root (Dockerfile ở trên), không mount gì ngoài volume `/data`, và token fine-grained chỉ cho repo này.
  2. Tốt hơn nữa: chạy agent và `pnpm verify` dưới một uid khác (ví dụ user `agent` không có quyền đọc `/proc` của uid `factory`, hoặc mount `/proc` với `hidepid=2`), hoặc tách push/PR sang một service khác giữ token. Orchestrator hiện chưa tự làm việc này.
- **Token**: dùng **fine-grained personal access token** (hoặc GitHub App) chỉ cho đúng repo này, với quyền **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write** (Metadata: read là mặc định). Không cấp `workflows`, admin hay quyền trên repo khác. Branch `main` vẫn protected, nên token này không merge được gì nếu không có review.
- Branch push luôn có dạng `agent/issue-<n>` (được kiểm tra trước khi push), dùng `--force-with-lease=refs/heads/<branch>:<sha đã fetch>` để chạy lại một issue có thể thay branch cũ của chính nó (PR đang mở được cập nhật, outcome `pr_updated`), nhưng không đè lên commit mà người khác push sau lần fetch.
