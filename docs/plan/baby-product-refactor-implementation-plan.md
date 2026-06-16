# 母婴模块改造实施计划（前后端）

## 1. 文档目标

基于以下输入文档，形成可评审、可执行的母婴模块改造计划：
- `server/docs/feedback-modules/baby-product-module-plan.md`
- `server/docs/feedback-refactor-master-plan.md`

本计划覆盖：
- 后端数据模型与 API 改造
- 前端 SKU 配置页与字典管理页改造
- 生成链路（Excel -> 解析 -> PPT）兼容迁移策略
- 分阶段交付与验收标准

## 2. 改造范围

### 2.1 In Scope（本次必须完成）

- 新增母婴颜色/图标字典与分组能力（后端 + 前端）
- `sku_configs` 改为绑定 `color_group_id` / `icon_group_id`
- 新增 `combo_overrides_json` 支持套组子 SKU 二级配置
- 生成链路读取优先级切换到新字段，并保留兼容兜底
- SKU 配置页改造：
  - 非套组：绑定颜色组/图标组
  - 套组：维护子 SKU 覆盖配置（`combo_overrides_json`）
- 补齐接口文档、迁移脚本、基础测试

### 2.2 Out of Scope（本次不做）

- 基于向量/模糊语义的高级词典匹配
- 批量导入图标 zip 的复杂去重策略
- 复杂权限模型（仅做 admin / 普通用户现有模型延续）

## 3. 当前现状与差距

当前（代码基线）：
- 后端 `sku_configs` 仍使用 `yarnColorMap`（JSON）和 `comboItems`（string[]）。
- 生成链路在 `basket.service.ts` 中仅按 `yarnColorMap` 做颜色映射；`variation.icon` 为 LLM 解析结果，未绑定图标字典。
- 前端 `client/app/pages/sku-config/client.tsx` 以“毛线颜色替换键值输入 + 套组项字符串”为主，缺少“组绑定”和“套组二级覆盖”UI。

目标状态：
- 颜色与图标使用“字典项 + 分组”统一管理。
- SKU 配置引用组 ID，不再直接维护零散文本映射。
- 套组配置按子 SKU 结构化覆盖（jsonb），支持字体/颜色组/图标组独立覆写。
- 生成链路可在组内词典匹配图标并注入 PPT 参数。

## 4. 目标数据模型

## 4.1 新表

1. `color_groups`
- `id` bigserial PK
- `user_id` uuid not null
- `name` varchar not null
- `description` text null
- `product_type` varchar null (`basket`/`backpack`/`sweater`)
- `is_active` boolean default true
- `created_at` / `updated_at` timestamptz

2. `color_kv`
- `id` bigserial PK
- `user_id` uuid null（预留系统词典）
- `group_id` bigint not null FK -> `color_groups.id`
- `name` varchar not null（颜色原词 key）
- `color_value` varchar not null（替换值 value）
- `is_active` boolean default true
- `created_at` / `updated_at` timestamptz

3. `icon_groups`
- `id` bigserial PK
- `user_id` uuid not null
- `name` varchar not null
- `description` text null
- `is_active` boolean default true
- `created_at` / `updated_at` timestamptz

4. `icon_kv`
- `id` bigserial PK
- `user_id` uuid null（预留系统词典）
- `group_id` bigint not null FK -> `icon_groups.id`
- `name` varchar not null（图标词条）
- `file_name` varchar not null
- `file_path` varchar not null
- `mime_type` varchar not null
- `is_active` boolean default true
- `created_at` / `updated_at` timestamptz

## 4.2 现有表 `sku_configs` 变更

新增字段：
- `color_group_id` bigint null FK -> `color_groups.id`
- `icon_group_id` bigint null FK -> `icon_groups.id`
- `combo_overrides_json` jsonb null

`combo_overrides_json` 建议结构：
```json
{
  "CHILD-SKU-A": {
    "fontSize": 18,
    "colorGroupId": 12,
    "iconGroupId": 5
  },
  "CHILD-SKU-B": {
    "fontSize": 16
  }
}
```

说明：
- `CHILD-SKU-A` / `CHILD-SKU-B` 是套组中的子 SKU 标识，来源于用户在 `comboItems` 中填写的条目（或其标准化后的 SKU key）。

约束：
- `colorGroupId` / `iconGroupId` 必须是有效组 ID。
- 不允许把颜色值/图标路径等纯文本直接写入 overrides。

## 4.3 索引与唯一性建议

