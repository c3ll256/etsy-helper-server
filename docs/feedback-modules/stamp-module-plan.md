# 印章模块改造计划（Stamp）

## 1. 目标

- 解决“上传任务历史不可查”
- 支持按订单粒度定位失败原因
- 导入时保存 `buyer_note_raw` 并在详情展示

## 2. 数据表

### `order_upload_jobs`
- `id` (bigserial, PK)
- `job_id` (varchar, unique)
- `user_id` (uuid, FK)
- `shop_name` (varchar, nullable)
- `file_name` (varchar)
- `status` (queued/processing/completed/failed/cancelled)
- `progress` (numeric(5,2))
- `total_rows` / `success_rows` / `failed_rows` (int)
- `error_message` (text, nullable)
- `started_at` / `finished_at` (timestamptz, nullable)
- `created_at` / `updated_at`

### `order_upload_job_items`
- `id` (bigserial, PK)
- `job_id` (varchar, FK -> `order_upload_jobs.job_id`)
- `order_id` (varchar, nullable)
- `transaction_id` (varchar, nullable)
- `sku` (varchar, nullable)
- `status` (success/skipped/failed)
- `reason` (text, nullable)
- `detail_json` (jsonb, nullable)
- `created_at` / `updated_at`

### `etsy_orders` 增量字段
- `buyer_note_raw` (text, nullable)

## 3. 后端改造

- 上传入口双写：
  - 实时进度：`JobQueueService`
  - 持久化：`order_upload_jobs`
- 每笔订单处理结果写 `order_upload_job_items`
- 状态查询策略：
  - `GET /orders/upload/:jobId/status` -> 内存优先，DB 兜底
- 新接口：
  - `GET /orders/upload-jobs`
  - `GET /orders/upload-jobs/:jobId/items`

## 4. 前端改造

- 印章/摇铃页面新增“上传任务历史”
- 支持查看任务下失败/跳过订单明细
- 订单详情展示 `buyer_note_raw`

## 5. 索引建议

- `idx_order_upload_jobs_user_created(user_id, created_at desc)`
- `idx_order_upload_jobs_status(status)`
- `idx_order_upload_job_items_job_id(job_id)`
- `idx_order_upload_job_items_status(status)`
- `idx_order_upload_job_items_order_id(order_id)`
