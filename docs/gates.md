# Cổng kiểm chứng (Pha 4)

Mục tiêu: tin được PR do agent viết nhiều hơn, mà không phải đọc kỹ từng dòng của mọi PR. Mỗi PR đi qua bốn lớp kiểm chứng; mức rủi ro quyết định lớp cuối cùng cần bao nhiêu sức người.

## Bốn lớp kiểm chứng

| Lớp | Ai kiểm                      | Kiểm gì                                                                                                                              | Agent có né được không                                                     |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | Chính agent, trong lượt chạy | `pnpm verify` (lint + typecheck + test), hook `Stop` chạy `pnpm typecheck`                                                           | Có thể "báo xong" sai, nên lớp này chỉ là lọc thô                          |
| 2   | Reviewer độc lập             | Subagent `reviewer` trong lượt chạy, rồi workflow `Claude review` trên PR: đối chiếu diff với yêu cầu, `AGENTS.md`, `.claude/rules/` | Reviewer chỉ comment, không approve hay merge được                         |
| 3   | Required CI checks           | `verify` (format, lint, typecheck, test, build) và `holdout` (kịch bản nghiệm thu chạy trên server thật)                             | Agent không đọc được `holdout/`, nên không thể viết code "cho vừa test"    |
| 4   | Người duyệt theo rủi ro      | Workflow `PR risk` gắn nhãn `risk:low` / `risk:medium` / `risk:high`; người quyết định merge                                         | Bộ phân loại chạy từ commit gốc (base), PR không sửa được nó để tự hạ nhãn |

Cách đọc nhãn ở lớp 4:

- `risk:high`: đọc toàn bộ diff, chạy thử preview. Không bao giờ auto-merge.
- `risk:medium`: đọc diff và review của Claude, xem preview Vercel. Merge tay.
- `risk:low`: chỉ docs/test, nhỏ. Lướt qua là đủ; có thể auto-merge nếu đã bật (xem dưới).

## Quy tắc phân loại rủi ro

Code: `packages/factory/src/risk/classify-risk.ts` (test dạng bảng ở `classify-risk.test.ts`). Input là danh sách file từ REST endpoint "list pull request files" (`filename`, `status`, `additions`, `deletions`, `previous_filename`). Mức của PR là mức cao nhất trong các quy tắc khớp; mọi lý do đều được liệt kê, mức cao trước.

| Mức      | Khi nào                                                                                                                                             | Vì sao                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `high`   | File dưới `.github/`, `.claude/`, `holdout/`; file tên `CODEOWNERS` ở bất kỳ đâu; `AGENTS.md` hoặc `CLAUDE.md` ở root                               | Guardrail của factory: CI, cấu hình agent, kịch bản ẩn  |
| `high`   | `package.json`, `pnpm-workspace.yaml`, `turbo.json` ở root; `eslint.config.*`, `vitest.config.*` ở bất kỳ đâu                                       | Định nghĩa `pnpm verify`; sửa chúng có thể tắt một cổng |
| `high`   | File `.env` / `.env.*` (trừ `.env.example`)                                                                                                         | Có thể chứa secret                                      |
| `high`   | Một từ trong path là `auth`, `oauth`, `security`, `secret(s)`, `payment(s)`, `billing`, `crypto` (tách theo `/ . - _` và camelCase, khớp nguyên từ) | Vùng nhạy cảm. `author` hay `cryptocurrency` không khớp |
| `high`   | Xoá file test (`status: removed`), hoặc đổi tên file test thành file không phải test                                                                | Làm yếu bộ test                                         |
| `high`   | Tổng `additions + deletions` > 800                                                                                                                  | Quá lớn để review đáng tin                              |
| `medium` | Danh sách file rỗng                                                                                                                                 | Không chứng minh được là low                            |
| `medium` | `package.json` của workspace, `pnpm-lock.yaml`                                                                                                      | Đổi dependency                                          |
| `medium` | Source dưới `packages/shared/`                                                                                                                      | Contract dùng chung cho cả hai app                      |
| `medium` | Source khác dưới `apps/` hoặc `packages/`                                                                                                           | Đổi hành vi                                             |
| `medium` | Mọi file không phải docs/test mà các quy tắc trên chưa nhận ra (ví dụ `scripts/`)                                                                   | Mặc định thận trọng                                     |
| `medium` | Chỉ docs/test nhưng tổng > 300 dòng                                                                                                                 | Lớn hơn mức "lướt qua"                                  |
| `low`    | Mọi file là docs (`*.md`, `*.mdx`, `docs/**`, `specs/**`) hoặc test (`*.test.ts`, `*.test.tsx`, ...) đang thêm/sửa, tổng <= 300 dòng                | Không đổi hành vi chạy                                  |

Một rename được xét cả path cũ lẫn path mới, nên chuyển file ra khỏi `holdout/` vẫn là `high`.

