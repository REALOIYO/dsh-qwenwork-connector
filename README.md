# dsh-qwenwork-connect

把**千问办公（QwenWork）**的模型接进 DeepSeek Harness，做成原生 `LlmAdapter` 插件。

**不需要安装千问办公客户端，也不需要 magpie 网关。** 签名、编码、登录全部在插件里实现。

> ⚠️ **非官方**。千问办公没有公开 API，本项目按它的桌面客户端协议实现，
> 属于对抗性反代。协议随时可能变，详见 [风险](#风险)。

## 为什么不是别的做法

| 方案 | 结论 |
|---|---|
| 加进 OFM 的 aggregate registry | ❌ 走不通。OFM 的 `resolveProvider` 见 oauth 直接抛错，wire 只认三种标准协议 |
| 用 magpie 网关 + baseUrl | ✅ 可行但要多装一个软件 |
| **本项目：原生 LlmAdapter** | ✅ 一个插件搞定，无额外进程 |

## 装

```sh
dsh plugin --profile desktop add "file:/path/to/dsh-qwenwork-connect"
```

或发布后：

```sh
dsh plugin --profile desktop add dsh-qwenwork-connect
```

装完重启 DSH。模型选择器里会出现「千问办公」分组，含三个模型。

## 登录

在设置页发起设备码登录（`POST /api/qwenwork/login`），拿到的 URL 形如：

```
https://gateway.qwenwork.cn/device/selectAccounts?challenge=...&client_id=...&redirect_uri=qwenwork-cn://
```

浏览器打开、登录并授权，插件每 2 秒轮询一次，成功后账号落到
`~/.dsh-qwenwork-connect/accounts.json`。

`redirect_uri=qwenwork-cn://` 是客户端注册的私有协议，只是照抄参数字符串，
**不需要**它真能唤起任何程序。

## 模型

| key | 名称 |
|---|---|
| `flash` | 标准 |
| `pro` | 高级 |
| `qwen3.8-max-preview` | Qwen3.8-Max |

三个都是纯文本、不思考。个人账号的额度只报「剩余」，报不出已用比例——
服务端的 quota 里 `total`/`used` 是 `null`，这不是插件的缺陷。

## 结构

```
src/
├── index.ts              宿主半边：注册 provider、挂 REST API
├── client/               前端半边：设置侧边栏入口
│   ├── index.ts          注册 settings.section
│   ├── page.tsx          登录 / 账号 / 模型 三块
│   └── i18n.ts           中英文案
└── adapter/
    ├── codec.ts          Encode=1 的 body 编解码（纯函数）
    ├── cosy.ts           COSY 信封签名（AES + RSA + md5）
    ├── auth.ts           设备码登录、账号存储
    ├── body.ts           DSH 请求 → agent_chat_generation
    ├── stream.ts         SSE → DSH StreamChunk，失败分类
    └── qwenwork.ts       7 个适配器契约方法
```

分层是为了能独立测：`codec` 是纯函数，`cosy` 只依赖 crypto，`stream` 和
`body` 能吃构造的字节流，只有 `qwenwork` 需要假服务器。

### 设置页

装好后 **设置 → 千问办公** 就是入口（`settings.section` 注册，order 13）。
页面三块：登录（发起设备码、显示授权链接）、已登录账号（套餐/余额/有效期/移除）、
可用模型清单。

图标目前是宿主的兜底齿轮——`settings.section` 这个 slot 只投影
`id`/`order`/`label`，**没有 icon 字段**。magpie 用 MutationObserver 打补丁换图标，
这里先不做：等宿主补上 icon 字段更划算。

### 协议要点

**签名**：每个请求带 `Authorization: Bearer COSY.<payload>.<sig>`

```
1. 账号信息 AES-128-CBC 加密（密钥=IV）→ info
   该密钥再用 RSA 公钥加密 → key
2. payload = base64(JSON{v1, requestId, info, cosyVersion, ideVersion:""})
3. sig = md5(`${payload}\n${key}\n${ts}\n${body}\n${path}`)
   path 去掉 /algo 前缀
```

**编码**：`Encode=1` 的请求体不是 JSON

- 打乱的 64 字符表做 base64 变体（`$` 补齐）
- 三段轮换：切成三等份，首尾交换

**响应**：两层信封，`data:` 里是 JSON，真正的 OpenAI chunk 在 `body` 字段里。

## 测试

```sh
node --test "test/*.test.ts"
```

67 个测试：

| 文件 | 覆盖 |
|---|---|
| `codec.test.ts` | 编解码往返、多字节、补位边界 |
| `cosy.test.ts` | 签名格式、RSA 包裹、md5 复算、机器标识 |
| `auth.test.ts` | 假网关跑通设备码全流程、404 不误判、存储原子写 |
| `body.test.ts` | tool 配对修复、cache 标记、小额度不思考 |
| `stream.test.ts` | chunk 序列契约、错误码分类、编码 body |
| `qwenwork.test.ts` | 端到端链路、多账号切换、错误信息 |
| `entry.test.ts` | provider 注册、配置解析、缺服务不崩 |

### 真实链路验证

单测都用构造的假网关，**只有这个能证明协议真的对**：

```sh
node scripts/verify-real.mjs            # 三个模型各问一句
node scripts/verify-real.mjs --tools    # 额外验证工具调用与多轮循环
```

会花掉一点额度，所以不放进 `npm test`。

## 风险

**一、协议会变。** 客户端版本号、RSA 密钥、字符表、头字段，任何一处变了
插件就得跟着改。magpie 那边为跟 QwenWork 已经改了十几个版本。

**二、绕过客户端校验。** 这违反服务条款，虽然你买的是正规订阅。

**三、账号风控。** 指纹校验是活的。参考 OFM 的 `buddy` 渠道被腾讯
`code 11128` 拦——同一类问题。

## 致谢

协议实现移植自：

- [`@magpie-community/opencode-qoder-auth`](https://www.npmjs.com/package/@magpie-community/opencode-qoder-auth)（MIT）
- [`yetone/magpie`](https://github.com/yetone/magpie)（MIT）

`codec` 层源自 CLIProxyAPI 的 qoder 支持（MIT）。

## 许可

MIT
