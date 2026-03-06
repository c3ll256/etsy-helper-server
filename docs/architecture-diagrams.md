# Etsy Helper Server 架构图表

本文档包含 Etsy Helper Server 后端项目的架构图表和业务流程图，使用 Mermaid 语法绘制。

## 1. 后端模块架构图

展示了 NestJS 后端的模块结构、服务依赖关系以及外部集成。

```mermaid
graph TB
    %% 客户端层
    subgraph "客户端层 (Client Layer)"
        WebApp[前端 Web 应用]
        MobileApp[移动端应用]
        ThirdParty[第三方集成]
    end

    %% API 网关层
    subgraph "API 网关层 (API Gateway)"
        NestJSApp[NestJS 应用]
        AuthGuard[JWT 认证守卫]
        ValidationPipe[数据验证管道]
        LoggingInterceptor[日志拦截器]
    end

    %% 控制器层
    subgraph "控制器层 (Controllers)"
        AuthController[AuthController<br/>认证控制器]
        UsersController[UsersController<br/>用户管理]
        OrdersController[OrdersController<br/>订单管理]
        StampsController[StampsController<br/>印章系统]
        BasketController[BasketController<br/>母婴产品]
        FontsController[FontsController<br/>字体管理]
    end

    %% 服务层
    subgraph "服务层 (Services)"
        AuthService[AuthService<br/>认证服务]
        UsersService[UsersService<br/>用户服务]
        OrdersService[OrdersService<br/>订单服务]
        StampsService[StampsService<br/>印章服务]
        BasketService[BasketService<br/>母婴服务]
        FontsService[FontsService<br/>字体服务]

        subgraph "专用服务 (Specialized Services)"
            PythonStampService[PythonStampService<br/>Python 印章生成]
            JobQueueService[JobQueueService<br/>任务队列服务]
            ExcelParserService[ExcelParserService<br/>Excel 解析服务]
            FileUploadService[FileUploadService<br/>文件上传服务]
        end
    end

    %% 数据访问层
    subgraph "数据访问层 (Data Access)"
        subgraph "TypeORM 实体 (Entities)"
            UserEntity[User Entity<br/>用户实体]
            OrderEntity[Order Entity<br/>订单实体]
            EtsyOrderEntity[EtsyOrder Entity<br/>Etsy订单实体]
            StampTemplateEntity[StampTemplate Entity<br/>印章模板实体]
            SkuConfigEntity[SkuConfig Entity<br/>SKU配置实体]
        end

        TypeORMModule[TypeORM 模块<br/>数据库连接管理]
    end

    %% 外部服务层
    subgraph "外部服务层 (External Services)"
        PostgreSQL[(PostgreSQL<br/>主数据库)]
        Redis[(Redis<br/>缓存数据库)]
        FileSystem[文件系统<br/>上传文件存储]
        PythonScripts[Python 脚本<br/>图像/文档生成]
    end

    %% 连接关系
    WebApp --> NestJSApp
    MobileApp --> NestJSApp
    ThirdParty --> NestJSApp

    NestJSApp --> AuthGuard
    NestJSApp --> ValidationPipe
    NestJSApp --> LoggingInterceptor

    AuthGuard --> AuthController
    ValidationPipe --> UsersController
    ValidationPipe --> OrdersController
    ValidationPipe --> StampsController
    ValidationPipe --> BasketController
    ValidationPipe --> FontsController

    AuthController --> AuthService
    UsersController --> UsersService
    OrdersController --> OrdersService
    StampsController --> StampsService
    BasketController --> BasketService
    FontsController --> FontsService

    OrdersService --> JobQueueService
    OrdersService --> ExcelParserService
    StampsService --> PythonStampService
    StampsService --> FileUploadService
    BasketService --> PythonStampService

    AuthService --> UserEntity
    UsersService --> UserEntity
    OrdersService --> OrderEntity
    OrdersService --> EtsyOrderEntity
    StampsService --> StampTemplateEntity
    BasketService --> SkuConfigEntity

    UserEntity --> TypeORMModule
    OrderEntity --> TypeORMModule
    EtsyOrderEntity --> TypeORMModule
    StampTemplateEntity --> TypeORMModule
    SkuConfigEntity --> TypeORMModule

    TypeORMModule --> PostgreSQL
    JobQueueService --> Redis
    FileUploadService --> FileSystem
    PythonStampService --> PythonScripts

    %% 样式定义
    classDef clientLayer fill:#e3f2fd,stroke:#1976d2,stroke-width:2px
    classDef apiLayer fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
    classDef controllerLayer fill:#e8f5e8,stroke:#388e3c,stroke-width:2px
    classDef serviceLayer fill:#fff3e0,stroke:#f57c00,stroke-width:2px
    classDef dataLayer fill:#fce4ec,stroke:#c2185b,stroke-width:2px
    classDef externalLayer fill:#f5f5f5,stroke:#616161,stroke-width:2px

    class WebApp,MobileApp,ThirdParty clientLayer
    class NestJSApp,AuthGuard,ValidationPipe,LoggingInterceptor apiLayer
    class AuthController,UsersController,OrdersController,StampsController,BasketController,FontsController controllerLayer
    class AuthService,UsersService,OrdersService,StampsService,BasketService,FontsService,PythonStampService,JobQueueService,ExcelParserService,FileUploadService serviceLayer
    class UserEntity,OrderEntity,EtsyOrderEntity,StampTemplateEntity,SkuConfigEntity,TypeORMModule dataLayer
    class PostgreSQL,Redis,FileSystem,PythonScripts externalLayer
```



