# DT_Greenhouse 工业温室数字孪生项目

DT_Greenhouse 是一个用于工业温室场景的数字孪生与设备控制项目，包含：

- 三维可视化主界面（Web，基于 Three.js + React）
- 工业节点协议仪表盘（Web，协议调试与设备控制）
- 网关中间件服务（Server，用于 TCP ↔ WebSocket 转发、协议解析）
- AI 控制功能（基于 Ollama LLM 和模糊控制算法）
- 辅助工具脚本（Python，用于模拟网关、模糊控制器等）

本文档主要说明项目结构、开发方式以及使用 pm2 的部署方式，方便在服务器上一键启动。

---

## 1. 项目结构

```text
DT_Greenhouse/
├─ apps/
│  ├─ server/                # 网关中间件服务（Node.js + TypeScript）
│  │  ├─ src/index.ts        # WebSocket 服务入口
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  ├─ web/                   # Web 前端（React + Vite）
│  │  ├─ src/
│  │  │  ├─ main.ts          # 应用入口
│  │  │  ├─ startApp.ts      # 启动 3D 主界面
│  │  │  ├─ startAppShell.ts # App Shell 与路由切换
│  │  │  ├─ viewer/          # 数字孪生三维农场
│  │  │  │  └─ createFarmApp.ts
│  │  │  ├─ protocol/        # 工业节点协议解析
│  │  │  │  ├─ frame.ts
│  │  │  │  └─ types.ts
│  │  │  └─ protocolDashboard/ # 协议仪表盘 UI
│  │  │     ├─ protocolDashboardApp.tsx
│  │  │     ├─ constants.ts
│  │  │     └─ components/
│  │  ├─ index.html
│  │  ├─ package.json
│  │  └─ vite.config.ts
│  └─ ecosystem.config.cjs   # pm2 启动配置（web + server）
│
├─ docs/                     # 协议、数据流与 Android 模板等文档
│  ├─ 工业节点通信协议_V1.1_完整开发文档.md
│  ├─ 工业节点通信协议V1.1.pdf
│  ├─ 控制.txt               # 精确控制帧
│  ├─ 数据流分析/            # 节点数据解析脚本与说明
│  └─ Android/               # Android 控制 / 监测 XML 模板
│
├─ src/models/               # 三维场景模型（温室、风机、传感器等）
├─ src/sky_box/              # 天空盒贴图
├─ Tools/                    # 辅助工具脚本
│  ├─ gateway_api.py         # 网关 API 封装
│  ├─ mock_gateway_simulator.py # 模拟网关
│  ├─ fuzzy_growth_controller.py # 模糊生长控制器
│  └─ convert_blender_obj_to_threejs_axes.py # 模型转换工具
├─ .vercel/                  # Vercel 配置
├─ .vercelignore             # Vercel 忽略文件
├─ .gitignore                # Git 忽略文件
└─ vercel.json               # Vercel 配置文件
```

---

## 2. 前端（apps/web）

### 2.1 功能概览

- **主界面（Viewer）**
  - Three.js 立体场景，展示温室、设备、风机、传感器等。
  - 左上角 HUD 显示真实环境数据（温度、湿度、CO₂ 等）。
  - 与后端 WebSocket 连接，使用工业节点协议解码真实数据。
  - 支持 AI 控制模式，可实时显示 AI 决策结果和执行器状态。
  - 日/夜模式切换功能，包括天空盒自动切换和光照效果调整。
  - 设备管理面板，支持遮阳棚和风机等设备的控制。
  - 性能优化，包括减少临时对象创建、优化阴影设置和渲染器配置。

- **协议仪表盘（Protocol Dashboard）**
  - 显示 12 类传感器（空气温度、湿度、雨雪、光照、人体感应、土壤温度/湿度、CO₂、PH、风速、风向、烟雾）。
  - 控制 7 类执行器（换气扇、植物生长灯、加湿器、加热器、智能窗帘、水泵、报警灯）。
  - 支持明/暗色主题切换、十六进制流量监控（Hex Monitor）、连接诊断信息。
  - 控制帧严格使用 `docs/控制.txt` 中定义的 16 字节协议。
  - 集成 AI 控制界面，支持 Ollama 服务器配置、模型选择、自动决策间隔设置等。
  - 实时显示 AI 决策结果和执行器状态，支持 AI 与手动控制模式切换。

### 2.2 本地开发

