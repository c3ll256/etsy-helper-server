# 问题和解决方案

## 2026-03-04 会议记录更新（待确认版）

以下内容基于今天会议记录整理，用于替换之前“颜色/icon 单表直连”的方案。

### A. 字典 + 组（Dictionary + Group）统一模型

结论：

- 颜色、icon 都采用“字典项 + 组 + SKU 绑定组”的关系
- `sku_configs` 不再直接存具体颜色/icon 明细，而是绑定到对应组

---

### A1. 颜色模型（母婴）

关系链路：

- `sku_configs` -> `color_groups.id` -> `color_kv[]`

建议表设计：

1. `color_kv`（颜色字典项）
- `id` (bigserial, PK)
- `user_id` (uuid, nullable)  // null 为系统字典，非空为用户私有字典
- `name` (varchar)            // 如：狮子、兔子、lion、rabbit
- `file` (varchar, nullable)  // 如：狮子.jpg、兔子.jpg（按会议记录保留）
- `is_active` (boolean, default true)
- `created_at` / `updated_at`

2. `color_groups`（颜色组）
- `id` (bigserial, PK)
- `user_id` (uuid, FK)
- `name` (varchar)            // 如：中文组、英文组
- `description` (text, nullable)
- `color_kv_ids` (jsonb)      // 直接存该组关联的 color_kv.id 列表
- `is_active` (boolean, default true)
- `created_at` / `updated_at`

3. `sku_configs`（新增外键）
- 新增 `color_group_id` (bigint, nullable, FK -> `color_groups.id`)

示例（按会议描述）：

- `color_kv`：`(name=狮子,file=狮子.jpg)`, `(name=兔子,file=兔子.jpg)`
- `color_groups`：`中文组`
- `color_groups.color_kv_ids`：中文组关联「狮子、兔子」对应字典ID
- `sku_configs` 仅绑定 `中文组` 即可

---

### A2. icon 模型（母婴）

关系链路：

- `sku_configs` -> `icon_groups.id` -> `icon_kv[]`

建议表设计：

1. `icon_kv`（icon 字典项）
- `id` (bigserial, PK)
- `user_id` (uuid, nullable)
- `name` (varchar)            // 识别词主键，如 lion、rabbit、小兔子
- `file` (varchar)            // 如 lion.png / rabbit.png
- `is_active` (boolean, default true)
- `created_at` / `updated_at`

2. `icon_groups`（icon 组）
- `id` (bigserial, PK)
- `user_id` (uuid, FK)
- `name` (varchar)
- `description` (text, nullable)
- `icon_kv_ids` (jsonb)       // 直接存该组关联的 icon_kv.id 列表
- `is_active` (boolean, default true)
- `created_at` / `updated_at`

3. `sku_configs`（新增外键）
- 新增 `icon_group_id` (bigint, nullable, FK -> `icon_groups.id`)

生成链路（母婴 Excel -> PPT）：

1. 解析 Excel personalization，提取 `icon` 文本
2. 在 `sku_configs` 绑定的 `icon_group` 范围内做精确匹配（`name`）
3. 命中后取 `icon_kv.file`，写入 PPT 生成参数
4. Python 生成 PPT 时按 `file` 插入对应图片

---

### A3. 摇铃 icon（独立于母婴）

结论：

- 摇铃继续使用独立 icon 资产表（不与母婴共用）
- 不需要 alias 表，用户上传后直接选取即可

建议表：

- `rattle_icon_assets`
  - `id`, `user_id`, `name`, `file_path`, `mime_type`, `is_active`, `created_at`, `updated_at`

---

### B. 套组 SKUConfig 变更

结论：

- 套组二级配置不新建表，直接在 `sku_configs` 增加一个 JSON 字段

建议字段：

- `sku_configs.combo_overrides_json` (jsonb, nullable)

建议结构示例：

```json
{
  "SKU-A": {
    "fontSize": 18,
    "colorGroupId": 12,
    "iconGroupId": 5
  },
  "SKU-B": {
    "fontSize": 20,
    "colorGroupId": 13,
    "iconGroupId": 7
  }
}
```

读取优先级建议：

- 子 SKU override（`combo_overrides_json`） > `sku_configs` 默认配置 > 系统默认

---

### C. 毛衣类型产品（母婴子品类）

当前确认范围：

- 仅做 `excel -> excel`
- 需要“自定义表头模板”能力

建议新表：

1. `sweater_header_templates`
- `id` (bigserial, PK)
- `user_id` (uuid, FK)
- `name` (varchar)                   // 模板名称
- `header_config_json` (jsonb)       // 自定义表头定义
- `is_active` (boolean, default true)
- `created_at` / `updated_at`

2. `sweater_transform_jobs`（可选但建议）
- `id` (bigserial, PK)
- `user_id` (uuid, FK)
- `template_id` (bigint, FK -> `sweater_header_templates.id`)
- `status` (pending/processing/completed/failed)
- `input_file_name` (varchar)
- `output_file_path` (varchar, nullable)
- `error_message` (text, nullable)
- `created_at` / `updated_at`

---

### D. 待你确认的问题（基于临时会议记录）

1. `color_kv.file` 是否确实需要长期保留（颜色通常是文本映射，不一定需要文件）？
2. `icon` 匹配规则是否“仅精确匹配 name”，还是需要大小写不敏感/空格标准化？
3. 毛衣转换规则暂不实现，先只支持自定义表头模板。

# 摇铃模块

**icon 管理**

问题描述：

在摇铃模板编辑界面之中，有一个上传 icon 的功能，但是用户现在反馈，如果需要上传 icon 的话，每次都要从本地找。用户希望有一个 icon 库在我们的系统之中。这样的话可以先从 icon 库里面挑选icon，如果没有的话，我们再从本地上传。因为其实很多 icon 都是复用的。

