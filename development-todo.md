# Etsy Helper 系统优化开发 TODO 清单

## 项目概述
**开发周期**: 10天
**目标**: 根据用户反馈解决系统核心问题，提升用户体验

---

## 任务清单

### 第1-2天：摇铃制单核心问题修复

#### Task #1: 修复摇铃制单Icon设置繁琐问题
**任务描述**: 解决每单需手动上传icon、调整位置与大小的问题

**具体工作**:
1. 在stamps模块中创建icon库管理功能
2. 设计icon预设模板，包含大小、位置、间距等参数
3. 修改订单处理流程，支持从icon库中选择而非手动上传
4. 在前端界面添加icon库选择器
5. 实现icon模板的保存和复用功能

**涉及文件**:
- `src/stamps/stamps.controller.ts`
- `src/stamps/stamps.service.ts`
- `src/stamps/entities/stamp-template.entity.ts`
- `src/orders/services/order-processing.service.ts`

**预计工作量**: 2天

#### Task #2: 实现模板配置界面记忆功能
**任务描述**: 解决模板配置效率低的问题，停止自动刷新，支持连续修改模版

**具体工作**:
1. 修改模板编辑页面，取消保存后的自动刷新行为
2. 实现页面状态保持，用户可以连续编辑多个模板
3. 添加批量模板复制和修改功能
4. 优化模板列表的分页和搜索功能
5. 实现模板编辑的撤销/重做功能

**涉及文件**:
- `src/stamps/stamps.controller.ts`
- `src/stamps/dto/create-stamp-template.dto.ts`
- `src/stamps/dto/update-stamp-template.dto.ts`

**预计工作量**: 1.5天

---

### 第3-4天：毛线产品问题解决

#### Task #3: 优化毛线产品颜色配置管理
**任务描述**: 解决每个SKU都需单独设置颜色的问题，实现统一颜色管理和批量关联

**具体工作**:
1. 创建全局颜色管理模块
2. 实现按产品SKU分组的颜色配置功能
3. 设计毛线SKU分组管理界面
4. 实现颜色配置的批量关联功能
5. 添加颜色配置的导入导出功能

**涉及文件**:
- `src/basket/entities/sku-config.entity.ts`
- `src/basket/dto/sku-config.dto.ts`
- `src/basket/basket.controller.ts`
- `src/basket/basket.service.ts`

**预计工作量**: 2天

#### Task #4: 修复毛线产品信息识别问题
**任务描述**: 解决拆解顾客信息识别为多页内容和产品颜色重复识别的问题

**具体工作**:
1. 分析现有的信息解析逻辑，找出多页识别的原因
2. 优化变体解析服务，避免产品-毛线-产品颜色的重复识别
3. 集成多个AI模型进行信息识别，提高准确率
4. 实现信息识别结果的验证和纠错机制
5. 添加手动调整识别结果的功能

**涉及文件**:
- `src/orders/services/variation-parsing.service.ts`
- `src/orders/entities/order.entity.ts`
- `src/common/services/glm.service.ts`
- `src/common/services/ollama.service.ts`

**预计工作量**: 2天

---

### 第5-6天：字典功能和印章问题修复

#### Task #5: 实现毛线字典全局管理功能
**任务描述**: 实现毛线字典的全局变量功能，支持多个字典库和SKU共享

**具体工作**:
1. 设计毛线字典的数据结构，支持多个字典库
2. 实现通过筛选SKU匹配字典库的功能
3. 创建字典库管理界面，支持增删改查
4. 实现同一输出匹配不同输入字段的功能
5. 添加字典库的导入导出功能

**涉及文件**:
- `src/basket/entities/sku-config.entity.ts`
- `src/basket/dto/sku-config.dto.ts`
- `src/basket/basket.controller.ts`
- `src/basket/basket.service.ts`

**预计工作量**: 1.5天

#### Task #6: 修复印章上传报告追踪问题
**任务描述**: 解决上传报告以弹窗形式展示，关闭后无法找回的问题

**具体工作**:
1. 将弹窗形式的上传报告改为持久化存储
2. 创建上传历史记录页面，可查看所有上传记录
3. 实现上传失败单号的详细记录和查询功能
4. 添加上传报告的导出功能
5. 实现上传状态的实时更新和通知