### 架构说明

**客户端层 (Client Layer)**

- 支持多种客户端接入：Web 应用、移动端、第三方集成
- 统一通过 RESTful API 进行通信

**API 网关层 (API Gateway)**

- NestJS 应用作为 API 网关
- JWT 认证守卫处理身份验证
- 数据验证管道确保输入数据合法性
- 日志拦截器记录请求响应信息

**控制器层 (Controllers)**

- 按功能模块划分控制器y
- 处理 HTTP 请求路由和参数验证
- 调用相应的服务层处理业务逻辑

**服务层 (Services)**

- 核心业务逻辑实现
- 专用服务处理复杂功能（Python 集成、任务队列等）
- 服务间协作完成复杂业务流程

**数据访问层 (Data Access)**

- TypeORM 实体映射数据库表结构
- 统一的数据库连接和事务管理
- 支持数据库迁移和版本控制

## 2. 数据库实体关系图

展示了系统中核心实体的关系和数据流。

```mermaid
erDiagram
    User {
        uuid id PK
        string username UK
        string password
        boolean isAdmin
        string shopName
        timestamp createdAt
        timestamp updatedAt
    }

    Order {
        uuid id PK
        string orderType
        string platformOrderId
        date platformOrderDate
        text searchKey
        enum status
        uuid userId FK
        integer templateId FK
        timestamp createdAt
        timestamp updatedAt
    }

    EtsyOrder {
        %% table: etsy_orders
        integer id PK
        string orderId
        string transactionId
        string listingId
        string itemName
        string buyer
        integer quantity
        decimal price
        string couponCode
        string couponDetails
        decimal discountAmount
        decimal shippingDiscount
        decimal orderShipping
        decimal orderSalesTax
        decimal itemTotal
        string currency
        date datePaid
        string shipName
        string shipAddress1
        string shipAddress2
        string shipCity
        string shipState
        string shipZipcode
        string shipCountry
        boolean isRemoteArea
        jsonb variations
        string originalVariations
        string orderType
        string listingsType
        string paymentType
        decimal vatPaidByBuyer
        string sku
        date saleDate
        uuid order_id FK
        jsonb stampImageUrls
        jsonb stampGenerationRecordIds
        timestamp createdAt
        timestamp updatedAt
    }

    StampTemplate {
        %% table: stamp_templates
        integer id PK
        uuid userId FK
        text[] skus
        string name
        string backgroundImagePath
        integer width
        integer height
        json textElements
        string description
        string type
        string previewImagePath
        boolean isActive
        timestamp createdAt
        timestamp updatedAt
    }

    StampGenerationRecord {
        %% table: stamp_generation_records
        integer id PK
        string orderId
        integer templateId FK
        json textElements
        string stampImageUrl
        string format
        timestamp createdAt
        timestamp updatedAt
    }

    SkuConfig {
        integer id PK
        uuid userId FK
        string sku UK
        enum type "basket|backpack|combo"
        string replaceValue
        float fontSize
        string font
        jsonb yarnColorMap
        jsonb comboItems
        boolean externalOrderReminderEnabled
        string externalOrderReminderContent
        timestamp createdAt
        timestamp updatedAt
    }

    Font {
        integer id PK
        string name
        string filename UK
        string filePath
        string fontWeight
        boolean isVariableFont
        string description
        boolean isActive
        timestamp createdAt
        timestamp updatedAt
    }

    BasketGenerationRecord {
        integer id PK
        string originalFilename
        enum status
        float progress
        string outputFilePath
        string jobId
        integer ordersProcessed
        integer totalOrders
        text errorMessage
        text[] orderIds
        text[] skus
        string orderType
        uuid userId FK
        timestamp createdAt
        timestamp updatedAt
    }

    %% 关系定义
    User ||--o{ Order : "拥有"
    User ||--o{ StampTemplate : "拥有模板"
    User ||--o{ SkuConfig : "拥有SKU配置"
    Order ||--|| EtsyOrder : "详情"
    Order }o--|| StampTemplate : "使用模板"
    StampTemplate ||--o{ StampGenerationRecord : "生成记录"
    EtsyOrder ||--o{ StampGenerationRecord : "关联生成记录"
    User ||--o{ BasketGenerationRecord : "生成记录"
```