期望功能：

添加一个系统内的 icon 库，可以从 icon 库之中选取icon，如果没有的话再从本地上传，上传后应该自动存储到 icon 库中。同时也可以直接对 icon 库进行上传，删除

**摇铃模版复制**

问题描述：

在摇铃模板复制界面的时候，当我点击一个模板进入复制，我们会进入到这个编辑摇铃模板界面。但是我们实际上业务是这样的，我们经常要创建好一个模板之后，要连续复制七八个模板，然后对这七八个模板进行微小的修改。而现在的操作是，每次我们复制编辑完毕之后，点击保存会创建一个新的模板。然后我们要继续从原来的模板之中复制保存，很复杂。所以用户希望，当我们复制模板的时候，我们要增加一个另存为的按钮，这样可以在不关闭当前编辑模版的情况下，通过另存为我们可以快速复制保存出多个模板，而不需要每次重复寻找模板，复制、保存。

期望功能：

更改复制模版的逻辑，当复制模版的时候，会读取原有模板的值，然后进入编辑界面，在这个编辑界面之中有一个另存为按钮，可以通过另存为按钮，在不关闭当前编辑界面的情况下，快速的保存新的模版。

# 母婴模块

毛线订单和书包订单都是母婴模块下的两类订单

**颜色管理**

问题描述：

现在的 SKUConfig 表中，有一个 yarnColorMapping 字段，也就是每个 SKU 可以配置期望拥有的颜色，然后这个颜色可能是多个。但是现在问题来了，可能有多个 SKU 其实是对应了同一组颜色，那么实际上 SKU 和颜色的对应关系是多对一的。当我们需要修改多个 SKU 的颜色时，得先找到这些 SKU 再逐一改色，很麻烦。

期望功能：

希望把 color mapping 字段抽取出来，做成一张独立的颜色表，并将颜色表里的颜色配置与 SKU config 建立多对一映射。

在此基础上，在母婴模块下新增“颜色编辑”页面，支持：

- 一键编辑整组颜色
- 为该组颜色增删对应 SKU

从而用更直观的方式管理颜色与 SKU 的对应关系。

**icon 管理**

问题描述：

在我们的过去产品之中，只有颜色管理。用户的定制是非常个性化的。，他们会给我们个性化的描述，用来描述他们下订单的颜色。我们会根据这个颜色去制作产品。然后现在我们新多了一个编辑选项，就是 icon 选项。用户可以在母婴订单里面，在个性化要求里面添加他们希望的 icon 。所以我们需要一个 新的表来存储 icon 这个表的就是 icon 的名字以及 icon 的实际的图片。这个我们会存储在服务器上，我们也需要一张表来存储它。然后 当用户告诉我们他们期望的 icon 的时候，我们要去匹配出这些 icon。

期望功能：

你可以阅读一下母婴订单的业务处理逻辑：导入 Excel 后，系统会读取里面的用户信息。之前我们只调用 AI 服务提取颜色信息，现在还要同时提取 icon 信息。生成 PPT 时，根据提取到的 icon 字段去 icon 表找到对应图标，再把实际图文件插入到生成的 PPT 中。考虑到需要维护新的 icon 表，以及解析 icon，你可以评估一下数据结构如何设计，以及如何处理识别代码来支持 icon。

**套组SKU 编辑问题**

问题描述：

前面提到书包和毛线都是母婴类别下面的两类产品，那么有些套组SKU会组合多个书包、毛线等 SKU，那么现在有一个编辑问题，针对字体大小、颜色、以及 icon 的，现在只能针对整体 SKU 编辑，应用到所有套组下面的分类 SKU

期望功能：

在套组编辑页面下，实现对特定 SKU 调整字体大小、颜色、icon 的功能

考虑到之后会实现 icon，重新设计颜色表，所以这里需要构思一下如何架构

总之需要实现一个类似二级编辑的效果，当添加了一个 SKU 之后，可以对这个 SKU 进行编辑，配置特定的字体大小、颜色、icon

# 印章模块

**印章订单上传**

问题描述：

上传表之后，无法查看历史过去上传状态

期望功能：

需要一个表来存储上传任务的情况（上传中，上传完成，失败），可以查看过去上传订单任务的完成情况

需要注意一下权限，普通用户只能看到自己店铺上传的

**备注解析问题**

期望功能：

在上传的excel 之中，希望解析一下用户的备注，现在没有解析到，解析了之后应该还要展示在订单详情之中

**SKU 识别遗漏问题**

问题描述：

这是一个bug：用户同一笔订单下了两个 SKU，但是定制内容不同，印章订单解析这里导致无法识别出第二个 SKU

**颜色描边功能缺失**

期望功能：

希望在图章编辑的时候，能够给文本描边添加一下描边颜色功能

给文字描边功能加上颜色描边功能

# 毛衣模块

是一个新的品类，但是还在需求确认阶段

期望功能：

1. excel to excel

    店铺订单转换成给工厂的订单，即实现一个 excel to excel 转换

    同时需要实现自定义表头的功能，因此可能会需要一个模板表

    多个json或者是表来存储不同的表头
    可能会存在键值映射规则

2. 管理颜色、icon

    同样是需要字典功能，也就是母婴下面的产品（背包、毛线）类似的颜色、icon 管理功能，方便我们管理颜色-SKU，icon等（在业务中，我们称管理这种映射的功能为字典功能）

3. 识别品类

    输⼊⽂件中会出现⾮⽑⾐sku, 需要增加sku筛选, 能⽀持增加/删除sku.
    需要和⽬前的篮⼦书包的sku识别机制⼀样, 只⽣成sku库⾥有的.
