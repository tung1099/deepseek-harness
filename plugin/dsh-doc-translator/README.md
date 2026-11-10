# dsh-doc-translator

Preset **Dịch tài liệu**: người dùng đưa một tệp và một ngôn ngữ đích, công cụ `doc_translate` dịch tệp và lưu kết quả cạnh tệp gốc. Việc dịch chạy trong công cụ, theo từng lô song song qua một hoặc nhiều model, nên nội dung tài liệu không đi qua ngữ cảnh của agent.

## Mức độ giữ định dạng

| Loại tệp | Cách làm | Giữ định dạng |
|---|---|---|
| `.docx`, `.pptx`, `.xlsx` | Thay chữ trực tiếp trong XML của tệp. Mọi phần khác (font, cỡ, màu, bảng, ảnh, tiêu đề đầu/cuối trang, ngắt dòng, ngắt trang) giữ nguyên từng byte | **Giữ nguyên**, đã kiểm chứng (xem dưới) |
| `.pdf` có lớp chữ (xuất từ Word, trình duyệt, "Print to PDF"…) | Đọc chính xác từng dòng chữ cùng vị trí, **họ font, cỡ chữ, màu, đậm/nghiêng** từ lớp chữ (`pdftohtml`), không OCR; dịch, xóa chữ cũ và vẽ chữ dịch đè lên | **Gần đúng**: vị trí, cỡ, màu, đậm giữ theo PDF; họ font được vẽ bằng font tương đương cài sẵn (Arial thành Liberation Sans). **Đầu ra là PDF toàn ảnh, không còn chọn được chữ** |
| `.pdf` quét, `.png`, `.jpg`, `.webp` | Hai model OCR đọc chữ kèm vị trí, dịch, xóa chữ cũ và vẽ chữ dịch đè lên đúng góc nghiêng | **Gần đúng**: OCR không cho biết tên font nên chữ dịch dùng font không chân phủ ngôn ngữ đích |
| `.doc`, `.xls`, `.ppt` | Không hỗ trợ (định dạng nhị phân cũ) | Lưu sang `.docx`, `.xlsx`, `.pptx` trước |

Chữ dịch dài hơn chữ gốc có thể tràn ô, khung hoặc slide; công cụ liệt kê các dòng dài ra nhiều nhất. Font trong tệp giữ nguyên tên, nên ngôn ngữ cần ký tự mà font đó không có (Trung, Nhật, Hàn, một số font trang trí với tiếng Việt) có thể hiển thị thiếu chữ; báo cáo nêu font nào có sẵn trên máy nhưng không phủ ngôn ngữ đích.

### Điều đã được kiểm chứng

Cách kiểm chứng: dịch "đồng nhất" (đặt lại đúng chữ gốc), để LibreOffice dựng ảnh từng trang của tệp gốc và tệp đã qua xử lý, rồi so từng điểm ảnh.

- 3 định dạng với tệp do bộ test dựng: giống nhau từng điểm ảnh.
- 11 tệp thật có chữ do LibreOffice tạo từ mẫu có sẵn (3 DOCX từ mẫu thư và CV, 7 PPTX từ mẫu trình chiếu, 1 XLSX từ CSV): giống nhau từng điểm ảnh, số trang bằng nhau. Các mẫu còn lại (1 DOCX, 10 PPTX) chỉ có chỗ giữ chỗ rỗng nên không có chữ để dịch.
- Phép kiểm tra này đã tìm ra hai lỗi bố cục mà tệp tự dựng không bao giờ lộ: ngắt dòng PowerPoint có thuộc tính riêng (cỡ chữ quyết định chiều cao dòng) bị sinh lại mất thuộc tính, làm lệch 9/13 trang của một tệp; và hai khung nội dung `w:sdt` cùng định dạng bị gộp thành một khoảng nên khung thứ hai bị làm rỗng. Cả hai đã sửa, kèm hai sửa phòng ngừa (run rỗng bị xóa hẳn vì PowerPoint coi `a:r` thiếu `a:t` là lỗi; khoảng trắng nằm trong thẻ bọc khác thành khoảng riêng). Mỗi lỗi có test riêng.

Chưa kiểm chứng: mở tệp đầu ra bằng Microsoft Office (chỉ có LibreOffice); tệp Office do chính Microsoft Office tạo; tài liệu rất lớn hoặc có biểu đồ, SmartArt, theo dõi thay đổi phức tạp.

## Cách dùng

Chọn agent "Dịch tài liệu". Agent chọn bước đầu theo câu hỏi:

| Người dùng đưa | Agent làm |
|---|---|
| Tệp và ngôn ngữ | Dịch ngay |
| Tệp, chưa có ngôn ngữ | Hỏi một lần: English, Tiếng Việt, 中文, 日本語 (hoặc gõ ngôn ngữ khác) |
| Ngôn ngữ, chưa có tệp | Hiện ô nhập đường dẫn tệp |