### 实体关系说明

**用户系统**

- User 是系统的核心实体，支持多租户隔离
- 每个用户可以有多个订单，支持店铺名称关联

**订单系统**

- Order 是订单的基础信息，包含状态和类型
- EtsyOrder 存储详细的 Etsy 订单信息，一对一关联
- 订单可以关联印章模板进行生成

**印章系统**

- StampTemplate 支持多 SKU 配置
- 模板包含复杂的文本元素和图标配置
- 支持多种印章类型和自定义扩展

**配置系统**

- SkuConfig 管理产品 SKU 的配置信息
- 支持毛线颜色映射和字体配置
- Font 管理系统字体资源

### 各表业务作用

**User (`users`)**

- 系统账号主体，承载登录身份、管理员权限和店铺归属信息。
- 作为数据隔离边界，决定用户可访问的订单、模板和生成记录范围。

**Order (`orders`)**

- 订单主表，记录系统内统一订单状态流转（待生成/待审核/已审核等）。
- 负责关联“谁的订单（userId）”与“用哪个模板（stampTemplateId）”。

**EtsyOrder (`etsy_orders`)**

- Etsy 原始订单详情表，保存买家、地址、SKU、变体、价格等业务原始字段。
- 与 `orders` 一对一，用于“平台原始数据”与“系统处理状态”分层。

**StampTemplate (`stamp_templates`)**

- 印章/摇铃模板定义表，保存模板尺寸、文本元素布局、图标配置和适配 SKU。
- 是批量生成印章时的规则来源，支持多类型模板（rubber/steel/rattle 等）。

**StampGenerationRecord (`stamp_generation_records`)**

- 印章生成审计表，记录每次生成时使用的模板、文本参数快照和输出图片地址。
- 用于追溯“某订单某次生成结果”，支持重生成、问题排查和历史回看。

**SkuConfig (`sku_configs`)**

- 母婴/篮子业务的 SKU 配置表，维护颜色映射、字体配置、外部订单提醒等规则。
- 作为订单解析和导出时的字典规则来源，减少人工映射成本。

**Font (`fonts`)**

- 字体资产表，记录字体文件元数据与可用状态。
- 为模板编辑器和 Python 生成服务提供可用字体清单与文件路径映射。

**BasketGenerationRecord (`basket_generation_records`)**

- 篮子/PPT 生成任务记录表，保存任务状态、输入数据快照、输出路径和错误信息。
- 用于异步任务进度展示、失败重试和生成历史管理。

## 3. 业务流程图

展示了系统的核心业务流程和数据处理逻辑。