```bash
cd apps/web

# 安装依赖
npm install

# 开发环境（默认 http://localhost:3001）
npm run dev
```

### 2.3 构建与预览

```bash
cd apps/web

# 构建生产包（输出到 dist/）
npm run build

# 本地预览 dist/ 内容（默认 http://localhost:3000）
npm run preview
```

---

## 3. 后端网关服务（apps/server）

### 3.1 功能概览

- 使用 WebSocket 在本地 `ws://<host>:8080` 上提供服务。
- 与上游工业节点网关（如 `yoned.xyz:2012`）通过 TCP 连接。
- 负责：
  - TCP ↔ WebSocket 的数据转发。
  - 按工业节点协议打包/解包帧，以及 CRC 校验。
  - 将前端控制操作转换为协议帧发送到上游。
  - 集成 Ollama LLM 接口，支持通过本地 AI 模型进行智能决策，实现基于传感器数据的自动控制。
  - 提供 AI 控制配置和决策执行功能，支持自定义控制策略。

> 具体协议细节参考 `docs/工业节点通信协议_V1.1_完整开发文档.md` 与 `docs/控制.txt`。

### 3.2 本地开发

```bash
cd apps/server

# 安装依赖
npm install

# 开发模式（使用 tsx 直接运行 TS）
npm run dev
```

默认会监听 8080 端口，对 Web 端提供 WebSocket 接入。

### 3.3 构建与运行

```bash
cd apps/server

# TypeScript 编译
npm run build

# 运行编译后的 JS
npm start         # 等价于 node dist/index.js
```

---

## 4. 使用 pm2 一键部署 web + server

在 `apps/` 目录下已经添加了 pm2 的 ecosystem 配置文件：

- 文件：`apps/ecosystem.config.cjs`

内容包含两个应用：

1. `agti-farm-server`
   - 工作目录：`apps/server`
   - 启动命令：`npm start`（内部为 `node dist/index.js`）
2. `agti-farm-web`
   - 工作目录：`apps/web`
   - 启动命令：`npm run preview -- --host 0.0.0.0 --port 3000`
   - 用 Vite 提供静态资源预览服务，监听 `0.0.0.0:3000`

### 4.1 首次部署步骤（服务器上）

> 以下以 Linux 为例，Windows Server 只需使用对应的 shell 即可。

```bash
# 1. 拉取代码
git clone https://github.com/yoned114514/DT_Greenhouse.git
cd DT_Greenhouse

# 2. 安装依赖 & 构建
cd apps/server
npm install
npm run build

cd ../web
npm install
npm run build
```

确保：

- `apps/server/dist/index.js` 已生成
- `apps/web/dist/` 已生成前端静态文件

### 4.2 使用 pm2 启动

```bash
cd DT_Greenhouse/apps

# 启动/重启所有服务
pm2 start ecosystem.config.cjs

# 查看状态
pm2 ls

# 查看日志
pm2 logs agti-farm-server
pm2 logs agti-farm-web
```

如需仅重启某一侧：

```bash
pm2 restart agti-farm-server
pm2 restart agti-farm-web
```

### 4.3 开机自启

```bash
pm2 save
pm2 startup
# 按 pm2 提示执行一条 systemd 命令
```

---

## 5. 运行时访问入口

- **前端 Web**
  - 本地开发：`http://localhost:3001`
  - 生产（pm2 + preview）：`http://<服务器 IP>:3000`
- **WebSocket 网关（前端使用）**
  - `ws://<服务器 IP>:8080`

前端协议仪表盘会自动根据当前页面协议选择 `ws://` 或 `wss://`，并连接到本机 8080 端口。

---

## 6. 开发注意事项

- 控制指令必须使用 `docs/控制.txt` 中的 16 字节十六进制帧，前端已按该文件进行映射配置。
- 传感器数据解析逻辑与 `docs/数据流分析` 中的解析脚本保持一致：
  - 不同 `mainType + subType` 组合对应不同传感器类型（温度、湿度、CO₂、风速/风向、PH 等）。
  - 浮点/整型的缩放与符号位规则与文档一致。
- UI 中的设备列表与协议文档中的 12 类传感器、7 类执行器一一对应。

如需扩展新的传感器或执行器，一般需要同时修改：

- `apps/web/src/protocolDashboard/constants.ts`
- `apps/web/src/protocol/frame.ts`（如需新增解析规则）

---

## 7. 当前开发进度

