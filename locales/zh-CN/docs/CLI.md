---
source: docs/CLI.md
source_version: 0.1.0
translation_version: 0.1.0
last_synced: 2026-05-30
status: complete
---

# CodeSage CLI

> **语言：** [English](../../../docs/CLI.md) · [繁體中文](../../zh-TW/docs/CLI.md) · 简体中文

`codesage` CLI 会把一个 repo 索引进图谱，并可从 shell 或 CI 查询它。它是 library 与
MCP server 共用的同一批已测函数之上的薄层——无 LLM、确定性。

```
codesage <command> [args] [options]
```

## 图数据库位置

每个命令都读写同一个 Kuzu 数据库，路径按以下顺序解析：

1. 显式的环境变量 `CODESAGE_DB`，否则
2. 当前工作目录下的 `./.codesage/graph.db`。

目录会按需创建，且每次打开都会确保 schema 存在（幂等），因此首次 `index` 也能在空 repo 上运行。

## 全局选项

| 选项 | 说明 |
|------|------|
| `--json` | 输出原始 JSON，而非人类可读摘要 |
| `-h`、`--help` | 显示用法 |
| `-v`、`--version` | 显示包版本 |

## 命令

### `index <dir> [--docs]`

递归将 `<dir>` 下的源代码索引进**代码图谱**（tree-sitter → `Function` / `Class` /
`Module` 节点 + 跨文件 `CALLS`）。加上 `--docs` 时，也会把 `*.md` 索引进**知识图谱**
（front-matter → `Spec` / `Decision` + `IMPACTS` / `SUPERSEDES`）。

- 代码扩展名：`.ts .tsx .js .jsx .mts .cts .mjs .cjs`（排除 `.d.ts`）。
- 跳过的目录：`node_modules`、`dist`、`.codesage`、`.git`、`coverage`。

```bash
codesage index ./src
codesage index . --docs
```

输出计数：`files`、`functions`、`classes`、`calls`，以及 `ambiguous`（被调用名称匹配到
> 1 个函数——跳过）与 `unresolved`（匹配不到——跳过）；加上 `--docs` 时还有
`specs` / `decisions` / `impacts` / `supersedes`。

### `callers <symbol> [--depth N]`

（可传递，最多到 `--depth`，默认 1）调用 `<symbol>` 的函数。“改这个会牵动什么？”

```bash
codesage callers callChain --depth 2
```

### `callees <symbol> [--depth N]`

`<symbol>`（可传递，最多到 `--depth`，默认 1）所调用的函数。

```bash
codesage callees createMcpServer
```

> `--depth` 会被夹到 `1..10`。符号以**名称**匹配；若名称在多个文件中重复使用，所有匹配项都会被纳入。

### `impact <spec-id> [--max-hops N]`

某个 spec 的影响链中的决策——哪些 `Decision` 节点通过直接的 `IMPACTS` 边，加上多跳
`SUPERSEDES` 链（`--max-hops`，默认 3，夹到 `1..10`），影响此 `Spec`。

```bash
codesage impact XSPEC-237
codesage impact XSPEC-237 --max-hops 5 --json
```

每条结果显示决策 `id`、抵达方式（`direct` | `supersedes`）与其 `title`。

### `feedback <type> <node-id> [--label L]`

按一个反馈事件演化某节点的 SAGE 置信度。

- `<type>`：`test_fail`（负向、权重 1.0）、`test_pass`（正向、0.4）、
  `human_fix`（正向、0.6）、`status_change`（中性）。
- `--label`：`Function`（默认）| `Spec` | `Decision` | `Doc`。
- 节点以 **id** 匹配（`Decision` / `Spec` 的 id 例如 `DEC-1` / `XSPEC-1`；
  `Function` 则是作用域限定的 id，如 `src/a.ts#a`）。

```bash
codesage feedback test_fail "src/api/server.ts#createServer"
codesage feedback human_fix DEC-070 --label Decision
```

打印 `before → after`，若 id/label 未命中则打印 "node not found"。

### `top <label> [--limit N]`

某标签下置信度最高的节点，按置信度递减。

- `<label>`：`Function` | `Spec` | `Decision` | `Doc`。
- `--limit`：默认 10，夹到 `1..1000`。

```bash
codesage top Function --limit 20
codesage top Decision --json
```

### `serve [--port 3000]`

在图数据库上运行 REST server（Hono）。路由挂载于 `/graph/*` 加上 `GET /health`。
长时间运行——自行管理生命周期。路由接口见 [API.md](./API.md)。

```bash
codesage serve --port 3000
```

### `mcp`

以 stdio 运行 MCP server 供编程助手使用，与 `codesage-mcp` bin 相同。长时间运行。
助手配置见 [MCP.md](./MCP.md)。

```bash
codesage mcp
```

## CI 示例

```bash
export CODESAGE_DB="$PWD/.codesage/graph.db"
codesage index ./src --docs
# 例如：当高风险符号出现新的调用者时让 job 失败，用 --json 查询等。
codesage callers paymentGateway --depth 3 --json > callers.json
```

## 退出码

成功为 `0`；错误为 `1`（消息以 `codesage: <message>` 写到 stderr）。
