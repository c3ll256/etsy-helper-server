# Feedback Refactor 模块拆分索引

本目录将主计划按业务模块拆分，开发时可直接进入对应模块文档。

## 文档清单

1. `rattle-module-plan.md`
- 摇铃模块：icon 资产库（无 alias）、模板编辑对接

2. `baby-product-module-plan.md`
- 母婴模块：颜色/icon 字典+组、SKU 绑定、combo 二级 JSON、Excel->PPT icon 匹配

3. `stamp-module-plan.md`
- 印章模块：上传任务历史持久化、任务订单明细、buyer note 原文解析

4. `sweater-module-plan.md`
- 毛衣子品类：excel to excel、自定义表头模板、转换任务记录

## 主计划

- 总览文档：`../feedback-refactor-master-plan.md`

## 使用建议

- 只做单模块开发：直接阅读对应模块文件
- 涉及跨模块影响（如 `sku_configs`/权限）：先看主计划再看模块文件
