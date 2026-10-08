# pi-media (PI-Desktop)

把 `@文件路径` 提到的本地**图片 / 音频 / 视频 / PDF** 作为真实附件发给模型,而不是留一行路径让模型自己去打开。这是 [@8monkey/pi-media](https://github.com/8monkey-ai/pi-media) 的 PI-Desktop 移植版。

```
这张截图哪里有问题? @debug-shot.png
对比 @"Q3 report.pdf" 和 @q4-report.pdf
这段录音说了什么 @meeting.mp3
```

路径相对当前会话工作目录解析;含空格的路径加引号(pi 的 `@` 自动补全会替你加)。

## 工作原理

PI-Desktop v1 不发射 pi CLI 的 `input` 事件,所以移植版改用两个钩子配合:

1. **`context` 钩子**(每次 LLM 调用前,拿到全量转录副本):扫描 user 消息里的 `@提及`,
   - 图片且当前模型支持图像输入 → 就地转成 `{type:"image", data, mimeType}` 内容块(所有 provider 适配器都认识,**全 provider 通用**);
   - 音频 / 视频 / PDF(或图片但模型不吃图)→ 把提及改写成 `[[pi-media:路径|MIME]]` 占位标记,交给下一步。
2. **`before_provider_request` 钩子**(拿到 provider 原生请求体):
   - 判定为 **chat-completions 形态**(OpenAI 兼容网关如 OpenRouter)→ 把标记换成 `{"type":"file","file":{data, media_type}}` part,音频/视频/PDF 真正内联;
   - **其他任何形态**(openai-responses、Anthropic 直连、Gemini 直连…)→ 没有对应的通用 file part,标记被还原成原 `@路径` 文本,同时 ui.notify 提示"该文件未内联"。模型仍可自己用 read 工具打开,不会报错。

只改 detached copy,不动持久转录 ⇒ 每条消息每次调用都重新扫描、重新附件,与原扩展"附件逐轮重发"的语义一致,幂等。

## Provider 兼容矩阵

| Provider(adapter) | 图片 | 音频 / 视频 / PDF |
|---|---|---|
| OpenAI 兼容网关 / OpenRouter(openai-completions) | ✅ image part | ✅ `{type:"file"}` part |
| openai-responses(本机当前 `cpa`) | ✅ image part | ⚠️ 还原为 `@路径` + notify 提示 |
| Anthropic 直连 | ✅ image part | ⚠️ 还原为 `@路径` + notify 提示 |
| Gemini 直连 | ✅ image part | ⚠️ 还原为 `@路径` + notify 提示 |

## 与原 pi-media 的差异

| 行为 | pi CLI 版 | 本移植版 |
|---|---|---|
| 提及捕获 | `input` 钩子(提交时) | `context` 钩子(每次 LLM 调用前) |
| 图片注入 | chat-completions `{type:"file"}` | `ImageContent`(全 provider) |
| 音/视/PDF 注入 | chat-completions `{type:"file"}` | 同左,仅 chat-completions 形态 |
| 不支持时的降级 | 静默留文本 | 还原 `@路径` + ui.notify 明示 |

## 限制

- 文件不存在、为空、超过 **20 MB** 或扩展名不在支持表的 `@提及` 保持原文不动。
- 支持的扩展名:图片 `png jpg jpeg webp gif heic heif`;音频 `wav mp3 aac flac ogg aiff aif`;视频 `mp4 mov webm mpeg mpg avi wmv flv 3gp`;文档 `pdf`。
- 单次 LLM 调用最多内联 8 个附件(防 30s 钩子预算耗尽),超出的保持 `@路径` 文本。

## 开发

```bash
node --test test/     # 25 个用例
npm run typecheck
```

## 安装(打包)

```bash
pnpm pi-plugin check .
pnpm pi-plugin pack .   # → dist/local.pi-media-0.1.0.piplug
```

PI-Desktop → Plugins → **Install plugin package** 选择该 `.piplug`。开发期也可 Plugins → **Load development plugin** 指向本目录,改动 300ms 热重载。

## license

MIT
