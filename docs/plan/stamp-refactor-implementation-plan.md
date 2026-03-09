# 印章模块后端实施计划（Stamp Backend）

## 1. 文档目的

基于以下输入文档，整理印章上传链路的后端实施计划，目标是把“仅内存可见的上传任务”升级为“可持久化、可追踪、可审计”的任务体系。

关联文档：
- `server/docs/feedback-refactor-master-plan.md`
- `server/docs/feedback-modules/stamp-module-plan.md`
- `server/docs/stamp-order-upload-logic-plan.md`

本计划聚焦 `server` 侧改造，同时明确对前端的接口契约、迁移顺序和验收边界。

## 2. 改造范围

### 2.1 In Scope（本次必须完成）
- 新增上传任务主表：`order_upload_jobs`
- 新增上传任务明细表：`order_upload_job_items`
- 为 `etsy_orders` 增加 `buyer_note_raw`
- 改造 `POST /orders/upload` 上传链路，在任务生命周期内双写：
  - 内存实时态：`JobQueueService`
  - 数据库持久态：`order_upload_jobs`
- 逐笔订单落库处理结果：`order_upload_job_items`
- 改造 `GET /orders/upload/:jobId/status` 为“内存优先，数据库兜底”
- 新增历史任务接口：
  - `GET /orders/upload-jobs`
  - `GET /orders/upload-jobs/:jobId/items`
- 在订单详情返回中补充 `buyer_note_raw`
- 权限隔离：普通用户仅可查看自己的上传任务与任务明细

### 2.2 Out of Scope（本次不做）
- 上传任务重试
- 上传任务取消后的断点恢复
- 任务告警、Webhook、消息通知
- 历史任务数据回填
- 独立后台任务队列系统替换（如 BullMQ）

## 3. 当前现状与问题定位

现状基线：
- 上传入口在 `server/src/orders/orders.controller.ts`
- 异步处理入口在 `server/src/orders/services/excel.service.ts`
- 实际 Excel 解析与订单处理位于 `server/src/orders/services/excel-processing.service.ts`
- 实时任务状态由 `server/src/common/services/job-queue.service.ts` 维护
- 订单明细实体为 `server/src/orders/entities/etsy-order.entity.ts`

当前问题：
- 上传任务状态仅存在内存中，服务重启或清理后历史丢失
- 无任务列表接口，无法查看历史上传记录
- 无逐单明细表，无法精确定位失败/跳过原因
- 买家备注未原文持久化，订单详情缺少排障信息

目标状态：
- 上传任务具备可查询历史、可分页展示、可查看失败明细的持久化能力
- 进度查询保持现有体验，但允许页面刷新或服务重启后继续查询
- 订单详情可展示上传时保存的 `buyer_note_raw`

## 4. 技术设计

### 4.1 数据库设计

新增表：`order_upload_jobs`
- `id` bigint PK
- `job_id` varchar unique
- `user_id` uuid FK -> `users.id`
- `shop_name` varchar nullable
- `file_name` varchar
- `status` varchar
- `progress` numeric(5,2) default 0
- `total_rows` int default 0
- `success_rows` int default 0
- `failed_rows` int default 0
- `error_message` text nullable
- `report_path` varchar nullable
- `started_at` timestamptz nullable
- `finished_at` timestamptz nullable
- `created_at` / `updated_at`

新增表：`order_upload_job_items`
- `id` bigint PK
- `job_id` varchar FK -> `order_upload_jobs.job_id`
- `order_id` varchar nullable
- `transaction_id` varchar nullable
- `sku` varchar nullable
- `status` varchar
- `reason` text nullable
- `detail_json` jsonb nullable
- `created_at` / `updated_at`

改造表：`etsy_orders`
- 新增 `buyer_note_raw` text nullable

索引：
- `unique(job_id)`
- `idx_order_upload_jobs_user_created(user_id, created_at desc)`
- `idx_order_upload_jobs_status(status)`
- `idx_order_upload_job_items_job_id(job_id)`
- `idx_order_upload_job_items_status(status)`
- `idx_order_upload_job_items_order_id(order_id)`

