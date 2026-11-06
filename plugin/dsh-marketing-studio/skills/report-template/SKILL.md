---
name: report-template
description: Khung báo cáo marketing (report.md) và quy tắc trích nguồn, nhãn giả định, cách bàn giao cho người dùng.
whenToUse: Dùng khi viết hoặc hoàn thiện báo cáo khảo sát và kế hoạch marketing để bàn giao.
---

# Báo cáo marketing

Ghi báo cáo vào `report.md` ở thư mục làm việc. Viết bằng ngôn ngữ của người dùng, câu ngắn, ưu tiên bảng cho dữ liệu so sánh.

## Khung

```markdown
# [Tên dự án]: khảo sát thị trường và đề xuất marketing

_Ngày lập: [ngày] · Khu vực: [khu vực] · Tiền tệ: [mã tiền tệ]_

## 1. Tóm tắt điều hành
Đề xuất và 3-5 phát hiện quan trọng nhất. Tối đa 10 dòng.

## 2. Brief
Sản phẩm, khách hàng dự kiến, mục tiêu, ngân sách.

## 3. Khảo sát thị trường
Ma trận đối thủ, persona, PESTEL, Porter, SWOT, quy mô TAM/SAM/SOM.

## 4. Chiến lược và kế hoạch
STP, marketing mix, phễu và kênh, ngân sách, KPI, lịch 90 ngày, thử nghiệm, rủi ro.

## 5. Giao diện minh hoạ
Liên kết tới `mockup.html` và mô tả ngắn ý tưởng thiết kế.

## 6. Giả định và hạn chế
Liệt kê mọi giả định, dữ liệu không kiểm chứng được, mảng chưa khảo sát.

## 7. Nguồn
Danh sách đánh số: tiêu đề, URL, ngày truy cập.
```

## Quy tắc trích nguồn

- Dẫn nguồn ngay sau số liệu bằng số thứ tự, ví dụ `[3]`, khớp với mục Nguồn.
- Số không có nguồn phải mang nhãn **[giả định]** và xuất hiện lại trong mục "Giả định và hạn chế".
- Số tính ra từ `marketing_calc` ghi rõ đầu vào đã dùng; kết quả không được trình bày như dữ liệu đo được.
- Không cắt dán đoạn dài từ nguồn. Tóm tắt bằng lời của mình và dẫn URL.
- Nếu hai nguồn mâu thuẫn, nêu cả hai và cách bạn chọn.

## Trước khi bàn giao

- Mọi con số trong tóm tắt điều hành có nguồn hoặc nhãn giả định.
- Không còn chỗ trống kiểu "[điền]" hay "TBD".
- Phần nào chưa làm được thì ghi rõ trong mục 6, đừng bỏ qua im lặng.
- Gọi `present` cho `report.md` (và `mockup.html` nếu có), rồi tóm tắt cho người dùng 3-5 dòng kèm các câu hỏi mở cần họ quyết.