Chạy tay:

```bash
pnpm build --filter @repo/factory
gh api --paginate --slurp repos/OWNER/REPO/pulls/123/files | node scripts/classify-pr.mjs
# dòng 1: low | medium | high, các dòng sau: lý do
```

### Workflow `PR risk` (`.github/workflows/pr-risk.yml`)

- Trigger `pull_request_target` (không phải `pull_request`): file workflow luôn lấy từ nhánh gốc. Với `pull_request`, PR có thể sửa chính workflow để tự gắn nhãn low.
- Checkout `github.event.pull_request.base.sha`, build `@repo/factory`, rồi chỉ đọc PR qua API (`gh api --paginate --slurp .../pulls/<n>/files`). Không bao giờ checkout hay chạy code của PR head, vì job có token ghi.
- Gắn đúng một nhãn `risk:*`, gỡ hai nhãn kia, tự tạo nhãn còn thiếu (`gh label create --force`). Lý do hiện trong job summary.
- Nếu một lần push mới làm mức không còn là low, job tắt auto-merge đã bật trước đó.
- PR mở lần đầu chứa chính `pr-risk.yml` sẽ không được phân loại: `pull_request_target` chạy bản trên `main`, mà lúc đó chưa có. Từ PR sau mới chạy.

## Holdout: kịch bản nghiệm thu mà agent không thấy

- Nằm trong `holdout/*.test.mjs`, dùng `node:test` và `fetch` có sẵn của Node 22, không dependency.
- Không thuộc pnpm workspace và không nằm trong `pnpm verify`, nên agent chạy verify cũng không thấy gì.
- Agent bị chặn ở ba chỗ: deny `Read`/`Edit` trong `.claude/settings.json`, hook `protect-files.sh`, và `--disallowedTools` trong `claude.yml`.
- CI chạy chúng trong job `holdout` của `ci.yml`: `pnpm build`, bật api (3001), web (3000) và một web thứ hai (3002) trỏ tới API chết, chờ bằng vòng `curl` có giới hạn, rồi `node --test 'holdout/*.test.mjs'`. Lỗi thì in log server.
- Biến môi trường: `API_URL`, `WEB_URL`, `WEB_DEAD_API_URL` (thiếu thì kịch bản "API chết" báo skipped). Cách chạy tay: xem `holdout/README.md`.

Ai được sửa: chỉ người (owner trong `.github/CODEOWNERS`). Trên PR, file holdout lấy từ PR head, nên lớp bảo vệ là: agent không ghi được vào đó, CODEOWNERS bắt review, và mọi thay đổi `holdout/` đều là `risk:high`, không bao giờ auto-merge. Khi thêm tính năng mới, người viết spec viết thêm kịch bản holdout trong một PR riêng do người làm.

## Auto-merge cho PR rủi ro thấp

**Mặc định TẮT.** Job `auto-merge` trong `pr-risk.yml` chỉ chạy khi đủ tất cả:

1. bộ phân loại trả về `low`,
2. repo variable `AUTO_MERGE_LOW_RISK` đúng bằng `true`,
3. nhánh head bắt đầu bằng `claude/` và nằm trong chính repo (không phải fork), PR không ở draft.

Khi đó nó chạy `gh pr merge --auto --merge --match-head-commit <head sha> <n>`. Auto-merge vẫn chờ mọi required check và luật bảo vệ của `main`; nó chỉ bỏ cú click cuối.

### Các bước bật

1. Settings → General → Pull Requests: tick **Allow auto-merge**.
2. Settings → Branches → luật của `main` → Require status checks: thêm **`holdout`** cạnh `verify` (chạy CI ít nhất một lần để GitHub biết tên check).
3. Settings → Secrets and variables → Actions → tab **Variables** → New repository variable: `AUTO_MERGE_LOW_RISK` = `true`.

Tắt lại: xoá variable hoặc đặt khác `true`. PR đang chờ auto-merge có thể tắt bằng `gh pr merge --disable-auto <n>`.

### Giới hạn cần biết

- Merge bằng `GITHUB_TOKEN` không kích hoạt workflow khác (CI không chạy lại trên push vào `main`). Vercel deploy qua GitHub App riêng, nên production vẫn deploy.
- Sau khi auto-merge đã bật, nếu agent push thêm commit làm mức thành medium/high, job `risk` sẽ tắt auto-merge. Job này (khoảng một phút) thường xong trước `verify` + `holdout`, nhưng đó là thời gian, không phải đảm bảo. Muốn chặt hơn: chỉ bật `AUTO_MERGE_LOW_RISK` khi đã quen tỷ lệ đúng của nhãn, hoặc đừng push thêm vào PR đã bật auto-merge.
- Bộ phân loại dựa trên path, không hiểu nội dung. Nó cố ý thận trọng: thứ gì không nhận ra thì ít nhất là `medium`.
