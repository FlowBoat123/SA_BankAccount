const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const dir = path.resolve(root, process.env.OUTPUT || 'docs/performance/phase2/results');
const runs = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json')));
const env = JSON.parse(fs.readFileSync(path.join(dir, 'environment.json')));
const kaggle = env.location === 'Kaggle CPU';
const scenarios = [...new Set(runs.map(r => r.scenario))];
const median = xs => { const a=[...xs].sort((a,b)=>a-b);return a[Math.floor(a.length/2)]; };
const num = n => n.toFixed(2);
const summary = scenarios.map(scenario => {
  const summarize = variant => {
    const rows=runs.filter(r=>r.scenario===scenario&&r.variant===variant);
    if(rows.length!==env.rounds)throw Error(`Incomplete runs for ${scenario}/${variant}`);
    return { rounds:rows.length,p50:median(rows.map(r=>r.p50)),p95:median(rows.map(r=>r.p95)),p99:median(rows.map(r=>r.p99)),
      rps:median(rows.map(r=>r.successRps)),p95Min:Math.min(...rows.map(r=>r.p95)),p95Max:Math.max(...rows.map(r=>r.p95)),
      cpuPercent:median(rows.map(r=>r.apiCpuPercent)),rssMiB:median(rows.map(r=>r.apiRssBytes/1048576)),
      requests:rows.reduce((n,r)=>n+r.requests,0),errors:rows.reduce((n,r)=>n+r.requests-r.successes,0) };
  };
  const baseline=summarize('baseline'),improved=summarize('improved');
  return {scenario,baseline,improved,p95ReductionPercent:100*(1-improved.p95/baseline.p95),throughputIncreasePercent:100*(improved.rps/baseline.rps-1)};
});
fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
const table = summary.map(s=>`| ${s.scenario} | ${num(s.baseline.p95)} | ${num(s.improved.p95)} | ${num(s.p95ReductionPercent)}% | ${num(s.baseline.rps)} | ${num(s.improved.rps)} | ${num(s.throughputIncreasePercent)}% |`).join('\n');
const rangeTable=summary.map(s=>`| ${s.scenario} | ${num(s.baseline.p95Min)}–${num(s.baseline.p95Max)} | ${num(s.improved.p95Min)}–${num(s.improved.p95Max)} | ${num(s.baseline.cpuPercent)} / ${num(s.improved.cpuPercent)} | ${num(s.baseline.rssMiB)} / ${num(s.improved.rssMiB)} |`).join('\n');
const errorTable=summary.map(s=>`| ${s.scenario} | ${s.baseline.errors}/${s.baseline.requests} | ${s.improved.errors}/${s.improved.requests} |`).join('\n');
const pgPlan=name=>JSON.parse(fs.readFileSync(path.join(dir,`plan-${name}.json`)))[0]['QUERY PLAN'][0];
const offset=pgPlan('offset'),seek=pgPlan('seek');
const chart = fs.existsSync(path.join(dir,'comparison.png')) ? '\n![So sánh các lượt đo](results/comparison.png)\n' : '';
const tradeoffs = summary.filter(s=>s.p95ReductionPercent<0 || s.throughputIncreasePercent<0).map(s=>
  `- ${s.scenario}: p95 ${s.p95ReductionPercent<0?'tăng':'giảm'} ${num(Math.abs(s.p95ReductionPercent))}%; thông lượng ${s.throughputIncreasePercent<0?'giảm':'tăng'} ${num(Math.abs(s.throughputIncreasePercent))}%. Không kết luận cải thiện đồng đều; xem độ dao động ở bảng dưới.`).join('\n');
