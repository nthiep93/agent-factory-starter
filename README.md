# Agent Factory Starter

Monorepo mẫu "sẵn sàng cho agent" (Pha 0 của software factory): Turborepo + pnpm, NestJS 12, Next.js 16, TypeScript 6.

## Chạy thử

```bash
pnpm install
pnpm verify     # lint + typecheck + test, một lệnh trả về đạt hoặc trượt
pnpm build
pnpm --filter api start   # GET http://localhost:3001/health
```

Cần Node 22+, pnpm 10 và `jq` (các hook dùng `jq`).

## Lớp Pha 0 gồm những gì

| File                             | Vai trò                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `AGENTS.md`                      | Chỉ dẫn cho mọi agent: lệnh, bản đồ repo, quy ước, bẫy  |
| `CLAUDE.md`                      | Import `AGENTS.md` cho Claude Code                      |
| `.claude/settings.json`          | Quyền allow / ask / deny và ba hook                     |
| `.claude/hooks/protect-files.sh` | Chặn agent sửa CI, holdout, guardrail, secret, lockfile |
| `.claude/hooks/format-file.sh`   | Format file agent vừa ghi, Prettier ghim phiên bản      |
| `.claude/rules/*.md`             | Quy tắc riêng cho `apps/api` và `apps/web`              |
| `.claude/agents/reviewer.md`     | Subagent review chỉ đọc                                 |
| `.github/workflows/ci.yml`       | CI chạy `format:check`, `verify`, `build`               |
| `.github/CODEOWNERS`             | Bắt buộc người duyệt khi đụng vào guardrail             |
| `holdout/`                       | Chỗ để kịch bản nghiệm thu mà agent không được đọc      |

Hook `Stop` chạy `pnpm typecheck`: agent không thể kết thúc lượt khi typecheck còn lỗi.

## Pha 1: nhiều agent song song, có nhật ký đo được

### Worktree không giẫm cổng

```bash
pnpm wt new auth-login      # .claude/worktrees/auth-login, nhánh wt/auth-login, web 3010 / api 3011
pnpm wt new fix-header      # slot kế tiếp: web 3020 / api 3021
pnpm wt list
cd .claude/worktrees/auth-login && claude     # mỗi worktree một phiên Claude Code
pnpm dev                                      # trong worktree: tự dùng cổng của slot
pnpm wt rm auth-login                         # từ chối nếu còn thay đổi chưa commit
```

Git worktree cách ly file nhưng không cách ly cổng, nên mỗi worktree nhận một slot N (1-9): web `3000+10N`, api `3001+10N`. File trong `.worktreeinclude` (ví dụ `.env`) được chép sang.

### Một task từ mô tả đến nhánh đã push

Trong Claude Code: `/implement-task thêm endpoint GET /version trả commit đang chạy`

Skill này bắt agent viết test trước, chạy `pnpm verify`, gọi subagent `reviewer` soát diff, commit, rồi in link mở PR.

### Chạy headless và ghi nhật ký

```bash
export ANTHROPIC_API_KEY=...        # headless cần API key
pnpm agent:run -w auth-login -b 2 "Implement the login form from docs/specs/login.md"
pnpm agent:label <run-id> success   # hoặc flawed | blocked | manual, kèm ghi chú
pnpm agent:stats                    # tỷ lệ success, verify độc lập, chi phí, thời gian
```

Runner tự chạy `pnpm verify` sau khi agent dừng, vì lời agent tự báo "xong" không phải bằng chứng. Nhật ký nằm ở `.agent-runs/` (gitignored).

Bốn nhãn: `success` (merge được), `flawed` (sai, sửa prompt, `AGENTS.md` hoặc test), `blocked` (thiếu quyền hoặc dịch vụ), `manual` (anh tự làm). Pha 1 xong khi 2-3 phiên song song không đụng nhau và tỷ lệ `success` của việc thường lệ đủ ổn định để không cần ngồi canh.

## Pha 2: agent chạy trên GitHub, giao việc bằng issue

### Luồng làm việc

1. Tạo issue bằng template **Agent task**: ghi mục tiêu, tiêu chí nghiệm thu và mức rủi ro.
2. Đọc lại spec. Khi đủ rõ thì gắn nhãn **`agent`**. Đó là quyết định giao việc của anh.
3. Workflow `Claude agent` chạy: viết test trước, chạy `pnpm verify`, nhờ subagent `reviewer` soát, rồi push nhánh `claude/...` và comment link mở PR. Tiến độ được cập nhật ngay trong comment trên issue.
4. Anh mở PR từ link đó. CI `verify`, preview Vercel và workflow `Claude review` tự chạy.
5. Anh xem preview và review, rồi merge. Production tự deploy.

Ngoài luồng trên, anh có thể gõ `@claude ...` trong bất kỳ issue hay PR nào để hỏi, sửa thêm, hoặc yêu cầu `@claude review again`.

### Cài đặt (làm một lần)

1. Cài Claude GitHub App cho repo: https://github.com/apps/claude
2. Thêm secret: Settings → Secrets and variables → Actions → `ANTHROPIC_API_KEY`
3. Tạo label `agent`: Issues → Labels → New label

### Giới hạn và an toàn