Tệp tải lên đến với agent dưới dạng một dòng chữ gồm tên và đường dẫn đã lưu; công cụ đọc tệp theo đường dẫn đó qua dịch vụ `fs` của harness. Kết quả được lưu cạnh tệp gốc là `<tên>.<mã ngôn ngữ>.<đuôi>`, không ghi đè tệp có sẵn (`-2`, `-3`…), rồi bàn giao bằng `present`.

## Công cụ `doc_translate`

| Tham số | Ý nghĩa |
|---|---|
| `path` | Tệp cần dịch (bắt buộc) |
| `target_language` | Ngôn ngữ đích, ví dụ `English`, `Vietnamese`, `ja` (bắt buộc) |
| `source_language` | Ngôn ngữ của tệp; bỏ trống để model tự nhận |
| `glossary` | Danh sách `{ source, target }` thuật ngữ cố định; chỉ các thuật ngữ có trong lô mới được gửi đi |
| `verify_layout` | Tệp Office: dựng trước và sau bằng LibreOffice, so số trang (mặc định bật) |

Kết quả nói rõ đã ghi gì, bao nhiêu dòng dịch được hoặc lỗi, kiểm tra bố cục có chạy không, các dòng dài ra nhiều nhất, font nào có thể thiếu ký tự, và dòng nào bị gộp định dạng đậm/nghiêng/liên kết. Số trang bằng nhau không chứng minh bố cục giống hệt; công cụ chỉ báo điều đó, và agent được dặn không nói hơn.

## Thiết kế

### Đơn vị dịch

Mỗi **dòng** (đoạn chữ nằm giữa hai lần xuống dòng) là một đơn vị dịch. Ngắt dòng và ngắt trang là ranh giới và không bao giờ bị sửa, nên thuộc tính của chúng (ví dụ cỡ chữ quyết định chiều cao dòng trong PowerPoint) giữ nguyên. Các dòng của cùng một đoạn nằm liền nhau trong lô nên model vẫn thấy ngữ cảnh.

Trong một dòng, các run cùng định dạng và cùng phần tử cha được gộp thành một *khoảng*. Dòng có nhiều khoảng được gửi đi với dấu `⟦1⟧…⟦/1⟧` quanh từng khoảng; chữ dịch được ghi trở lại đúng run mang định dạng đó. Nếu model đổi thứ tự từ, mỗi khoảng vẫn giữ định dạng của nó (đổi `rPr` giữa các run), trừ khi run đó còn chứa dòng khác. Nếu model làm mất dấu, dòng được ghi vào khoảng dài nhất và đếm là "gộp định dạng"; chữ không bao giờ mất.

Các quy tắc rút ra từ tệp thật: run trong các thẻ bọc khác nhau (khung nội dung, siêu liên kết) không bao giờ gộp; run bị làm rỗng bị xóa hẳn khỏi PowerPoint và Excel (vì `a:r` và `r` cần có `t`); `a:t` của PowerPoint không nhận thuộc tính `xml:space`; chữ đã xóa theo dõi thay đổi (`w:del`) và nội dung dự phòng `mc:Fallback` không được dịch.

### Dịch theo lô, nhiều model, song song

`translationModels` liệt kê các model dịch theo thứ tự ưu tiên. Các lô được rải lần lượt qua các model (vòng tròn); model lỗi hoặc trả sai dạng thì chuyển lô sang model kế. Lô trả sai dạng JSON được chia đôi trước khi bỏ model. Dòng mất dấu định dạng được hỏi lại một lần. Các đoạn trùng chữ chỉ dịch một lần. Mỗi model có giới hạn song song riêng (`modelConcurrency`), mỗi yêu cầu có timeout `requestTimeoutMs`, đặt dưới giới hạn 60 giây của cổng nginx của endpoint staging; lỗi kết nối, hết giờ và HTTP 429/5xx được thử lại.

### PDF và ảnh

