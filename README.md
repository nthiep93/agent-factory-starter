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

## Việc anh cần làm tay sau khi push lên GitHub

1. `CODEOWNERS` đã trỏ về `@nthiep93`.
2. Bật branch protection cho `main`: bắt buộc PR, bắt buộc check `verify`, bắt buộc review của code owner.
3. Chạy `chmod +x .claude/hooks/*.sh` nếu quyền thực thi bị mất khi giải nén.
4. Mở Claude Code trong repo, chạy `/context` để xác nhận `CLAUDE.md` đã nạp `AGENTS.md`.

## Kiểm tra guardrail

```bash
echo '{"tool_input":{"file_path":"'"$PWD"'/.github/workflows/ci.yml"}}' \
  | CLAUDE_PROJECT_DIR="$PWD" .claude/hooks/protect-files.sh; echo "exit=$?"   # exit=2
```
