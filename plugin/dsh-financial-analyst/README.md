# dsh-financial-analyst

Preset **Phân tích báo cáo tài chính**: nhập mã cổ phiếu (FPT, VNM, HPG...), agent đọc báo cáo tài chính, tính biên lợi nhuận, ROE, P/E và nợ/vốn chủ, so sánh với các công ty cùng ngành, chỉ ra điểm bất thường, rồi trình bày biểu đồ, bảng và nguồn dữ liệu.

**Agent chỉ phân tích và trình bày số liệu. Nó không khuyến nghị mua, bán hay nắm giữ, không đưa giá mục tiêu và không kết luận cổ phiếu rẻ hay đắt.** Quy tắc này nằm ở ba chỗ: persona của preset, hai file `SKILL.md`, và thiết kế công cụ (kết quả không có trường xếp hạng, điểm số hay khuyến nghị; báo cáo HTML luôn mở đầu bằng phần miễn trừ cố định). Hai chỗ đầu là chỉ dẫn cho model, không phải cơ chế cưỡng chế; phần còn lại do code bảo đảm.

## Cài đặt

Plugin là một bundle Cordis. Thêm vào profile (ví dụ `web`):

```sh
pnpm dsh plugin --profile web add link:/đường/dẫn/tới/plugin/dsh-financial-analyst
```

rồi thêm `dsh-financial-analyst` vào `dsh.profile.bundles` trong `package.json` của profile và **khởi động lại** `pnpm dsh web`. Cấu hình chỉ được nạp khi tiến trình khởi động. Sau đó chọn agent "Phân tích báo cáo tài chính" khi tạo phiên.

Cần truy cập Internet tới `api-finfo.vndirect.com.vn`. Không cần khoá API.

## Cách dùng

Ví dụ câu hỏi:

- `Phân tích báo cáo tài chính FPT`
- `So sánh HPG với HSG, NKG và các công ty cùng ngành`
- `VNM có điểm bất thường nào trong báo cáo gần nhất không?`
- `Giải thích biên lợi nhuận gộp của FPT giảm`

Agent chọn bước đầu theo những gì câu hỏi nêu ra:

| Câu hỏi nêu | Agent làm |
|---|---|
| Mã cổ phiếu (`FPT`, `phân tích HPG`) | Gọi `fin_report` ngay, không hỏi gì |
| Tên công ty (`Hòa Phát`, `Sữa Việt Nam`) | Gọi `fin_find_company`. Nếu chỉ có một công ty khớp rõ ràng thì gọi `fin_report` ngay và nói rõ đã dùng công ty nào. Nếu có nhiều công ty khớp thì hỏi một lần, lấy các kết quả làm lựa chọn |
| Chung chung, không nêu công ty (`phân tích báo cáo tài chính`) | Hiện một form nhập chữ ("Bạn muốn phân tích doanh nghiệp nào?") rồi xử lý câu trả lời như hai dòng trên |

Form là một câu hỏi `ask_user_question` không có lựa chọn, nên giao diện web hiện ô nhập chữ. Agent không hỏi gì khác trước khi phân tích. Sau khi có kết quả, agent nạp skill `financial-report-delivery`, trả lời bằng bảng chỉ số, xu hướng, cờ bất thường, giới hạn và nguồn, rồi bàn giao `fin-report-<MÃ>.html` bằng `present`.

## Công cụ `fin_find_company`

Tra mã cổ phiếu từ tên công ty. Một lần gọi đọc toàn bộ danh sách công ty niêm yết của VNDirect (khoảng 1.500 mã) rồi so khớp tại chỗ, không đoán:

- Khớp theo mã, tên đăng ký và tên ngắn, không phân biệt hoa thường và dấu, bỏ tiền tố pháp lý như "Công ty cổ phần".
- Kết quả ghi `Confident: yes` khi chỉ có một công ty khớp mã hoặc khớp nguyên tên; khi đó agent dùng luôn, không hỏi xác nhận. Nếu các công ty khác chỉ chứa cụm từ đó (ví dụ "Hòa Phát" khớp tên HPG và cũng có trong tên HPA), kết quả vẫn liệt kê chúng để agent nêu trong câu trả lời.
- Thương hiệu không nằm trong tên đăng ký hoặc tên ngắn thì không khớp; khi đó agent hỏi lại.

## Công cụ `fin_report`

| Tham số | Ý nghĩa |
|---|---|
| `ticker` | Mã cổ phiếu, bắt buộc |
| `peers` | Danh sách mã so sánh. Bỏ trống để dùng các công ty cùng ngành |
| `years` | Số năm tài chính trong bảng và biểu đồ (mặc định 5) |
| `max_peers` | Số công ty so sánh, 0 để bỏ qua (mặc định 5) |

Một lần gọi làm các việc sau:

