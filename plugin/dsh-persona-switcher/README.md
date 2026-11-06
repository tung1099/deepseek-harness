# dsh-persona-switcher

Đổi nhân cách (persona) của agent DeepSeek Harness ngay trong cuộc trò chuyện. Mỗi session có persona riêng; đổi ở chat này không ảnh hưởng chat khác.

## Cài

```sh
cd ~/deepseek-harness
pnpm dsh plugin --profile web add link:/home/tungtd/deepseek-harness/plugin/dsh-persona-switcher
# tuỳ chọn: thêm persona Bác sĩ từ package riêng
pnpm dsh plugin --profile web add link:/home/tungtd/deepseek-harness/plugin/dsh-persona-doctor
```

Cả hai là bundle (`dsh.bundle`), nên tự được thêm vào profile. Khởi động lại `dsh web`.

## Dùng

| Cách | Ai dùng | Ví dụ |
|---|---|---|
| Thanh **Persona** ngay trên ô nhập chat | Người dùng | Bấm `⚖️ Luật sư` |
| Lệnh `/persona` | Người dùng | `/persona`, `/persona teacher`, `/persona default` |
| Tool `switch_persona` | Model | Khi người dùng nhờ chuyển vai, model tự gọi |

Persona mới áp dụng từ câu trả lời kế tiếp. `default` trả về persona gốc của agent preset (ví dụ "coding agent").

## Cách hoạt động

| Plugin (dòng trong `cordis.patch.yml`) | Vai trò |
|---|---|
| `persona-switcher` → `dsh-persona-switcher` | Service `ctx.personaSwitcher`: danh mục persona, lựa chọn theo session, ghi đè prompt |
| `persona-switcher-tool` → `…/tool` | Tool `switch_persona` |
| `persona-switcher-command` → `…/command` | Lệnh `/persona` |
| `persona-lawyer`, `persona-teacher` → `…/persona` | Mỗi dòng là một persona |
| `client.js` | Thanh chọn persona trên Web |

- **Prompt:** khi session chọn một persona, service đăng ký section `deployment:persona-prefix` trên **scope của agent đó** (`agent.ctx`). Section ở scope gần nhất thắng, nên nó che persona của preset chỉ cho agent này. Agent loop tự ghi system prompt mới thành `system/message`, nên mọi request vẫn dựng lại được từ log.
- **Lưu trữ:** lựa chọn được ghi thành record `plugin:persona-switcher/select` trong session log (không vào context của model). Mở lại session, fork, resume đều giữ persona. Danh mục persona đang cài được ghi vào `plugin:persona-switcher/catalog` khi nó thay đổi, để Web đọc qua projection `personaSwitcher`.
- **Web:** thanh chọn đọc projection, khi bấm thì chạy `/persona <id>` qua API lệnh có sẵn. Bấm nút hay gõ lệnh đều đi chung một đường và để lại cùng một dòng trong chat.

## Thêm persona

**Trong profile của bạn** (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: persona-psychologist
      name: dsh-persona-switcher/persona
      config:
        id: psychologist          # chữ thường, số, dấu gạch ngang
        name: Chuyên gia tâm lý
        icon: 🧠
        description: Lắng nghe và hỗ trợ cảm xúc
        prompt: |-
          You are a supportive listener ... running on the {{model}} model.
```

**Như một package cài thêm (marketplace):** xem `../dsh-persona-doctor`. Package đó chỉ có `package.json` (khai báo `dsh.bundle`) và một `cordis.patch.yml` chèn một dòng `dsh-persona-switcher/persona`, không có code. Persona cần thêm tool riêng thì viết plugin bình thường, `inject: ['personaSwitcher']` rồi gọi `ctx.effect(() => ctx.personaSwitcher.register({...}))`.

## Cấu hình và tắt

- Tắt tool để model không tự đổi persona: thêm `- id: persona-switcher-tool` + `disabled: true` vào patch của profile. Tắt một persona cũng làm tương tự với id của nó.
- Đổi nhãn "Default" bằng `config` của dòng `persona-switcher`: `defaultName`, `defaultIcon`, `defaultDescription`.

## Giới hạn

- Persona chỉ thay phần mở đầu prompt (và phần cuối nếu đặt `suffix`); bộ tool của preset giữ nguyên.
- Gỡ một persona đang được session dùng thì session đó tạm quay về persona preset. Record lựa chọn vẫn còn, nên cài lại thì persona trở lại.
- Thanh chọn chỉ hiện khi đã cài ít nhất một persona và session đã mở; chữ trên thanh là tiếng Anh/tên persona, chưa đi qua hệ thống ngôn ngữ của Web.
