---
name: assessment-rubric
description: Chấm điểm một thị trường theo 4 trục và độ tin cậy dữ liệu, rồi đưa ra kết luận Hấp dẫn, Trung lập hoặc Thận trọng kèm mức tin cậy và kịch bản.
whenToUse: Dùng sau khi đã có dữ kiện và phân tích cấu trúc, khi cần đưa ra đánh giá cuối cho người dùng.
---

# Chấm điểm và đánh giá

Chỉ đánh giá khi đã có dữ kiện (xem skill `market-structure`). Thiếu dữ kiện thì nói thiếu, không chấm bằng cảm tính.

## 1. Chấm điểm

Chấm từng trục từ 1 (bất lợi nhất cho một người mới vào) đến 5 (thuận lợi nhất). Mỗi điểm phải trích được dữ kiện hoặc phép tính đứng sau nó.

| Trục | 1 điểm | 3 điểm | 5 điểm |
|---|---|---|---|
| Quy mô và tăng trưởng | Nhỏ, hoặc tăng trưởng thực âm | Vừa, tăng trưởng thực quanh mức nền kinh tế | Lớn, tăng trưởng thực cao hơn nền kinh tế rõ rệt và bền |
| Cường độ cạnh tranh | Hãng chi phối hoặc chiến tranh giá | HHI vừa, cạnh tranh có khác biệt hoá | Phân tán, còn khoảng trống chưa ai phục vụ |
| Rào cản và kinh tế đơn vị | Vốn lớn, biên mỏng, khách khó giữ | Rào cản vừa, biên đủ sống | Rào cản thấp với người mới và biên tốt, hoặc có lợi thế bảo vệ được |
| Rủi ro vĩ mô | Lạm phát, tỉ giá, lãi suất hoặc quy định bất lợi và biến động mạnh | Có rủi ro nhưng kiểm soát được | Ổn định và thuận lợi |

Thêm một điểm riêng cho **độ tin cậy dữ liệu** (1 đến 5): 1 nghĩa là phần lớn là giả định, 3 nghĩa là các số chính có nguồn nhưng chỉ một nguồn, 5 nghĩa là mọi số chính có hai nguồn độc lập và còn mới. Điểm này không làm thị trường hấp dẫn hơn, nó chỉ quyết định mức tin cậy.

## 2. Kết luận

Gọi `econ_calc` `score` với `scores` (bốn điểm theo đúng thứ tự trong bảng) và `data_reliability`. Công cụ trả điểm tổng hợp, kết luận (Hấp dẫn, Trung lập hoặc Thận trọng) và mức tin cậy (cao, vừa hoặc thấp). Dùng đúng kết quả đó. Không tự đổi kết luận bằng lời; nếu bạn thấy kết luận sai, quay lại sửa điểm từng trục và giải thích vì sao.

## 3. Ba kịch bản

Mỗi kịch bản một đoạn ngắn, nêu giả định thay đổi so với kịch bản cơ sở và hệ quả:
- **Cơ sở**: các điều kiện hiện tại tiếp tục.
- **Lạc quan**: một biến số then chốt thuận lợi hơn (ví dụ cầu tăng nhanh hơn, hãng lớn rút bớt).
- **Bi quan**: biến số đó xấu đi (ví dụ lãi suất tăng, đối thủ giảm giá).

Nếu người dùng có dự án cụ thể và có dòng tiền ước tính, gọi `econ_calc` `npv_irr` cho từng kịch bản và nêu rõ dòng tiền là giả định của ai.

## 4. Điều gì làm kết luận đổi

Liệt kê 2 đến 4 điều kiện cụ thể, quan sát được, mà nếu xảy ra thì kết luận phải đổi (ví dụ "nếu hãng A vượt 40% thị phần thì cường độ cạnh tranh giảm xuống 2 điểm"). Mỗi điều kiện nêu rõ người dùng có thể theo dõi bằng chỉ số nào.

## 5. Giới hạn của đánh giá

- Đây là phân tích tham khảo dựa trên dữ liệu công khai, không phải tư vấn đầu tư hay tài chính.
- Kết luận thay đổi khi dữ liệu thay đổi. Ghi ngày lập và năm mới nhất của các số chính.
- Khi mức tin cậy là "thấp", nói thẳng rằng kết luận chưa nên dùng để ra quyết định và nêu dữ kiện nào cần bổ sung.