1. Đọc báo cáo kết quả kinh doanh, bảng cân đối kế toán (quý và năm), lưu chuyển tiền tệ (năm), giá đóng cửa gần nhất, số cổ phiếu lưu hành và phân ngành.
2. Chọn công ty cùng ngành: lấy phân ngành hẹp nhất, xếp theo vốn hoá, bỏ công ty không có báo cáo dùng được và thay bằng công ty kế tiếp. Nếu ngành hẹp có dưới `minPeers` công ty dùng được thì mở rộng sang bậc ngành rộng hơn và ghi chú lại.
3. Tính chỉ số từ các dòng báo cáo gốc (công thức ở dưới) cho 4 quý gần nhất (TTM) và từng năm.
4. Sàng lọc điểm bất thường và so với trung vị cùng ngành.
5. Ghi `fin-report-<MÃ>.html` vào thư mục làm việc của phiên, gồm bảng, 3 biểu đồ theo năm, 4 biểu đồ so sánh ngành, công thức, ghi chú và URL của mọi nguồn đã đọc.

Tool chỉ ghi một file có tên cố định trong thư mục làm việc của phiên; model không chọn được đường dẫn. File được ghi qua dịch vụ `fs` của harness và truyền **chính sách sandbox của phiên** (giống tool `write` của `dsh-tool-fs`), nên chế độ `workspace-write` cho phép ghi trong thư mục làm việc còn `read-only` thì từ chối. Tool không xin nâng quyền. Nếu ghi bị từ chối, tool vẫn trả số liệu, nói rõ file chưa được ghi và agent không gọi `present`. Preset không mount `dsh-tool-fs`, nên agent không có công cụ ghi file tổng quát.

### Công thức

| Chỉ số | Cách tính |
|---|---|
| Biên gộp / hoạt động / ròng | Lợi nhuận gộp (23100) / LN thuần từ HĐKD (23110) / LNST của công ty mẹ (23000), chia doanh thu thuần (21001) |
| ROE | LNST công ty mẹ / vốn chủ của công ty mẹ bình quân đầu và cuối kỳ. Vốn chủ công ty mẹ = vốn chủ sở hữu (14000) trừ lợi ích cổ đông không kiểm soát (14240) |
| P/E | Giá đóng cửa gần nhất / EPS TTM. EPS TTM = LNST công ty mẹ 4 quý / số cổ phiếu đang lưu hành hiện tại |
| Nợ phải trả / vốn chủ | Nợ phải trả (13000) / vốn chủ sở hữu (14000) |
| Nợ vay / vốn chủ | (Vay và nợ ngắn hạn 13110 + vay và nợ dài hạn 13340) / vốn chủ sở hữu (14000) |
| Vốn hoá | Giá đóng cửa gần nhất x số cổ phiếu đang lưu hành |

Số trong ngoặc là mã dòng của VNDirect. Một dòng không có trong dữ liệu của công ty thì tính là thiếu (`null`), trừ dòng vay nợ và lợi ích cổ đông không kiểm soát được coi là 0.

### Cờ bất thường

Mỗi cờ là một chênh lệch vượt ngưỡng cấu hình, kèm các con số tạo nên nó. Cờ chỉ cho biết chỗ cần đọc thêm trong thuyết minh, không kết luận về chất lượng báo cáo.

| Cờ | Điều kiện (ngưỡng mặc định) |
|---|---|
| `growth_divergence` | Tăng trưởng lợi nhuận TTM và doanh thu TTM lệch nhau quá 30 điểm % |
| `grossMargin_swing`, `netMargin_swing` | Biên đổi quá 3 điểm % so với cùng kỳ năm trước |
| `receivablesGrowth_outpaces_revenue`, `inventoryGrowth_outpaces_revenue` | Phải thu hoặc tồn kho tăng nhanh hơn doanh thu quá 20 điểm % |
| `leverage_jump` | Nợ phải trả / vốn chủ tăng quá 0,3 lần so với một năm trước |
| `low_interest_coverage` | (LNTT + lãi vay) / lãi vay dưới 3 lần |
| `low_cash_conversion`, `negative_operating_cash_flow` | Dòng tiền kinh doanh / LNST dưới 0,5, hoặc âm khi có lãi (năm tài chính gần nhất) |
| `non_core_income_share` | Doanh thu tài chính cộng thu nhập khác vượt 30% LNTT |
| `tax_rate_out_of_band` | Thuế suất thực tế ngoài khoảng 10% đến 30% |
| `net_loss` | LNST công ty mẹ TTM không dương |
| `peer_pe`, `peer_roe`, `peer_liabilitiesToEquity` | Lệch trung vị cùng ngành quá 50% của trung vị |
| `peer_grossMargin`, `peer_operatingMargin`, `peer_netMargin` | Lệch trung vị cùng ngành quá 5 điểm % |

Các ngưỡng là heuristic sàng lọc, không phải chuẩn kế toán. Cờ so với ngành chỉ được đưa ra khi có ít nhất `minPeers` công ty so sánh.

## Cấu hình

Mọi trường đều tuỳ chọn; nhập dưới `config` của `dsh-financial-analyst/tools`.