- Chỉ người có quyền write mới kích hoạt được workflow. Bot bị chặn.
- Claude không tự tạo hay merge PR. Nó chỉ push nhánh và đưa link.
- Mỗi lần chạy có giới hạn: agent tối đa 40 turn và 30 phút; review tối đa 20 turn và 15 phút.
- Cả hai workflow tắt auto mode: agent dùng `acceptEdits`, review dùng `default`, nên chỉ những lệnh có trong allow list mới chạy được. Review không có quyền approve, merge hay sửa file; agent không sửa được `.github/`, `.claude/`, `holdout/`.
- Không gắn nhãn `agent` cho việc rủi ro cao (auth, dữ liệu, tiền, bảo mật).
- Trên PR, action lấy `.claude/`, `CLAUDE.md`, `AGENTS.md` từ nhánh gốc, nên PR không tự nới được guardrail của mình. Tuy vậy, `pnpm verify` vẫn chạy `package.json` của PR với API key trong môi trường. Với repo một người thì chấp nhận được; khi mở repo cho người ngoài, cần siết lại.

## Pha 3: việc lớn đi qua spec

```bash
# Trong Claude Code: phỏng vấn ngắn rồi viết specs/<NNN>-<slug>/{spec,plan,tasks}.md
/write-spec thêm endpoint GET /time và hiển thị độ lệch giờ web/api

pnpm build --filter @repo/factory
node scripts/spec-to-issues.mjs specs/001-time-endpoint            # dry run: kiểm tra + in issue
node scripts/spec-to-issues.mjs specs/001-time-endpoint --create   # tạo issue bằng gh
```

- Mỗi task trong `tasks.md` thành một issue theo form **Agent task**. Chạy lại `--create` không tạo trùng, vì script tìm lại issue cũ qua marker ẩn trong nội dung.
- Task không phụ thuộc gì, rủi ro thấp hoặc trung bình, nhận nhãn `agent` và chạy ngay.
- Task có phụ thuộc nhận `waiting-on-deps`. Khi mọi issue phụ thuộc đóng ở trạng thái completed, workflow `unblock-tasks` đổi sang `ready-for-agent` và comment nhắc anh. Anh gắn `agent` để giao việc.
- Task rủi ro cao không bao giờ có đường tự động tới `agent`. Spec nào nhắc `@claude` sẽ bị từ chối, vì `@claude` trong issue mới sẽ tự kích hoạt agent.
- `node scripts/factory-metrics.mjs --days 14`: tỷ lệ merge, tỷ lệ làm lại, thời gian từ lúc tạo tới merge, thời gian tới review đầu tiên của người, phân theo rủi ro.

Chi tiết: [`docs/spec-workflow.md`](docs/spec-workflow.md).

## Pha 4: cổng kiểm chứng nhiều tầng và orchestrator

### Bốn tầng kiểm chứng

1. **Agent tự kiểm:** hook `Stop`, `pnpm verify` trong chính lần chạy.
2. **Reviewer độc lập:** subagent `reviewer` khi chạy local, workflow `Claude review` trên PR.
3. **Check bắt buộc của CI:** `verify` và `holdout`. Holdout là kịch bản nghiệm thu mà agent viết code không đọc được, và trên PR luôn được lấy từ commit gốc.
4. **Người duyệt theo rủi ro:** workflow `pr-risk` gắn `risk:low|medium|high` bằng code lấy từ nhánh gốc.

Auto-merge cho PR `risk:low` từ nhánh `claude/*` **mặc định tắt**. Cách bật nằm trong [`docs/gates.md`](docs/gates.md).

### Orchestrator

`apps/orchestrator` nhận webhook GitHub (có kiểm chữ ký HMAC), xếp việc vào BullMQ và chạy Claude Agent SDK trong worktree riêng có giới hạn turn và ngân sách. Sau đó orchestrator **tự chạy `pnpm verify`**, từ chối các nhánh đụng vào `.github/`, `.claude/`, `holdout/` hoặc cấu hình verify, rồi mới push và mở PR. Service này chạy dài hạn, cần Redis và git, nên phải chạy trên VM, Render hoặc Fly, trong container có user riêng, không đặt trên Vercel. Orchestrator còn ở mức **thử nghiệm**: code mà agent viết vẫn chạy cùng user OS trong lúc verify, nên agent và verify phải chạy trong container dùng một lần cho mỗi run trước khi dùng thật (xem mục "Trust boundary"). Chi tiết: [`docs/orchestrator.md`](docs/orchestrator.md).

## Cấu hình GitHub

- `main` có branch protection: bắt buộc PR và check `verify`.
- Repo một người: đừng bật "Require approvals", vì GitHub không cho tác giả tự duyệt PR của mình. Bật lại cùng "Require review from Code Owners" khi có người thứ hai.
- Chạy `chmod +x .claude/hooks/*.sh scripts/*.sh` nếu quyền thực thi bị mất khi giải nén.
- Mở Claude Code trong repo, chạy `/context` để xác nhận `CLAUDE.md` đã nạp `AGENTS.md`.

## Kiểm tra guardrail

```bash
echo '{"tool_input":{"file_path":"'"$PWD"'/.github/workflows/ci.yml"}}' \
  | CLAUDE_PROJECT_DIR="$PWD" .claude/hooks/protect-files.sh; echo "exit=$?"   # exit=2
```
