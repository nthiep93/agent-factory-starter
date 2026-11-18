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