| Trường | Mặc định | Ý nghĩa |
|---|---|---|
| `baseUrl` | `https://api-finfo.vndirect.com.vn/v4` | Gốc API finfo |
| `userAgent` | `dsh-financial-analyst` | Header User-Agent |
| `timeoutMs`, `retries`, `retryDelayMs` | 90000, 2, 500 | Ngân sách thời gian và thử lại khi mất kết nối |
| `maxMatches` | 5 | Số công ty `fin_find_company` trả về cho một truy vấn |
| `concurrency` | 3 | Số công ty đọc song song khi nạp công ty cùng ngành |
| `defaultYears`, `maxYears` | 5, 10 | Số năm mặc định và tối đa |
| `maxPeers`, `maxPeersLimit`, `minPeers` | 5, 10, 3 | Số công ty so sánh mặc định, tối đa và tối thiểu để đưa cờ lệch ngành |
| `peerIndustryLevel` | 4 | Bậc ngành hẹp nhất để lấy công ty cùng ngành (4 hẹp nhất, 1 rộng nhất) |
| `maxStatementAgeDays` | 400 | Công ty có báo cáo quý mới nhất cũ hơn mức này bị loại |
| `divergencePp`, `marginSwingPp`, `workingCapitalGapPp`, `cashConversionMin`, `interestCoverageMin`, `leverageJump`, `nonCoreShareMaxPct`, `taxRateMinPct`, `taxRateMaxPct`, `peerDeviationPct`, `peerMarginDevPp` | xem bảng cờ | Ngưỡng sàng lọc |

Cấu hình sai thứ tự (ví dụ `taxRateMinPct` không nhỏ hơn `taxRateMaxPct`) làm plugin báo lỗi khi nạp.

## Mô hình ngữ cảnh và token

Mỗi lần gọi `fin_report` trả khoảng 5 đến 8 nghìn ký tự: bảng TTM, bảng theo năm, bảng công ty cùng ngành, cờ, ghi chú và URL nguồn của mã chính. URL của các công ty cùng ngành chỉ nằm trong file HTML. Biểu đồ không đi qua model. Preset mount nhóm nén ngữ cảnh giống `dsh-market-analyst`.

## Giới hạn

- **Nguồn không chính thức.** API finfo của VNDirect là API công khai không có cam kết ổn định; có thể đổi cấu trúc, giới hạn tốc độ hoặc chậm so với báo cáo công bố gốc. Đối chiếu với báo cáo tài chính của doanh nghiệp trước khi trích dẫn.
- **Chỉ doanh nghiệp phi tài chính.** Ngân hàng, công ty chứng khoán và bảo hiểm dùng mô hình báo cáo khác; tool từ chối thay vì tính sai.
- **Công ty cùng ngành khác nhau về quy mô và mô hình**, nên trung vị chỉ là mốc tham chiếu. Công ty rất nhỏ hoặc vốn chủ rất thấp làm ROE hoặc P/E cực đoan; trung vị giảm ảnh hưởng này nhưng không loại bỏ.
- **EPS TTM dùng số cổ phiếu hiện tại**, có thể lệch EPS công bố khi vừa phát hành thêm hoặc chia thưởng.
- **Số liệu tính trên đồng tiền và đơn vị của nguồn** (đồng, giá nguồn tính bằng nghìn đồng nhân 1.000).
- Chưa có kiểm tra bằng phiên thật với model; test hiện có là test đơn vị và test với `fetch` giả lập.

## Kiểm thử

```sh
cd plugin/dsh-financial-analyst
npm test
```

75 test chạy bằng `node --test`: chỉ số, cờ bất thường, lớp dữ liệu (kể cả lỗi HTTP, JSON hỏng, thử lại), tra tên công ty, chọn công ty cùng ngành, báo cáo HTML (escape, nguồn, biểu đồ), phần miễn trừ và nội dung skill. Không cần mạng; `fetch` được giả lập theo cú pháp lọc `q` của VNDirect.

## Cấu trúc

| File | Vai trò |
|---|---|
| `cordis.patch.yml` | Khai báo preset `financial-analyst` |
| `tools.js` | Cấu hình và hai công cụ `fin_find_company`, `fin_report` |
| `data.js` | Đọc API VNDirect, danh sách mã dòng báo cáo |
| `lookup.js` | Tra mã cổ phiếu từ tên công ty |
| `metrics.js` | Tính chỉ số, TTM, chuỗi theo năm, P/E |
| `anomalies.js` | Sàng lọc bất thường |
| `analyze.js` | Điều phối: chọn công ty cùng ngành, đọc song song, so sánh |
| `report.js` | Báo cáo HTML với biểu đồ SVG |
| `deliver.js` | Ghi file báo cáo dưới chính sách sandbox của phiên |
| `summary.js` | Bản tóm tắt dạng văn bản cho model, kiểm tra cấu hình |
| `skills.js`, `skills/*/SKILL.md` | Hai skill, gồm quy tắc không khuyến nghị |