### 4.2 模块划分

建议继续落在现有 `orders` 模块内，不额外新开一级业务模块，避免把上传链路拆散。

建议新增内容：
- Entities
  - `server/src/orders/entities/order-upload-job.entity.ts`
  - `server/src/orders/entities/order-upload-job-item.entity.ts`
- DTO
  - `server/src/orders/dto/query-order-upload-jobs.dto.ts`
  - `server/src/orders/dto/query-order-upload-job-items.dto.ts`（如列表需要分页）
- Service（可拆分）
  - `server/src/orders/services/order-upload-job.service.ts`
- Controller 扩展
  - `server/src/orders/orders.controller.ts`
- Module 注册
  - `server/src/orders/orders.module.ts`

### 4.3 状态流与写入策略

#### 上传任务状态机
- `queued`
- `processing`
- `completed`
- `failed`
- `cancelled`

#### 双写原则
1. 创建任务：
- `JobQueueService.createJob(userId)` 保留
- 同时插入 `order_upload_jobs` 初始记录，状态为 `queued`

2. 开始处理：
- 更新 `order_upload_jobs.status = processing`
- 写入 `started_at`
- 同步 `file_name`、`shop_name`（若可从解析结果中拿到）

3. 处理中：
- 继续更新内存进度
- 在关键阶段按批更新 DB 的 `progress`、`total_rows`

4. 单条订单完成时：
- 为 success / skipped / failed 分别写入 `order_upload_job_items`
- 失败或跳过原因统一归一到 `reason`
- 原始上下文、模板匹配、解析异常等放入 `detail_json`

5. 全部完成：
- 更新 `order_upload_jobs.status = completed`
- 写入 `finished_at`、`report_path`
- 汇总 `success_rows`、`failed_rows`

6. 异常失败 / 用户取消：
- 更新 DB 为 `failed` 或 `cancelled`
- 写入 `finished_at` 与 `error_message`

### 4.4 buyer note 保存策略

目标：上传导入时，尽量保留 Etsy Excel 中买家备注原文，不参与复杂格式化。

建议：
- 在 Excel 行解析阶段提取原始 buyer note 字段
- 创建/更新 `etsy_orders` 时写入 `buyer_note_raw`
- 在订单详情查询返回结构中显式暴露该字段
- 前端缺值时展示为空，不做补算

### 4.5 API 契约

#### 1) `GET /orders/upload/:jobId/status`
行为：
- 先查 `JobQueueService`
- 若内存不存在，则查 `order_upload_jobs`
- 若查到 DB，返回与当前前端兼容的结构

返回建议：
- `status`
- `progress`
- `message`
- `result`（完成后可包含聚合统计）
- `error`

#### 2) `GET /orders/upload-jobs`
Query 建议：
- `page`
- `limit`
- `status`
- `dateFrom`
- `dateTo`
- `userId`（仅管理员可用）

返回：
- 分页列表，字段至少包含 `jobId/fileName/status/progress/totalRows/successRows/failedRows/createdAt/finishedAt/errorMessage`

#### 3) `GET /orders/upload-jobs/:jobId/items`
Query 建议：
- `page`
- `limit`
- `status`

返回：
- 当前任务下逐单明细分页
- 字段至少包含 `orderId/transactionId/sku/status/reason/detailJson/createdAt`

#### 4) `GET /orders/:id`
扩展：
- 订单详情结构补充 `buyerNoteRaw`
- 若当前接口已嵌套 `etsyOrder`，建议同时在 `etsyOrder.buyerNoteRaw` 中返回，减少前端兼容成本

## 5. 代码改造步骤（按顺序）

### 阶段 A：数据层落地
- 新建 migration：创建 `order_upload_jobs`、`order_upload_job_items`
- 新建 migration：为 `etsy_orders` 增加 `buyer_note_raw`
- 新增并注册 2 个 entity
- 确认 `orders.module.ts` 注入对应 repository

### 阶段 B：任务持久化服务
- 新增 `order-upload-job.service.ts`
- 收敛以下职责：
  - 创建任务记录
  - 更新任务进度/状态
  - 写入任务明细
  - 查询任务列表/任务明细
  - 将 DB 记录转换为前端兼容状态结构

