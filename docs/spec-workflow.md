# Spec workflow: từ feature lớn đến agent PR

Pha 3 của software factory. Một feature lớn được viết thành spec, chia thành các task nhỏ có thứ tự, mỗi task thành một GitHub issue theo form **Agent task**, rồi agent làm từng issue thành PR. Sau đó đo xem agent PR chạy tốt đến đâu.

```
/write-spec "<feature>"           spec.md + plan.md + tasks.md trong specs/<NNN>-<slug>/
        |
node scripts/spec-to-issues.mjs   dry run: validate + in ra các issue theo thứ tự
        |
... --create                      gh issue create theo thứ tự dependency
        |
label `agent`                     workflow "Claude agent" chạy, push nhánh claude/...
        |
agent PR -> review -> merge
        |
node scripts/factory-metrics.mjs  merge rate, rework rate, thời gian merge / review
```

## Luồng làm việc

1. **Spec.** Trong Claude Code: `/write-spec thêm endpoint GET /time và hiển thị clock drift`. Skill hỏi nhanh tối đa 5 câu, rồi viết `specs/<NNN>-<slug>/`:
   - `spec.md`: problem, users, acceptance criteria đánh số, edge cases, out of scope, risk.
   - `plan.md`: approach, file theo từng app, contract (type và function) đặt trong `packages/shared`.
   - `tasks.md`: danh sách task theo format bên dưới.

   Skill kết thúc bằng việc chạy validator ở chế độ dry run và sửa cho đến khi hết lỗi.

2. **Review spec.** Anh đọc lại cả ba file. Đây là chỗ rẻ nhất để sửa hiểu lầm. Commit spec qua PR như code bình thường.
3. **Dry run.** `node scripts/spec-to-issues.mjs specs/001-time-endpoint` in ra từng issue (thứ tự, title, labels, body). `#1..#N` trong dry run là số giả, đứng thay cho số issue thật.
4. **Tạo issue.** `node scripts/spec-to-issues.mjs specs/001-time-endpoint --create` gọi `gh issue create` theo thứ tự dependency, lấy số issue thật từ URL mà `gh` in ra và dùng nó cho dòng `Depends on #N` của các task sau. Label còn thiếu (`risk:*`, `agent`) được tạo trước.
5. **Label `agent`.** Issue có label `agent` sẽ kích hoạt workflow `Claude agent` (xem `.github/workflows/claude.yml`). Script chỉ gắn `agent` khi task sẵn sàng: risk không phải `high` VÀ mọi dependency đã có issue. Task `risk: high` không bao giờ được gắn `agent`.
6. **Agent PR.** Agent push nhánh `claude/...`, anh mở PR, CI `verify` và `Claude review` chạy, anh review rồi merge.
7. **Đo.** `node scripts/factory-metrics.mjs` định kỳ, xem phần định nghĩa bên dưới.

> **Lưu ý về thứ tự.** Khi `--create` chạy một lượt, dependency luôn được tạo trước, nên mọi task không phải `high` đều nhận `agent` ngay. GitHub sẽ chạy agent cho T2 song song với T1, trước khi code của T1 được merge. Với chuỗi task phụ thuộc chặt (T2 cần code của T1), hãy gỡ label `agent` khỏi task sau ngay khi tạo xong, và gắn lại khi PR của dependency đã merge.

## Format `tasks.md`

```markdown
# Tasks: 001 server time endpoint

## T1: Add TimeResponse and buildTime to packages/shared

goal: Give both apps one definition of the time payload.
area: shared
risk: low
depends: none
in-scope: packages/shared/src/time.ts and its export
out-of-scope: apps/api, apps/web
Acceptance:

- buildTime(new Date(0)) returns { iso: "1970-01-01T00:00:00.000Z", epochMs: 0 }
- buildTime(new Date(NaN)) throws a RangeError

## T2: Expose GET /time in the API

goal: Serve the current server time.
area: api
risk: low
depends: T1
Acceptance:

- GET /time returns 200 with { iso, epochMs }
```

| Thành phần         | Quy tắc                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `## T<n>: <title>` | Một heading cho mỗi task. Id là `T` + số, không trùng. Title thành issue title `[agent] <title>`.     |
| `goal:`            | Bắt buộc. Một hai câu: thay đổi gì, vì sao. Thành mục **Goal** của issue.                             |
| `area:`            | Bắt buộc: `api` \| `web` \| `shared` \| `docs` \| `infra`.                                            |
| `risk:`            | Bắt buộc: `low` \| `medium` \| `high`. Thành label `risk:<level>` và mục **Risk**.                    |
| `depends:`         | Bắt buộc: `none` hoặc danh sách id cách nhau bằng dấu phẩy (`T1, T2`).                                |
| `in-scope:`        | Tuỳ chọn. Ghép sau đường dẫn của area trong mục **In scope / out of scope**.                          |
| `out-of-scope:`    | Tuỳ chọn. Mặc định: "anything not needed for the acceptance criteria above".                          |
| `Acceptance:`      | Một dòng riêng, theo sau là các bullet `- ` (ít nhất một). Dòng thụt 2 dấu cách nối vào bullet trước. |

