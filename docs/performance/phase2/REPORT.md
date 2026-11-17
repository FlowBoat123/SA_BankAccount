# Đánh giá cải tiến SA_BankAccount — Giai đoạn 2

## Phạm vi và môi trường

Đã chạy thực nghiệm tại máy Windows. Đây là bộ số liệu tại máy, tách riêng với phép đo Kaggle CPU.

- Commit gốc: `c347c921d77ba533cfacd8e180feccef720be013`.
- Thời điểm bắt đầu (UTC): 2026-11-17T06:25:38.403Z.
- CPU: AMD Ryzen AI 9 365 w/ Radeon 880M, 20 luồng logic; RAM 27.8 GiB.
- Node v24.11.1; win32 10.0.26300; PostgreSQL 15.19 (Debian 15.19-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit. PostgreSQL chạy trong Docker Desktop/WSL2; API và bộ tạo tải chạy trên Windows.
- Không nâng phần cứng, không thay schema/index, không giảm Bcrypt. API, PostgreSQL và bộ tạo tải dùng chung máy. Không đo đăng nhập trong thí nghiệm này; token được chuẩn bị trước.

## Những thay đổi đã thực hiện

1. **Rút ngắn phần ghi của chuyển khoản:** giữ khóa dòng theo thứ tự và một transaction, gộp hai UPDATE số dư thành một câu lệnh và hai INSERT bút toán thành một createMany. Phần ghi giảm từ 5 xuống 3 lần gọi database (không tính SELECT và BEGIN/COMMIT). Không bỏ kiểm tra số dư, quyền sở hữu, trạng thái hay ràng buộc database.
2. **Chống dùng lại khóa với payload khác:** cùng tài khoản nguồn và key nhưng khác số tiền, tài khoản đích hoặc mô tả trả HTTP 409 IDEMPOTENCY_KEY_REUSED. Gửi lại đúng lệnh trả kết quả cũ. Đây là thay đổi về độ tin cậy, không gộp vào tuyên bố tăng tốc riêng của batching.
3. **API lịch sử dùng cursor:** bổ sung GET /api/v1/accounts/{accountId}/transactions/feed. Dùng index có sẵn (account_id, created_at DESC, id DESC), lấy limit+1 dòng để xác định hasMore và không COUNT mỗi trang. API page/limit cũ được giữ nguyên.
4. **Thử lại có giới hạn khi transaction bị hủy:** phát hiện timeout transaction khi cạnh tranh khóa. Chỉ tự thử lại một lần với lỗi Prisma P2034 hoặc P2028 xác nhận transaction đã hết hạn; giữ timeout gốc 5 giây. Không tự thử lại lỗi mạng/commit không rõ trạng thái, lỗi ràng buộc hay lỗi nghiệp vụ. Nếu vẫn thất bại trả 503 TRANSACTION_BUSY. Việc thử lại có thể tăng thời gian ở đuôi; không coi p95 là toàn bộ trải nghiệm.

Cursor là ID giao dịch cuối trang. Timestamp được đọc ngay trong PostgreSQL để giữ chính xác microsecond; mọi trang đều kiểm tra chủ tài khoản. Cursor phải thuộc cùng tài khoản và bộ lọc. Trang cuối có nextCursor=null. Nếu bản ghi cursor bị xóa, yêu cầu nhận 400 và client cần bắt đầu lại.

## Thiết kế phép đo

Mỗi kịch bản chạy 3 lần cho mỗi bản, 10 giây/lượt, warm-up 2 giây riêng. Thứ tự bản gốc/cải tiến được đảo giữa các vòng. Dùng HTTP thực, tải vòng kín không think-time; số client là số luồng yêu cầu đồng thời, không phải requests/giây. Độ trễ tại client gồm nhận response, đọc JSON và kiểm tra kết quả. Bộ tạo tải dùng Node.js, không dùng k6; không so sánh trực tiếp với số liệu k6 của nhóm gốc. p95 ở bảng là trung vị của p95 từng lượt; không phải p95 gộp toàn bộ request.

- transfer_hot_1/10: 1 hoặc 10 client chuyển 1 VND trên cùng cặp tài khoản, mỗi request có key mới.
- transfer_distributed_10: 10 client trên 10 cặp tài khoản độc lập.
- history_10000_deep: 10.000 bản ghi/tài khoản, đọc 20 dòng ở vị trí OFFSET 8.000.
- history_300000_deep: 300.000 bản ghi/tài khoản, đọc 20 dòng ở vị trí OFFSET 240.000.
- Bản gốc đọc trang bằng OFFSET + COUNT; bản cải tiến dùng cursor đã biết để đọc **cùng 20 ID**, và script kiểm tra toàn bộ ID trả về. Thời gian lấy cursor ban đầu không nằm trong phép đo trang sâu.
- Trước mỗi lượt ghi đặt lại cùng số dư, xóa dữ liệu chỉ trong fixture của lần chạy. Sau mỗi lượt đối soát tổng tiền, số transfer, đúng hai bút toán/transfer và số dư từng tài khoản khớp sổ giao dịch.

**Đánh đổi của cursor:** không trả tổng số dòng/trang và không hỗ trợ nhảy trực tiếp tới trang số N. Kết quả lịch sử đo lợi ích của cách duyệt tuần tự mới, bao gồm việc bỏ COUNT; không phải tăng tốc cùng một hợp đồng API hoàn toàn giống nhau. Đo EXPLAIN riêng ở dưới để tách chi phí OFFSET.

## Kết quả HTTP trước–sau

| Kịch bản | p95 gốc (ms) | p95 mới (ms) | Giảm p95 | Gốc (thành công/s) | Mới (thành công/s) | Tăng thông lượng |
|---|---:|---:|---:|---:|---:|---:|
| transfer_hot_1 | 23.88 | 16.90 | 29.22% | 48.85 | 67.51 | 38.19% |
| transfer_hot_10 | 187.50 | 212.15 | -13.15% | 67.91 | 98.38 | 44.86% |
| transfer_distributed_10 | 48.19 | 49.19 | -2.08% | 246.88 | 243.59 | -1.33% |
| history_10000_deep | 36.11 | 11.49 | 68.19% | 172.56 | 552.48 | 220.17% |
| history_300000_deep | 90.21 | 11.00 | 87.81% | 67.32 | 577.34 | 757.65% |

![So sánh các lượt đo](results/comparison.png)


### Diễn giải

Lịch sử dùng cursor được đánh giá cho nhu cầu duyệt tuần tự. Luồng ghi được đánh giá theo cả thông lượng và độ trễ; giảm số lượt gọi SQL không bảo đảm mọi phân vị đều giảm.

- transfer_hot_10: p95 tăng 13.15%; thông lượng tăng 44.86%. Không kết luận cải thiện đồng đều; xem độ dao động ở bảng dưới.
- transfer_distributed_10: p95 tăng 2.08%; thông lượng giảm 1.33%. Không kết luận cải thiện đồng đều; xem độ dao động ở bảng dưới.

Tổng 30 lượt đo, 65,309 request; 0 request lỗi. Toàn bộ 18 lượt ghi vượt qua đối soát dữ liệu.

| Kịch bản | Lỗi / request gốc | Lỗi / request mới |
|---|---:|---:|
| transfer_hot_1 | 0/1549 | 0/2038 |
| transfer_hot_10 | 0/2199 | 0/2979 |
| transfer_distributed_10 | 0/7680 | 0/7390 |
| history_10000_deep | 0/5211 | 0/16721 |
| history_300000_deep | 0/2090 | 0/17452 |

Các lượt khảo sát ban đầu (exploratory-first-run và diagnostic-hot) đã phát hiện HTTP 500 do Prisma transaction hết hạn khi chờ khóa. Chúng được giữ riêng, không gộp vào bảng đo chính thức sau khi bổ sung cơ chế thử lại. Một lần chạy so sánh sau đó cũng tái hiện lỗi ở bản gốc; giữ trong exploratory-baseline-timeout. Không sửa bản gốc để che lỗi. Log lỗi của các lượt đo chính thức được lưu cùng runs.json nếu có.

## Độ dao động và tài nguyên API

| Kịch bản | Khoảng p95 gốc (ms) | Khoảng p95 mới (ms) | CPU gốc / mới (%) | RSS gốc / mới (MiB) |
|---|---:|---:|---:|---:|
| transfer_hot_1 | 21.23–25.61 | 16.79–19.10 | 56.30 / 52.12 | 260.57 / 254.56 |
| transfer_hot_10 | 184.99–188.13 | 196.83–235.31 | 66.16 / 62.26 | 313.09 / 312.52 |
| transfer_distributed_10 | 47.23–51.41 | 47.61–49.85 | 106.04 / 107.26 | 405.92 / 363.46 |
| history_10000_deep | 34.76–36.85 | 11.45–11.78 | 53.83 / 106.23 | 410.22 / 373.72 |
| history_300000_deep | 85.05–90.63 | 10.98–11.32 | 21.44 / 105.29 | 411.21 / 373.27 |

CPU lấy chênh lệch thời gian CPU của tiến trình API ở hai đầu mỗi lượt, RSS là mẫu cuối lượt; 100% tương đương một lõi logic. Đây là số liệu phụ trợ gần đúng, có chi phí lấy mẫu ngoài cửa sổ HTTP; không phải tổng CPU/RAM toàn hệ thống và chưa đo peak theo từng kịch bản. Peak RSS của tiến trình có trong dữ liệu thô nhưng bao gồm các kịch bản trước đó.

## Bằng chứng ở database

EXPLAIN ANALYZE BUFFERS trên cùng trang sâu 300.000 bản ghi, không kèm COUNT:

- OFFSET: index scan đọc 240.020 dòng để trả 20; execution time 27.351 ms; 10221 shared-buffer hits.
- Seek: index chính đọc 21 dòng và một lookup cursor; execution time 0.055 ms; 8 shared-buffer hits, 1 shared-buffer reads.
- Hai bản đều dùng index đã có; không thêm index chỉ để làm đẹp số đo. Đây là một mẫu kế hoạch truy vấn, không phải thống kê thời gian SQL qua nhiều lần.

## Kiểm thử và giới hạn

Kết quả kiểm thử được lưu riêng trong results/validation.txt. Bộ kiểm thử mới sử dụng PostgreSQL thật: gửi lại đồng thời, payload xung đột, chuyển chéo, chống thấu chi, lỗi sau khi đã ghi dữ liệu, lỗi ràng buộc khi ghi theo lô; cursor có timestamp trùng và khác nhau ở microsecond, phân quyền, bộ lọc và chèn bản ghi giữa hai trang. Kiểm thử HTTP xác nhận DTO/Guard/envelope và API cũ.

Đạt 172 unit test, 46 integration test và 22 test HTTP/persistence/retry, tổng cộng 240 test. Swagger contract cũng đạt cho 10 API. Adapter chuẩn hóa Decimal thành chuỗi thật theo hợp đồng port; test integration đã kiểm chứng kiểu dữ liệu trả về. Kết quả Docker được ghi riêng ở bộ dữ liệu tại máy.

Chưa xác định tải tối đa, chưa kiểm thử soak dài hạn, chưa kiểm chứng nhiều bản sao API hoặc mô hình multi-node. Dữ liệu lịch sử được sinh tổng hợp để đo truy vấn; không coi là sổ giao dịch tài chính đã đối soát. Mỗi lượt chính thức chỉ 10 giây nên kết luận giới hạn trong cấu hình và kịch bản đã đo. Không suy rộng thành cam kết hiệu năng production.

Hướng dẫn chạy lại: [README](README.md). Dữ liệu thô: [runs.json](results/runs.json), [môi trường](results/environment.json), [summary.json](results/summary.json), [OFFSET](results/plan-offset.json), [seek](results/plan-seek.json).
