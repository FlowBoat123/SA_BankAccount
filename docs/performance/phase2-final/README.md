# Bản nộp Pha 2

[Báo cáo chính thức trên Kaggle CPU](REPORT.md) · [Sơ đồ trước–sau](ARCHITECTURE.md) · [Notebook để chạy lại](kaggle-final.ipynb) · [ZIP dữ liệu gốc](kaggle-output-original.zip) · [GitHub Actions](https://github.com/FlowBoat123/SA_BankAccount/actions/runs/44227386720)

Mục tiêu là đọc lịch sử nhanh hơn và rút ngắn phần ghi khi nhiều yêu cầu chuyển khoản tranh chấp cùng tài khoản. Bản nộp bổ sung API lịch sử dùng cursor, ghi chuyển khoản gộp, xử lý gửi lại bằng mã yêu cầu cho cả chuyển khoản và nạp/rút, đo thời gian từng công đoạn và CI. Các quyết định thiết kế và thử nghiệm sàng lọc được ghi trong [báo cáo tại máy](../phase2-contention/REPORT.md).

## Chạy lại phép đo chính

1. Import `kaggle-final.ipynb` vào một Kaggle Notebook. Bật Internet, chọn Accelerator = None và chạy tất cả cell trong một phiên.
2. Notebook lấy mã từ fork công khai theo commit đã ghi ở đầu notebook. Cả hai bản dùng cùng máy, bộ thư viện, Node.js, PostgreSQL, schema thử nghiệm và dữ liệu mẫu. Bản gốc dùng mã tại `c347c921`, còn bản nộp dùng mã tại `bf78c1e`.
3. Chờ cài đặt, migrate và kiểm thử. Bộ đo dùng HTTP thực với 10, 50 và 100 client cùng cặp, 10 cặp độc lập, và đọc một trang sâu trong 300.000 giao dịch. Mỗi kịch bản có ba lượt × 60 giây cho mỗi bản, với hai giây warm-up.
4. Tải ZIP `sa-bankaccount-phase2-final.zip` từ output. File `COMPLETE.json` cho biết phép đo đã đủ 30 lượt và 24 lượt ghi đối soát đúng. Thư mục `results` chứa môi trường, kiểm thử, số liệu từng lượt, bản tổng hợp và kế hoạch truy vấn.

Lịch sử so sánh việc đọc cùng 20 giao dịch ở một vị trí. Bản gốc dùng OFFSET và COUNT để hỗ trợ nhảy trang theo số. Bản nộp dùng cursor đã biết để đọc tuần tự và xác định còn trang tiếp. Bảng hiệu năng đặt rõ hai cách sử dụng này.

Kịch bản dùng tài khoản và giao dịch thử nghiệm. Các tệp đo trên Windows trong thư mục `phase2-contention` cung cấp chi tiết sàng lọc hàng đợi và cách ghi. Dùng số liệu Kaggle của bản nộp cho phép so sánh chính.
