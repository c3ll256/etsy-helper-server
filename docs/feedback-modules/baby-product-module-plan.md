# 母婴模块改造计划（Baby Product）

## 1. 目标

- 用“字典 + 组”管理颜色与 icon
- `sku_configs` 绑定组，不直接绑定明细词条
- 套组配置使用 `combo_overrides_json`（不新建覆盖表）
- Excel 导入后按组内词典匹配 icon，并用于 PPT 生成

## 2. 数据表

### `color_groups`
- `id` (bigserial, PK)
- `user_id` (uuid, FK)
- `name` (varchar)
- `description` (text, nullable)
- `product_type` (varchar, nullable)
- `is_active` (boolean)
- `created_at` / `updated_at`

### `color_kv`
- `id` (bigserial, PK)
- `user_id` (uuid, nullable)
- `group_id` (bigint, FK -> `color_groups.id`)
- `name` (varchar)        // key
- `color_value` (varchar) // value
- `is_active` (boolean)
- `created_at` / `updated_at`

### `icon_groups`
- `id` (bigserial, PK)
- `user_id` (uuid, FK)
- `name` (varchar)
- `description` (text, nullable)
- `is_active` (boolean)
- `created_at` / `updated_at`

### `icon_kv`
- `id` (bigserial, PK)
- `user_id` (uuid, nullable)
- `group_id` (bigint, FK -> `icon_groups.id`)
- `name` (varchar)
- `file_name` (varchar)
- `file_path` (varchar)
- `mime_type` (varchar)
- `is_active` (boolean)
- `created_at` / `updated_at`

## 3. 已有表改造

### `sku_configs` 新增字段
- `color_group_id` (bigint, FK -> `color_groups.id`, nullable)
- `icon_group_id` (bigint, FK -> `icon_groups.id`, nullable)
- `combo_overrides_json` (jsonb, nullable)

### `combo_overrides_json` 约束
- color/icon 必须存 `group_id`，不存纯文本
- UI 按 `group.name` 搜索，写回 `group_id`

示例：
```json
{
  "SKU-A": {
    "fontSize": 18,
    "colorGroupId": 12,
    "iconGroupId": 5
  }
}
```

读取优先级：
- `combo_overrides_json[childSku]`
- `sku_configs.color_group_id/icon_group_id`
- `yarnColorMap`（兼容期）

## 4. 后端改造

- 新增模块：
  - `color-kv`
  - `color-groups`
  - `icon-kv`
  - `icon-groups`
- 在母婴 Excel 解析链路：
  - 提取 icon 词
  - 在 SKU 绑定的 `icon_group` 范围内匹配 `icon_kv.name`
  - 命中后将 `icon_kv.file_path` 注入 PPT 参数

## 5. 前端改造

- 母婴配置页新增：
  - 颜色字典管理（kv）
  - 颜色组管理（groups）
  - icon 字典管理（kv）
  - icon 组管理（groups）
  - SKU 绑定组配置
- 套组编辑页写入 `combo_overrides_json`

## 6. 索引建议

- `idx_color_groups_name(name)`
- `idx_color_kv_group_id(group_id)`
- `idx_color_kv_name(name)`
- `idx_icon_groups_name(name)`
- `idx_icon_kv_group_id(group_id)`
- `idx_icon_kv_name(name)`
