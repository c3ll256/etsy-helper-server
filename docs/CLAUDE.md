# Etsy Helper Server - 后端项目概述

## 项目简介

Etsy Helper Server 是 Etsy Helper 系统的后端服务，基于 NestJS 框架构建的企业级订单管理 API 服务。专门处理 Etsy 订单导入、印章生成、母婴产品配置和用户管理等核心业务逻辑。

## 技术栈

### 核心框架
- **框架**: NestJS (Node.js 企业级框架)
- **语言**: TypeScript
- **数据库**: PostgreSQL + TypeORM
- **认证**: JWT + Passport
- **API 文档**: Swagger/OpenAPI

### 关键依赖
- **文件处理**: ExcelJS, XLSX, Multer
- **图像处理**: Canvas, Sharp
- **Python 集成**: 外部 Python 脚本调用
- **任务队列**: 自定义异步任务处理
- **安全**: bcrypt, helmet, CORS

### Python 依赖 (外部脚本)
- **图像处理**: Pillow, svgwrite
- **字体处理**: fonttools
- **文档生成**: python-pptx
- **二维码**: qrcode

## 核心功能模块

### 1. 认证与用户管理 (Auth & Users)
- JWT 令牌认证，24小时有效期
- 基于角色的访问控制 (admin/user)
- 用户与店铺关联管理
- 密码加密存储 (bcrypt)

### 2. 订单管理 (Orders)
- **Excel 导入**: 异步处理 Etsy 订单文件
- **订单状态管理**: 完整的状态流转控制
- **批量操作**: 支持大批量订单处理
- **任务队列**: 长时间运行任务的进度跟踪

**订单状态流程:**
```
STAMP_NOT_GENERATED → STAMP_GENERATED_PENDING_REVIEW → STAMP_GENERATED_REVIEWED/REJECTED
```

### 3. 印章系统 (Stamps)
- **模板管理**: 支持多种印章类型 (橡胶章、钢印、感光章等)
- **动态生成**: 基于模板和 Python 脚本的印章图像生成
- **字体管理**: 动态字体加载和映射
- **预览功能**: 实时模板效果预览
- **文件上传**: 背景图片和图标上传管理

**支持的印章类型:**
- 橡胶章 (rubber)
- 钢印 (steel)
- 感光章 (photosensitive)
- 自定义类型扩展

### 4. 母婴产品系统 (Basket)
- **SKU 配置**: 复杂的产品 SKU 映射管理
- **颜色映射**: 毛线产品颜色智能匹配
- **PPT 生成**: 通过 Python 脚本生成产品展示文档
- **远程地区检测**: 地理位置定价逻辑
- **外部订单提醒**: 订单处理提醒功能

### 5. 字体管理 (Fonts)
- 字体文件上传和存储
- 字体与印章模板的关联管理
- 动态字体加载支持

### 6. 任务队列系统 (Job Queue)
- 异步任务处理和进度跟踪
- 用户级别的任务隔离
- 任务取消和错误恢复
- 实时状态更新

## 项目结构

```
etsy-helper-server/
├── src/
│   ├── app.module.ts          # 主应用模块
│   ├── main.ts               # 应用入口点
│   ├── auth/                 # 认证模块
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   └── jwt.strategy.ts
│   ├── users/                # 用户管理模块
│   │   ├── users.controller.ts
│   │   ├── users.service.ts
│   │   └── entities/user.entity.ts
│   ├── orders/               # 订单管理模块
│   │   ├── orders.controller.ts
│   │   ├── orders.service.ts
│   │   └── entities/
│   │       ├── order.entity.ts
│   │       └── etsy-order.entity.ts
│   ├── stamps/               # 印章系统模块
│   │   ├── stamps.controller.ts
│   │   ├── stamps.service.ts
│   │   ├── services/python-stamp.service.ts
│   │   └── entities/stamp-template.entity.ts
│   ├── basket/               # 母婴产品模块
│   │   ├── basket.controller.ts
│   │   ├── basket.service.ts
│   │   └── entities/sku-config.entity.ts
│   ├── fonts/                # 字体管理模块
│   ├── common/               # 共享模块
│   │   ├── services/job-queue.service.ts
│   │   ├── decorators/
│   │   └── guards/
│   └── migrations/           # 数据库迁移文件
├── uploads/                  # 文件上传目录
├── scripts/                  # Python 脚本目录
├── dist/                     # 编译输出目录
└── docs/                     # 项目文档 (本地)
```

