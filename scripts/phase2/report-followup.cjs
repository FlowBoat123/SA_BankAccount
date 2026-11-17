const fs=require('node:fs'),path=require('node:path');
const directory=path.resolve(process.env.OUTPUT||'docs/performance/phase2-followup/results');
const runs=JSON.parse(fs.readFileSync(path.join(directory,'runs.json')));
const environment=JSON.parse(fs.readFileSync(path.join(directory,'environment.json')));
const unit=JSON.parse(fs.readFileSync(path.join(directory,'unit.json')));
const integration=JSON.parse(fs.readFileSync(path.join(directory,'integration.json')));
const validation=fs.readFileSync(path.join(directory,'validation.txt'),'utf8');
const httpTests=Number(validation.match(/(?:ℹ|#) tests (\d+)/)?.[1]||0);
const dockerFile=path.join(directory,'docker-smoke.json');
const docker=fs.existsSync(dockerFile)?JSON.parse(fs.readFileSync(dockerFile)):null;
const auditFile=path.join(directory,'dependency-audit.json');
const audit=fs.existsSync(auditFile)?JSON.parse(fs.readFileSync(auditFile,'utf8').replace(/^\uFEFF/,'')):null;
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;};
const fixed=n=>n.toFixed(2),errorCount=run=>Object.values(run.errors).reduce((s,n)=>s+n,0);
const summaries=[...new Set(runs.map(r=>r.scenario))].map(scenario=>{
  const result={scenario};
  for(const variant of ['baseline','improved']){
    const group=runs.filter(r=>r.variant===variant&&r.scenario===scenario);
    const mean=name=>median(group.map(r=>{const t=r.telemetry.timings[name];return t?t.sumMs/t.count:0;}));
    result[variant]={rounds:group.length,p50:median(group.map(r=>r.p50)),p95:median(group.map(r=>r.p95)),p99:median(group.map(r=>r.p99)),
      p95Min:Math.min(...group.map(r=>r.p95)),p95Max:Math.max(...group.map(r=>r.p95)),rps:median(group.map(r=>r.successRps)),
      requests:group.reduce((s,r)=>s+r.requests,0),errors:group.reduce((s,r)=>s+errorCount(r),0),retries:group.reduce((s,r)=>s+(r.telemetry.counters.retries||0),0),
      beginMeanMs:mean('transaction_start'),lockQueryMeanMs:mean('account_lock_query'),callbackMeanMs:mean('transaction_callback'),
      finishMeanMs:mean('transaction_finish'),meanWaiting:median(group.map(r=>r.lockSampling.meanWaiting)),
      lockCallsPerAttempt:median(group.map(r=>r.telemetry.timings.account_lock_query.count/r.telemetry.counters.attempts))};
  }
  result.p95ReductionPercent=(1-result.improved.p95/result.baseline.p95)*100;
  result.throughputIncreasePercent=(result.improved.rps/result.baseline.rps-1)*100;
  return result;
});
fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify(summaries,null,2));
const totalRequests=runs.reduce((s,r)=>s+r.requests,0),errors=runs.reduce((s,r)=>s+errorCount(r),0);
const lines=[
'# Đánh giá đợt cải tiến tiếp theo của giai đoạn 2','',
'## Phạm vi và thay đổi','',
'1. Bổ sung đo thời gian bắt đầu transaction, callback, kết thúc và truy vấn khóa; đếm commit, lần thử bị từ chối, retry và hết retry. Dữ liệu là histogram/counter có kích thước cố định trong mỗi process, không chứa tài khoản, số tiền, key hay payload. Script chẩn đoán lấy snapshot qua IPC tại máy, không mở endpoint metrics công khai.',
'2. Chuyển khoản lấy khóa hai tài khoản bằng một SELECT có ORDER BY id ASC FOR UPDATE, thay cho hai SELECT nối tiếp. Giữ nguyên transaction, kiểm tra nghiệp vụ, retry, timeout và thứ tự khóa theo ID bất biến.',
'3. Nạp/rút nhận Idempotency-Key tùy chọn. Key được trim, dài 16–128 ký tự, phạm vi một tài khoản và dùng chung giữa nạp/rút. Cùng key/nội dung trả bút toán cũ với HTTP 200; khác loại/số tiền/mô tả trả 409. Không gửi key: mỗi request vẫn là giao dịch mới (201). Unique index và lưu key cùng bút toán/số dư bảo vệ tính nguyên tử. Replay kiểm tra quyền sở hữu và vẫn hoạt động sau khi đóng tài khoản. Không trả key trong response hay lịch sử.','',
'## Phương pháp','',
`Môi trường: ${environment.cpu.trim()}, ${environment.logicalCpus} luồng logic, RAM ${(environment.ramBytes/1024**3).toFixed(1)} GiB; Node ${environment.node}, ${environment.postgres}. Windows API và bộ tạo tải; PostgreSQL trong Docker tại cùng máy.`,
`Mã API cải tiến: ${environment.improvedCommit}; nguồn use case baseline: ${environment.baselineCommit}. Hash JS và kiểm tra UoW giống hệt được lưu trong environment.json.`,
`Mỗi kịch bản đo ${environment.rounds} lần mỗi bản, ${environment.duration} giây/lượt, warm-up 2 giây riêng; đảo thứ tự bản giữa các vòng. Dùng tải HTTP vòng kín không think-time. API/DB/bộ tạo tải dùng chung máy. p95 là trung vị của p95 từng lượt; không phải p95 gộp. Thời gian tại client gồm nhận và kiểm tra JSON, tính cả request lỗi.`,
'Baseline dùng luồng chuyển khoản tại commit 8ad4781, được compile từ nguồn cố định. Hai bản dùng cùng UoW, telemetry, migration/index, client Prisma và bộ mã còn lại; chỉ thay use case chuyển khoản. Đây là phép đo tách riêng lợi ích gộp truy vấn khóa, không phải đo toàn bộ bản cũ trên schema cũ so với toàn bộ bản mới. Không đo hiệu năng nạp/rút trong bảng này.',
'Mỗi request chuyển 1 VND với key mới. Hot dùng một cặp tài khoản; distributed dùng 10 cặp độc lập. Trước mỗi lượt đặt lại fixture; sau lượt kiểm tra tổng tiền, số transfer, hai bút toán/transfer và số dư khớp sổ. SQL thống kê theo chênh lệch trước/sau, loại warm-up/reset/đối soát. Lấy mẫu pg_stat_activity mỗi khoảng 50 ms, không phải theo dõi liên tục. Không gộp với số liệu Kaggle cũ.','',
'## Kết quả HTTP','',
'| Kịch bản | p95 trước → sau (ms) | Giảm p95 | Thành công/giây trước → sau | Tăng thông lượng | Lỗi/request trước → sau |',
'|---|---:|---:|---:|---:|---:|',
...summaries.map(s=>`| ${s.scenario} | ${fixed(s.baseline.p95)} → ${fixed(s.improved.p95)} | ${fixed(s.p95ReductionPercent)}% | ${fixed(s.baseline.rps)} → ${fixed(s.improved.rps)} | ${fixed(s.throughputIncreasePercent)}% | ${s.baseline.errors}/${s.baseline.requests} → ${s.improved.errors}/${s.improved.requests} |`),'',
`Tổng ${runs.length} lượt, ${totalRequests.toLocaleString('en-US')} request, ${errors} lỗi. ${runs.filter(r=>r.reconciliation.conserved&&r.reconciliation.ledgerMatchesBalances).length}/${runs.length} lượt đối soát đạt.`,
'',
...summaries.filter(s=>s.p95ReductionPercent<0).map(s=>`- ${s.scenario}: p95 tăng ${fixed(-s.p95ReductionPercent)}%; không kết luận mọi mức tải đều nhanh hơn.`),
...(errors?[ '- Có lỗi HTTP trong dữ liệu đo; lỗi được giữ trong runs.json và các failure-*.log, không loại bỏ để chọn mẫu tốt. Thông lượng chỉ tính request thành công.' ]:[]),'',
'![So sánh p95 và thông lượng](results/comparison.png)','',
'## Chẩn đoán','',
'| Kịch bản | Bắt đầu transaction TB trước → sau (ms) | Một truy vấn khóa TB trước → sau (ms) | Callback TB trước → sau (ms) | Số session chờ khóa TB trước → sau |',
'|---|---:|---:|---:|---:|',
...summaries.map(s=>`| ${s.scenario} | ${fixed(s.baseline.beginMeanMs)} → ${fixed(s.improved.beginMeanMs)} | ${fixed(s.baseline.lockQueryMeanMs)} → ${fixed(s.improved.lockQueryMeanMs)} | ${fixed(s.baseline.callbackMeanMs)} → ${fixed(s.improved.callbackMeanMs)} | ${fixed(s.baseline.meanWaiting)} → ${fixed(s.improved.meanWaiting)} |`),'',
'Các ô TB là trung vị của trung bình từng lượt. Bắt đầu transaction gồm chờ pool, BEGIN và chi phí Prisma; không tách riêng chính xác thời gian chờ pool. Truy vấn khóa gồm chờ khóa, thực thi SQL và chi phí adapter. Bản trước có hai truy vấn khóa/attempt, bản sau có một: không so sánh trung bình một truy vấn như tổng thời gian giữ khóa. Callback bao gồm cả đọc và ghi; không phải phép đo chính xác thời gian giữ khóa.',
'Counter rejected là lần thử bị từ chối, không chứng minh rollback nếu lỗi mạng/commit không rõ kết quả. Retry chỉ thực hiện khi transaction được xác nhận hủy; histogram attempt không tính thời gian ngủ giữa hai lần thử. pg_stat_statements cung cấp thời gian ở server, khác độ trễ truy vấn nhìn từ ứng dụng.','',
'| Kịch bản | Khoảng p95 trước → sau (ms) | Retry trước → sau | Số truy vấn khóa/attempt trước → sau |',
'|---|---:|---:|---:|',
...summaries.map(s=>`| ${s.scenario} | ${fixed(s.baseline.p95Min)}–${fixed(s.baseline.p95Max)} → ${fixed(s.improved.p95Min)}–${fixed(s.improved.p95Max)} | ${s.baseline.retries} → ${s.improved.retries} | ${fixed(s.baseline.lockCallsPerAttempt)} → ${fixed(s.improved.lockCallsPerAttempt)} |`),'',
'## Kiểm chứng và giới hạn','',
`Đạt ${unit.numPassedTests} unit test + ${integration.numPassedTests} integration test + ${httpTests} HTTP/persistence/retry/telemetry test = ${unit.numPassedTests+integration.numPassedTests+httpTests} test. Swagger contract đạt cho 10 API.${docker?.passed?' Bản Docker build và smoke test đạt, gồm replay/conflict nạp/rút.':''}`,
'Kết quả build, unit, integration PostgreSQL thật, HTTP/persistence/retry/telemetry và Swagger được lưu tại results/validation.txt. Kiểm thử gồm gửi 20 yêu cầu nạp/rút cùng key đồng thời, xung đột loại/số tiền/mô tả, quyền sở hữu, key theo tài khoản, replay sau đóng tài khoản, rollback sau ghi ledger, hết timeout sau ghi ledger, mất socket sau commit và chuyển khoản vòng ba tài khoản trộn nạp/rút. Một kiểm thử giữ khóa bằng connection riêng để xác nhận telemetry đo được truy vấn thực sự bị chặn.',
'Đây là đo ngắn hạn trên một máy, chưa xác định tải tối đa, chưa soak dài hạn hoặc nhiều replica API. Chưa đánh giá chi phí ghi/dung lượng của index idempotency trên dữ liệu lớn. Key được giữ cùng bút toán, chưa có chính sách hết hạn; yêu cầu thiếu key vẫn có thể bị lặp nếu client tự gửi lại. Chưa hứa hẹn loại bỏ mọi lỗi hoặc giảm mọi phân vị độ trễ.',
'Các lượt có độ dao động đáng kể, đặc biệt kịch bản các cặp độc lập; chưa cố định xung CPU hay tách bộ tạo tải/DB ra máy riêng. Warm-up 2 giây chưa bảo đảm mọi cache/JIT ở trạng thái ổn định. Phần trăm ở bảng chỉ mô tả bộ đo này, chưa phải ước lượng có kiểm định thống kê cho môi trường khác.',
'',
...(audit?.metadata?.vulnerabilities?[
'## Cảnh báo dependency hiện có','',
`npm audit --omit=dev báo ${audit.metadata.vulnerabilities.total} package bị đánh dấu (${audit.metadata.vulnerabilities.high} high, ${audit.metadata.vulnerabilities.moderate} moderate, ${audit.metadata.vulnerabilities.critical} critical). Đợt cải tiến này không thay package-lock.json và chưa nâng các dependency đó. Đây là cảnh báo theo cây dependency, chưa phải kết luận từng lỗ hổng khai thác được qua API PostgreSQL hiện tại. Cần xử lý và kiểm thử riêng trước triển khai thực tế. [Bản audit gốc](results/dependency-audit.json).`,''
]:[]),
'## Dữ liệu khảo sát được giữ lại','',
'Bộ đo khảo sát đầu tiên được giữ ở exploratory-sampling-alias: một lỗi tên alias làm các trường lấy mẫu khóa thành null. Không dùng các trường đó để kết luận; bộ đo chính thức sửa alias và kiểm tra giá trị hợp lệ. Các số đo HTTP/telemetry khảo sát cũng được giữ nguyên, gồm lỗi 503 đã quan sát.','',
'Bộ exploratory-baseline-setup bị dừng khi phát hiện helper compile baseline sai rootDir và UoW chưa được copy lại sau build. Đã sửa helper và bắt buộc UoW hai bản cùng hash; dữ liệu gián đoạn không dùng để kết luận.','',
'[Hướng dẫn chạy lại và hợp đồng API](README.md) · [Dữ liệu từng lượt](results/runs.json) · [Môi trường](results/environment.json) · [Tổng hợp](results/summary.json)',
];
fs.writeFileSync(path.join(directory,'../REPORT.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({runs:runs.length,totalRequests,errors,summaries},null,2));
