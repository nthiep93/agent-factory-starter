# Spec workflow: từ feature lớn đến agent PR

Pha 3 của software factory. Một feature lớn được viết thành spec, chia thành các task nhỏ có thứ tự, mỗi task thành một GitHub issue theo form **Agent task**, rồi agent làm từng issue thành PR. Sau đó đo xem agent PR chạy tốt đến đâu.

```
/write-spec "<feature>"           spec.md + plan.md + tasks.md trong specs/<NNN>-<slug>/
        |
node scripts/spec-to-issues.mjs   dry run: validate + in ra các issue theo thứ tự
        |
... --create                      gh issue create theo thứ tự dependency
        |
waiting-on-deps -> ready-for-agent workflow "Unblock tasks" khi các dependency đã close
        |
label `agent`                     người gắn; workflow "Claude agent" chạy, push nhánh claude/...
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
4. **Tạo issue.** `node scripts/spec-to-issues.mjs specs/001-time-endpoint --create` gọi `gh issue create` theo thứ tự dependency, lấy số issue thật từ URL mà `gh` in ra và dùng nó cho dòng `Depends on #N` của các task sau. Label còn thiếu (`risk:*`, `agent`, `waiting-on-deps`, `ready-for-agent`) được tạo trước. Chạy lại `--create` an toàn: trước khi tạo mỗi task, script tìm issue (mọi state) có đúng dòng marker ẩn `<!-- factory-task: specs/<dir>/tasks.md#T1 -->` trong body; nếu có thì dùng lại số đó, không tạo trùng và không gắn lại label. Search của GitHub có độ trễ index, nên đừng chạy lại ngay vài giây sau lần đầu.
5. **Label.** Mỗi issue luôn có `risk:<level>`, cộng thêm:
   - `agent`: task `low`/`medium` **không có dependency**. Workflow `Claude agent` (`.github/workflows/claude.yml`) chạy ngay.
   - `waiting-on-deps`: task `low`/`medium` **có dependency**. Mục Dependencies trong body ghi rõ điều kiện mở khoá.
   - Không gì thêm: task `risk: high`. Body ghi rằng người phải tự làm, hoặc chủ động dispatch bằng cách gắn `agent` sau khi review. Không workflow nào tự động mở đường cho task high.
6. **Mở khoá.** Workflow `Unblock tasks` (`.github/workflows/unblock-tasks.yml`) chạy `scripts/unblock-tasks.mjs` khi một issue được close, khi một issue được gắn `waiting-on-deps` (dependency có thể đã close sẵn lúc tạo), hoặc chạy tay qua `workflow_dispatch`. Với mỗi issue open có `waiting-on-deps`:
   - Chỉ xét issue có `risk:low` hoặc `risk:medium`; có `risk:high` hoặc không có risk thì bỏ qua.
   - Chỉ đọc các dòng `- Depends on #N` trong mục `### Dependencies` (đến heading `### ` kế tiếp), không đọc chỗ khác trong body.
   - Một dependency chỉ tính là xong khi nó là issue (URL chứa `/issues/`, không phải PR) và đã close với `stateReason == COMPLETED`. Close dạng `DUPLICATE`, `NOT_PLANNED` hay không có lý do đều không tính.
   - Khi mọi dependency đã xong: gỡ `waiting-on-deps`, gắn `ready-for-agent`, comment "Dependencies #a, #b are closed. Add the `agent` label to start the agent." Issue còn dependency chưa có số (`Depends on T3 (no issue yet...)`) hoặc không có dòng `Depends on #N` nào thì giữ nguyên.
7. **Dispatch.** Anh xem các issue `ready-for-agent` (code nền vừa thay đổi, nên đọc lại spec cho chắc) rồi gắn `agent`.
8. **Agent PR.** Agent push nhánh `claude/...`, anh mở PR, CI `verify` và `Claude review` chạy, anh review rồi merge. Close issue khi merge (ví dụ `Closes #N` trong PR) để các task sau được mở khoá.
9. **Đo.** `node scripts/factory-metrics.mjs` định kỳ, xem phần định nghĩa bên dưới.

> **Vì sao workflow không tự gắn `agent`?** Label gắn bằng `GITHUB_TOKEN` không kích hoạt workflow khác, nên `Unblock tasks` có gắn `agent` thì `claude.yml` cũng không chạy. Hơn nữa, để người dispatch giữ được cổng kiểm soát: mỗi task chỉ chạy khi có người quyết định. Body của issue là dữ liệu không tin cậy: script chỉ đọc số issue từ đó, không bao giờ đưa vào shell.

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
- Validator (`validateTasks`) báo: id trùng, dependency không tồn tại, dependency cycle, acceptance rỗng, area hoặc risk không hợp lệ, và mọi chữ `@claude` trong title, goal, scope hay acceptance. Lý do: `claude.yml` chạy agent ngay khi issue mới có `@claude` trong title hoặc body, bất kể label, nên một mention sẽ vượt qua cổng risk và dependency.
- `orderTasks` trả về thứ tự topological, ổn định: khi nhiều task cùng sẵn sàng, task đứng trước trong file đi trước.

Body issue (`taskToIssue`) có đúng các mục của form Agent task: **Goal**, **Acceptance criteria**, **In scope / out of scope**, **Risk**, cộng thêm **Spec** (link tương đối tới `spec.md`, `plan.md`, `tasks.md`) và **Dependencies** (`Depends on #N (T1)`). Dòng đầu là comment `<!-- factory-task: specs/<dir>/tasks.md#T1 -->` để truy ngược.

