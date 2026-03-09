# 毛衣订单改造实施计划（后端）

## 1. 文档目标

基于以下输入，形成本次“毛衣订单改造”的后端实施计划：

- `server/docs/feedback-modules/sweater-module-plan.md`
- `server/docs/feedback-modules/baby-product-module-plan.md`
- 样例源文件：`test-data/店铺后台源文件.xlsx`
- 样例目标文件：`test-data/需要生成的文件.xlsx`


本计划用于评审范围、确认数据结构和接口边界，评审通过后再开始开发。

## 2. 业务背景与目标

当前母婴订单域下已有两类产品：

- `basket`（篮子）
- `backpack`（背包）

本次需要新增第三类：

- `sweater`（毛衣）

同时补齐毛衣订单处理链路的 3 个核心能力：

1. SKU 配置
2. Excel -> Excel 转换
3. 自定义表头模板

其中颜色管理模块已经具备，本次不重复建设颜色字典能力，只在毛衣 SKU / 表头模板配置中引用现有颜色组与颜色词典。

## 3. 样例文件结论

### 3.1 源 Excel（店铺后台）

从 `test-data/店铺后台源文件.xlsx` 可确认，当前毛衣订单源数据至少包含以下关键列：

- `Order ID`
- `Variations`
- `SKU`
- `Quantity`
- `Buyer`
- `Ship Name`

样例 `Variations` 内容形态：

- `Sweater Color:Cream,Size:12-18 months,Personalization:1. ISLA noelle \n3. 09 Brown`
- `Sweater Color:Cream,Size:12-18 months,Personalization:Madelyn, 10 Rose Gold (first name)\nJames, 10 Rose Gold (middle name)`

本期这些源字段主要用于作为 AI 转换输入，由模型结合模板 JSON 产出目标结构。

### 3.2 目标 Excel（工厂格式）

从 `test-data/需要生成的文件.xlsx` 可确认，当前样例目标文件表头为：

- `单号`
- `码数`
- `毛衣颜色`
- `名字`

说明：

- 该文件仅作为当前工厂样例格式参考，不代表系统内置默认模板
- 实际转换前必须由用户先创建并选择一个表头模板
- 模板决定输出字段顺序、字段名称、字段描述及颜色组绑定关系

## 4. 当前代码现状

基于当前代码基线，现状如下：

### 4.1 已具备

- 前端颜色/图标字典产品类型枚举已经包含 `sweater`
  - `client/api/basket-dictionaries.ts`
- 后端母婴模块已有颜色组、颜色词典、图标组、图标词典能力
  - `server/src/basket/entities/color-group.entity.ts`
  - `server/src/basket/entities/color-kv.entity.ts`
  - `server/src/basket/entities/icon-group.entity.ts`
  - `server/src/basket/entities/icon-kv.entity.ts`

### 4.2 尚未具备

- 后端 `SkuType` 仍只有 `basket` / `backpack` / `combo`
  - `server/src/basket/entities/sku-config.entity.ts`
- 母婴订单生成入口 `orderType` 仍只有 `basket` / `backpack` / `all`
  - `server/src/basket/basket.controller.ts`
  - `server/src/basket/basket.service.ts`
- 当前母婴链路主要是 Excel -> 生成文件包 / PPT，不是毛衣所需的 Excel -> Excel
- 自定义表头模板仅在文档中提出，尚未落库与落接口

## 5. 改造原则

### 5.1 范围内

- 在母婴订单域内新增 `sweater` 产品类别
- 新增毛衣 SKU 配置能力
- 新增毛衣 Excel -> Excel 转换任务链路
- 新增毛衣表头模板配置能力
- 使用现有颜色管理模块完成颜色字段映射
- 支持用户先建模板、再选模板执行转换

### 5.2 暂不纳入

- 通用规则引擎 / DSL 化转换配置
- 不同工厂复杂脚本化转换逻辑
- 大规模历史数据回填
- 图标相关能力在毛衣链路中的扩展使用

### 5.3 设计原则

- 优先复用现有 `basket` 域基础设施（鉴权、任务轮询、上传下载、用户隔离）
- 毛衣转换以“模板 JSON + AI 转换 + 结果校验”实现，不在本期引入复杂规则引擎
- 颜色转换走现有颜色字典，不再在毛衣模块单独维护颜色表

## 6. 后端实施方案

## 6.1 产品类型与 SKU 扩展

目标：让毛衣成为母婴域下的正式产品类型，而不是临时分支逻辑。

实施建议：