**涉及文件**:
- `src/stamps/stamps.controller.ts`
- `src/stamps/stamps.service.ts`
- `src/orders/services/excel-processing.service.ts`

**预计工作量**: 1天

---

### 第7天：印章功能优化

#### Task #7: 优化印章上传进度条显示
**任务描述**: 解决大订单量或网络不稳定时进度条消失和重复上传的问题

**具体工作**:
1. 重新设计进度条组件，增强稳定性
2. 实现上传任务的断点续传功能
3. 添加上传冲突检测，避免重复上传
4. 优化网络异常时的错误处理
5. 实现上传任务的暂停和恢复功能

**涉及文件**:
- `src/stamps/stamps.controller.ts`
- `src/stamps/services/order-stamp.service.ts`
- `src/common/services/job-queue.service.ts`

**预计工作量**: 1天

#### Task #8: 修复相同SKU漏识别问题
**任务描述**: 解决同一订单下SKU相同但定制内容不同时，系统只识别到其中一个的问题

**具体工作**:
1. 分析现有SKU识别逻辑，找出漏识别的原因
2. 修改订单解析算法，支持相同SKU的多个定制内容
3. 实现基于定制内容的唯一性识别
4. 添加重复SKU的检测和处理机制
5. 优化订单数据结构，支持同SKU多变体

**涉及文件**:
- `src/orders/services/variation-parsing.service.ts`
- `src/orders/entities/order.entity.ts`
- `src/stamps/services/order-stamp.service.ts`

**预计工作量**: 1天

---

### 第8-9天：新功能开发

#### Task #9: 开发毛衣制单Excel转换功能
**任务描述**: 实现将店铺后台导出的订单excel转成给外部工厂的excel功能

**具体工作**:
1. 创建毛衣制单专用的Excel处理服务
2. 实现表头自定义名称和位置的配置功能
3. 建立绣线颜色和毛衣颜色的全局字典翻译
4. 实现毛衣SKU的筛选功能，支持增加/删除SKU
5. 创建独立的毛衣SKU库，与篮子摇铃分开管理

**涉及文件**:
- `src/orders/services/excel-export.service.ts`
- `src/orders/services/excel-processing.service.ts`
- `src/basket/entities/sku-config.entity.ts`

**预计工作量**: 2天

---

### 第10天：收尾和测试

#### Task #10: 修复外部订单逻辑问题
**任务描述**: 修复外部订单整体逻辑，实现外部订单SKU库和提示功能

**具体工作**:
1. 创建独立的外部订单SKU库管理功能
2. 实现外部SKU和PPT生成SKU的关联检测
3. 在订单界面右上角添加外部订单提示功能
4. 优化外部订单的处理流程
5. 添加外部订单的统计和报告功能

**涉及文件**:
- `src/orders/orders.controller.ts`
- `src/orders/orders.service.ts`
- `src/basket/entities/sku-config.entity.ts`

**预计工作量**: 1天

---

## 开发计划时间表

| 天数 | 任务 | 重点工作 |
|------|------|----------|
| 第1-2天 | Task #1, #2 | 摇铃制单Icon设置和模板配置优化 |
| 第3-4天 | Task #3, #4 | 毛线产品颜色管理和信息识别修复 |
| 第5天 | Task #5 | 毛线字典全局管理功能 |
| 第6天 | Task #6 | 印章上传报告追踪修复 |
| 第7天 | Task #7, #8 | 印章上传进度条和SKU识别修复 |
| 第8-9天 | Task #9 | 毛衣制单Excel转换功能开发 |
| 第10天 | Task #10 | 外部订单逻辑修复和整体测试 |

---

## 注意事项

1. **并行开发**: 某些任务可以并行进行，如Task #1和#2可以同时开发
2. **测试验证**: 每个任务完成后需要进行功能测试
3. **代码审查**: 重要功能需要进行代码审查
4. **文档更新**: 新功能需要更新相关文档
5. **备份数据**: 涉及数据结构变更的任务需要做好数据备份

---

## 成功标准

- [ ] 所有用户反馈的核心问题得到解决
- [ ] 新功能正常运行，无明显bug
- [ ] 系统性能没有明显下降
- [ ] 用户界面友好，操作流程优化
- [ ] 代码质量良好，可维护性强

---

*此TODO清单基于用户反馈文档制定，可根据实际开发进度进行调整*