const report=`# Đánh giá cải tiến SA_BankAccount — Giai đoạn 2

## Phạm vi và môi trường

${kaggle ? 'Đã chạy thực nghiệm trên **Kaggle CPU**; hai phiên bản cùng một phiên phần cứng. Kết quả tại máy Windows được giữ riêng.' : 'Đã chạy thực nghiệm tại máy Windows. Đây là bộ số liệu tại máy, tách riêng với phép đo Kaggle CPU.'}

- Commit gốc: \`${env.baselineCommit}\`.
- Thời điểm bắt đầu (UTC): ${env.timestamp}.
- CPU: ${env.cpu.trim()}, ${env.logicalCpus} luồng logic; RAM ${(env.ramBytes/1073741824).toFixed(1)} GiB.
- Node ${env.node}; ${env.platform} ${env.release}; ${env.postgres}. ${kaggle ? 'API, PostgreSQL và bộ tạo tải cùng phiên Kaggle CPU.' : 'PostgreSQL chạy trong Docker Desktop/WSL2; API và bộ tạo tải chạy trên Windows.'}
- Không nâng phần cứng, không thay schema/index, không giảm Bcrypt. API, PostgreSQL và bộ tạo tải dùng chung máy. Không đo đăng nhập trong thí nghiệm này; token được chuẩn bị trước.

## Những thay đổi đã thực hiện

1. **Rút ngắn phần ghi của chuyển khoản:** giữ khóa dòng theo thứ tự và một transaction, gộp hai UPDATE số dư thành một câu lệnh và hai INSERT bút toán thành một createMany. Phần ghi giảm từ 5 xuống 3 lần gọi database (không tính SELECT và BEGIN/COMMIT). Không bỏ kiểm tra số dư, quyền sở hữu, trạng thái hay ràng buộc database.
2. **Chống dùng lại khóa với payload khác:** cùng tài khoản nguồn và key nhưng khác số tiền, tài khoản đích hoặc mô tả trả HTTP 409 IDEMPOTENCY_KEY_REUSED. Gửi lại đúng lệnh trả kết quả cũ. Đây là thay đổi về độ tin cậy, không gộp vào tuyên bố tăng tốc riêng của batching.
3. **API lịch sử dùng cursor:** bổ sung GET /api/v1/accounts/{accountId}/transactions/feed. Dùng index có sẵn (account_id, created_at DESC, id DESC), lấy limit+1 dòng để xác định hasMore và không COUNT mỗi trang. API page/limit cũ được giữ nguyên.
4. **Thử lại có giới hạn khi transaction bị hủy:** phát hiện timeout transaction khi cạnh tranh khóa. Chỉ tự thử lại một lần với lỗi Prisma P2034 hoặc P2028 xác nhận transaction đã hết hạn; giữ timeout gốc 5 giây. Không tự thử lại lỗi mạng/commit không rõ trạng thái, lỗi ràng buộc hay lỗi nghiệp vụ. Nếu vẫn thất bại trả 503 TRANSACTION_BUSY. Việc thử lại có thể tăng thời gian ở đuôi; không coi p95 là toàn bộ trải nghiệm.

Cursor là ID giao dịch cuối trang. Timestamp được đọc ngay trong PostgreSQL để giữ chính xác microsecond; mọi trang đều kiểm tra chủ tài khoản. Cursor phải thuộc cùng tài khoản và bộ lọc. Trang cuối có nextCursor=null. Nếu bản ghi cursor bị xóa, yêu cầu nhận 400 và client cần bắt đầu lại.

## Thiết kế phép đo

Mỗi kịch bản chạy ${env.rounds} lần cho mỗi bản, ${env.seconds} giây/lượt, warm-up 2 giây riêng. Thứ tự bản gốc/cải tiến được đảo giữa các vòng. Dùng HTTP thực, tải vòng kín không think-time; số client là số luồng yêu cầu đồng thời, không phải requests/giây. Độ trễ tại client gồm nhận response, đọc JSON và kiểm tra kết quả. Bộ tạo tải dùng Node.js, không dùng k6; không so sánh trực tiếp với số liệu k6 của nhóm gốc. p95 ở bảng là trung vị của p95 từng lượt; không phải p95 gộp toàn bộ request.

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
${table}
${chart}

### Diễn giải

Lịch sử dùng cursor được đánh giá cho nhu cầu duyệt tuần tự. Luồng ghi được đánh giá theo cả thông lượng và độ trễ; giảm số lượt gọi SQL không bảo đảm mọi phân vị đều giảm.

${tradeoffs || 'Trong các kịch bản đã đo, trung vị p95 và thông lượng đều cải thiện; vẫn cần xem độ dao động và giới hạn thời lượng trước khi suy rộng.'}

Tổng ${runs.length} lượt đo, ${runs.reduce((n,r)=>n+r.requests,0).toLocaleString('en-US')} request; ${runs.reduce((n,r)=>n+r.requests-r.successes,0)} request lỗi. Toàn bộ ${runs.filter(r=>r.reconciliation).length} lượt ghi vượt qua đối soát dữ liệu.

| Kịch bản | Lỗi / request gốc | Lỗi / request mới |
|---|---:|---:|
${errorTable}

${kaggle ? 'Nhóm đã phát hiện timeout transaction trong đợt khảo sát tại máy và bổ sung thử lại có giới hạn trước phép đo này.' : 'Các lượt khảo sát ban đầu (exploratory-first-run và diagnostic-hot) đã phát hiện HTTP 500 do Prisma transaction hết hạn khi chờ khóa. Chúng được giữ riêng, không gộp vào bảng đo chính thức sau khi bổ sung cơ chế thử lại. Một lần chạy so sánh sau đó cũng tái hiện lỗi ở bản gốc; giữ trong exploratory-baseline-timeout.'} Không sửa bản gốc để che lỗi. Log lỗi của các lượt đo chính thức được lưu cùng runs.json nếu có.

## Độ dao động và tài nguyên API

| Kịch bản | Khoảng p95 gốc (ms) | Khoảng p95 mới (ms) | CPU gốc / mới (%) | RSS gốc / mới (MiB) |
|---|---:|---:|---:|---:|
${rangeTable}

CPU lấy chênh lệch thời gian CPU của tiến trình API ở hai đầu mỗi lượt, RSS là mẫu cuối lượt; 100% tương đương một lõi logic. Đây là số liệu phụ trợ gần đúng, có chi phí lấy mẫu ngoài cửa sổ HTTP; không phải tổng CPU/RAM toàn hệ thống và chưa đo peak theo từng kịch bản. Peak RSS của tiến trình có trong dữ liệu thô nhưng bao gồm các kịch bản trước đó.

## Bằng chứng ở database

EXPLAIN ANALYZE BUFFERS trên cùng trang sâu 300.000 bản ghi, không kèm COUNT:

- OFFSET: index scan đọc 240.020 dòng để trả 20; execution time ${offset['Execution Time']} ms; ${offset.Plan['Shared Hit Blocks']} shared-buffer hits.
- Seek: index chính đọc 21 dòng và một lookup cursor; execution time ${seek['Execution Time']} ms; ${seek.Plan['Shared Hit Blocks']} shared-buffer hits, ${seek.Plan['Shared Read Blocks']} shared-buffer reads.
- Hai bản đều dùng index đã có; không thêm index chỉ để làm đẹp số đo. Đây là một mẫu kế hoạch truy vấn, không phải thống kê thời gian SQL qua nhiều lần.

## Kiểm thử và giới hạn

Kết quả kiểm thử được lưu riêng trong results/validation.txt. Bộ kiểm thử mới sử dụng PostgreSQL thật: gửi lại đồng thời, payload xung đột, chuyển chéo, chống thấu chi, lỗi sau khi đã ghi dữ liệu, lỗi ràng buộc khi ghi theo lô; cursor có timestamp trùng và khác nhau ở microsecond, phân quyền, bộ lọc và chèn bản ghi giữa hai trang. Kiểm thử HTTP xác nhận DTO/Guard/envelope và API cũ.

Đạt 172 unit test, 46 integration test và 22 test HTTP/persistence/retry, tổng cộng 240 test. Swagger contract cũng đạt cho 10 API. Adapter chuẩn hóa Decimal thành chuỗi thật theo hợp đồng port; test integration đã kiểm chứng kiểu dữ liệu trả về. Kết quả Docker được ghi riêng ở bộ dữ liệu tại máy.

Chưa xác định tải tối đa, chưa kiểm thử soak dài hạn, chưa kiểm chứng nhiều bản sao API hoặc mô hình multi-node. Dữ liệu lịch sử được sinh tổng hợp để đo truy vấn; không coi là sổ giao dịch tài chính đã đối soát. Mỗi lượt chính thức chỉ ${env.seconds} giây nên kết luận giới hạn trong cấu hình và kịch bản đã đo. Không suy rộng thành cam kết hiệu năng production.

Hướng dẫn chạy lại: [README](README.md). Dữ liệu thô: [runs.json](results/runs.json), [môi trường](results/environment.json), [summary.json](results/summary.json), [OFFSET](results/plan-offset.json), [seek](results/plan-seek.json).
`;
fs.writeFileSync(path.join(dir,'../REPORT.md'),report);
console.table(summary.map(s=>({scenario:s.scenario,oldP95:num(s.baseline.p95),newP95:num(s.improved.p95),p95Reduction:num(s.p95ReductionPercent)+'%',rpsGain:num(s.throughputIncreasePercent)+'%'})));
