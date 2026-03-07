# 摇铃模块改造实施计划（Rattle）

## 1. 文档目的

基于以下输入文档，形成可执行的摇铃模块实施计划：
- `server/docs/feedback-refactor-master-plan.md`
- `server/docs/feedback-modules/rattle-module-plan.md`

本计划聚焦后端为主，并明确与前端联调的接口契约与验收边界。

## 2. 改造范围

### 2.1 In Scope（本次必须完成）
- 新增摇铃 icon 资产库数据模型：`rattle_icon_assets`
- 新增摇铃 icon 资产库 API：
  - `GET /rattle-icons`
  - `POST /rattle-icons/upload`
  - `DELETE /rattle-icons/:id`
- 上传链路复用现有图片存储能力（本地 `uploads/icons`）
- 权限模型：普通用户仅可管理自己的资产；管理员可管理全局资产
- 与现有模板编辑能力兼容（前端可通过返回的 `file_path` 写入模板元素）

## 3. 现状与目标差距

现状：
- icon 上传后只返回路径，缺少资产表、缺少列表/删除接口、缺少用户隔离。

目标：
- 上传即入库，可查询、可删除、可按用户隔离，前端可在模板编辑中“从库选择 + 上传”。

## 4. 技术设计

### 4.1 数据库设计
新增表：`rattle_icon_assets`
- `id` bigint PK
- `user_id` uuid nullable
- `name` varchar
- `file_path` varchar
- `mime_type` varchar
- `width` int nullable
- `height` int nullable
- `is_active` boolean default true
- `created_at` timestamptz
- `updated_at` timestamptz

索引：
- `idx_rattle_icon_assets_user_active(user_id, is_active)`
- `idx_rattle_icon_assets_name(name)`

说明：
- `user_id = null` 预留系统级资产能力（管理员可维护）。

### 4.2 模块划分
建议新增 `rattle-icon-library` 模块：
- `entities/rattle-icon-asset.entity.ts`
- `dto/query-rattle-icons.dto.ts`
- `dto/upload-rattle-icon.dto.ts`（如需额外字段）
- `rattle-icon-library.controller.ts`
- `rattle-icon-library.service.ts`
- `rattle-icon-library.module.ts`

### 4.3 API 契约
1) `GET /rattle-icons`
- Query: `page`, `limit`, `search`（按 name）
- 行为：
  - 普通用户：仅返回 `user_id = currentUser.id` 的资产
  - 管理员：返回所有icon资产

2) `POST /rattle-icons/upload`
- `multipart/form-data`，字段 `file`
- 校验：与现有 icon 上传一致（类型/大小/实际内容）,要求填入name
- 行为：
  - 文件写入 `uploads/icons`
  - 新增 `rattle_icon_assets` 记录
  - 返回资产元数据（含 `id`、`filePath`、`name`）

3) `DELETE /rattle-icons/:id`
- 权限：
  - 普通用户只能删除自己的资产
  - 管理员可删除系统资产或指定资产
- 删除策略：
  - 数据先做软删除（`is_active=false`）
  - 文件物理删除作为异步/后续清理（避免误删影响历史模板）

## 5. 实施步骤（按顺序）

### 阶段 A：数据层落地
- 新建 migration：创建 `rattle_icon_assets` + 索引
- 新建 entity 并接入 TypeORM
- 本地 migration 执行验证

### 阶段 B：服务与接口
- 新建 `rattle-icon-library` 模块
- 实现列表/上传/删除 3 个接口
- 接入 JWT 与角色权限控制
- 统一错误码与返回结构（与现有接口风格一致）

### 阶段 C：与现有能力衔接
- 复用上传校验逻辑（避免重复代码，可抽到通用 util）
- 明确前端从资产库选择后写入模板 `textElements.icon.imagePath` 的约定
- 回归验证摇铃模板创建、编辑、预览

### 阶段 D：联调与验收
- 提供最小联调脚本（Postman/curl）
- 前端联调问题收敛
- 文档更新（Swagger + docs）

## 6. 验收标准

- 功能验收
  - 用户上传 icon 后，可在 `GET /rattle-icons` 看到该资产
  - 用户只能删除自己的资产
  - 删除后资产不再出现在列表中
  - 模板编辑流程可使用资产库 `file_path` 并正确预览

- 非功能验收
  - 上传类型与大小校验生效，非法文件被拒绝
  - 列表分页性能可接受（默认分页 + 索引命中）
  - 无跨用户资产越权读取/删除

## 7. 测试计划

- 单元测试
  - Service 权限分支（admin / normal user）
  - 删除软删逻辑
  - 查询过滤逻辑（search + user scope）

- 集成测试（e2e）
  - 上传成功/失败（格式错误、超限）
  - 列表分页与搜索
  - 删除鉴权

- 回归测试
  - `stamps/templates` CRUD
  - `stamps/preview` 预览路径加载

## 8. 风险与应对

- 风险：上传接口重复导致行为不一致
- 应对：抽象共用文件校验与落盘逻辑，减少双实现漂移

- 风险：删除资产影响历史模板渲染
- 应对：先软删除，文件不立即物理删除

- 风险：管理员与普通用户边界不清
- 应对：在 service 层做强约束，不仅依赖 controller 守卫

## 9. 交付物清单

- migration 文件（新增表与索引）
- `rattle-icon-library` 模块代码
- Swagger 接口文档
- 联调说明文档（示例请求/响应）
- 回归测试记录

## 10. 建议执行顺序（实际开发）

1. 先完成 migration + entity（确保数据结构稳定）
2. 再完成 3 个 API（最小可用）
3. 再做权限与测试补齐
4. 最后联调前端与文档收口