- 扩展 `SkuType`，新增 `SWEATER = 'sweater'`
- 保持 `combo` 仅服务原母婴套组，不强行映射到毛衣
- 母婴生成入口 `orderType` 扩展为：
  - `basket`
  - `backpack`
  - `sweater`
  - `all`

涉及代码：

- `server/src/basket/entities/sku-config.entity.ts`
- `server/src/basket/dto/sku-config.dto.ts`
- `server/src/basket/basket.controller.ts`
- `server/src/basket/basket.service.ts`

## 6.2 毛衣 SKU 配置模型

毛衣 SKU 配置建议继续复用 `sku_configs` 主表，不单独新建一套 SKU 表。

每条毛衣 SKU 至少包含：

- `sku`
- `type = sweater`
- `replaceValue`：SKU 显示名 / 内部备注（可选）
- `colorGroupId`：引用颜色组，用于模板中的颜色字段映射
- `fontSize` / `font`：先保留，若后续工厂模板需要可复用
- `externalOrderReminderEnabled` / `externalOrderReminderContent`：沿用现有能力

毛衣 SKU 在本期不额外增加复杂字段，先通过“解析规则 + 模板配置”满足交付。

## 6.3 毛衣表头模板

按 `server/docs/feedback-modules/sweater-module-plan.md` 的方向，新增模板表。

建议表：`sweater_header_templates`

字段：

- `id`
- `user_id`
- `name`
- `header_config_json`
- `mapping_config_json`（本期建议启用，用于补充 AI prompt、字段约束或后处理配置）
- `is_active`
- `created_at`
- `updated_at`

### `header_config_json` 建议结构

```json
{
  "columns": [
    {
      "key": "orderId",
      "label": "单号",
      "description": "Etsy 订单号，用于工厂侧关联订单",
      "enabled": true,
      "order": 1,
      "colorGroupId": null
    },
    {
      "key": "size",
      "label": "码数",
      "description": "毛衣尺码，来自 SKU 或 Variations",
      "enabled": true,
      "order": 2,
      "colorGroupId": null
    },
    {
      "key": "color",
      "label": "毛衣颜色",
      "description": "颜色字段，输出工厂识别的颜色名",
      "enabled": true,
      "order": 3,
      "colorGroupId": 12
    },
    {
      "key": "name",
      "label": "名字",
      "description": "个性化名字内容，按模板要求输出",
      "enabled": true,
      "order": 4,
      "colorGroupId": null
    }
  ]
}
```

说明：

- `key` 固定绑定 canonical 字段
- `label` 定义导出 Excel 的列名
- `description` 必填，作为 AI prompt 的字段说明
- `order` 支持列排序
- `enabled` 支持字段开关
- `colorGroupId` 用于给该字段绑定颜色字典；通常只有颜色相关字段需要绑定

本期模板不是系统预置默认模板，必须由用户自行创建后才能用于转换。

## 6.4 毛衣转换任务表

建议表：`sweater_transform_jobs`

字段沿用 `server/docs/feedback-modules/sweater-module-plan.md`：

- `id`
- `user_id`
- `template_id`
- `job_id`
- `input_file_name`
- `output_file_path`
- `status`
- `progress`
- `error_message`
- `started_at`
- `finished_at`
- `created_at`
- `updated_at`

用途：

- 记录异步 Excel 转换任务
- 支持任务轮询、历史查看、失败重试与结果下载

## 6.5 Excel -> Excel 转换链路

建议采用“毛衣独立任务入口 + 复用现有任务队列模式 + AI 转换”的方式实现。

建议链路：

1. 用户上传源 Excel
2. 选择已创建的毛衣表头模板
3. 后端创建 `sweater_transform_jobs`
4. 异步读取 Excel 行数据
5. 仅提取毛衣相关订单（可按 `SKU` 命中毛衣 SKU 配置）
6. 组装模板 JSON（字段顺序、字段名称、字段描述、字段颜色组绑定）
7. 将源 Excel 结构化内容 + 模板 JSON 作为 prompt 输入 AI
8. AI 输出符合模板语义的结构化 rows
9. 服务端做结果校验与颜色字典归一化
10. 按表头模板生成目标 Excel
11. 保存输出文件并返回下载地址

### AI 转换约束（本期）

基于当前确认信息，本期转换由 AI 完成，服务端负责提供稳定输入上下文与结果约束：

- 源 Excel 行数据需要先结构化后再送入模型
- 表头模板 JSON 必须完整包含：
  - 字段顺序
  - 字段名称
  - 字段描述
  - 字段绑定的 `colorGroupId`
