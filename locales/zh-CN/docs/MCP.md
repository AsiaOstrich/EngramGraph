---
source: docs/MCP.md
source_version: 0.15.0-beta.1
translation_version: 0.15.0-beta.1
last_synced: 2026-11-04
status: complete
---

# EngramGraph MCP server

> **语言：** [English](../../../docs/MCP.md) · [繁體中文](../../zh-TW/docs/MCP.md) · 简体中文

EngramGraph 内置一个 [Model Context Protocol](https://modelcontextprotocol.io)
server（stdio 传输），让任何支持 MCP 的编程助手都能把它当成**代码 + 知识图谱记忆**。
它是既有、已测查询函数之上的薄 adapter——**无 LLM、确定性、免 Docker**。

server 以助手通过 stdio 启动的本地子进程运行；没有网络服务、没有容器、没有 API key。

## 配置

server 可执行文件为 `egr-mcp`（等同 `egr mcp`）。它从 `ENGRAM_DB`
（默认 `./.engram/graph.db`）读取图数据库。

### Claude Code

```bash
# 使用已安装的包：
claude mcp add egr -- npx egr-mcp

# 或指向本地 checkout 已 build 的 bin：
claude mcp add egr -- node /abs/path/to/EngramGraph/dist/mcp/stdio.js
```

要固定图谱位置，传入环境变量：

```bash
claude mcp add egr --env ENGRAM_DB=/abs/path/.engram/graph.db -- npx egr-mcp
```

用 `claude mcp list` 验证 → `egr … ✓ Connected`。

**Windows（PowerShell，非 WSL）。** 有用户在 Windows 11 上以全局安装
（`npm i -g engramgraph`）、通过 `cmd /c` 启动 bin，实测可连接：

```powershell
claude mcp add egr --scope local -e "ENGRAM_DB=C:\abs\path\.engram\graph.db" -- cmd /c egr-mcp
```

上方 `npx egr-mcp` 的写法**尚未**在原生 Windows 上验证。若在那里连不上，
请改用全局安装与上面这条命令。

**Windows：`egr-mcp` 运行中升级。** Windows 不会删除正被运行中进程加载的原生模块，而
`egr-mcp` 会加载 `ryugraph\ryujs.node`。所以在 Claude Code（或任何 MCP 客户端）开着
`egr-mcp` 的时候运行 `npm i -g engramgraph@<version>`，仍会报告成功，`egr --version`
也会打印出新版本，但有两件事是错的（macOS 与 Linux 可以删除已打开的文件，所以那里看不到
这两个问题）：

1. npm 无法删除旧的包目录。它会打印 `npm warn cleanup
   Failed to remove some directories … EPERM … ryujs.node`，并留下一份改名后的副本
   `%APPDATA%\npm\node_modules\.engramgraph-<hash>`。这个名称**每次升级都相同**
   （npm 由包路径算出）。
2. 已经在运行的 `egr-mcp` 会继续提供**旧**版本，直到它的客户端重新启动它。没有任何东西会告诉你。

该怎么做：

1. **升级前先关闭 Claude Code（或 MCP 客户端）**，这样就不会留下任何 `egr-mcp` 进程。
   残留的那个会在任务管理器里显示为一个 `node.exe`，其命令行结尾是
   `…\node_modules\engramgraph\dist\mcp\stdio.js`。
2. 升级。
3. **每次全局升级之后、下一次升级之前：重新启动所有 MCP 客户端，然后删除所有残留的
   `%APPDATA%\npm\node_modules\.engramgraph-*` 目录。** 这不是可做可不做的清理。
   残留的是旧包改名后的副本，没有东西在用它，但旧的 `egr-mcp` 打开着的 `ryujs.node`
   还在里面；而下一次升级一开始，npm 就要把已安装的包改名成同一个名称。残留还在
   的话，下一次 `npm i -g engramgraph@<version>` 会失败，报
   `EBUSY: resource busy or locked, copyfile …`，尽管你什么都没改。npm 会回滚，但回滚
   可能让包一半是旧的、一半是新的（JavaScript 文件来自一个版本、`ryujs.node` 来自另一个）；
   有一次同时开着三个 `egr-mcp` 的实测，留下了无法启动的安装（`ERR_MODULE_NOT_FOUND`）。
   若删除被拒绝，说明还有 `egr-mcp` 在运行：先把它关掉。PowerShell 命令：
   `Remove-Item -Recurse -Force "$(npm root -g)\.engramgraph-*"`（`npm root -g` 在自定义 prefix 时也找得到；`doctor` 会打印绝对路径）。
4. 确认重新启动的客户端启动的是新 server：请让助手运行 `doctor` 工具，并读它的
   **`server`** 字段。server 会把自己启动时的版本（`runningVersion`，另有 `egrVersion` 与其
   `initialize` 响应中的 `serverInfo.version`）与“此 server 启动所在的包”的
   `package.json` 比对——后者是在你询问的*当下*才从磁盘读取的（`installedVersion`），
   由 `status` 说明属于哪一种情况。全局安装时，那就是 `npm i -g` 会替换的包。
   若在自己有 `node_modules/engramgraph` 的项目里用 `npx egr-mcp`，或用 `npm link`，
   读的则是那一份，不是全局那份：升级全局包不会改变这个 server 读到的任何东西。

   - `"current"`：版本相同。
   - `"stale"`：两者不同。`message` 会说明，例如 *this MCP server is
     still running version 0.14.0, but version 0.14.1 is installed … restart the
     MCP client (for example Claude Code)*。这是在包变更（升级或降级）之前就启动的
     server：重新启动客户端。若重启后仍是 `"stale"`，说明该路径下的包没有重新构建或
     重新安装（`npm link` 时很常见）。
   - `"unknown"`：读不到已安装的版本（`message` 以 `cannot determine` 开头并说明原因，
     `installedVersion` 为 `null`）。这**不是**通过：请自己拿 `egr --version` 与
     `runningVersion` 比对，前提是客户端启动的就是你 `PATH` 上的那个 `egr-mcp`。

   `server.upgradeLeftovers` 列出已安装包旁所有的 `.engramgraph-*` 目录（没有时为空数组；找不到已安装包或目录读不到时也是空数组，所以空数组不保证没有残留）。
   不是空的时候，无论 `status` 是什么，`message` 都会多一句：先关闭客户端、删除这些目录、
   然后才再升级——“`"current"` 但有残留”正是下一次升级会失败的状态。在残留旁边全新运行
   `npm i -g` 时，`preinstall` 可能打印同样的建议（只限已没有 `package.json` 的残留，且 npm 有显示脚本输出时），但 npm 默认隐藏生命周期脚本的输出，所以
   该看的是 `doctor`。`preinstall` 本身拦不住那次会失败的升级：npm 在把包改名到残留
   目录上时就已经失败，新版本的 `preinstall` 根本还没有机会运行。

   server 绝不会因为没能去查看就报告 `"current"`。终端里的 `egr doctor` 没有 `server`
   字段：它每次都是全新的进程，所以永远就是已安装的版本。

### Codex / Cursor / Windsurf（及其他 MCP 客户端）

在客户端的 MCP 配置中加入一个 stdio server。各客户端格式略有不同，但
command/args/env 都一样：

```jsonc
{
  "mcpServers": {
    "egr": {
      "command": "npx",
      "args": ["egr-mcp"],
      "env": { "ENGRAM_DB": "/abs/path/.engram/graph.db" }
    }
  }
}
```

## 工具

下表列出全部十五个。**stdio server（`egr-mcp`、`egr mcp`）是只读的，只提供其中十一个**：除了 `index_code`、
`index_docs`、`ingest_feedback`、`related` 之外的所有工具；这四个会写入图，下表标为*仅可写入模式*。
stdio 的 `tools/list` 不含这四个（0.13.0-beta.4 会列出它们、再在每次调用时拒绝）；它们只存在于以可写入连接创建的
server，例如嵌入式使用的 `createMcpServer(conn)`。原因与各自对应的终端命令见下方“通过 stdio 不提供的工具”。

| 工具 | 输入 | 返回 |
|------|------|------|
| `index_code` *(仅可写入模式)* | `files: { path, source }[]` | 将源代码索引进代码图谱（跨文件 `CALLS`）。返回 files/functions/classes/calls（+ ambiguous/unresolved）计数。 |
| `index_docs` *(仅可写入模式)* | `docs: { content, fallbackId? }[]` | 将带 front-matter 的 markdown 索引进知识图谱。返回 specs/decisions/impacts/supersedes/relates/decisionRelates 计数，另有 `conflicts`：每个被不止一份文档声明的 id，连同保留的那份文档与被搁置的那些文档。 |
| `call_chain` | `symbol`、`direction?`（`callers`\|`callees`\|`both`）、`depth?`、`file?` | 谁调用某函数符号 / 被它调用。“改 X 会坏掉什么？”多个函数共用同一个名字时会回答而不是拒答：`definitions` 列出每一个定义（`{ id, file, startLine }`），`mergedDefinitions` 说明答案合并了几个，所以 `mergedDefinitions > 1` 表示不同函数的调用者（与被调用者）在同一份清单里。同一个类的重载共用一个节点 id，所以会是多个 `id` 相同、`startLine` 不同的条目。`file`（路径，或恰好对上一个定义所在文件的尾段）只问该文件里的定义，调用者与被调用者都适用；结果会带 `file`（存储时的写法）与该文件的 `mergedDefinitions`。`file` 里没有这个符号的定义、或尾段对上多个文件，是错误结果（`isError: true`），并列出真正定义它的文件：**绝不是 `callers: []`**。字段只增不减：只有一个定义的名字，返回和以前相同，另加 `definitions`（一项）与 `mergedDefinitions: 1`。见 [CLI.md](./CLI.md)。 |
| `impact_analysis` | `nodeId`、`maxHops?` | 某 spec 影响链中的决策（`IMPACTS` + 多跳 `SUPERSEDES`）。 |
| `ingest_feedback` *(仅可写入模式)* | `nodeId`、`type`、`nodeLabel?`（`Function`\|`Spec`\|`Decision`\|`Doc`）、`weight?` | 按反馈事件（`test_fail`/`test_pass`/`human_fix`）演化节点的 SAGE 置信度。 |
| `implementers` | `specId` | 声明 `// implements <specId>` 的文件及其定义的函数。「哪些代码实现了这个 spec？」读取 `IMPLEMENTS(Module→Spec)` + `DEFINES`。 |
| `implemented_specs` | `moduleId` | 一个文件声明自己实现了哪些 spec。「这段代码受哪个 spec 规范？」`moduleId` 是该文件被索引时的路径。读取 `IMPLEMENTS(Module→Spec)`。 |
| `related` *(仅可写入模式)* | `seedId`、`depth?`、`limit?` | 从某个种子 id 出发、结构上重要的节点（对所有边类型跑 seeded PageRank，横跨 `Function`/`Spec`/`Module`/`Decision`）。「有什么跟 X 相关？」**通过 stdio 不提供**——见下方。 |
| `explore` | `topic`、`path?`、`limit?`、`maxChars?`、`includeTests?` | **还没有符号名称时（X 怎么运作／Y 在哪里处理），先于 grep 调用它**（XSPEC-531）：输入白话主题（几个字词，不是精确名称），一次返回名称或文件路径匹配的符号、它们调用与被调用的函数（以匹配处为起点的 seeded PageRank 排序）、这些符号之间的调用路径（`callPaths`，`A → B → C`），每个符号的源代码（`snippet`），以及最相关的几个符号「改了它会影响谁」（`impact`）。不使用模型。`path` 把搜索限制在某个目录或文件之下，路径相对于 `egr index` 所给的目录（与回答中显示的文件路径同一种形式）；`limit`（默认 12、最大 50：更大的值会被降到 50，不是错误）是列出的符号数。**`maxChars`（默认 6000、下限 400、上限 200000：超出范围的值会被夹住，不是错误，返回的 `maxChars` 写明实际用了多少）限制整份回答的长度**；放不下时，先缩短 `impact` 清单、并从最不相关的符号开始去掉源代码，再去掉符号，并由 `notExpanded` 列出被去掉的内容（`symbols`、`snippets`、`impact`，以及经 `IMPORTS` 相邻的 `files`，各附 `…Total`），同时 `truncated` 为 `true`：绝不静默截断。没有 `snippet` 的符号会有 `snippetNote`（文件位置未知、已移动，或索引之后已被修改）。`status: "no-match"` 表示没有任何符号或文件路径含这些字词，这不等于代码不存在；主题含中文、日文或韩文字符时，`message` 还会说代码里的名称多半是英文，请改用英文关键字再查（连续的这类字符仍算一个字词，只在与拉丁字母或数字相接处切开，所以 `解析parseInvoice流程` 会以 `解析`、`parse`、`invoice`、`流程` 搜索）。**`impact`：改了一个符号会影响谁**（dev-platform #266）。列出的符号里，前五个既不是测试代码、也不带 `noise` 的会有 `impact`，查法与 `call_chain` 相同：`{ "callers": ["ServeHTTP (gin.go:21)"], "callersTotal": 1, "tests": ["TestEngineServeRunsMiddleware (gin_test.go:9)", ...], "testsTotal": 3, "fullList": "call_chain {...}" }`。`callers` 是直接调用该符号、且不是测试代码的函数；`tests` 是测试文件里能走到它的函数，最多向外 3 层调用，自己直接调用它的排前面（测试会经过的辅助函数也会列出）。每一条写成 `name (file:line)`，`line` 是定义开始的行号。清单最多 5 条，版面不够时更少；`callersTotal` 与 `testsTotal` 是完整数量，`fullList`（只有清单被截短时才有）是能拿到完整清单的 `call_chain` 调用，带 `direction: "callers"` 与 `depth: 3`。`impact` 最多占用 `maxChars` 在不含源代码的回答之后剩下版面的 40%，其余留给源代码；放不下的符号不会有 `impact`，并由 `notExpanded.impact`（附 `impactTotal`；名称有列出时另附 `impactFullList`，即以该符号名称调用 `call_chain` 的写法）列出，同时 `truncated` 为 `true`。**不论有没有设 `includeTests`，`impact` 里的测试都会列出**：那个参数只决定测试代码要不要当成符号列出。`callers: []` 是调用关系边的说法，不是「没有人调用」的证明：经由接口、回调函数或反射的调用没有边；而在 JavaScript 与 TypeScript，写在匿名回调（vitest、jest 的 `it("...", () => { ... })`）里的调用没有可挂上的调用者，所以这样写的测试常常找不到。**默认不列出测试代码**（`*_test.go`、`*.test.*`、`*.spec.*`、`test/`、`tests/`、`__tests__/`、`__test__/`、`testdata/`）：测试会重复它所测功能的字词，因此得分高过代码、占掉版面（在 gin 的重放里，列出的 12 个符号有 7 个是测试函数）。它们既不当起点、也不纳入调用邻域，`testsLeftOut` 会算出被略过的数量；`includeTests: true` 则把它们当一般代码列出。名称过于泛用的函数（`has`、`get`、`set`、`save`、`error`、`config`、`init`、`new` ……）与构建／工具配置文件中的函数（`vite.config.*`、`*.config.*`、`scripts/`）会被排在后面并带 `noise`（`generic-name` 或 `build-tooling`）：它们被到处调用，随机游走的质量会堆到它们身上（在 excalidraw 的重放里，`has`、`save`、`error`、`config` 都被列了出来）。它们的排名降为原来的十分之一，版面还有空间时仍会列出；泛用名称的文件路径若含主题的字词、或主题本身就是关于构建，这条规则就不适用。测试路径的完整规则与泛用名称的完整清单在代码里（`src/code-graph/explore.ts` 的 `isTestPath` 与 `GENERIC_NAMES`），它们可能比你预期的抓得更多：`start`、`run`、`open` 在泛用名称清单上，`testdata/` 目录算测试代码，所以预期的符号没出现时，先看 `testsLeftOut` 与 `noise`。`note` 是一句读法说明：每个 `snippet` 是该文件从那一行开始的原文（最多 40 行、到下一个定义为止），不是整个文件，其余要打开文件看；没有显示的内容由 `notExpanded` 列名。`next` 列出可接着用的点查询（`call_chain`），绝不从测试代码或 `noise` 起算。主题没有可搜索的字词、或图中没有任何代码，会返回错误结果。只读：只做 `MATCH` 查询与读源代码；**不**使用会写入的 `related`，所以 stdio server 可以提供它。源代码是依 parse-health manifest 记录的文件读取，所以只经 `index_code` 填入的图没有源代码可显示。见 [CLI.md](./CLI.md)。 |
| `blindspots` | — | 解析不完全或失败的文件（来自 parse-health manifest）——图可能缺少节点／边的地方。当查询报告 `indexHealth.possiblyIncomplete` 时用它查出**缺的是什么**。`manifestPresent` 用来区分「没有问题」与「从未测量过」。 |
| `signatures` | — | 同一批文件改以**根本原因**分组而非逐一列出——把「584 个文件」变成「1 个问题」。当 `blindspots` 返回很长的列表时使用。 |
| `doctor` | — | 哪些语言可用、不可用的原因、这台机器上有哪些是自行编译的、哪些命令需要网络。另有 `server: { runningVersion, installedVersion, status: "current" \| "stale" \| "unknown", message, upgradeLeftovers }`：这个运行中的 server 是否就是现在磁盘上已安装的版本（升级之前就启动的 server 是 `"stale"`；见*Windows：`egr-mcp` 运行中升级*）。**不打开图**，所以在「索引本身坏掉」时仍然回答得出来。 |
| `cochange` | `file`、`repo?`、`commits?`、`maxFilesPerCommit?`、`limit?` | 从**本机 git 历史**找出与 `file` 出现在同一批提交里的文件，次数多的在前（XSPEC-514 R2）：“这个文件以前通常还会一起改哪些文件？”读的是 `git`，不是图。`commits`（默认 200）是看该文件最近几个非合并提交；改动超过 `maxFilesPerCommit`（默认 30）个文件的提交会被跳过，答案会写明用了几个、跳过几个。不算合并提交，**不追踪重命名**。`file` 相对于 `repo`（git 工作树内的一个目录；默认为 server 的工作目录）或使用绝对路径；结果是相对于仓库根目录的路径。`existsAtHead` 表示每个路径是否还在 `HEAD` 的树里（被删除的文件与重命名前的旧路径为 `false`；`null` = git 读不出树，无法判定；绝不因此过滤文件）。结果为 `{ status: "ok", file, commitsExamined, commitsUsed, commitsSkippedLarge, commitsSkippedShallowBoundary, shallow, totalFiles, cochanged: [{ file, count, existsAtHead }], … }`。无法回答时（不在 git 工作树内、没有提交碰过该文件、git 失败或超时、每个提交都被跳过）结果是错误（`isError: true`），文本带有 `status: "undetermined"`、原因与“无法判定 (cannot determine)”：**绝不回空列表**。见 [CLI.md](./CLI.md)。 |
| `lint` | `dir`、`exclude?: string[]` | 检查 `dir` 下规格／决策 Markdown 文档的取代关系有没有自相矛盾（DEC-140）：`superseded-without-declaration`（状态写 Superseded 或 Replaced，却没有任何文档在 front matter 声明 `supersedes: <它的 id>`）与 `live-cites-superseded`（状态有效的文档仍通过 `IMPACTS` 或 `DECISION_RELATES` 引用已被取代的决策）。读的是 `egr index <dir> --docs` 会读的那批文档，**绝不打开图**；不用模型、不写入。状态是 front matter 的 `status`，没有时读第一个 `## ` 之前的第一行状态行（例如 `> **狀態**: Draft`，或表格行 `| 狀態 | Draft |`／`| **狀態** | Draft |`）；每条发现写明是哪一个（`statusSource`）。每份文档都判得出时，即使有发现也是一般结果。没有状态的文档**不判、也不算通过**：计入 `undeterminable`（无法判定）；只要有任何一份判不出、或根本没有规格／决策文档，结果就是**错误结果**（`isError: true`，文本是报告加上“无法判定”那句），不论有没有发现，与 `cochange` 相同；绝不是干净的答案。结果为 `{ status: "findings" \| "undetermined" \| "clean", scanned, supersededStatuses, findings: [{ rule, file, id, status, statusSource, reason, cites?, edge?, supersededBecause? }], counts, undeterminable: { count, files } }`。`exclude` 与 `egr index --exclude` 用同样的 glob。`dir` 读不到或不是目录时结果是没有报告的错误。见 [CLI.md](./CLI.md)。 |
| `refs_check` | `paths: string[]` | 检查 Markdown 文件／目录中（反引号包住的）文件路径与符号引用，对照图与 `git` 是否仍然正确。每个引用回报 `present`（仍存在）｜`moved`（附新位置）｜`missing`（找不到）｜`unresolvable`（信息不足，例如引用的是这个图没有索引的另一个 repo——绝不回报成 `missing`）。只读，不会修改图或被检查的文件。抽取规则见 [CLI.md](./CLI.md)。 |

每个工具都返回一个 JSON 文本内容块；失败时返回 `error: <message>` 并带 `isError: true`。

**代码查询上的 `indexHealth`。** `call_chain`、`implementers`、`implemented_specs` 与 `explore` 在答案背后的图谱有话要说时，
会加上 `indexHealth` 字段，没有就不加（解析干净且是最新的图谱不会多出这个字段）：答案靠近解析不完全或失败的文件时，是
`possiblyIncomplete`（加 `blindspots`）；已索引的文件**比索引新**或已从磁盘消失、使答案可能描述的是它们的旧内容时，是
`staleFiles`（加 `staleSample`，最多 20 个名称）。`staleFiles` 算的是整张图谱，不只这个答案；它看不到索引之后才创建的文件。`indexHealth` 现在也可能出现在解析干净的图谱上，所以判断完整性要看 `possiblyIncomplete`，不要看 `indexHealth` 在不在。`lastIndexAttempts` 列出上一次 `egr index` 运行失败、或只写了开始而没有结束的根目录（每条有 `root`、`outcome`（`"failed"` 或 `"interrupted"`）、`startedAt` 与 `fix`；`failed` 另有 `finishedAt` 与 `error`，`interrupted` 两者都没有）；它只陈述这个事实与该跑的命令，不说图谱过旧。上一次成功的图谱不会多出任何东西，所以没有它不能证明那次运行成功。
请跑 `egr index <dir> --incremental`，或在终端让 `egr watch <dir>` 一直运行（它在每次变动后重跑那个索引，并且与这个 server 并存：
图谱只在索引运行进行中才被持有）。见 [CLI.md](./CLI.md) 的 `watch`。

有两种失败是“答案”而不是崩溃，而且都不会被当成空结果返回：

- **图里没有这个名字。** 对图里没有的函数调用 `call_chain`、对没见过的 spec id 调用 `impact_analysis`，
  返回错误（`no function named "X" is in the graph — this is not the same as "nothing calls it"`），
  有相近名称时一并列出。在图里但没有调用者的函数，返回 `callers: []` 并带 `symbolFound: true`。
- **`file` 指到的文件没有这个符号的定义。** 带 `file` 的 `call_chain`，若该文件没有定义这个符号，返回错误
  （`"X" has no definition in "path" — this is not the same as "nothing calls it"; it is defined in: …`），
  不是 `callers: []`。
- **另一个进程正在写图。** 查询会重试约 5 秒（可用 `ENGRAM_LOCK_WAIT_MS` 调整），然后返回
  `the graph … is being written by another process … This is not an empty result`。

### 通过 stdio 不提供的工具，以及原因

stdio server 只在**一次查询的期间**把图**只读**打开，查完就关。这个引擎是单一写入者，而 server 是
长生命的——它跟你的编辑器开多久就活多久。如果它握有写入句柄，你在终端同时执行的任何 `egr`
命令都会跟它抢，而这个引擎上两个写入者不是单纯拒绝输的那个，是**把数据库毁掉**。如果它在查询之间握着
只读句柄，一样会挡住那些命令：引擎在打开文件时就上锁，任何平台都一样。（0.12.0 就是这样；在
Windows 11 上，编辑器开着的整段时间里 `egr index`、`egr feedback`、`egr god-nodes`、`egr related`
都会失败。）

所以 server 在查询之间什么都不握——每次工具调用付出一次打开与关闭（小图约 20 ms），终端命令只会碰到
“此刻正在跑”的那一次查询；同时重叠的工具调用共用同一次打开。所以有四个工具在这里无法工作，因此**不提供**：
`tools/list` 不含它们（用名称硬调用会得到“not found”），而 server 在客户端连接时发送的 `instructions`
会指明各自该改跑哪个命令——那个命令在 server 运行时就能用：

| 工具 | 改跑 |
|------|------|
| `index_code` | `egr index <dir>` |
| `index_docs` | `egr index <dir> --docs` |
| `ingest_feedback` | `egr feedback <type> <node-id>` |
| `related` | `egr related <seed-id>` |

server 会在下一次查询时看到结果——不需要重启。在第一次 `egr index` 之前就启动的 server，每次查询都会回答
“No graph at …”，图一出现就开始正常工作。

### 先用哪个工具，以及预先加载 `explore`

每个 server（只读或可写入）在客户端连接时都会发送一段 `instructions`。除了只读 server 不提供的那几个工具所对应的终端命令（见上），它还带有一张简短的对照表，从问题类型指向该先用的工具：X 怎么运作／Y 在哪里处理 → `explore`；谁调用它／改了它会坏什么 → `call_chain`；这段代码受哪份规格约束 → `implemented_specs`；文档与代码是否还同步 → `refs_check`。因为索引是某个时间点的快照，它也指明两个“这个答案可不可信”的自查工具：`doctor`（索引在不在、是不是最新）与 `blindspots`（哪些文件没有完整解析）。工具自己的描述只有在客户端考虑该工具时才会被读；这段文字则在一开始就读一次。

Claude Code 另外会延后加载 MCP 工具定义：助手搜索某个工具时才取回它的定义，不搜索的助手永远看不到它。工具可以用 `_meta` 键 `anthropic/alwaysLoad` 要求从第一轮就加载。**从 0.17 起，`explore` 默认就提出这个要求**（0.17 之前不会）。

**为什么默认开启。** 测量条件：Claude Code 2.1.330、claude-opus-5-5，在 excalidraw 上问两道“X 怎么运作”，每题 4 次（每种设置共 8 次）：`explore` 被延后加载（旧默认）时，**8 次里有 0 次调用 `explore`**，助手照样读文件、用 grep，好像没有 EGR；`explore` 从第一轮就加载时，**8 次全部调用，各调用一次**。每次作答的花费和完全不接 EGR 差不多（一题 0.71 对 0.72 美元，另一题 0.42 对 0.43）；比延后加载的设置略高（0.61 与 0.40），那是定义每次都在上下文里的代价。**这份证据的限制：** 一个项目、两题、一种作答模型、一个 Claude Code 版本；不论有没有接 EGR，每种设置都把两题答全了（9 分满分拿 9、8 分满分拿 8），所以它只证明“助手看得到 `explore` 时会用它”，**没有**证明答案因此更好。更早、中止的那批在 Claude Code 2.1.329 上，有一次加载设置下没有调用 `explore`，所以 8 次全中不保证每个问题、每个客户端版本都会用。这项测量记在维护者的规划笔记里，不是本仓库的测试。

**代价。** `explore` 的定义（描述与参数，约 3,200 字符）会被加载**每一次**连着这个 server 的对话，不论这个问题需不需要它，包括完全不碰代码的对话。其他工具仍然延后加载，只有 `explore` 提出要求。

**怎么关掉。** 在客户端启动 `egr-mcp` 的环境中设置 `ENGRAM_MCP_ALWAYS_LOAD=none`：

```bash
claude mcp add egr --env ENGRAM_MCP_ALWAYS_LOAD=none -- npx egr-mcp
```

关掉的代价：助手要自己想到去搜索，才看得到 `explore`；在上面的测量里，它没有想到。这个变量是以逗号分隔的工具名称列表（不区分大小写）；**没设置时列表是 `explore`，一旦设置就取代这份列表**。所以 `none`、空值、或任何不含 `explore` 的列表，都让 `explore` 保持延后加载；列表里有 `explore`（`ENGRAM_MCP_ALWAYS_LOAD=explore`，也就是 0.17 之前开启它的写法，仍然有效）则保持加载。目前只认得 `explore`，写其他工具名称没有作用。它在 server 启动时读取，所以改了之后要重启客户端。不认得这个键的客户端会直接忽略它。

### 工具标注（DEC-115 L2）

每个工具都声明了 MCP 规格的 `readOnlyHint`／`destructiveHint`／`idempotentHint`／
`openWorldHint`——这些是提示，不是保证，但完全不声明就等于什么线索都没给客户端。
每一格的值都是**读过该工具的实现**才定的，不是照名字猜的：`related` 读起来像查询，
其实不是只读——见上方它自己的说明，以及下表的 `readOnlyHint: false`。

| 工具 | readOnly | destructive | idempotent | openWorld |
|------|:--:|:--:|:--:|:--:|
| `index_code` | false | false | true | false |
| `index_docs` | false | false | true | false |
| `call_chain` | true | false | true | false |
| `impact_analysis` | true | false | true | false |
| `ingest_feedback` | false | false | **false** | false |
| `implementers` | true | false | true | false |
| `implemented_specs` | true | false | true | false |
| `related` | **false** | false | true | false |
| `blindspots` | true | false | true | false |
| `signatures` | true | false | true | false |
| `doctor` | true | false | true | false |
| `refs_check` | true | false | true | false |
| `cochange` | true | false | true | false |
| `lint` | true | false | true | false |
| `explore` | true | false | true | false |

全部都不连网（`openWorldHint: false`）——图、文件系统与 `git` 都是本机的。`cochange` 是只读的，因为它只执行 `git rev-parse` 与 `git log`（带 `GIT_OPTIONAL_LOCKS=0`），什么都不写；`lint` 是只读的，因为它只遍历一个目录并在内存中解析其中的 Markdown；两者都是读实现确认的，不是从名字推断的。
只有 `ingest_feedback` 不是幂等的：它套用的是置信度的**增量**，同一组参数调用两次
会改变分数两次，不是一次。

`related` 是出人意料的那个：从调用者的角度看，它是在*读*。但排名前必须先安装算法扩展（algo extension）
并构建投影图，两者都是写入。把它列在这里而不是移除，是因为这项能力是真的；只是这种传输方式提供不了它。

## 助手流程示例

1. **索引** repo：在终端运行 `egr index ./src --docs`（以可写入模式嵌入的 server 也可改由 `index_code`、
   `index_docs` 喂入；stdio server 不提供它们）。
2. **问“谁调用 `execute`？”** → 以 `{ symbol: "execute", direction: "callers", depth: 2 }`
   调用 `call_chain`，返回调用者。
3. **问“SPEC-001 背后有哪些决策？”** → 以 `{ nodeId: "SPEC-001" }` 调用
   `impact_analysis`，返回如 `[ADR-001, ADR-002]`。
4. **记录结果**：某函数测试失败后，在终端运行
   `egr feedback test_fail <node-id>`（或在可写入的 server 上以 `{ nodeId, type: "test_fail" }` 调用
   `ingest_feedback`）降低该节点置信度，使下次的排名查询优先浮现被更多次强化的节点。

## 备注

- 连接是**长生命周期**；EngramGraph 不会每次调用就关闭它（kuzu + tree-sitter 销毁注意事项——见
  [CONTRIBUTING.md](../CONTRIBUTING.md)）。
- 图谱与 `egr` CLI 及 REST server 共用：用任一模式索引一次，从另一个查询。
- 置信度语义（`STEP` 0.25、下限 0.1）与完整 DDL 见 [API.md](./API.md)。