```mermaid
graph TD
    %% 用户认证流程
    subgraph "用户认证流程"
        A1[用户登录请求] --> A2{验证用户名密码}
        A2 -->|成功| A3[生成 JWT Token]
        A2 -->|失败| A4[返回认证错误]
        A3 --> A5[返回 Token 和用户信息]
    end

    %% 订单处理流程
    subgraph "订单处理流程"
        B1[上传 Excel 文件] --> B2[创建异步任务]
        B2 --> B3[解析 Excel 数据]
        B3 --> B4[验证订单数据]
        B4 --> B5{数据验证}
        B5 -->|通过| B6[批量插入订单]
        B5 -->|失败| B7[记录错误信息]
        B6 --> B8[更新任务状态]
        B7 --> B8
        B8 --> B9[通知前端完成]
    end

    %% 印章生成流程
    subgraph "印章生成流程"
        C1[选择订单和模板] --> C2[准备生成参数]
        C2 --> C3[调用 Python 脚本]
        C3 --> C4[生成印章图片]
        C4 --> C5{生成成功?}
        C5 -->|成功| C6[保存图片路径]
        C5 -->|失败| C7[记录错误日志]
        C6 --> C8[更新订单状态]
        C7 --> C8
        C8 --> C9[返回生成结果]
    end

    %% 母婴产品流程
    subgraph "母婴产品处理流程"
        D1[接收产品订单] --> D2[解析 SKU 信息]
        D2 --> D3[查找 SKU 配置]
        D3 --> D4{配置存在?}
        D4 -->|存在| D5[应用颜色映射]
        D4 -->|不存在| D6[使用默认配置]
        D5 --> D7[准备 PPT 数据]
        D6 --> D7
        D7 --> D8[调用 Python PPT 生成]
        D8 --> D9[生成 PPT 文件]
        D9 --> D10[返回文件路径]
    end

    %% 任务队列流程
    subgraph "任务队列管理"
        E1[创建异步任务] --> E2[分配任务 ID]
        E2 --> E3[任务入队]
        E3 --> E4[后台执行任务]
        E4 --> E5[更新执行进度]
        E5 --> E6{任务完成?}
        E6 -->|否| E4
        E6 -->|是| E7[标记任务完成]
        E7 --> E8[清理任务资源]
    end

    %% 流程间连接
    A5 --> B1
    B9 --> C1
    B9 --> D1
    B2 --> E1
    C3 --> E1
    D8 --> E1

    %% 样式定义
    classDef authFlow fill:#e3f2fd,stroke:#1976d2,stroke-width:2px
    classDef orderFlow fill:#e8f5e8,stroke:#388e3c,stroke-width:2px
    classDef stampFlow fill:#fff3e0,stroke:#f57c00,stroke-width:2px
    classDef basketFlow fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
    classDef queueFlow fill:#fce4ec,stroke:#c2185b,stroke-width:2px

    class A1,A2,A3,A4,A5 authFlow
    class B1,B2,B3,B4,B5,B6,B7,B8,B9 orderFlow
    class C1,C2,C3,C4,C5,C6,C7,C8,C9 stampFlow
    class D1,D2,D3,D4,D5,D6,D7,D8,D9,D10 basketFlow
    class E1,E2,E3,E4,E5,E6,E7,E8 queueFlow
```



## 4. API 请求流程图

展示了典型 API 请求的处理流程。

```mermaid
sequenceDiagram
    participant Client as 客户端
    participant Gateway as API 网关
    participant Auth as 认证守卫
    participant Controller as 控制器
    participant Service as 服务层
    participant DB as 数据库
    participant Python as Python 脚本
    participant Queue as 任务队列

    %% 认证请求流程
    Note over Client,Queue: 用户认证流程
    Client->>Gateway: POST /auth/login
    Gateway->>Controller: 路由到 AuthController
    Controller->>Service: AuthService.login()
    Service->>DB: 查询用户信息
    DB-->>Service: 返回用户数据
    Service->>Service: 验证密码
    Service->>Service: 生成 JWT Token
    Service-->>Controller: 返回 Token
    Controller-->>Gateway: 返回认证结果
    Gateway-->>Client: 返回 Token 和用户信息

    %% 订单上传流程
    Note over Client,Queue: 订单上传流程
    Client->>Gateway: POST /orders/upload (带 JWT)
    Gateway->>Auth: 验证 JWT Token
    Auth->>Controller: 通过认证
    Controller->>Service: OrdersService.uploadExcel()
    Service->>Queue: 创建异步任务
    Queue-->>Service: 返回任务 ID
    Service-->>Controller: 返回任务 ID
    Controller-->>Gateway: 返回任务信息
    Gateway-->>Client: 返回任务 ID

    %% 异步任务执行
    Note over Client,Queue: 异步任务执行
    Queue->>Service: 执行 Excel 解析
    Service->>DB: 批量插入订单数据
    DB-->>Service: 确认插入完成
    Service->>Queue: 更新任务状态

    %% 印章生成流程
    Note over Client,Queue: 印章生成流程
    Client->>Gateway: POST /stamps/generate (带 JWT)
    Gateway->>Auth: 验证 JWT Token
    Auth->>Controller: 通过认证
    Controller->>Service: StampsService.generate()
    Service->>Python: 调用 Python 脚本
    Python-->>Service: 返回生成结果
    Service->>DB: 更新订单状态
    DB-->>Service: 确认更新
    Service-->>Controller: 返回生成结果
    Controller-->>Gateway: 返回印章信息
    Gateway-->>Client: 返回印章 URL
```



