---
name: marketing-plan
description: Lập phương án marketing từ kết quả khảo sát: STP, 4P/7P, phễu AARRR, kênh, ngân sách, KPI, lịch 90 ngày, kế hoạch thử nghiệm.
whenToUse: Dùng sau khi đã có brief và dữ liệu khảo sát, khi người dùng cần đề xuất chiến lược hoặc kế hoạch hành động marketing.
---

# Phương án marketing

Chỉ lập kế hoạch khi đã có brief và khảo sát (xem skill `market-research`). Thiếu dữ liệu thì quay lại khảo sát, không điền bằng phỏng đoán.

## 1. Chiến lược nền

- **Phân khúc (S)**: chọn 1-2 phân khúc có nhu cầu rõ và đối thủ phục vụ kém. Nêu lý do loại các phân khúc còn lại.
- **Mục tiêu (T)**: persona chính, quy mô phân khúc theo `marketing_calc` (`market_size`).
- **Định vị (P)**: một câu theo mẫu "Cho [persona] cần [nhu cầu], [sản phẩm] là [loại] mang lại [lợi ích chính], khác với [đối thủ] ở [điểm khác biệt có bằng chứng]".

## 2. Marketing mix

Dùng 4P cho sản phẩm vật lý, 7P (thêm con người, quy trình, bằng chứng hữu hình) cho dịch vụ. Mỗi chữ P một đoạn ngắn, mỗi quyết định phải truy được về một phát hiện trong khảo sát.

## 3. Phễu và kênh

Dựng phễu AARRR (Acquisition, Activation, Retention, Referral, Revenue). Với mỗi tầng ghi: hành động của khách, kênh phụ trách, chỉ số đo. Chọn tối đa 3-4 kênh cho giai đoạn đầu; nêu rõ kênh bị loại và lý do. Mỗi kênh nên nêu: đối tượng, thông điệp, hình thức nội dung, tần suất.

## 4. Ngân sách và hiệu quả

1. Chia ngân sách theo kênh bằng `marketing_calc` (`budget_split`) với trọng số bạn đề xuất kèm lý do.
2. Kiểm tra tính khả thi bằng `unit_economics` (LTV/CAC, thời gian hoàn vốn CAC) và `break_even`.
3. Với kênh quảng cáo trả phí, dùng `ad_return` để nêu ROAS cần đạt để hoà vốn.
4. Đặt các đầu vào là **[giả định]** và nêu khoảng nhạy cảm: kết quả đổi thế nào nếu CAC tăng 30% hoặc tỉ lệ chuyển đổi giảm một nửa.

## 5. KPI và lịch

- KPI gồm chỉ số dẫn dắt (traffic, lead, tỉ lệ chuyển đổi) và chỉ số kết quả (doanh thu, CAC, LTV). Mỗi KPI có mục tiêu, cách đo, tần suất xem lại.
- Lịch 90 ngày chia ba giai đoạn: 30 ngày chuẩn bị và thử nghiệm nhỏ, 30 ngày mở rộng kênh hiệu quả, 30 ngày tối ưu và quyết định tiếp tục hay dừng. Mỗi mốc có người phụ trách (vai trò) và tiêu chí dừng/tiếp tục.

## 6. Thử nghiệm

Mỗi giả thuyết lớn có một thử nghiệm: giả thuyết, biến thay đổi, chỉ số thành công, cỡ mẫu hoặc thời lượng tối thiểu, ngưỡng quyết định. Không kết luận từ dữ liệu quá nhỏ.

## 7. Rủi ro

Liệt kê 3-5 rủi ro lớn nhất (cạnh tranh phản ứng, phụ thuộc một kênh, quy định quảng cáo, chuỗi cung ứng) kèm dấu hiệu cảnh báo sớm và phương án giảm thiểu.

## Đầu ra

Ghi vào `report.md` theo skill `report-template`, mở đầu bằng đề xuất ngắn (≤ 10 dòng) để người ra quyết định đọc trước.