1. PDF được tách thành ảnh bằng `pdftoppm` (150 dpi); ảnh dùng thẳng.
2. **Từng trang của PDF được xét riêng**: `pdftohtml -xml` đọc lớp chữ một lần; trang có ít nhất `ocr.minLayerLetters` chữ cái dùng lớp chữ (chính xác, không tốn OCR, không có lỗi đọc sai), các trang còn lại đi OCR. Một PDF có trang chữ lẫn trang ảnh vẫn được xử lý đúng. Nếu `pdftohtml` lỗi, tool ghi chú và đọc mọi trang bằng OCR.
3. **Trang có lớp chữ**: mỗi dòng giữ họ font (đã bỏ tiền tố nhúng `ABCDEF+` và hậu tố `PS`/`MT`), cỡ, màu và đậm/nghiêng của PDF. Họ font được ánh xạ sang font tương đương số đo có sẵn qua `fc-match` (Times New Roman thành Liberation Serif); với chữ không phải Latin/Việt/Hy Lạp/Kirin (Nhật, Trung, Hàn, Thái, Ả Rập) họ font gốc không có glyph nên chọn font theo hệ chữ. Chữ dịch dài hơn được **giãn sang phải đến sát dòng kế bên cùng hàng** (tối đa 2,5 lần bề rộng gốc) thay vì co nhỏ, và chỉ co khi hết chỗ; dòng căn giữa không giãn.
4. **Trang OCR**: mỗi trang gửi đồng thời cho hai model: **PaddleOCR-VL với prompt `Spotting:`** trả từng dòng kèm bốn góc (ổn định, tọa độ theo góc nghiêng của trang, kể cả ảnh quét), và **một model đọc** (Qwen3-VL) trả chữ chính xác. Mỗi dòng giữ khung của Paddle và nhận chữ của model đọc, ghép bằng độ giống không tính dấu, rồi bằng tìm chuỗi con gần giống trên toàn văn (cho trường hợp model đọc gộp cả hàng bảng thành một dòng). Trên trang thử 24 dòng, Paddle một mình đọc đúng nguyên văn 20 dòng, model đọc 23, hai model ghép 24 trên bản sạch.
5. Chữ dịch được vẽ bằng Pillow: che chữ cũ bằng màu nền lấy mẫu quanh dòng, vẽ chữ dịch cỡ vừa khung (xoay theo góc nghiêng của dòng với trang OCR), font phủ đúng chữ viết của bản dịch (Latin, Trung, Nhật, Hàn, Thái, Ả Rập). Dòng chỉ gồm chữ số giữ nguyên.

## Cấu hình

Đặt dưới `config` của `dsh-doc-translator/tools` (preset đã điền sẵn endpoint của cài đặt này).

| Trường | Mặc định | Ý nghĩa |
|---|---|---|
| `baseUrl` | bắt buộc | Gốc endpoint kiểu OpenAI (`https://host/v1`) |
| `apiKeyEnv` | không | Tên biến môi trường chứa khóa; bỏ trống nếu endpoint không cần |
| `translationModels` | bắt buộc | Model dịch theo thứ tự ưu tiên |
| `modelConcurrency` | `{}` | Số yêu cầu đồng thời tối đa theo model |
| `defaultConcurrency` | 4 | Giới hạn cho model không có mục riêng |
| `batchConcurrency` | 6 | Số lô chạy cùng lúc |
| `batchChars`, `batchItems` | 2500, 40 | Cỡ một lô |
| `requestTimeoutMs`, `retries`, `retryDelayMs` | 50000, 2, 500 | Timeout và thử lại |
| `maxOutputTokens` | 4096 | Giới hạn token một câu trả lời |
| `maxFileBytes`, `maxArchiveBytes` | 50 MiB, 300 MiB | Giới hạn tệp và dung lượng giải nén (chống zip bomb) |
| `expansionWarn` | 1.5 | Báo các dòng dài ra từ mức này |
| `verifyLayout` | `true` | Bật kiểm tra số trang bằng LibreOffice |
| `ocr.spotModel`, `ocr.readModel` | bắt buộc | Model lấy vị trí dòng và model đọc chữ |
| `ocr.dpi`, `ocr.maxPages`, `ocr.pageConcurrency` | 150, 30, 4 | Độ phân giải, số trang tối đa, số trang đọc cùng lúc |
| `ocr.useTextLayer` | `true` | Dùng lớp chữ của trang PDF khi có, thay vì OCR |
| `ocr.minLayerLetters` | 20 | Trang có ít chữ cái hơn mức này trong lớp chữ được coi là ảnh và đi OCR |
| `toolTimeoutMs` | 900000 | Ngân sách thời gian một lần gọi |

## Yêu cầu trên máy

- Mọi tệp: Node, quyền truy cập endpoint.
- Kiểm tra bố cục Office: `soffice` (LibreOffice) và `pdfinfo`; thiếu thì bước này bị bỏ qua và kết quả ghi rõ "không kiểm tra".
- PDF và ảnh: `pdftoppm`, `pdfinfo`, `pdftohtml` (đều thuộc Poppler), `python3` với Pillow, và `fc-match`. Thiếu `pdftohtml` thì mọi trang PDF đi OCR và tool ghi chú điều đó.

## An toàn và quyền ghi

