# 毛衣模块改造计划（Sweater）

## 1. 当前范围

- 仅实现 `excel -> excel`
- 支持自定义表头模板
- 转换规则引擎暂不实现（但字段预留）

## 2. 数据表

### `sweater_header_templates`
- `id` (bigserial, PK)
- `user_id` (uuid, FK)
- `name` (varchar)
- `header_config_json` (jsonb)
- `mapping_config_json` (jsonb, nullable) // 先保留
- `is_active` (boolean)
- `created_at` / `updated_at`

### `sweater_transform_jobs`
- `id` (bigserial, PK)
- `user_id` (uuid, FK)
- `template_id` (bigint, FK -> `sweater_header_templates.id`)
- `job_id` (varchar, unique)
- `input_file_name` (varchar)
- `output_file_path` (varchar, nullable)
- `status` (pending/processing/completed/failed/cancelled)
- `progress` (numeric(5,2))
- `error_message` (text, nullable)
- `started_at` / `finished_at` (timestamptz, nullable)
- `created_at` / `updated_at`

## 3. 后端改造

- 模板 CRUD：
  - `GET /sweater/header-templates`
  - `POST /sweater/header-templates`
  - `PUT /sweater/header-templates/:id`
  - `DELETE /sweater/header-templates/:id`
- 转换任务：
  - `POST /sweater/transform`
  - `GET /sweater/transform/:jobId/status`
  - `GET /sweater/transform-jobs`

## 4. 前端改造

- 毛衣页面新增：
  - 模板选择器
  - 转换任务历史
  - 结果文件下载

## 5. 索引建议

- `idx_sweater_header_templates_user_active(user_id, is_active)`
- `unique(user_id, name)`
- `idx_sweater_transform_jobs_user_created(user_id, created_at desc)`
- `idx_sweater_transform_jobs_status(status)`