## 数据模型

### 核心实体关系

#### User (用户)
```typescript
interface User {
  id: string          // UUID 主键
  username: string    // 用户名
  password: string    // 加密密码
  isAdmin: boolean    // 管理员标识
  shopName?: string   // 关联店铺名称
  createdAt: Date
  updatedAt: Date
}
```

#### Order (订单)
```typescript
interface Order {
  id: string
  type: 'ETSY' | 'MANUAL' | 'OTHER'
  status: OrderStatus
  userId: string      // 关联用户
  stampTemplateId?: string
  etsyOrder?: EtsyOrder
  createdAt: Date
  updatedAt: Date
}
```

#### StampTemplate (印章模板)
```typescript
interface StampTemplate {
  id: string
  name: string
  type: string        // 印章类型
  skus: string[]      // 支持的 SKU 列表
  width: number
  height: number
  textElements: TextElement[]
  iconConfig?: IconConfig
  backgroundImage?: string
  isActive: boolean
}
```

#### SkuConfig (SKU 配置)
```typescript
interface SkuConfig {
  id: string
  sku: string
  yarnColorMapping: Record<string, string>
  fontConfig: FontConfig
  externalOrderReminder?: string
  isActive: boolean
}
```

## API 设计

### 认证端点
- `POST /auth/login` - 用户登录
- `POST /auth/register` - 用户注册 (管理员功能)

### 订单管理端点
- `POST /orders/upload` - 异步 Excel 文件上传
- `GET /orders/upload/:jobId/status` - 任务状态查询
- `GET /orders` - 分页订单列表 (支持筛选)
- `POST /orders/export-stamps` - 批量印章导出
- `PUT /orders/:id/stamp` - 更新订单印章

### 印章管理端点
- `POST /stamps/templates` - 创建印章模板
- `GET /stamps/templates` - 分页模板列表
- `POST /stamps/upload-background` - 背景图片上传
- `POST /stamps/upload-icon` - 图标上传
- `POST /stamps/preview` - 模板预览生成
- `POST /stamps/generate` - 印章生成

### 母婴产品端点
- `GET /basket/sku-configs` - SKU 配置列表
- `POST /basket/sku-configs` - 创建 SKU 配置
- `POST /basket/generate` - 生成产品 PPT

## 开发规则

### 代码规范
- 使用 TypeScript 严格模式
- 遵循 NestJS 最佳实践
- 实体使用 TypeORM 装饰器
- 服务注入使用依赖注入模式
- 异常处理使用 NestJS 内置异常

### API 设计原则
- RESTful API 设计
- 统一的响应格式
- 分页查询标准化
- 错误码标准化
- Swagger 文档完整性

### 数据库规范
- 使用 UUID 作为主键
- 软删除优于硬删除
- 创建时间和更新时间字段必须
- 外键关系明确定义
- 索引优化查询性能

### 安全规范
- JWT 令牌过期时间控制
- 文件上传类型和大小限制
- SQL 注入防护 (TypeORM 参数化查询)
- 路径遍历攻击防护
- CORS 配置严格控制

## 环境配置

### 开发环境启动
```bash
# 后端服务
cd etsy-helper-server
npm install
npm run start:dev

# 数据库迁移
npm run migration:run

# Python 环境 (如需要)
python -m venv venv
source venv/bin/activate  # Linux/Mac
pip install -r requirements.txt
```

### 环境变量配置
```bash
# 数据库配置
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=password
DATABASE_NAME=etsy_helper

# JWT 配置
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h

# 文件上传配置
UPLOAD_PATH=./uploads
MAX_FILE_SIZE=10485760  # 10MB
```

## 文档索引

- [CLAUDE.md](./CLAUDE.md) - 项目概述和开发规则 (本文件)
- [plan.md](./plan.md) - 开发计划和进度跟踪
- [product-spec.md](./product-spec.md) - 产品规格和功能边界
- [architecture-diagrams.md](./architecture-diagrams.md) - 架构图表和业务流程图
- [architecture-diagrams.md](./architecture-diagrams.md) - 架构图表和业务流程图

## 注意事项

- docs/ 文件夹已加入 .gitignore，仅用于本地开发文档
- Python 脚本依赖需要单独安装和配置
- 数据库迁移在生产环境部署时必须执行
- 文件上传目录需要适当的权限配置
- JWT 密钥在生产环境中必须使用强密钥
- 定期备份数据库和上传文件