- Tệp đầu vào đọc qua dịch vụ `fs` của harness. Dịch vụ này chỉ ghi văn bản, nên tệp nhị phân đầu ra được ghi bằng mã của plugin sau khi kiểm tra **chính sách sandbox của phiên** (`assertWritable`): không ghi khi `read-only`; khi `workspace-write` chỉ ghi dưới thư mục làm việc hoặc thư mục ghi thêm, sau khi giải quyết liên kết tượng trưng. Đây là bản tự cài đặt quy tắc, không đi qua `dsh-tool-fs`. Model không chọn được đường dẫn đầu ra.
- `soffice`, `pdftoppm`, `pdfinfo`, `fc-list`, `fc-match` và `python3` chạy bằng `execFile` với danh sách đối số cố định, không qua shell, và không đi qua công cụ shell hay sandbox tiến trình của harness.
- Preset không có `dsh-tool-fs`, công cụ web hay shell: agent không đọc được nội dung tài liệu.
- Đường dẫn tệp phải nằm trên máy này; thư mục làm việc ở máy khác bị từ chối rõ ràng.
- Nội dung tài liệu được gửi tới endpoint đã cấu hình để dịch; không gửi nơi nào khác.

## Giới hạn

- Chữ dài ra có thể tràn; công cụ chỉ cảnh báo, không tự thu nhỏ chữ trong tệp Office.
- Tên trang tính, SmartArt, biểu đồ, chú thích và siêu dữ liệu không được dịch.
- Ngôn ngữ viết từ phải sang trái được dịch nhưng bố cục không được lật.
- Mỗi dòng giữa hai lần xuống dòng được dịch như một đơn vị riêng; câu bị xuống dòng thủ công có thể kém mạch lạc.
- **PDF luôn ra dạng PDF toàn ảnh**, kể cả khi bản gốc có lớp chữ: chữ không còn chọn hay tìm kiếm được. Giữ lớp chữ cần thư viện ghi PDF (ví dụ PyMuPDF) mà máy này chưa có.
- Trang có lớp chữ: họ font là font tương đương cài sẵn, không phải font nhúng; nghiêng và căn phải/căn đều là xấp xỉ; mỗi dòng của PDF được dịch riêng, nên câu bị ngắt giữa hai dòng có thể kém mạch lạc; chữ dịch dài hơn vẫn có thể phải co nhỏ khi dòng kế bên sát.
- Trang OCR: font xấp xỉ; nhận diện đậm/thường là phỏng đoán theo độ dày nét (hiệu chỉnh trên một trang, chưa chắc đúng với trang mờ); nền không đồng màu (ảnh chụp, gradient) che chữ cũ kém hơn nền trơn; lỗi OCR thành lỗi dịch.
- Tệp có mật khẩu, ZIP64 và nén kiểu lạ không đọc được.

## Kiểm thử

```sh
cd plugin/dsh-doc-translator
npm test
```

Chạy bằng `node --test`, không cần mạng. Gồm: đọc/ghi ZIP và XML (bao gồm tệp lỗi, mã hóa, zip bomb), phân tích và ghi lại OOXML (khoảng định dạng, đổi thứ tự, mất dấu, tab, ngắt dòng, khung nội dung, hộp văn bản, theo dõi thay đổi), client LLM (thử lại, timeout, hủy, giới hạn song song theo model), bộ dịch (lô, trùng lặp, xoay vòng model, chuyển dự phòng, chia lô, hỏi lại khi mất dấu), OCR (đọc tọa độ, ghép dòng, tìm chuỗi con), vào/ra có chính sách sandbox, vẽ chữ lên ảnh và PDF thật bằng Pillow, và so ảnh từng điểm ảnh bằng LibreOffice thật cho cả ba định dạng. Test cần LibreOffice, Poppler hoặc Pillow tự bỏ qua khi thiếu.

## Cấu trúc

| Tệp | Vai trò |
|---|---|
| `cordis.patch.yml` | Khai báo preset `document-translator` |
| `tools.js`, `translate-file.js` | Cấu hình, công cụ `doc_translate` và luồng xử lý một tệp |
| `zip.js`, `xml.js`, `ooxml.js`, `office.js` | Đọc/ghi gói Office, tách dòng và khoảng, ghi chữ dịch vào đúng run |
| `translate.js`, `llm.js` | Dịch theo lô nhiều model, client có giới hạn song song |
| `layer.js`, `ocr.js`, `scan.js`, `scripts/render_overlay.py` | PDF và ảnh: lớp chữ của PDF, OCR hai model, ghép dòng, vẽ chữ dịch |
| `io.js`, `proc.js` | Đọc/ghi tệp có kiểm tra sandbox, chạy chương trình ngoài |
| `verify.js`, `fonts.js`, `lang.js`, `summary.js` | Kiểm tra bố cục, kiểm tra font, ngôn ngữ, kết quả cho model |
| `skills/document-translation/SKILL.md` | Cách chọn bước đầu và cách báo kết quả trung thực |
