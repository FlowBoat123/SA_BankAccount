# Chạy lại đánh giá giai đoạn 2

Các cải tiến tập trung vào chuyển khoản, idempotency và lịch sử dùng cursor. Xem [báo cáo thực nghiệm](REPORT.md). Kết quả lưu kèm là đo tại Windows + Docker, chưa phải Kaggle.

## Chuẩn bị tại máy

Yêu cầu Node.js 24 LTS, Git, Docker. Dùng PostgreSQL 15.19 và một database riêng có tên kết thúc bằng `_test`. Không trỏ các script vào database thật. Ví dụ PowerShell:

```powershell
docker run --name sa-bank-phase2-pg -e POSTGRES_USER=phase2 -e POSTGRES_PASSWORD=phase2-local-only -e POSTGRES_DB=bank_phase2_test -p 127.0.0.1:55432:5432 -d postgres:15.19
$env:DATABASE_URL='postgresql://phase2:phase2-local-only@localhost:55432/bank_phase2_test'
npm.cmd ci
node node_modules/prisma/build/index.js generate
node node_modules/prisma/build/index.js migrate deploy
npm.cmd run phase2:baseline
npm.cmd run build
node scripts/phase2/verify.cjs
npm.cmd run phase2:benchmark
npm.cmd run phase2:report
```

Nếu container đã có, dùng `docker start sa-bank-phase2-pg`. Script benchmark không tự migrate; chờ PostgreSQL sẵn sàng và chạy migrate trước. Dừng container khi xong bằng `docker stop sa-bank-phase2-pg`.

`prepare-baseline.cjs` tạo detached worktree ở commit `c347c921d77ba533cfacd8e180feccef720be013`, dùng cùng dependencies đã cài và lưu bản build vào `.phase2/baseline-dist`. Cần chạy trong Git checkout. Cả hai bản phải dùng cùng package-lock và Prisma Client. Không chạy test, build, hoặc tác vụ nặng trong lúc benchmark.

Biến cấu hình benchmark: `DURATION` (mặc định 10 giây), `ROUNDS` (3), `HISTORY_SIZE` (300000), `BASELINE_DIST`, `OUTPUT`. Có thể đặt `DURATION=60` để đo dài hơn; không gộp kết quả giữa hai cấu hình. Dùng thư mục `OUTPUT` khác để giữ bằng chứng cũ. `phase2:report` nhận cùng biến `OUTPUT`.

## API mới

```text
GET /api/v1/accounts/{accountId}/transactions/feed?limit=20
GET /api/v1/accounts/{accountId}/transactions/feed?limit=20&cursor={nextCursor}
```

Cần Bearer token của chủ tài khoản. Có các bộ lọc `type`, `from`, `to` giống API cũ. Response `data` gồm `items`, `nextCursor`, `hasMore`; không có exact total. Giữ nguyên tài khoản và bộ lọc khi dùng cursor. Cursor UUID không phải thông tin xác thực; mọi request vẫn kiểm tra quyền. Dữ liệu cũ được dùng trực tiếp, không cần migration.

Idempotency: gửi lại đúng nguồn/key/đích/số tiền/mô tả nhận kết quả cũ; đổi payload với cùng key nhận 409 `IDEMPOTENCY_KEY_REUSED`. API page/limit hiện có vẫn trả `pagination.total` như trước.

## Chạy trên Kaggle CPU

Notebook [phase2-kaggle.ipynb](phase2-kaggle.ipynb) cài môi trường, lấy bản gốc theo commit cố định và áp dụng file `phase2.patch` được bàn giao. Đưa patch vào Kaggle Dataset/Input, mở notebook, bật Internet và chọn CPU. Notebook dựng cả hai bản trong cùng phiên Kaggle, chạy test trước, sau đó đo và xuất ZIP kết quả. Cấu hình mặc định notebook là 60 giây/lượt, 3 lượt/kịch bản.

Notebook chưa được thực thi trong phiên làm việc này vì chưa có kết nối/tài khoản Kaggle. Nếu chưa có patch, tạo từ Git checkout đã có commit cải tiến:

```powershell
git diff --binary c347c921d77ba533cfacd8e180feccef720be013 HEAD --output=phase2.patch
```

Sau khi Kaggle chạy thành công, giữ riêng ZIP mới và dùng môi trường/thời lượng trong ZIP đó khi báo cáo; không gộp với số liệu tại máy.