- **整体状态**
  - 前后端与网关服务均已打通，可本地完整跑通「三维场景 + 协议仪表盘 + 网关」。
  - 协议相关的打包/解包、CRC 校验、常用设备映射与控制指令均已按照文档实现，并在前端联调验证。
  - 提供 Python 工具脚本（模拟网关、模糊控制器等）和完整协议文档，方便联调与扩展。

- **前端 Web（apps/web）**
  - 已实现基于 hash 的应用壳（`#/viewer` 与 `#/protocol`），支持在三维主界面和协议仪表盘之间切换。
  - **三维主界面（Viewer）**
    - 已接入 WebSocket，支持从网关接收二进制协议帧，按工业节点协议解析，并在 HUD 和画面内「传感器监视器」面板中展示 12 类传感器数据。
    - 在三维场景中加载温室主体 GLB 模型及多个 OBJ 设备模型（风机、风力发电机等），支持相机漫游、缩放、工程模式下的对象编辑等能力。
    - 监视器纹理中已集成 7 类执行器控制按钮，点击后会发送对应的 16 字节控制帧，并在画面内实时反馈设备状态。
    - 日/夜模式切换功能，包括天空盒自动切换（白天使用 sky.jpg，夜晚使用 sky_evening.jpg）和光照效果调整。
    - 设备管理面板，支持遮阳棚和风机等设备的控制。
    - 性能优化，包括减少临时对象创建、优化阴影设置和渲染器配置，提高系统运行流畅度。
  - **协议仪表盘（Protocol Dashboard）**
    - 已完成 12 类传感器、7 类执行器的列表展示与控制，设备定义与协议文档保持一一对应。
    - 支持手动查询与自动轮询，使用 `packFrame + DataType` 组合构造查询帧，并通过 WebSocket 发送到网关。
    - 内置十六进制流量监控（Hex Monitor）、CRC 校验标记、明/暗色主题、连接状态与目标网关地址展示等调试功能。
    - 集成 AI 控制界面，支持 Ollama 服务器配置、模型选择、自动决策间隔设置等。

- **网关中间件服务（apps/server）**
  - 已实现 WebSocket 服务（默认 8080 端口），支持多客户端连接。
  - 已实现与上游 TCP 网关的连接、重连机制，以及对上游输出的十六进制文本流进行帧边界提取与 16 字节帧转发。
  - 对来自前端的 16 字节控制帧，会直接转写为十六进制字符串并发送至上游，实现「前端控制 → 上游网关 → 设备」的闭环控制链路。
  - 内置简单的随机 Telemetry JSON 推送逻辑，可用于在无真实上游网关时进行本地联调与前端展示测试。
  - 集成 Ollama LLM 接口，支持通过本地 AI 模型进行智能决策，实现基于传感器数据的自动控制。

- **辅助工具与文档（Tools 与 docs）**
  - `Tools/` 目录提供网关 API 封装、模拟网关（mock_gateway_simulator）、模糊生长控制器（fuzzy_growth_controller）等工具脚本，用于快速模拟传感器数据和执行器响应。
  - `docs/` 下提供完整的协议规范、十六进制报文格式汇总、数据流解析脚本与示例，当前前后端实现已与文档保持一致，部分文档中标记的 TODO 主要用于进一步完善数据解析说明，对现有功能不构成阻塞。

- **AI 控制功能**
  - 基于 LLM (Large Language Model) 的智能温室环境调节系统，通过 Ollama 本地服务器进行推理。
  - 支持根据传感器数据自动调整执行器状态，实现智能环境控制。
  - 提供 AI 控制与手动控制的无缝切换功能，支持自定义控制策略和参数调优。
  - 前端提供完整的 AI 配置界面，可设置 Ollama 服务器地址、端口、模型选择和自动决策间隔。

## 8. 技术栈概览

| 组件 | 技术 | 版本/依赖 | 用途 |
|------|------|-----------|------|
| 前端框架 | React | - | 用户界面构建 |
| 3D 渲染 | Three.js | - | 三维场景可视化 |
| 构建工具 | Vite | - | 前端构建与开发服务器 |
| 后端语言 | TypeScript | - | 网关服务开发 |
| 网络通信 | WebSocket, TCP | - | 数据传输 |
| 部署工具 | pm2 | - | 服务进程管理 |
| 辅助工具 | Python | - | 模拟与控制脚本 |
| AI 控制 | Ollama (LLM) + Python (模糊控制算法) | - | 智能环境调节 |