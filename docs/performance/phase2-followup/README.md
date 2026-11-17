# Cải tiến tiếp theo — hướng dẫn và hợp đồng

[Báo cáo đo trước–sau](REPORT.md) · [Dữ liệu gốc](results/runs.json) · [Kiểm thử](results/validation.txt)

Đã đạt 257 kiểm thử và kiểm tra Docker. Phép đo chính thức tại máy gồm 24 lượt × khoảng 15 giây, 69.366 request không lỗi, tất cả lượt đối soát đạt. Tải 10 client cùng cặp tài khoản giảm p95 32,51%, tăng thông lượng 41,18%; ở 50 client p95 tăng 18,32%. Xem báo cáo để đọc giới hạn và các cảnh báo dependency hiện có.

## Cài đặt và migration

Yêu cầu Node 24, PostgreSQL và các biến môi trường theo `.env.example`. Chạy tại thư mục repo:

```sh
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm run start:prod
```

Migration `20261117000000_cash_idempotency` thêm cột nullable và unique index `(account_id, idempotency_key)` trên `financial_transactions`. Chạy migration trước mã mới. Bản ghi cũ có key NULL; nhiều NULL vẫn được chấp nhận. Cần dự trù thời gian khóa khi tạo index trên bảng lớn; chưa triển khai migration online cho môi trường production đang có tải. Không có thao tác xóa dữ liệu cũ.

## Nạp/rút với Idempotency-Key

```http
POST /api/v1/accounts/{accountId}/transactions
Authorization: Bearer <access-token>
Idempotency-Key: cash-operation-unique-0001
Content-Type: application/json

{"type":"CREDIT","amount":"10000","description":"Nap tien"}
```

- Tạo mới: HTTP 201. Gửi lại cùng tài khoản, key và nội dung: HTTP 200, cùng ID và snapshot bút toán ban đầu.
- Thay loại CREDIT/DEBIT, số tiền hoặc mô tả với cùng key: HTTP 409 `IDEMPOTENCY_KEY_REUSED`.
- Key được trim, dài 16–128 ký tự; có header nhưng sai độ dài: HTTP 400 `VALIDATION_ERROR`.
- Phạm vi key là một tài khoản, dùng chung giữa nạp và rút. Cùng key ở tài khoản khác độc lập. Không dùng chung namespace với API chuyển khoản.
- Kiểm tra người sở hữu trước replay. Giao dịch đã hoàn tất vẫn replay được khi tài khoản đóng; giao dịch mới bị từ chối.
- Key được lưu cùng bút toán, không có TTL. Response giao dịch và lịch sử không chứa key.
- Bỏ header giữ hành vi cũ: mỗi request tạo giao dịch mới. Client muốn chống trùng phải tạo key trước lần gửi đầu và giữ nguyên key/nội dung khi thử lại.
- Nếu lỗi nghiệp vụ hoặc rollback, không giữ chỗ key. Nếu mất response sau commit, gửi lại cùng key để lấy kết quả đã lưu; không tự tạo key mới cho cùng thao tác.

Adapter lưu key, số dư và bút toán trong cùng transaction, khóa dòng tài khoản trước đọc key. Unique index bảo vệ thêm tại database. Retry vẫn tối đa một lần khi xác nhận transaction bị hủy; không retry lỗi mạng/commit không rõ kết quả. Response vẫn là schema cũ; thêm trạng thái 200 cho replay và header tùy chọn trong Swagger.

## Telemetry

`MoneyMovementTelemetry` được cung cấp qua DI và có `snapshot()`/`reset()`. Dùng histogram có bucket cố định và counter, không giữ từng request. Mỗi process có bộ số liệu riêng; restart làm mất số liệu. Chưa có exporter hay dashboard tập trung.

| Tên | Ý nghĩa |
|---|---|
| `transaction_start` | Từ gọi `$transaction` tới bắt đầu callback: gồm pool, BEGIN và Prisma |
| `account_lock_query` | Thời gian truy vấn khóa nhìn từ ứng dụng: gồm chờ khóa, SQL và adapter |
| `transaction_callback` | Tổng thời gian callback, gồm đọc/ghi/chờ khóa |
| `transaction_finish` | Từ callback kết thúc tới transaction resolve/reject |
| `transaction_attempt` | Tổng thời gian mỗi lần thử, không tính ngủ giữa hai lần thử |
| `attempts`, `committed`, `rejected`, `retries`, `retry_exhausted` | Các counter; rejected không khẳng định rollback trong lỗi commit không rõ trạng thái |

