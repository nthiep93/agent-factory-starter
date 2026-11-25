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
|     2. Workspace.prepare(n): git fetch, git worktree add -B agent/issue-<n>           |
|        WORKTREES_DIR/issue-<n> origin/main, pnpm install --frozen-lockfile            |
|     3. AgentRunner.run(): Claude Agent SDK query() trong worktree                     |
|     4. Workspace.verify(): orchestrator tự chạy pnpm verify (không tin agent)         |
|     5. Workspace.commitsAhead(): đếm commit so với origin/main                        |
|     6. pass + commits > 0: push -> createPullRequest ("Closes #n") -> comment link    |
|        ngược lại: comment lý do, không push, giữ branch local để kiểm tra             |
|     7. finally: Workspace.cleanup() xoá thư mục worktree                              |
|                                                                                       |
|  GET /runs?limit=20  -> đọc job từ BullMQ (waiting, active, completed, failed)        |
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

| Biến                    | Bắt buộc | Mặc định | Ý nghĩa                                                                  |
| ----------------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `GITHUB_WEBHOOK_SECRET` | có       |          | Secret đặt khi tạo webhook, dùng để verify `X-Hub-Signature-256`         |
| `GITHUB_TOKEN`          | có       |          | Token để push branch, mở PR, comment. Chỉ orchestrator dùng              |
| `GITHUB_REPOSITORY`     | có       |          | `owner/repo`. Webhook của repo khác bị bỏ qua                            |
| `REDIS_URL`             | có       |          | `redis://` hoặc `rediss://`                                              |
| `REPO_DIR`              | có       |          | Đường dẫn tuyệt đối tới một clone có sẵn (remote `origin` trỏ về GitHub) |
| `WORKTREES_DIR`         | có       |          | Đường dẫn tuyệt đối, nơi tạo worktree `issue-<n>` (tự tạo nếu chưa có)   |
| `TRIGGER_LABEL`         | không    | `agent`  | Label kích hoạt agent                                                    |
| `AGENT_MAX_TURNS`       | không    | `40`     | `maxTurns` của SDK                                                       |
| `AGENT_MAX_BUDGET_USD`  | không    | `3`      | `maxBudgetUsd` của SDK, trần chi phí cho một run                         |
| `AGENT_CONCURRENCY`     | không    | `2`      | Số run chạy song song trên một instance                                  |
| `PORT`                  | không    | `3100`   | HTTP port                                                                |
| `ANTHROPIC_API_KEY`     | có       |          | SDK tự đọc. Orchestrator không bao giờ log key này hay bất kỳ token nào  |

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
- **Webhook được xác thực**: HMAC-SHA256 trên raw body, so sánh bằng `crypto.timingSafeEqual`; thiếu hoặc sai signature -> 401 (kể cả `ping`). Event của repo khác `GITHUB_REPOSITORY` bị bỏ qua.
- **Agent không push và không sửa CI.** `ClaudeAgentRunner` dùng `permissionMode: "acceptEdits"`, `settingSources: ["project"]` (nên `CLAUDE.md`, hooks `protect-files.sh` và deny rules trong `.claude/settings.json` vẫn áp dụng), `allowedTools` chỉ gồm `pnpm install --frozen-lockfile`, `pnpm verify|lint|typecheck|test|format`, `git add`, `git commit`; `disallowedTools` chặn `Edit/Write(.github/**)`, `Edit/Write(.claude/**)`, `Read/Edit/Write(holdout/**)`, `Bash(git push *)`, `Bash(gh *)`.
- **Orchestrator giữ GitHub token.** Agent process nhận env đã loại `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `REDIS_URL`. `pnpm install`/`pnpm verify` (chạy code agent vừa viết) còn bị loại thêm `ANTHROPIC_API_KEY`. Token dùng cho `git push` được truyền qua `GIT_CONFIG_*` env (HTTP header), không nằm trong argv hay remote URL. Mọi lệnh chạy bằng `spawn` với mảng argument, không qua shell.
- **Không tin agent**: orchestrator tự chạy `pnpm verify` và tự đếm commit trước khi push. PR vẫn cần người review và CI `verify` job trước khi merge.
- **Giới hạn còn lại**: agent và `pnpm verify` chạy cùng user OS với orchestrator, nên về lý thuyết code độc hại vẫn đọc được `/proc/<pid>/environ` của orchestrator. Trên production, chạy orchestrator trong container/VM riêng chỉ dành cho việc này, và tốt hơn nữa là chạy agent/verify dưới một user OS khác hoặc trong sandbox.
- **Token**: dùng **fine-grained personal access token** (hoặc GitHub App) chỉ cho đúng repo này, với quyền **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write** (Metadata: read là mặc định). Không cấp `workflows`, admin hay quyền trên repo khác. Branch `main` vẫn protected, nên token này không merge được gì nếu không có review.
- Branch push luôn có dạng `agent/issue-<n>` (được kiểm tra trước khi push), dùng `--force-with-lease` để chạy lại một issue có thể thay branch cũ của chính nó, nhưng không đè lên commit mà người khác push sau lần fetch.
