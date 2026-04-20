# LLM Proxy

基于 Bun 的 LLM API 代理服务。

## 功能特性

- 🚀 基于 Bun，超快启动
- 🔐 环境变量配置
- 🔄 OpenAI API 代理
- 🩺 健康检查端点

## 快速开始

### 1. 配置环境变量

编辑 `.env` 文件，填入你的 API 密钥：

```env
PORT=3000
OPENAI_API_KEY=sk-your-actual-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
```

### 2. 启动服务

```bash
# 开发模式
bun run dev

# 生产模式
bun run start
```

## API 端点

- `GET /health` - 健康检查
- `POST /v1/chat/completions` - 代理 OpenAI 聊天接口
- `POST /v1/completions` - 代理 OpenAI 补全接口
- 其他 `/v1/*` 端点也会被代理

## 使用示例

```bash
# 健康检查
curl http://localhost:3000/health

# 发送聊天请求
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```