- 颜色字段统一为单一 `color` 语义，不再区分“毛衣颜色”和“刺绣颜色”
- 服务端仍需在 AI 输出后做字段完整性校验、列顺序校验和颜色映射兜底
- 若 AI 输出不满足模板约束，应标记任务失败并记录可定位错误信息

## 6.6 API 设计

建议新增毛衣专属接口，避免和现有篮子 / 背包生成接口混杂。

### 模板接口

- `GET /sweater/header-templates`
- `POST /sweater/header-templates`
- `PUT /sweater/header-templates/:id`
- `DELETE /sweater/header-templates/:id`

### 转换任务接口

- `POST /sweater/transform`
- `GET /sweater/transform/:jobId/status`
- `GET /sweater/transform-jobs`
- `GET /sweater/transform-jobs/:id/download`

### 与现有母婴接口的关系

- 毛衣 SKU 配置仍建议复用 `GET/POST/PUT /baskets/sku-config`
- 仅在 `type = sweater` 维度扩展现有 SKU 管理
- 毛衣 Excel 转换不走 `POST /baskets/generate`

这样可以把“配置”和“任务处理”清晰拆开：

- SKU、颜色组等继续放在母婴配置域
- 毛衣 Excel 转换作为独立业务流实现

## 6.7 数据库迁移

建议迁移步骤：

1. 扩展 `sku_configs.type` 枚举，新增 `sweater`
2. 创建 `sweater_header_templates`
3. 创建 `sweater_transform_jobs`
4. 为模板名、任务状态、用户维度补索引

建议索引：

- `unique(user_id, name)` on `sweater_header_templates`
- `idx_sweater_header_templates_user_active(user_id, is_active)`
- `unique(job_id)` on `sweater_transform_jobs`
- `idx_sweater_transform_jobs_user_created(user_id, created_at desc)`
- `idx_sweater_transform_jobs_status(status)`

## 7. 交付阶段

### Phase 1：数据模型与接口骨架

- 新增 `sweater` SKU 类型
- 建立毛衣模板表和任务表
- 完成模板 CRUD 接口
- 完成转换任务创建 / 查询 / 下载接口骨架

### Phase 2：用户模板跑通

- 按样例文件跑通 Excel -> Excel
- 打通模板 JSON 入参到 AI prompt
- 接入颜色映射
- 按用户所选模板生成结果文件

### Phase 3：异常与可维护性补齐

- 行级错误定位
- 任务失败状态与错误提示
- 基础单元测试 / 集成测试
- 文档补充

## 8. 验收标准

### 8.1 功能验收

- 可在 SKU 配置中新增 `sweater` 类型 SKU
- 用户必须先创建至少 1 个毛衣表头模板，且每个字段必须填写描述
- 模板可保存字段顺序、字段名称、字段描述、字段颜色组绑定
- 上传 `test-data/店铺后台源文件.xlsx` 后，选择模板可生成目标 Excel
- 生成结果表头顺序与所选模板完全一致

### 8.2 任务链路验收

- 支持任务创建、状态轮询、结果下载
- 解析失败时返回明确错误信息
- 用户只能看到自己的模板和转换任务

### 8.3 技术验收

- 不影响现有 `basket` / `backpack` 订单能力
- 不破坏现有颜色组、颜色词典、SKU 配置逻辑
- 数据迁移可重复执行或具备明确回滚方案

## 9. 风险与待确认项

### 9.1 需确认

- 颜色字段已确认统一，不再区分“毛衣颜色”和“刺绣颜色”
- `Personalization` 是否存在更多格式，需要覆盖更多名字/线色组合规则
- 工厂是否只要求当前 5 列，还是后续会加 `SKU`、`数量`、`备注` 等列
- 模板是否只需“表头重命名 + 排序”，还是需要“字段映射到不同列集合”

### 9.2 风险

- `Personalization` 文本格式存在非标准输入，解析容错要预留
- 若直接复用现有母婴控制器，职责会继续膨胀，建议毛衣转换接口单独拆 controller/service
- 若后续工厂模板差异过大，`mapping_config_json` 可能需要在下一阶段真正启用

## 10. 推荐开发顺序

1. 先补 `sweater` SKU 类型与查询过滤
2. 再建模板表、任务表、接口骨架
3. 再实现源 Excel 解析与 canonical row 组装
4. 接入颜色字典映射
5. 最后生成目标 Excel、联调前端模板配置与任务页

## 11. 本次评审结论建议

建议按“母婴配置复用 + 毛衣转换独立任务流”的方案推进。

这样能兼顾：

- 对现有篮子/背包逻辑的最小侵入
- 对毛衣 Excel -> Excel 特殊链路的清晰建模
- 对后续多工厂表头模板扩展的可维护性
