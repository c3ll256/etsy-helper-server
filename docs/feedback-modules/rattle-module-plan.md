# 摇铃模块改造计划（Rattle）

## 1. 目标

- 提供可复用的摇铃 icon 资产库
- 在模板编辑时支持“从库选择 + 上传”
- 不引入 alias 机制（按用户直接选择已上传资产）

## 2. 数据表

### `rattle_icon_assets`

字段：
- `id` (bigserial, PK)
- `user_id` (uuid, nullable)
- `name` (varchar)
- `file_path` (varchar)
- `mime_type` (varchar)
- `width` / `height` (int, nullable)
- `is_active` (boolean, default true)
- `created_at` / `updated_at`

索引：
- `idx_rattle_icon_assets_user_active(user_id, is_active)`
- `idx_rattle_icon_assets_name(name)`

权限：
- 普通用户仅管理自己资产
- 管理员可管理系统资产

## 3. 后端改造

- 新建 `rattle-icon-library` 模块
- API：
  - `GET /rattle-icons`
  - `POST /rattle-icons/upload`
  - `DELETE /rattle-icons/:id`
- 上传链路复用现有文件存储能力

## 4. 前端改造

- 摇铃模板编辑器接入：
  - icon 库弹窗选择
  - 本地上传入库

## 5. 验收点

- 用户可看到自己已上传 icon
- 选中 icon 后模板保存可回显
- 删除 icon 后不影响其他用户资产
