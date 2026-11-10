---
name: analysis-report
description: Khung báo cáo đánh giá thị trường (assessment.md): tách Dữ kiện, Suy luận, Giả định, quy tắc trích nguồn và cách bàn giao cho người dùng.
whenToUse: Dùng khi viết hoặc hoàn thiện báo cáo đánh giá để bàn giao.
---

# Báo cáo đánh giá thị trường

Ghi báo cáo vào `assessment.md` ở thư mục làm việc. Viết bằng ngôn ngữ của người dùng, câu ngắn, dùng bảng cho dữ liệu so sánh. Chỉ agent chính được ghi file; subagent thu thập dữ kiện trả kết quả trong tin nhắn.

## Khung

```markdown
# [Thị trường hoặc ngành]: đánh giá

_Ngày lập: [ngày] · Khu vực: [khu vực] · Góc nhìn: [gia nhập / đầu tư / mở rộng]_

## 1. Kết luận
Một câu: **Hấp dẫn / Trung lập / Thận trọng**, mức tin cậy [cao / vừa / thấp], điểm tổng hợp [x/5].
Ba lý do quan trọng nhất, mỗi lý do một dòng.

## 2. Điểm theo trục
Bảng: trục, điểm, căn cứ (dữ kiện hoặc phép tính), [n] là số nguồn.

## 3. Dữ kiện
Bảng: dữ kiện, giá trị, năm, nguồn [n].

## 4. Phân tích
Cung cầu, cấu trúc cạnh tranh, rào cản, chu kỳ ngành. Mỗi nhận định ghi rõ là Suy luận và nêu dữ kiện làm căn cứ.

## 5. Kịch bản
Cơ sở, lạc quan, bi quan.

## 6. Điều gì làm kết luận đổi
2 đến 4 điều kiện quan sát được, kèm chỉ số theo dõi.

## 7. Giả định và hạn chế
Mọi giả định, dữ liệu chưa kiểm chứng, dữ liệu cũ, mảng chưa khảo sát.

## 8. Nguồn
Danh sách đánh số: tiêu đề, URL, ngày truy cập.

_Phân tích tham khảo dựa trên dữ liệu công khai, không phải tư vấn đầu tư hay tài chính._
```

## Ba loại câu

- **Dữ kiện**: có giá trị, đơn vị, năm và nguồn [n]. Ví dụ "Tăng trưởng GDP của Việt Nam năm 2025 là 8,02% [1]".
- **Suy luận**: kết luận bạn rút ra, mở đầu bằng "Suy luận:" hoặc nằm trong mục Phân tích, luôn trỏ về dữ kiện làm căn cứ.
- **Giả định**: điều bạn không có nguồn, gắn nhãn **[giả định]** và nhắc lại trong mục 7.

Số tính bằng `econ_calc` ghi rõ đầu vào đã dùng và là dữ kiện hay giả định. Kết quả `econ_calc` không phải dữ liệu đo được.

## Trích nguồn

- Dẫn nguồn ngay sau số liệu bằng số thứ tự [n], khớp mục Nguồn.
- Với `econ_indicator`, dùng URL trong dòng `Cite:` của kết quả và ghi năm của giá trị.
- Không cắt dán đoạn dài từ nguồn. Tóm tắt bằng lời của mình và dẫn URL.
- Hai nguồn mâu thuẫn thì nêu cả hai và cách bạn chọn.

## Trước khi bàn giao

- Kết luận, mức tin cậy và điểm trong mục 1 khớp đúng kết quả của `econ_calc` `score`.
- Mọi con số trong mục 1 và 2 có nguồn hoặc nhãn giả định.
- Không còn chỗ trống kiểu "[điền]" hay "TBD". Phần nào chưa làm được thì ghi rõ trong mục 7.
- Gọi `present` cho `assessment.md`, rồi tóm tắt cho người dùng 3 đến 5 dòng kèm các câu hỏi mở họ cần quyết.
