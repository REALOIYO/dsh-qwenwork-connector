# dsh-qwenwork-connector

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![install](https://img.shields.io/badge/install-dsh%20plugin%20add-4D6BFE?style=flat-square)](#安装)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

千问办公（QwenWork）模型接入 DeepSeek Harness 的 provider 插件。

自带设备码登录，直连官方接口。不需要安装千问办公桌面客户端，也不需要额外跑一个转发进程。

---

## 背景

千问办公没有公开 API。要让 DSH 用上它家的模型，目前有两种做法。

一种是装千问办公桌面版，再挂一个 magpie 做转发。这条路能走通，代价是常驻两个额外软件，还得处理它们各自崩溃、掉线的问题。

这个插件走的是另一条路：把客户端的登录握手和请求协议直接实现在插件内部，作为一个普通 provider 注册进 DSH。没有额外窗口，没有额外进程。

前提是你已经买了千问办公的套餐。

---

## 安装

**从 GitHub 装**（`lib/` 已随仓库提供，无需自行编译）：

```sh
git clone https://github.com/REALOIYO/dsh-qwenwork-connector.git
dsh plugin --profile desktop add "file:$(pwd)/dsh-qwenwork-connector"
```

也可以在 设置 → 插件 页面点「安装」选本地目录。

**从 npm 装**（发布后可用）：

```sh
dsh plugin --profile desktop add dsh-qwenwork-connector
```

装完重启 DSH，模型选择器里会多出一个「千问办公」分组。

> 改过 `src/` 的话要 `npm run build` 重新生成 `lib/`，然后重装一次 —— DSH 是把插件复制进 profile 的，不是软链。

---

## 登录

设置 → 千问办公，点「登录」。插件给出一个链接，浏览器打开、登录千问办公账号、授权，之后不用管：插件在后台轮询设备码状态，通常几秒完成。

凭据写在 `~/.dsh-qwenwork-connect/accounts.json`，刻意不放进 DSH 的配置目录，这样切 profile 或重装插件都不会丢登录态。

退出登录在同一个设置页点「移除」。

---

## 模型

| 模型 | 倍率 | 上下文上限 | 视觉 | 思考 |
|---|---|---|---|---|
| 标准（flash） | 0.1× | 1M | ✅ | ✅ |
| 高级（pro） | 1× | 1M | ✅ | ✅ |
| Qwen3.8-Max | 1.8× | 1M | ✅ | ✅ |

倍率相对标准价，0.1× 即一折。日常对话用标准档，长上下文或需要认真推理再换另外两个。

三个模型都提供 200K / 400K / 1M 三档上下文，可在设置页按模型单独指定，也可以留「自动」，由插件按消息实际大小选最省的一档。

两点需要说明：

- **只有图片输入，没有生图。** 千问办公目前不对外开放图像生成模型。
- **没有 reasoning effort 可选。** 上游模型列表里 `thinking_config` 为 `null`，未声明任何档位，因此选择器不会出现强度菜单。插件照常带 `enable_thinking: true` 打开思考，只是不传 `reasoning_effort`。上游一旦给出档位，插件会自动跟随显示。

---

## 设置页

- 登录 / 移除账号
- **刷新** —— 重新拉取剩余额度、套餐信息、下次续费日（额度不会自动更新，需要手动刷新）
- **上下文长度** —— 按模型分别设置，或留「自动」
- **模型清单** —— 倍率、视觉、思考能力均实时读自上游，不是本地写死的常量

---

## 常见问题

**提示登录失效？**
点「移除」，重新登录一次。插件不会自行清除本地数据：登录失败时旧记录保留，重新成功后才覆盖。

**报「额度已用完」？**
是千问办公侧账户额度真的耗尽，去官网充值或等续费。

**响应很慢 / 长时间无输出？**
千问办公服务端会排队。插件内部最多等两轮（每轮 ≤20s）后重试；仍失败则抛 `MODEL_POOL_BUSY`，由 DSH 按 `providerRetryPolicy()` 声明的策略继续接手。这不是本地问题。

**生成到一半中断？**
早期版本存在这个缺陷：上游的 `All models failed` 被判为普通失败，DSH 不认识该错误码直接放弃，表现为父 agent 中断而子代理仍在运行。现在 `providerRetryPolicy()` 显式声明 `MODEL_POOL_BUSY` 和 `QUEUED` 为可重试，这类等待会自动跨过。如果仍然中断，请把报错贴到 issue。

**会影响 DSH 里的其他模型吗？**
不会。插件只注册自己的 provider。内部异常全部自行兜住，即使加载失败 DSH 也照常启动，只是少一个模型来源。

**凭据存在哪，会发给谁？**
只存本地 `~/.dsh-qwenwork-connect/accounts.json`，请求只发往千问办公自己的服务器。插件代码里没有、也不可能出现第三个接收方。

---

## 可靠性与免责声明

接口行为是照着千问办公桌面客户端的实际请求实现的，各字段都用真实账号跑通验证过，不是猜测。

但仍要明确：**这是非官方实现。** 千问办公未公开 API，协议随时可能变更，届时插件会直接失效 —— 遇到这种情况请开 issue。

另外，以非官方方式访问服务，理论上存在违反服务条款的风险。是否使用、如何使用，责任自负。

---

## 致谢

实现参考了以下 MIT 许可的开源项目：

- **[dsh-magpie-connect](https://github.com/bitxeno/dsh-magpie-connect)**
  —— DSH 内模型 provider 的整体结构、图片与缓存处理，基本以此为蓝本。
  作者：dsh-magpie-connect contributors
- **[magpie](https://github.com/yetone/magpie)**
  —— 千问办公的请求发送、会话标识、错误分类。
  作者：yetone
- **[@magpie-community/opencode-qoder-auth](https://github.com/magpie-community/plugins)**
  —— 设备码授权登录流程的原始实现。
  作者：magpie-community contributors

---

## 开发笔记

两个踩过的坑，改这块代码前值得先看一眼。

**1. DSH 传下来的 tool 定义是扁平结构**

不是 OpenAI 的 `{ type:'function', function:{...} }` 包装：

```js
{ name: 'ops_bash', description: '...', parameters: { ... } }
```

早期版本只认包装格式，结果宿主给的 23 个工具被静默全部丢弃：模型看不到任何工具，想调用却无从调起，只能输出一段思维链就结束 —— 现象是「几秒钟截断，只有 reasoning 没有正文」。

`normaliseTool()` 现在两种形状都接受，改动时不要把类型收紧回去。

**2. 不要用虚构的形状去测真实链路**

`scripts/verify-real.mjs` 曾经自己拼了一个 OpenAI 包装格式来测工具调用：脚本显示通过，真实链路仍然挂。测试输入的形状必须与宿主实际给的一致，否则结论无意义。

排查这类问题：

```sh
node scripts/dump-stream.mjs              # 逐帧打印上游 SSE
node scripts/repro-reasoning-only.mjs     # 分四种条件复现「只有思维链」
```

常用命令：

```sh
npm run build        # src/ -> lib/
npm test             # node --test test/*.test.ts
npm run typecheck    # tsc --noEmit
```

---

## 许可

MIT，详见 [LICENSE](LICENSE)。

第三方组件的版权声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