- `idx_color_groups_user_active(user_id, is_active)`
- `idx_color_groups_name(name)`
- `idx_color_kv_group_id(group_id)`
- `idx_color_kv_name(name)`
- `idx_icon_groups_user_active(user_id, is_active)`
- `idx_icon_groups_name(name)`
- `idx_icon_kv_group_id(group_id)`
- `idx_icon_kv_name(name)`
- `unique(user_id, sku)`（`sku_configs` 保持）
- `GIN (combo_overrides_json)`（按查询需求可选）

## 5. 后端实施方案（NestJS）

## 5.1 模块拆分

新增模块：
- `color-groups`
- `color-kv`
- `icon-groups`
- `icon-kv`

各模块标准能力：
- 列表（分页 + 搜索）
- 新增
- 更新
- 软删除（`is_active=false`）

权限策略：
- 普通用户：仅可管理自己的 `user_id` 数据。
- 管理员：可管理全量（含系统级 `user_id=null` 数据）。

## 5.2 API 契约（建议）

1. 颜色组
- `GET /baskets/color-groups?page=&limit=&search=&productType=`
- `POST /baskets/color-groups`
- `PUT /baskets/color-groups/:id`
- `DELETE /baskets/color-groups/:id`

2. 颜色字典
- `GET /baskets/color-kv?page=&limit=&search=&groupId=`
- `POST /baskets/color-kv`
- `PUT /baskets/color-kv/:id`
- `DELETE /baskets/color-kv/:id`

3. 图标组
- `GET /baskets/icon-groups?page=&limit=&search=`
- `POST /baskets/icon-groups`
- `PUT /baskets/icon-groups/:id`
- `DELETE /baskets/icon-groups/:id`

4. 图标字典
- `GET /baskets/icon-kv?page=&limit=&search=&groupId=`
- `POST /baskets/icon-kv/upload`（multipart，含 `name`、`groupId`、`file`）
- `PUT /baskets/icon-kv/:id`
- `DELETE /baskets/icon-kv/:id`

5. SKU 配置
- 复用现有：
  - `GET /baskets/sku-config`
  - `POST /baskets/sku-config`
  - `PUT /baskets/sku-config/:id`
  - `POST /baskets/sku-config/batch`
- DTO 增加：
  - `colorGroupId?: number`
  - `iconGroupId?: number`
  - `comboOverridesJson?: Record<string, { fontSize?: number; colorGroupId?: number; iconGroupId?: number }>`

## 5.3 生成链路改造（关键）

涉及文件：`server/src/basket/basket.service.ts`

改造点：
1. 在匹配 SKU 配置后解析“有效配置”：
- 优先：`combo_overrides_json[childSku]`（若为套组子 SKU）
- 次优：`sku_configs.color_group_id/icon_group_id/font_size`
- 兜底：`yarnColorMap`（兼容期只读）

2. 颜色映射：
- 若存在 `color_group_id`，先加载 `color_kv` 构建大小写无关 map。
- 再对 `analyzedVariations.color` 做替换。
- 若无组则 fallback 到 `yarnColorMap`。

3. 图标匹配：
- 若存在 `icon_group_id`，用 `variation.icon` 在该组 `icon_kv.name` 中匹配（大小写/trim 归一）。
- 命中后将 `icon_kv.file_path` 写入 PPT 数据（新增字段如 `iconFilePath`）。
- 未命中不阻塞，记录 debug 日志。

4. Python 参数：
- 在 `preparePPTData` 输出中加入图标文件路径字段。
- 同步调整 `basket_order_generator.py` 读取该字段并渲染（若当前模板已支持则仅映射字段名）。

## 5.4 兼容策略

- 读：`combo_overrides_json` > `color/icon_group_id` > `yarnColorMap`。
- 写：新前端只写新字段；`yarnColorMap` 不再新增写入。
- 迁移期内保留 `yarnColorMap` 字段与旧数据读取，防止存量配置失效。

## 6. 前端实施方案（Next.js）

## 6.1 API 层改造

新增：`client/api/basket-dictionaries.ts`（或并入 `client/api/basket.ts`）
- `ColorGroupsAPI`
- `ColorKvAPI`
- `IconGroupsAPI`
- `IconKvAPI`

扩展 `client/api/basket.ts`：
- `SkuConfig` 与 `CreateSkuConfigDto` 增加：
  - `colorGroupId?: number`
  - `iconGroupId?: number`
  - `comboOverridesJson?: Record<string, ...>`

## 6.2 页面改造