## 5. 数据流图

展示了系统中数据的流转和处理过程。

```mermaid
graph LR
    %% 数据输入
    subgraph "数据输入 (Data Input)"
        ExcelFile[Excel 订单文件]
        UserConfig[用户配置数据]
        TemplateData[模板配置数据]
        UploadFiles[上传文件<br/>图片/字体]
    end

    %% 数据处理
    subgraph "数据处理 (Data Processing)"
        ExcelParser[Excel 解析器]
        DataValidator[数据验证器]
        ImageProcessor[图像处理器]
        PPTGenerator[PPT 生成器]
        TaskScheduler[任务调度器]
    end

    %% 数据存储
    subgraph "数据存储 (Data Storage)"
        PostgreSQLDB[(PostgreSQL<br/>主数据库)]
        RedisCache[(Redis<br/>缓存)]
        FileStorage[文件存储<br/>本地/云存储]
        TempStorage[临时存储<br/>处理中文件]
    end

    %% 数据输出
    subgraph "数据输出 (Data Output)"
        StampImages[印章图片]
        PPTFiles[PPT 文件]
        ExcelReports[Excel 报表]
        APIResponses[API 响应数据]
        LogFiles[日志文件]
    end

    %% 数据流向
    ExcelFile --> ExcelParser
    UserConfig --> DataValidator
    TemplateData --> DataValidator
    UploadFiles --> ImageProcessor

    ExcelParser --> DataValidator
    DataValidator --> PostgreSQLDB
    DataValidator --> TaskScheduler

    PostgreSQLDB --> ImageProcessor
    PostgreSQLDB --> PPTGenerator
    TaskScheduler --> RedisCache

    ImageProcessor --> StampImages
    ImageProcessor --> FileStorage
    PPTGenerator --> PPTFiles
    PPTGenerator --> FileStorage

    PostgreSQLDB --> ExcelReports
    PostgreSQLDB --> APIResponses
    TaskScheduler --> LogFiles

    FileStorage --> TempStorage
    TempStorage --> ImageProcessor
    TempStorage --> PPTGenerator

    %% 样式定义
    classDef inputData fill:#e3f2fd,stroke:#1976d2,stroke-width:2px
    classDef processData fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
    classDef storageData fill:#e8f5e8,stroke:#388e3c,stroke-width:2px
    classDef outputData fill:#fff3e0,stroke:#f57c00,stroke-width:2px

    class ExcelFile,UserConfig,TemplateData,UploadFiles inputData
    class ExcelParser,DataValidator,ImageProcessor,PPTGenerator,TaskScheduler processData
    class PostgreSQLDB,RedisCache,FileStorage,TempStorage storageData
    class StampImages,PPTFiles,ExcelReports,APIResponses,LogFiles outputData
```



## 使用说明

这些图表可以在支持 Mermaid 的环境中渲染，包括：

- GitHub/GitLab 的 Markdown 文件
- VS Code 的 Mermaid 插件
- 在线 Mermaid 编辑器
- 文档生成工具 (如 GitBook, Docusaurus)

### 图表说明

1. **后端模块架构图**: 展示了 NestJS 应用的完整架构，从客户端请求到数据存储的各个层次
2. **数据库实体关系图**: 使用 ER 图展示了核心实体的关系和字段结构
3. **业务流程图**: 展示了主要业务流程的步骤和决策点
4. **API 请求流程图**: 使用时序图展示了典型 API 请求的处理过程
5. **数据流图**: 展示了数据在系统中的流转和处理过程

---

*图表版本: 1.0*
*最后更新: 2026-03-01*
*创建工具: Mermaid*