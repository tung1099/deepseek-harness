---
name: document-translation
description: Dịch tệp (Word, PowerPoint, Excel, PDF quét, ảnh) sang ngôn ngữ khác bằng công cụ doc_translate, giữ font, cỡ chữ, màu và bố cục; nói đúng những gì đã được kiểm tra và những gì chỉ gần đúng.
whenToUse: Dùng trước khi gọi doc_translate và khi viết câu trả lời cho người dùng sau khi dịch.
---

# Dịch tài liệu

Việc dịch chạy hoàn toàn trong công cụ `doc_translate`. Bạn không đọc, không dịch và không dán nội dung tệp vào cuộc trò chuyện. Vai trò của bạn là xác định tệp và ngôn ngữ, gọi công cụ, rồi báo lại **đúng** những gì công cụ ghi.

## Chọn bước đầu

| Người dùng đưa | Bạn làm |
|---|---|
| Tệp và ngôn ngữ đích | Gọi `doc_translate` ngay, không hỏi gì thêm |
| Tệp, chưa có ngôn ngữ | Hỏi một lần bằng `ask_user_question` (id `language`, các lựa chọn English, Tiếng Việt, 中文, 日本語; người dùng có thể gõ ngôn ngữ khác) |
| Ngôn ngữ, chưa có tệp | Hỏi một lần bằng `ask_user_question` **không có `options`** để hiện ô nhập đường dẫn. Tệp người dùng tải lên đến với bạn dưới dạng một dòng chữ gồm tên và đường dẫn đã lưu; dùng đường dẫn đó |
| Không có gì | Hỏi tệp trước, rồi ngôn ngữ |

Không hỏi thêm về giọng văn, mục đích hay phong cách. Nếu người dùng đưa bảng thuật ngữ, truyền vào `glossary`.

## Mức độ giữ định dạng theo loại tệp

| Loại tệp | Cách làm | Giữ định dạng |
|---|---|---|
| `.docx`, `.pptx`, `.xlsx` | Thay chữ trực tiếp trong tệp; các phần còn lại giữ nguyên từng byte | Font, cỡ, màu, bảng, ảnh, tiêu đề đầu/cuối trang giữ nguyên. Công cụ có kiểm tra bằng LibreOffice (so số trang) |
| `.pdf` có lớp chữ | Đọc chính xác chữ, vị trí, họ font, cỡ, màu, đậm từ chính PDF (không OCR), dịch rồi vẽ chữ dịch đè lên | **Gần đúng**: cỡ, màu, đậm, vị trí theo PDF; họ font vẽ bằng font tương đương cài sẵn. PDF ra là PDF toàn ảnh nên **không còn chọn được chữ**, dù bản gốc chọn được |
| `.pdf` quét, `.png`, `.jpg`, `.webp` | Đọc chữ bằng OCR, dịch, xóa chữ cũ và vẽ chữ dịch đè lên | **Gần đúng**: OCR không cho biết tên font, nên chữ dịch dùng một font không chân hỗ trợ ngôn ngữ đích, đậm khi nét mực dày, màu mực gốc. Kết quả là ảnh; PDF ra là PDF toàn ảnh, không chọn được chữ |

Một PDF có thể lẫn trang có lớp chữ và trang quét; kết quả của công cụ cho biết mỗi loại bao nhiêu trang.
| `.doc`, `.xls`, `.ppt` | Không hỗ trợ | Báo người dùng lưu sang `.docx`, `.xlsx`, `.pptx` rồi dịch lại |

## Báo kết quả

Chỉ nói điều có trong kết quả của công cụ:

- **Tệp đầu ra** nằm ở đâu, và gọi `present` cho tệp đó.
- **Số dòng đã dịch**, dòng nào lỗi và vẫn giữ tiếng gốc.
- **Kiểm tra bố cục**: nếu công cụ ghi số trang trước và sau bằng nhau, nói rằng *số trang không đổi*, không nói rằng bố cục giống hệt. Nếu số trang đổi, nói rõ. Nếu công cụ ghi *không kiểm tra được*, nói là chưa kiểm tra.
- **Chữ dài ra** (tiếng Anh sang tiếng Việt thường dài hơn): chữ có thể tràn ô, khung hoặc slide. Nêu các dòng dài nhất mà công cụ liệt kê.
- **Font**: nếu công cụ ghi một font có sẵn trên máy nhưng không có chữ của ngôn ngữ đích, hoặc font chưa cài để kiểm tra, nói người dùng kiểm tra khi mở tệp. Với tiếng Trung, Nhật, Hàn, tệp giữ nguyên tên font cũ nên có thể thiếu ký tự nếu font đó không có.
- **Dòng bị gộp định dạng** (đậm, nghiêng, liên kết trong cùng một dòng): nêu số lượng.
- **Với PDF**: nói trang nào đọc từ lớp chữ và trang nào qua OCR, đúng như công cụ ghi. Nhắc rằng PDF ra không còn chọn được chữ (nói rõ điều này khi bản gốc có lớp chữ). Chỉ khi có trang OCR mới nhắc rằng lỗi OCR sẽ thành lỗi dịch và người dùng nên đối chiếu với bản gốc; trang đọc từ lớp chữ thì chữ gốc là chính xác. Các dòng chỉ gồm chữ số được giữ nguyên.

Không nói "giữ nguyên hoàn toàn", "giống hệt bản gốc" hay "không thay đổi gì". Nói những gì đã được kiểm tra.

## Giới hạn cần nêu khi liên quan

- Ngôn ngữ viết từ phải sang trái (Ả Rập, Do Thái) được dịch nhưng bố cục không được lật.
- Tên trang tính, hình dạng SmartArt, biểu đồ, chú thích và siêu dữ liệu tài liệu không được dịch.
- Mỗi dòng nằm giữa hai lần xuống dòng được dịch như một đơn vị riêng, nên một câu bị xuống dòng thủ công có thể kém mạch lạc hơn một đoạn liền.
- Tệp có mật khẩu hoặc mã hóa không đọc được.

## Khi công cụ báo lỗi

Nói cho người dùng điều công cụ ghi, bằng một hai câu dễ hiểu, rồi dừng. Bạn không có công cụ sao chép, di chuyển hay sửa tệp, nên đừng tìm cách vòng; đừng gọi lại công cụ với đúng các đối số cũ. Nếu lỗi là "file access denied" thì phiên đang bị hạn chế ghi: nói rõ điều đó để người dùng đổi chế độ hoặc chọn thư mục làm việc khác.
