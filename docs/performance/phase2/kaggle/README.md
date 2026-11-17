# Bộ kết quả chính thức trên Kaggle CPU

Đã thực thi thành công phiên bản 2 của [notebook đánh giá](https://www.kaggle.com/code/flowboat/sa-bankaccount-phase-2-before-after-evaluation?scriptVersionId=370555759).

- [Báo cáo và biểu đồ](REPORT.md): 30 lượt đo, 3 lần/kịch bản/phiên bản, 60 giây/lượt.
- [ZIP đầu ra gốc](original-results.zip): tải trực tiếp từ Kaggle và giữ nguyên byte.
- [Dữ liệu từng lượt](results/runs.json), [môi trường](results/environment.json), [giới hạn CPU/RAM và cấu hình PostgreSQL](results/kaggle-limits.json).
- [Kết quả kiểm thử](results/validation.txt), [đối chiếu idempotency](results/idempotency-before-after.json).
- [Nguồn notebook đã nhập](source-used.ipynb): chứa patch thực thi; file này giữ nguồn đầu vào, không chứa output các cell. Notebook trên Kaggle lưu bản thực thi.
- [Thông tin nguồn và checksum](provenance.json).

Hai phiên bản chạy trong cùng phiên Kaggle CPU, Node 24.22.0 và PostgreSQL 16.15. Không gộp với kết quả Windows/PostgreSQL 15.19. Bộ đo là HTTP Node.js với kiểm tra response tại client; không phải bộ k6 của nhóm gốc.

Báo cáo Markdown và hình được tổng hợp lại từ JSON gốc sau khi tải về; original-results.zip là bằng chứng nguyên bản. phase2-kaggle.ipynb trong ZIP là template được copy ra bởi script, còn source-used.ipynb là file đã được nhập để chạy phiên bản 2.

Mã API cải tiến tương ứng commit ec44a870a2cd645ab23b62a5d03805eed8b27820; bản gốc c347c921d77ba533cfacd8e180feccef720be013. Patch đầy đủ được nhúng trong source-used.ipynb, có SHA-256 tại đầu notebook. Trường improvedDiff trong environment.json chỉ liệt kê tệp Git đã theo dõi; patch chứa cả các tệp mới.

[Hướng dẫn chạy lại](../README.md) · [Thiết kế cải tiến](../ARCHITECTURE.md)
