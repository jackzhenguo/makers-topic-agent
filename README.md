# makers-topic-agent

本项目按 EdgeOne Makers 的 Agent 文件即路由约定组织：

- `agents/topic/index.ts` -> `/topic`
- `agents/_model.ts` 是私有模块，不生成路由
- `data/` 是本项目自定义素材库目录
- `edgeone.json` 配置 `agents.framework = claude-agent-sdk`、`agents.dir = agents`

## 本地运行

```powershell
cd C:\Users\guozh\Documents\codes\tests\makers\makers-topic-agent
npm install
npm run dev -- "请基于今天热点生成 5 个公众号选题"
```

没有配置 `AI_GATEWAY_API_KEY` 或 `ANTHROPIC_API_KEY` 时，`npm run dev` 会使用本地确定性逻辑，方便先验证目录、数据和路由入口。

配置模型密钥后，`npm run dev` 会调用真实模型，可能需要 30-120 秒。只想快速检查素材读取时，使用：

```powershell
npm run dev:local -- "请基于今天热点生成 5 个公众号选题"
```

## Web 界面

```powershell
npm run web
```

打开 `http://localhost:8787`。

如果提示 `EADDRINUSE`，说明 8787 已经有服务在跑。可以直接打开页面，或先停止再启动：

```powershell
npm run web:stop
npm run web
```

也可以一条命令重启：

```powershell
npm run web:restart
```

如果 Windows PowerShell 输出中文乱码，使用：

```powershell
npm run dev:win -- "请基于今天热点生成 5 个公众号选题"
```

## 配置 DeepSeek V4 Flash

本地配置 EdgeOne AI Gateway API Key：

```powershell
npm run config:deepseek
```

脚本会写入 `.env`：

```env
AI_GATEWAY_API_KEY=你的密钥
AI_GATEWAY_BASE_URL=https://ai-gateway.edgeone.link/v1
AI_GATEWAY_MODEL=@makers/deepseek-v4-flash
```

## Makers 调试

```powershell
npm run makers:dev
```

启动后请求 `/topic`，示例：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8080/topic `
  -Headers @{ "Makers-Conversation-Id" = "local-topic-001" } `
  -ContentType "application/json" `
  -Body '{"message":"请生成 5 个适合今天写的 AI 公众号选题"}'
```

本地可观测面板通常在 `http://localhost:8080/agent-metrics`。

## 部署

```powershell
npm run makers:link
npm run makers:deploy
```

部署前请把 `.env.example` 中的模型网关变量配置到 Makers 项目环境变量里。
