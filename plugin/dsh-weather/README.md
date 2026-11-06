# dsh-weather

Tool `weather` cho DeepSeek Harness: thời tiết hiện tại và dự báo theo ngày từ [Open-Meteo](https://open-meteo.com/) (API miễn phí, không cần key).

## Cài vào profile

```sh
cd ~/deepseek-harness
pnpm dsh plugin --profile web add link:/home/tungtd/dsh-weather
```

Package khai báo `dsh.bundle`, nên lệnh trên tự thêm bundle `dsh-weather` vào profile; không cần sửa `cordis.patch.yml`. Khởi động lại `dsh` để nạp. Gỡ: `pnpm dsh plugin --profile web remove dsh-weather`.

## Model gọi tool thế nào

| Tham số | Kiểu | Ý nghĩa |
|---|---|---|
| `location` | string | Tên nơi, ví dụ `Hà Nội`, `Tokyo` (chỉ tên, không kèm tỉnh/nước) |
| `country_code` | string | Mã nước ISO 2 chữ để thu hẹp `location`, ví dụ `VN` |
| `latitude`, `longitude` | number | Toạ độ, dùng thay cho `location` |
| `days` | integer | Số ngày dự báo, 1–16 |

Kết quả gồm nơi đã khớp (tên, vùng, nước, toạ độ, múi giờ), thời tiết hiện tại và từng ngày (nhiệt độ thấp/cao, mô tả theo mã WMO, lượng mưa, xác suất mưa).

## Cấu hình

Ghi đè trong `~/.dsh/profiles/<profile>/cordis.patch.yml` bằng dòng có `id: weather`. Một dòng patch thay **toàn bộ** `config`, nên chép đủ các trường bạn muốn giữ:

```yaml
- id: weather
  name: dsh-weather
  config:
    forecastDays: 5
    language: vi
    temperatureUnit: celsius
    windSpeedUnit: kmh
```

| Trường | Mặc định | Ý nghĩa |
|---|---|---|
| `forecastDays` | 3 | Số ngày khi model không truyền `days` (1–16) |
| `language` | `en` (bundle đặt `vi`) | Ngôn ngữ tên địa danh khi geocoding |
| `temperatureUnit` | `celsius` | `celsius` hoặc `fahrenheit` |
| `windSpeedUnit` | `kmh` | `kmh`, `ms`, `mph`, `kn` |
| `timeoutMs` | 15000 | Giới hạn thời gian một lần gọi tool, gồm cả thử lại |
| `retries` | 2 | Số lần thử lại khi lỗi kết nối (không thử lại lỗi HTTP) |
| `retryDelayMs` | 500 | Thời gian chờ trước mỗi lần thử lại, nhân với số lần |
| `forecastUrl`, `geocodingUrl` | API công khai của Open-Meteo | Đổi khi dùng server tự host hoặc gói thương mại |
| `apiKey` | trống | Key gói thương mại của Open-Meteo |

## Ghi chú

- Plugin gọi mạng từ process `dsh` (không qua sandbox của `bash`). Nếu mạng cần proxy, chạy `dsh` với `NODE_USE_ENV_PROXY=1` và `HTTPS_PROXY=...`.
- Geocoding chỉ lấy kết quả khớp nhất. Kết quả luôn ghi rõ nơi đã khớp; nếu sai nơi, model có thể gọi lại với `country_code` hoặc toạ độ.
