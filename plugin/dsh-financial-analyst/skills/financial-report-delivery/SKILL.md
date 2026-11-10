---
name: financial-report-delivery
description: Cách trình bày kết quả phân tích báo cáo tài chính: tin nhắn tóm tắt, bảng, nguồn, file báo cáo HTML có biểu đồ, và câu từ trung lập không khuyến nghị mua bán.
whenToUse: Dùng sau khi fin_report trả kết quả, khi viết phần trả lời cho người dùng và bàn giao file báo cáo.
---

# Trình bày kết quả phân tích báo cáo tài chính

Skill này chỉ nói về cách trình bày. Quy tắc nội dung nằm ở skill `financial-statement-analysis` và áp dụng cho mọi câu bạn viết: **chỉ phân tích và trình bày số liệu, không khuyến nghị mua, bán hay nắm giữ, không đưa giá mục tiêu, không kết luận cổ phiếu rẻ hay đắt.**

## Cấu trúc tin nhắn trả lời

Viết bằng ngôn ngữ của người dùng, mặc định tiếng Việt. Theo thứ tự:

1. **Một câu mở đầu**: mã, tên công ty, kỳ dữ liệu (TTM đến quý nào, năm tài chính gần nhất), ngày giá đóng cửa.
2. **Bảng chỉ số chính (TTM)**: P/E, ROE, biên lợi nhuận gộp, hoạt động và ròng, nợ phải trả / vốn chủ, nợ vay / vốn chủ; cột của công ty và cột trung vị cùng ngành. Ghi số công ty trong nhóm so sánh.
3. **Xu hướng nhiều năm**: hai đến ba gạch đầu dòng về doanh thu, lợi nhuận, biên và ROE, lấy từ bảng theo năm. Mô tả hướng và độ lớn, không đánh giá.
4. **Cờ bất thường**: mỗi cờ một gạch đầu dòng gồm con số và điều cần đọc thêm trong thuyết minh. Nếu không có cờ, nói vậy.
5. **Giới hạn**: nêu những ghi chú của công cụ có ảnh hưởng đến cách đọc (ngành phải mở rộng, công ty bị bỏ qua, dưới 3 công ty so sánh, ROE dùng vốn chủ cuối kỳ), và rằng nguồn là API không chính thức.
6. **Nguồn**: các URL trong mục nguồn của kết quả `fin_report`. Số liệu của các công ty cùng ngành nằm trong file báo cáo.
7. **File báo cáo**: gọi `present` với đường dẫn file `fin-report-<MÃ>.html` mà công cụ trả về, kèm mô tả một câu. Gọi `present` sau khi trả lời đã gần xong để file là bản cuối. Nếu kết quả ghi "Report file NOT written", không gọi `present`: nói với người dùng rằng file báo cáo không lưu được (kèm lý do công cụ nêu) và các số liệu ở trên vẫn đúng.
8. **Câu cuối cố định**: "Đây là phân tích số liệu từ báo cáo tài chính đã công bố, không phải khuyến nghị mua, bán hay nắm giữ."

Giữ ngắn. Biểu đồ và bảng đầy đủ nằm trong file báo cáo; tin nhắn chỉ cần đủ để đọc mà không mở file.

## Cách viết số

- Tiền: tỷ đồng, dấu chấm ngăn hàng nghìn, ví dụ "70.113 tỷ đồng".
- Tỷ lệ: phần trăm một chữ số thập phân, dấu phẩy thập phân. Chênh lệch giữa hai tỷ lệ phần trăm viết là "điểm %" (biên lợi nhuận tăng 3,8 điểm %), không viết là "%".
- Bội số (P/E, nợ/vốn chủ): hai chữ số thập phân với "lần" hoặc "x".
- Luôn kèm kỳ: "TTM đến 30/9/2026", "năm 2025".
- Số lấy từ công cụ thì giữ đúng giá trị; chỉ làm tròn khi trình bày.

## Câu từ trung lập

Dùng: "cao hơn", "thấp hơn", "tăng", "giảm", "lệch xa trung vị", "cần xem thêm thuyết minh".

Tránh, vì mang tính phán quyết hoặc khuyến nghị: rẻ, đắt, hấp dẫn, đáng mua, đáng lo, an toàn, nguy hiểm, tiềm năng, cơ hội, nên, không nên, khuyến nghị, mục tiêu, kỳ vọng tăng.

Nếu người dùng yêu cầu khuyến nghị, nói một câu rằng bạn chỉ phân tích số liệu và không đưa khuyến nghị, rồi trình bày số liệu liên quan. Không thay bằng lời gợi ý gián tiếp.

## Trường hợp đặc biệt

- **So sánh hai mã** (ví dụ FPT và CMG): gọi `fin_report` lần lượt cho từng mã, rồi trình bày một bảng cạnh nhau với số liệu TTM. Nói rằng nhóm so sánh ngành của hai mã có thể khác nhau.
- **Tool báo lỗi hoặc không hỗ trợ** (ngân hàng, chứng khoán, bảo hiểm, mã không tồn tại, mất kết nối): nói nguyên nhân bằng lời của công cụ và dừng. Không tự tìm số khác để thay.
- **Chưa biết doanh nghiệp nào**: không tự đoán. Làm theo bước 1 của skill `financial-statement-analysis` (hiện ô nhập bằng `ask_user_question` không có lựa chọn).
- **Người dùng muốn thêm số liệu từ nguồn khác**: có thể dùng `web_fetch` đọc trang công bố của doanh nghiệp, đặt kết quả trong phần riêng có URL, và không trộn vào bảng chỉ số tính từ `fin_report`.
