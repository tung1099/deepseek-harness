---
name: ui-mockup
description: Vẽ mockup giao diện (landing page hoặc màn hình sản phẩm) thành một file HTML đơn, responsive, có thể mở trực tiếp.
whenToUse: Dùng khi người dùng muốn xem giao diện minh hoạ cho sản phẩm, chiến dịch hoặc landing page.
---

# Mockup giao diện bằng HTML đơn

## 1. Trước khi vẽ

Xác định: mục đích trang (một hành động chính duy nhất), persona, thông điệp từ phần định vị trong `marketing-plan`, tông thương hiệu. Nếu chưa có thương hiệu, đề xuất bảng màu và cặp font rồi nêu rõ đó là đề xuất.

## 2. Quy ước kỹ thuật

- Một file `mockup.html`: CSS trong thẻ `<style>`, không phụ thuộc thư viện bên ngoài. Chỉ dùng font hệ thống hoặc `font-family` có phương án dự phòng.
- Khai báo màu, cỡ chữ, khoảng cách thành biến CSS trên `:root` (ví dụ `--color-bg`, `--color-primary`, `--space-4`). Không rải mã màu trong từng thẻ.
- Thẻ ngữ nghĩa: `header`, `main`, `section`, `footer`; một `h1`; thứ bậc tiêu đề liên tục.
- Responsive theo hướng mobile-first. Kiểm tra bố cục ở 375px và 1280px, không cuộn ngang. Dùng `grid`/`flex` và `clamp()` cho cỡ chữ.
- Khả năng truy cập: tương phản chữ/nền tối thiểu 4.5:1, thuộc tính `alt` cho ảnh, nút là `<button>` hoặc `<a>` có nhãn rõ, trạng thái focus nhìn thấy được.
- Ảnh minh hoạ dùng khối màu, SVG nội tuyến hoặc nhãn `[ảnh: mô tả]`. Không nhúng ảnh có bản quyền hay logo thật của bên thứ ba.
- Nội dung chữ viết bằng ngôn ngữ của thị trường mục tiêu. Nội dung giả (số liệu, lời chứng thực, tên khách hàng) phải ghi nhãn "mẫu" ngay trên trang.

## 3. Bố cục landing page gợi ý

1. Hero: tiêu đề nêu lợi ích, một câu phụ, một nút hành động chính.
2. Vấn đề và giải pháp: 3 ý, mỗi ý một biểu tượng và một câu.
3. Cách hoạt động: 3 bước.
4. Bằng chứng: số liệu có nguồn, đánh giá (nhãn "mẫu" nếu chưa thật).
5. Bảng giá hoặc ưu đãi, nếu có trong kế hoạch.
6. Câu hỏi thường gặp, 4-6 mục.
7. Lời kêu gọi cuối trang, lặp lại hành động chính.

Với màn hình sản phẩm (dashboard, app), bắt đầu từ luồng việc chính của persona rồi mới đến thành phần giao diện.

## 4. Hoàn tất

1. Ghi `mockup.html` bằng công cụ ghi file.
2. Rà soát lại mã: biến CSS có được dùng nhất quán, có chỗ nào tràn ngang ở 375px, mọi liên kết giả có `href="#"` rõ ràng.
3. Gọi `present` với `mockup.html` kèm mô tả một câu, cùng `report.md` nếu có.

Nói rõ với người dùng: đây là mockup tĩnh, chưa kết nối dữ liệu hay biểu mẫu thật.
