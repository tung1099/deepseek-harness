# dsh-marketing-studio

Preset agent **Marketing** cho DeepSeek Harness: khảo sát thị trường có nguồn dẫn, vẽ mockup giao diện bằng HTML, đề xuất phương án marketing. Các con số tính toán đi qua công cụ `marketing_calc`, không để model ước lượng.

## Cài đặt

```sh
pnpm dsh plugin --profile web add link:/home/tungtd/deepseek-harness/plugin/dsh-marketing-studio
pnpm dsh --profile web --dump-config   # xem các layer đã gộp, không khởi động
```

Sau đó chọn preset **Marketing** khi tạo phiên. Agent `standard` không bị thay đổi: skill và công cụ của plugin chỉ được gắn vào preset này.

## Thành phần

| Thành phần | Vai trò |
|---|---|
| Preset `marketing` | Persona chiến lược gia, cùng `web_search`/`web_fetch`, ghi file, `ask_user_question`, `todo`, `subagent`, `present` |
| Skill `market-research` | Brief, chia mảng khảo sát, quy tắc chứng cứ, ma trận đối thủ, persona, PESTEL, Porter, SWOT |
| Skill `marketing-plan` | STP, 4P/7P, phễu AARRR, kênh, ngân sách, KPI, lịch 90 ngày, thử nghiệm, rủi ro |
| Skill `ui-mockup` | `mockup.html` đơn, biến CSS, responsive 375px/1280px, truy cập, bố cục landing page |
| Skill `report-template` | Khung `report.md`, trích nguồn, nhãn **[giả định]**, kiểm tra trước khi bàn giao |
| Công cụ `marketing_calc` | `market_size`, `unit_economics`, `ad_return`, `break_even`, `budget_split` |

## Cấu hình

Đặt trong `cordis.patch.yml` của profile bằng cách nhắm vào id `preset-marketing`. `config.plugins` thay toàn bộ danh sách, nên cần khai lại mọi thành phần muốn giữ. Chỉnh preset trong trình soạn thảo Web cũng ghi đè theo cách này.

| Trường | Mặc định | Ý nghĩa |
|---|---|---|
| `marketing-tools` → `currency` | `VND` | Mã tiền tệ hiển thị cho kết quả tiền trong `marketing_calc` |

## Giới hạn

- `web_fetch` chỉ lấy văn bản, không chạy JavaScript; trang dựng bằng JS có thể trống.
- Kết quả web là dữ liệu không tin cậy. Model được dặn không làm theo chỉ dẫn trong đó, nhưng báo cáo vẫn cần người đọc kiểm tra các số quan trọng.
- Mockup là HTML tĩnh, chưa xuất sang Figma và chưa có ảnh chụp tự động.

## Phát triển

```sh
npm test   # node --test, không cần API key
```

`calc.js` là phần tính toán thuần; `tools.js` chỉ đăng ký công cụ; `skills.js` nạp `skills/*/SKILL.md` vào phạm vi preset.