### 阶段 C：上传主流程接入
- 改造 `excel.service.ts`
- 在 `processExcelFileAsync` 创建任务时同步落 DB
- 在 `processExcelFileWithProgress` 生命周期节点更新 DB
- 在 `excel-processing.service.ts` / `order-processing.service.ts` 中补逐单 item 写入点
- 统一 success / skipped / failed 的判定口径

### 阶段 D：查询接口扩展
- 在 `orders.controller.ts` 新增：
  - `GET /orders/upload-jobs`
  - `GET /orders/upload-jobs/:jobId/items`
- 改造 `GET /orders/upload/:jobId/status`
- 在 service 层实现用户隔离与管理员扩展查询

### 阶段 E：订单详情补充 buyer note
- 在 Excel 导入链路中写入 `buyer_note_raw`
- 改造订单详情查询返回 DTO / 映射逻辑
- 确保 `getOrderById` 响应包含该字段

### 阶段 F：文档与联调
- Swagger 补充新接口与字段说明
- 与前端确认分页结构、状态值和错误文案
- 更新后端实施文档与联调说明

## 6. 验收标准

### 6.1 功能验收
- 上传成功后，刷新页面仍能通过 `jobId` 查到状态
- 服务重启后，历史上传任务仍可通过列表接口看到
- 可查看指定任务下失败/跳过订单明细及原因
- 新导入订单的详情接口可返回 `buyer_note_raw`
- 普通用户无法查看其他用户的上传任务或明细

### 6.2 非功能验收
- 状态查询兼容现有前端轮询逻辑
- 上传高峰期下列表查询可命中索引，默认分页性能可接受
- 单条订单失败不会导致整批任务明细丢失
- 任务异常退出时主表状态可收敛为 `failed` 或 `cancelled`

## 7. 测试计划

### 7.1 单元测试
- `order-upload-job.service.ts`
  - 创建任务
  - 状态迁移
  - 权限过滤
  - 明细写入与分页查询
- `orders.service.ts` / 查询映射逻辑
  - `buyer_note_raw` 返回映射正确

### 7.2 集成测试（e2e）
- `POST /orders/upload` 创建任务成功
- `GET /orders/upload/:jobId/status` 内存命中 / DB 兜底均正确
- `GET /orders/upload-jobs` 分页与权限正确
- `GET /orders/upload-jobs/:jobId/items` 可返回失败明细
- 普通用户查询其他用户任务返回 403/404

### 7.3 手工回归
- 印章订单上传
- 摇铃订单上传（若复用同订单链路）
- 订单详情页查询
- 现有导出与印章生成流程

## 8. 风险与应对

- 风险：上传链路分散在多个 service，中途插入 DB 写入容易遗漏
- 应对：新增统一的 `order-upload-job.service.ts`，所有任务状态更新只走一个出口

- 风险：success / skipped / failed 口径不一致，导致汇总数与明细数不匹配
- 应对：先定义统一枚举和写入时机，再在 service 中集中汇总

- 风险：旧前端仍依赖 `pending/processing/completed/failed` 返回格式
- 应对：状态接口继续返回兼容结构，只在列表接口中新增更完整字段

- 风险：buyer note 来源列名在不同 Excel 模板中不稳定
- 应对：解析阶段先做兼容列名映射，无法识别时写空，不阻塞主流程

## 9. 交付物清单

- migration 文件（2 张新表 + `etsy_orders` 新字段）
- `order_upload_jobs` / `order_upload_job_items` entities
- `order-upload-job.service.ts`
- `orders.controller.ts` 新接口与状态兜底逻辑
- 上传链路双写改造
- Swagger 文档更新
- 测试用例与联调记录

## 10. 建议执行顺序

1. 先完成 migration + entity，锁定数据结构
2. 再完成任务持久化 service 与状态查询兜底
3. 再接入上传主链路与逐单明细写入
4. 再补订单详情 `buyer_note_raw`
5. 最后补测试、文档和前后端联调