`scripts/phase2/diagnostic-server.cjs` khởi tạo cùng ứng dụng HTTP qua `createApplication`, bind localhost và nhận lệnh snapshot/reset/close từ parent qua IPC. Không mở endpoint metrics cho người dùng. Các thời gian trên không được diễn giải thành phép đo chính xác riêng pool wait/lock wait; script đo còn lấy mẫu `pg_stat_activity` và chênh lệch `pg_stat_statements` ở server.

## Kiểm thử

Chỉ dùng database riêng có tên kết thúc `_test`. Không chạy kiểm thử hoặc bộ tải trên dữ liệu thật.

```sh
# Đặt DATABASE_URL trỏ đến database *_test trước khi chạy.
npx prisma migrate deploy
OUTPUT=docs/performance/phase2-followup/results node scripts/phase2/verify.cjs
```

Trên PowerShell, dùng `$env:DATABASE_URL='...'` và `$env:OUTPUT='docs/performance/phase2-followup/results'`, sau đó `node scripts/phase2/verify.cjs`. Script kiểm tra đối chiếu giai đoạn 2 cũ cần `.phase2/baseline-dist`; tạo bằng `npm run phase2:baseline` nếu checkout mới chưa có.

## Chạy lại phép đo khóa

1. Bật `shared_preload_libraries='pg_stat_statements'` và restart PostgreSQL dành riêng cho đo; tạo extension trong database test. Tài khoản đo cần quyền đọc thống kê session của API. Không cần bật extension cho ứng dụng thông thường.
2. `npm run build`, rồi `npm run phase2:followup-baseline`. Helper copy cùng cây mã đã compile và chỉ thay use case chuyển khoản bằng nguồn tại commit `8ad478154e3772eb60e08cc8a741b087843dd35f`.
3. Đặt `DATABASE_URL` là database test, `ROUNDS=3`, `DURATION=15`, `OUTPUT` là một thư mục kết quả mới; chạy `npm run phase2:followup-benchmark`.
4. Giữ nguyên `OUTPUT`, chạy `npm run phase2:followup-report`. Để vẽ hình: `pip install -r scripts/phase2/requirements-plot.txt`, rồi `python scripts/phase2/plot.py --results <OUTPUT> --title "SA BankAccount Phase 2 follow-up"`.

Hai bản dùng cùng schema, UoW, telemetry và dependency; chỉ use case chuyển khoản khác. Script ghi hash JS, cấu hình môi trường, SQL thống kê, histogram, trạng thái chờ khóa và đối soát từng lượt. Thứ tự bản đảo giữa các vòng. Không chạy test/build hoặc bộ tải khác đồng thời khi đo. Lỗi được giữ trong dữ liệu, không loại lượt lỗi để chọn mẫu tốt.

Đợt khảo sát đầu tiên được lưu ở `exploratory-sampling-alias/`: alias PostgreSQL không đặt dấu ngoặc kép làm trường `waitingOnLock` trả về sai tên. Các trường lấy mẫu khóa của đợt đó là null và không dùng để diễn giải; số liệu HTTP/telemetry cùng lỗi 503 được giữ nguyên. Bộ đo chính thức sửa alias và kiểm tra dữ liệu lấy mẫu trước ghi.

`exploratory-baseline-setup/` giữ bộ đo đã dừng khi phát hiện helper compile baseline đặt sai đường dẫn `rootDir` và chưa cập nhật bản sao UoW sau build. Đã sửa helper, xác nhận hash use case gốc khớp bản đã compile trước đó và bắt buộc UoW hai bản giống hệt byte trước khi chạy. Không dùng bộ đo gián đoạn này để kết luận.

Tài liệu nền: [PostgreSQL SELECT và khóa dòng](https://www.postgresql.org/docs/16/sql-select.html), [thứ tự lấy khóa](https://www.postgresql.org/docs/16/explicit-locking.html), [pg_stat_statements](https://www.postgresql.org/docs/16/pgstatstatements.html).
