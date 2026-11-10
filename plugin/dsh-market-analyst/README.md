# dsh-market-analyst

Preset agent **Phân tích thị trường** cho DeepSeek Harness: thu thập dữ kiện về một thị trường hoặc ngành, phân tích cấu trúc, rồi đưa ra đánh giá **Hấp dẫn / Trung lập / Thận trọng** kèm mức tin cậy, kịch bản và điều kiện làm kết luận đổi. Số liệu vĩ mô lấy từ World Bank, phép tính đi qua `econ_calc`, kết luận lấy từ `econ_calc score`, không để model tự chọn.

Đây là phân tích tham khảo dựa trên dữ liệu công khai, không phải tư vấn đầu tư hay tài chính.

## Cài đặt

```sh
pnpm dsh plugin --profile web add link:/home/tungtd/deepseek-harness/plugin/dsh-market-analyst
pnpm dsh --profile web --dump-config   # xem các layer đã gộp, không khởi động
```

Khởi động lại `pnpm dsh web` nếu preset chưa hiện, rồi chọn **Phân tích thị trường** khi tạo phiên. Agent `standard` và agent Marketing không bị thay đổi.

## Hai preset

| Preset | Vai trò | Công cụ ghi file |
|---|---|---|
| `market-analyst` ("Phân tích thị trường") | Agent người dùng chọn. Hỏi brief, giao thu thập dữ kiện, phân tích, chấm điểm, ghi `assessment.md` | Có (`tool-fs`, `present`) |
| `market-analyst-researcher` ("Thu thập dữ kiện (nội bộ)") | Subagent do agent trên dựng, mỗi mảng một con. Trả bảng dữ kiện trong tin nhắn cuối | **Không** có `tool-fs`, `present` hay `subagent` |

Preset con không có công cụ ghi nên các subagent song song không thể ghi đè `assessment.md` hay ghi đè lẫn nhau. Đây là ràng buộc ở tầng công cụ: preset cha đặt `agentPreset: market-analyst-researcher` cho `dsh-tool-subagent`. Preset con vẫn có thể hiện trong danh sách chọn preset của giao diện; chưa thấy cách ẩn.

## Thành phần

| Thành phần | Vai trò |
|---|---|
| Skill `market-structure` | Thu thập dữ kiện theo 3 mảng, cung cầu, co giãn, HHI, năm lực lượng, rào cản, chu kỳ ngành |
| Skill `assessment-rubric` | Chấm 4 trục và độ tin cậy dữ liệu, kết luận, 3 kịch bản, điều làm kết luận đổi |
| Skill `analysis-report` | Khung `assessment.md`, tách Dữ kiện / Suy luận / Giả định, trích nguồn |
| Công cụ `econ_indicator` | Chỉ số kinh tế theo năm của World Bank, kèm năm, ngày cập nhật và URL để trích |
| Công cụ `econ_calc` | `growth`, `concentration`, `elasticity`, `npv_irr`, `deflate`, `score` |

## `econ_indicator`

Bí danh: `gdp_growth`, `inflation`, `gdp_per_capita`, `population`, `urban_share`, `lending_rate`, `fx_rate`, `unemployment`, `internet_users`. Mã World Bank bất kỳ (ví dụ `NY.GDP.MKTP.KD.ZG`) cũng dùng được.

Hạn chế:
- Dữ liệu theo năm, cấp quốc gia, công bố có độ trễ khác nhau theo chỉ số. Ví dụ lãi suất cho vay của Việt Nam mới nhất là 2023, trong khi tăng trưởng GDP đã có 2025. Kết quả luôn có `latestYear`.
- Không có số liệu ngành hay doanh nghiệp. Phần đó vẫn dựa vào `web_fetch` trang nguồn cụ thể.
- Yêu cầu N năm nhưng World Bank có thể chỉ có ít giá trị hơn; kết quả chỉ chứa các năm có dữ liệu.

## `econ_calc score`

Chấm 4 trục từ 1 đến 5 theo thứ tự: quy mô và tăng trưởng, cường độ cạnh tranh, rào cản và kinh tế đơn vị, rủi ro vĩ mô. Điểm tổng hợp là trung bình có trọng số. Độ tin cậy dữ liệu (1 đến 5) không tham gia điểm tổng hợp, chỉ quyết định mức tin cậy.

Điểm đúng bằng ngưỡng thì rơi vào mức bên trong: điểm 3,5 là "Hấp dẫn", điểm 2,5 là "Thận trọng".

## Cấu hình

Đặt trong `cordis.patch.yml` của profile bằng cách nhắm vào row `analyst-tools` của preset (xem ghi chú đầu `cordis.patch.yml` của plugin: `config.plugins` thay toàn bộ danh sách, nên cần khai lại mọi thành phần muốn giữ).

| Trường | Mặc định | Ý nghĩa |
|---|---|---|
| `defaultCountry` | `VN` | Quốc gia khi model không nêu |
| `defaultYears`, `maxYears` | `10`, `30` | Số năm trả về mặc định và tối đa |
| `baseUrl`, `siteUrl` | World Bank | Địa chỉ API và trang dùng để dựng URL trích dẫn |
| `timeoutMs`, `retries`, `retryDelayMs` | `20000`, `2`, `500` | Thời hạn và thử lại khi mất kết nối |
| `hhiModerate`, `hhiHigh` | `1000`, `1800` | Ngưỡng HHI (hướng dẫn sáp nhập 2023 của Mỹ) |
| `scoreWeights` | `[1,1,1,1]` | Trọng số 4 trục |
| `verdictAttractive`, `verdictCautious` | `3.5`, `2.5` | Ngưỡng điểm cho "Hấp dẫn" và "Thận trọng" |
| `confidenceHigh`, `confidenceMedium` | `4`, `3` | Ngưỡng độ tin cậy dữ liệu cho mức "cao" và "vừa" |

Cấu hình sai (ví dụ `hhiModerate` không nhỏ hơn `hhiHigh`) làm plugin báo lỗi khi nạp.

## Giới hạn

- `web_fetch` chỉ lấy văn bản, không chạy JavaScript. Agent được dặn không mở trang kết quả tìm kiếm của Google hay Bing.
- Công cụ `web_search` chỉ xuất hiện khi nhà cung cấp tìm kiếm có credential. Khi thiếu, agent phải ghi điều đó vào báo cáo; độ tin cậy phần cạnh tranh và giá sẽ thấp.
- Kết quả web là dữ liệu không tin cậy. Persona dặn không làm theo chỉ dẫn trong đó, nhưng người đọc vẫn nên kiểm tra các số quan trọng.

## Phát triển

```sh
npm test   # node --test, không cần API key; test econ_indicator dùng fetch giả
```

`econ.js` và `indicator.js` là phần thuần, `tools.js` chỉ đăng ký công cụ và kiểm tra cấu hình, `skills.js` nạp `skills/*/SKILL.md` vào phạm vi preset. `skills.js` là bản sao của loader trong `dsh-marketing-studio`; nếu cần sửa chung, nên tách thành một module dùng chung.