- Key không phân biệt hoa thường, mỗi key một dòng, không có key nào khác.
- Text trước heading `##` đầu tiên bị bỏ qua. Bên trong task chỉ được có key, bullet và dòng trống. Dòng trống đặt ở đâu cũng được (Prettier tự chèn dòng trống sau heading và sau `Acceptance:`).
- Parser (`parseTasks`) không bao giờ throw: mọi lỗi thành `{ line, message }`.
- Validator (`validateTasks`) báo: id trùng, dependency không tồn tại, dependency cycle, acceptance rỗng, area hoặc risk không hợp lệ.
- `orderTasks` trả về thứ tự topological, ổn định: khi nhiều task cùng sẵn sàng, task đứng trước trong file đi trước.

Body issue (`taskToIssue`) có đúng các mục của form Agent task: **Goal**, **Acceptance criteria**, **In scope / out of scope**, **Risk**, cộng thêm **Spec** (link tương đối tới `spec.md`, `plan.md`, `tasks.md`) và **Dependencies** (`Depends on #N (T1)`). Dòng đầu là comment `<!-- factory-task: specs/<dir>/tasks.md#T1 -->` để truy ngược.

Code nằm ở `packages/factory/src/spec/`, script ở `scripts/spec-to-issues.mjs`.

## Metrics

`computeFactoryMetrics(prs, now?, { sinceDays?, botLogins? })` trong `packages/factory/src/metrics/`. Input là output của `gh pr list --json` với các field `number, headRefName, state, createdAt, mergedAt, closedAt, author, commits, reviews, labels, additions, deletions`.

Chỉ tính **agent PR**: head branch bắt đầu bằng `claude/` (workflow GitHub) hoặc `agent/` (chạy local).

| Metric               | Định nghĩa                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| total                | Số agent PR (trong cửa sổ `--days` tính theo `createdAt`, nếu có).                                                |
| merged               | `state == MERGED` hoặc có `mergedAt`.                                                                             |
| closed unmerged      | `state == CLOSED` và không có `mergedAt`.                                                                         |
| open                 | Phần còn lại.                                                                                                     |
| merge rate           | `merged / (merged + closed unmerged)`. PR đang mở không tính. `n/a` khi chưa có PR nào kết thúc.                  |
| rework rate          | `reworked / merged`, xem định nghĩa rework bên dưới.                                                              |
| time to merge        | `mergedAt - createdAt`, median và p90.                                                                            |
| time to first review | `submittedAt` của review đầu tiên (bỏ `PENDING`) trừ `createdAt`, median.                                         |
| by risk              | Các số trên tách theo label `risk:low/medium/high`; PR có nhiều label lấy mức cao nhất; không có thì `unlabeled`. |

**Rework**: một agent PR đã merge được tính là rework khi bản agent nộp lần đầu không phải bản được merge, tức là có ít nhất một trong ba dấu hiệu:

1. Có review với state `CHANGES_REQUESTED`.
2. Có commit với `committedDate` sau review đầu tiên (sửa theo review, dù người hay agent sửa).
3. Với nhánh `claude/`: có commit mà mọi author đều là người (người tự push bản sửa). Author là bot khi `login` rỗng (GitHub App không có user), kết thúc bằng `[bot]`, hoặc nằm trong danh sách bot (`claude`, `github-actions`, `dependabot`, `copilot-swe-agent`, cộng `botLogins`). Commit của bot có `Co-authored-by` người vẫn là commit bot. Quy tắc này không áp dụng cho nhánh `agent/`, vì runner local commit bằng git identity của chính anh.

Median là giá trị giữa (trung bình hai giá trị giữa khi số phần tử chẵn). p90 dùng nearest-rank: giá trị nhỏ nhất mà ít nhất 90% giá trị nhỏ hơn hoặc bằng nó.

## Lệnh

```bash
pnpm build --filter @repo/factory                               # script dùng bản compiled trong dist/
node scripts/spec-to-issues.mjs specs/001-time-endpoint         # dry run, exit 1 nếu tasks.md sai
node scripts/spec-to-issues.mjs specs/001-time-endpoint --create
node scripts/factory-metrics.mjs                                # gh pr list --state all --limit 200
node scripts/factory-metrics.mjs --days 30
node scripts/factory-metrics.mjs --input prs.json --json        # file đã lưu, in JSON thô
node scripts/factory-metrics.mjs --input prs.json --days 7 --now 2026-11-25T00:00:00Z
gh pr list --state all --limit 200 --json number,headRefName,state,createdAt,mergedAt,closedAt,author,commits,reviews,labels,additions,deletions > prs.json
```

`spec-to-issues.mjs` exit `1` khi validate lỗi (in `tasks.md:<line>: <message>`) hoặc `gh` lỗi (in các issue đã tạo được), exit `2` khi sai tham số. Test end to end của hai script dùng một `gh` giả đặt đầu `PATH`, không gọi GitHub thật.

Ví dụ đầy đủ: `specs/001-time-endpoint/`.