1. 现有页面 `client/app/pages/sku-config/client.tsx`
- 非套组表单：
  - 删除“手工 yarnColorMap 编辑区”作为主入口（保留只读兼容展示可选）
  - 新增“颜色组选择器”“图标组选择器”
- 套组表单：
  - `comboItems` 保留（子 SKU 列表）
  - 新增“子 SKU 覆盖配置表格”维护 `comboOverridesJson`
  - 每行支持设置 `fontSize/colorGroup/iconGroup`

2. 新增字典管理页面
- `/pages/basket-color-groups`
- `/pages/basket-color-kv`
- `/pages/basket-icon-groups`
- `/pages/basket-icon-kv`

能力要求：
- 列表/搜索/分页
- 新增/编辑/删除
- 图标字典支持上传预览

3. 侧边栏导航
- 在母婴菜单下新增“颜色组”“颜色字典”“图标组”“图标字典”入口。

## 6.3 交互与校验要求

- 选择组时显示 `group.name`，提交时写入 `group_id`。
- 当 `type=combo` 且配置了 overrides：
  - key 必须属于 `comboItems`。
  - 覆盖字段至少一个非空。
- 删除组时若被 SKU 引用：
  - 后端返回 400（或软删除并阻止活跃引用），前端提示“请先解除绑定”。

## 7. 数据迁移与发布策略

## 7.1 Migration 顺序

1. 新增四张字典表 + 索引。
2. 变更 `sku_configs` 新增 3 字段。
3. （可选）回填脚本：从已有 `yarnColorMap` 自动创建默认颜色组并回填 `color_group_id`。
4. 发布后端兼容读取逻辑。
5. 发布前端新 UI（仅写新字段）。

## 7.2 回滚策略

- 应用回滚：前端可回滚到旧版，后端仍兼容旧字段读取。
- 数据回滚：新表可保留不删；`sku_configs` 新列置空不影响旧逻辑。

## 8. 测试计划

## 8.1 后端

单元测试：
- 组/字典 CRUD 权限隔离
- `sku-config` DTO 校验（groupId、combo_overrides_json）
- 生成链路优先级选择与 fallback

集成测试（e2e）：
- 字典接口增删改查
- SKU 配置写入新字段后生成成功
- icon 命中/未命中场景

## 8.2 前端

- SKU 配置新增/编辑（非套组、套组）
- 子 SKU 覆盖配置编辑与提交
- 字典管理页上传/预览/删除
- 旧数据展示（仅 yarnColorMap）兼容不崩溃

## 8.3 回归

- `/pages/basket` 订单上传与任务轮询
- 生成结果下载与文件可用性
- 非母婴模块（印章/摇铃）不受影响

## 9. 验收标准

功能验收：
- 可独立管理颜色/图标字典与分组。
- SKU 配置能绑定组并保存。
- 套组可配置子 SKU 覆盖并生效。
- 生成链路按优先级读取，兼容存量数据。
- icon 词条命中后 PPT 使用对应图标路径。

非功能验收：
- 无跨用户读写越权。
- 字典查询分页性能稳定（索引命中）。
- 无阻断级回归（订单上传/生成主流程可用）。

## 10. 分阶段里程碑（建议）

1. P0（1-2 天）
- migration + entity + repository 接入
- 字典模块最小 CRUD

2. P1（2-3 天）
- `sku_configs` DTO / service / controller 扩展
- 生成链路接入 group 读取与 icon 匹配

3. P2（2-3 天）
- SKU 配置页改造（组绑定 + combo overrides）
- 字典管理页面与导航接入

4. P3（1-2 天）
- 联调、回归、文档完善（Swagger + 使用说明）

## 11. 风险与应对

- 风险：LLM 输出 icon 词与字典词条不一致导致命中率低。
- 应对：首版做标准化匹配（trim/lowercase/符号清洗），并记录未命中词用于后续补词。

- 风险：组被删除后导致 SKU 引用失效。
- 应对：服务端删除前做引用检查；有引用时拒绝删除并返回明确错误。

- 风险：前端一次性替换 old UI 导致用户迁移成本高。
- 应对：保留兼容显示区与“从旧映射迁移到颜色组”的辅助入口（可选按钮）。

## 12. 交付物清单

- 后端 migration 文件（5 张表/字段变更）
- 后端模块代码（color/icon groups + kv）
- `basket` 模块改造代码（DTO/Service/生成链路）
- 前端 API 与页面改造代码（SKU 配置 + 字典管理）
- 文档：Swagger 更新 + 联调说明 + 本实施计划