Code nằm ở `packages/factory/src/spec/`, script ở `scripts/spec-to-issues.mjs`.

## Metrics

`computeFactoryMetrics(prs, now?, { sinceDays?, botLogins?, issueLabels? })` trong `packages/factory/src/metrics/`. Input là output của `gh pr list --json` với các field `number, headRefName, state, createdAt, mergedAt, closedAt, author, commits, reviews, labels, closingIssuesReferences, additions, deletions`; `issueLabels` là map số issue -> tên label, lấy từ `gh issue list --json number,labels`.

Chỉ tính **agent PR**: head branch bắt đầu bằng `claude/` (workflow GitHub) hoặc `agent/` (chạy local).

| Metric               | Định nghĩa                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| total                | Số agent PR (trong cửa sổ `--days` tính theo `createdAt`, nếu có).                                                                                                                                                                                     |
| merged               | `state == MERGED` hoặc có `mergedAt`.                                                                                                                                                                                                                  |
| closed unmerged      | `state == CLOSED` và không có `mergedAt`.                                                                                                                                                                                                              |
| open                 | Phần còn lại.                                                                                                                                                                                                                                          |
| merge rate           | `merged / (merged + closed unmerged)`. PR đang mở không tính. `n/a` khi chưa có PR nào kết thúc.                                                                                                                                                       |
| rework rate          | `reworked / merged`, xem định nghĩa rework bên dưới.                                                                                                                                                                                                   |
| time to merge        | `mergedAt - createdAt`, median và p90.                                                                                                                                                                                                                 |
| time to first review | `submittedAt` của review đầu tiên trừ `createdAt`, median. Chỉ tính review của người, khác tác giả PR, không `PENDING`.                                                                                                                                |
| by risk              | Risk lấy từ issue gắn với PR (vì label `risk:*` nằm trên issue): `closingIssuesReferences` và số trong tên nhánh `claude/issue-<n>-...` / `agent/issue-<n>`. Nhiều mức thì lấy mức cao nhất. Không có thì dùng label của PR, cuối cùng là `unlabeled`. |

**Rework**: một agent PR đã merge được tính là rework khi bản agent nộp lần đầu không phải bản được merge, tức là có ít nhất một trong ba dấu hiệu. Review của bot và của chính tác giả PR không tính; commit merge (`messageHeadline` bắt đầu bằng `Merge branch `, `Merge remote-tracking branch ` hoặc `Merge pull request `, ví dụ từ nút "Update branch") được bỏ qua.

1. Có review với state `CHANGES_REQUESTED`.
2. Có commit với `committedDate` sau review đầu tiên (sửa theo review, dù người hay agent sửa).
3. Với nhánh `claude/`: có commit mà mọi author đều là người (người tự push bản sửa). Author là bot khi `login` rỗng (GitHub App không có user), kết thúc bằng `[bot]`, hoặc nằm trong danh sách bot (`claude`, `github-actions`, `dependabot`, `copilot-swe-agent`, cộng `botLogins`). Commit của bot có `Co-authored-by` người vẫn là commit bot. Quy tắc này không áp dụng cho nhánh `agent/`, vì runner local commit bằng git identity của chính anh.

Median là giá trị giữa (trung bình hai giá trị giữa khi số phần tử chẵn). p90 dùng nearest-rank: giá trị nhỏ nhất mà ít nhất 90% giá trị nhỏ hơn hoặc bằng nó.

## Lệnh

```bash
pnpm build --filter @repo/factory                               # script dùng bản compiled trong dist/
node scripts/spec-to-issues.mjs specs/001-time-endpoint         # dry run, exit 1 nếu tasks.md sai
node scripts/spec-to-issues.mjs specs/001-time-endpoint --create
node scripts/unblock-tasks.mjs --dry-run                         # xem issue nào sẽ được mở khoá
node scripts/factory-metrics.mjs                                # gh pr list --state all --limit 200 + gh issue list (label)
node scripts/factory-metrics.mjs --days 30                      # thêm --search "created:>=<ngày>" cho gh
node scripts/factory-metrics.mjs --input prs.json --json        # file đã lưu, in JSON thô
node scripts/factory-metrics.mjs --input prs.json --issues issues.json   # risk lấy từ label của issue
node scripts/factory-metrics.mjs --input prs.json --days 7 --now 2026-11-25T00:00:00Z
gh pr list --state all --limit 200 --json number,headRefName,state,createdAt,mergedAt,closedAt,author,commits,reviews,labels,closingIssuesReferences,additions,deletions > prs.json
gh issue list --state all --limit 500 --json number,labels > issues.json
```

Khi `gh` trả về đúng 200 PR (bằng `--limit`), `factory-metrics.mjs` cảnh báo trên stderr vì có thể thiếu PR cũ; hãy thu hẹp `--days`.

`spec-to-issues.mjs` exit `1` khi validate lỗi (in `tasks.md:<line>: <message>`) hoặc `gh` lỗi (in các issue đã tạo được), exit `2` khi sai tham số. `unblock-tasks.mjs` exit `1` nếu có issue không sửa label hoặc comment được (vẫn xử lý các issue khác). Test end to end của các script dùng một `gh` giả đặt đầu `PATH`, không gọi GitHub thật.

Ví dụ đầy đủ: `specs/001-time-endpoint/`.
