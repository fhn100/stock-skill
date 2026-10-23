---
name: stock-skill
description: "股票交易数据管理：同步交易记录、导入嘉信美股 CSV、匹配买卖、统计网格收益、排查未匹配记录。触发词：收益、网格收益、赚了多少、同步、导入、嘉信、美股、CSV、匹配、未匹配、重跑、profit、stock"
category: finance
---

# 股票交易技能

基于 `opencli stock` 插件复用浏览器登录态同步交易数据，本地用 DuckDB 做匹配与收益统计。

## 环境

- **脚本目录**：`~/.agents/skills/stock-skill/scripts/`（所有命令必须在此目录下执行）
- **数据库**：`~/.duckdb/stock/stock.db`（唯一落盘数据；**本地不保存任何凭证**，联网只由 `opencli stock sync` 在浏览器上下文内发起）
- **Node 版本**：node v24 可正常运行（2026-09 验证）；若遇 DuckDB 原生模块加载错误，先 `npm rebuild`，仍失败再降级 node v20，详见 [README.md 故障排除](README.md#故障排除)

## 命令总览

| 功能 | 命令 | 说明 |
|------|------|------|
| 交易记录同步 | `opencli stock sync [start] [end]` | 复用浏览器登录态（策略 COOKIE）拉取数据；需先在浏览器登录 `https://tzzb.10jqka.com.cn/pc/index.html`。建表 + 同步账户字典 + 交易记录，日期格式 `YYYYMMDD`（默认当月）；自动分页、幂等 |
| 仅初始化表结构 | `opencli stock init-db` | 只建表建索引（sync 启动时已自动执行） |
| 嘉信美股 CSV 导入 | `node import-csv.js <file.csv> [--account 嘉信-冯] [--no-split] [--replace] [--dry-run] [--verbose]` | 把嘉信(Schwab)网页导出的 Trades/Transactions CSV 导入 `t_trade_record`（纯本地，不联网）。表头自动识别，支持英文/中文列名；**默认按 1 股拆分**买入/卖出（qty=N → N 条 1 股记录，便于与逐笔小额成交配对，`--no-split` 关闭）；`--replace` 整表重导（先清除本账户旧交易+配对，切换拆分口径或重新导出时用，免手写 DELETE）；`history_id` 稳定幂等，重跑覆盖不重复；`market_code='US'`。默认账户名 `嘉信-冯`，只写交易表，配对/收益仍需再跑 `profit.js` |
| 交易记录匹配 | `node match.js` | 匹配本地库中未配对的买入/卖出（纯本地，不联网） |
| 收益统计 | `node profit.js [startMonth] [endMonth]` | 查询网格收益，月份格式 `YYYY-MM`；年收益 = 年初至截止月累计。执行时在一个事务内先清理**查询范围内** 0 过户费的匹配记录、再调用与 `match.js` 相同的 `tradeMatch()` 重算配对（崩溃则整体回滚，不会留下"删了未重配"的不一致）；0 过户费的交易记录只统计提示，需 `opencli stock sync` 重拉修复。输出含**币种列**（嘉信等 `market_code='US'` 账户标 USD，其余 CNY，跨账户不可加总）；纯本地，不联网 |
| 未匹配查询 | `node unmatched.js [--code] [--name] [--op] [--start] [--end] [--account] [--all]` | 默认只列可配对记录（op=1/2 且数量>0），与 `match.js` 口径一致；`--all` 含逆回购/派息等非买卖流水 |
| 纯函数自测 | `node --test selftest.js` | 校验匹配算法、净额口径、CSV 导入、日期与表格工具、schema 漂移守卫（不碰数据库） |
| 钱路集成测试 | `node --test inttest.js` | 临时 DuckDB 库跑通 `tradeMatch` 落库 + `gridProfit` 聚合，校验收益金额、币种与 SQL 参数绑定 |

**📋 触发词与动作映射**：首次使用/初始化 → 首次使用流程（插件就位 + 浏览器登录 + sync）；同步、拉取交易 → `opencli stock sync`；导入、嘉信、Schwab、美股、CSV → `import-csv.js`；匹配、配对 → `match.js`；收益、赚了多少、网格收益 → `profit.js`；未匹配、为什么没配上 → `unmatched.js`；重跑、重新匹配 → `node match.js`。

**本技能已不联网**：`scripts/` 下的脚本全部只读写本地 DuckDB；实时行情与账户收益卡片能力已下线，联网只有 `opencli stock sync` 一条路径。

**⚠️ 不提供删除能力**：本技能没有删除交易/匹配记录的工具，也禁止手写 SQL DELETE。数据修正一律通过幂等的 `opencli stock sync` / `node match.js` 重跑覆盖完成（`profit.js` 只删除查询范围内 0 过户费的匹配记录并立即重配，不删交易记录）。

**📐 收益口径**：网格收益 = 现货买卖的净额价差之和（买入净成本含佣金过户费，卖出净所得扣费），**不含**国债逆回购收益（op=5/35）、现金分红（op=6）、缴税/转入转出等非买卖流水。与券商账户的总收益对账时会有差额，属预期口径而非丢数据。

## 标准工作流

### 场景：首次使用

```bash
# 🔴 STOP · 检查点：首次使用前确认环境
# 执行前询问："首次使用需要初始化并同步当月数据，确认继续？"

# 1. 确认 opencli stock 插件已就位（未就位则复制仓库 resources/stock 到插件目录）
ls ~/.opencli/plugins/stock/sync.js || cp -r ~/.agents/skills/stock-skill/resources/stock ~/.opencli/plugins/stock

# 2. 确认浏览器已登录同花顺投资决策页（sync 复用该登录态，本地不落凭证）
#    未登录时先在浏览器打开并登录 https://tzzb.10jqka.com.cn/pc/index.html

# 3. 建表 + 同步账户与当月交易记录
opencli stock sync
```

### 场景：查看收益（最常用）

```bash
# 步骤1：同步最新数据（用户说"同步"或"最新"时执行；纯查询收益可跳过）
opencli stock sync

# 步骤2：统计（在脚本目录下执行；profit 内部已自动匹配，无需先跑 match.js）
cd ~/.agents/skills/stock-skill/scripts
node profit.js [YYYY-MM] [YYYY-MM]
```

**执行规则**：
- 用户说"这个月收益" → 直接执行 `node profit.js`（profit 会先对全库未匹配记录重算配对再统计，不必前置 `match.js`）
- 用户说"同步并查看收益" / "最新收益" → 按顺序执行 sync → profit
- 仅想重算配对而不看收益时才单独跑 `node match.js`
- **结果必须以 Markdown 表格输出给用户**（收益等统计结果均适用），格式见下方「输出格式」

**边界处理：**
- 登录态失效：`sync` 报 `AuthRequiredError` / HTTP 401/403 时，提示在浏览器重新登录 `https://tzzb.10jqka.com.cn/pc/index.html` 后重试（无本地 Cookie 文件可更新）
- 网络异常：提示检查网络连接后重试
- 无数据：提示是否需要同步历史数据

**输出示例**（仅含盈利配对，无负数；以 Markdown 表格输出给用户）：

```markdown
## 📊 收益统计结果（2026-07）

| 账户 | 币种 | 代码 | 名称 | 交易次数 | 收益 |
|------|:---:|------|------|:---:|---:|
| 国泰-冯* | CNY | 02269 | 药明生物 | 5 | 5,020.87 |
| 国泰-冯* | CNY | 512400 | 有色金属ETF南方 | 6 | 403.26 |
| 嘉信-冯* | USD | TSLA | TESLA INC | 19 | 166.10 |

| 账户 | 币种 | 月收益（2026-07） | 年收益（累计） |
|------|:---:|---:|---:|
| 国泰-冯* | CNY | **6,654.73** | 75,942.36 |
| 嘉信-冯* | USD | **166.10** | 1,048.65 |
```

> 币种由 `market_code` 派生（`US`→USD，其余→CNY）；同账户天然单币种，**跨币种不可加总**。

### 场景：重跑某月配对（不删数据）

配对结果不对或想纳入新对手盘时，**不删数据**，直接重跑收益统计（`profit.js` 会对全库未配对记录重算，无需单独 match）：

```bash
cd ~/.agents/skills/stock-skill/scripts
node profit.js 2026-09
```

只想重算配对、不出收益表时，才单独跑 `node match.js`。

注意：`opencli stock sync` 采用 INSERT OR REPLACE 幂等写入，同窗口重跑即交易数据修正的唯一手段。

### 场景：同步历史数据

```bash
# 🔴 STOP · 检查点：同步前必须确认时间范围
# 执行前询问："确认同步 XXXX-XX-XX 至 XXXX-XX-XX 的数据？"

opencli stock sync 20250101 20260627

# 🔴 STOP · 检查点：匹配前确认同步完成
cd ~/.agents/skills/stock-skill/scripts && node match.js
```

**🔴 STOP · 检查点：** 大范围同步（超过 3 个月）前必须确认用户意图，避免长时间等待。

### 场景：导入嘉信(Schwab)美股 CSV

用户提供嘉信证券导出的 CSV（`Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount` 等表头，支持英文 Trades/Transactions 与常见中文表头）时：

```bash
cd ~/.agents/skills/stock-skill/scripts

# 步骤1（可选）：先 dry-run 预览解析结果，确认账户名/行数是先 dry-run 预览解析结果，确认账户名/行数无误
node import-csv.js "<file.csv>" --dry-run

# 步骤2：正式导入交易表（默认账户 嘉信-冯，可用 --account 覆盖；默认按 1 股拆分）
node import-csv.js "<file.csv>"

# 切换拆分/不拆分口径，或重新导出覆盖时，用 --replace 整表重导（免手删）
node import-csv.js "<file.csv>" --replace --no-split

# 步骤3：配对 + 收益（profit 内部自动匹配；美股与 A 股走同一套）
node profit.js [YYYY-MM] [YYYY-MM]
```

**导入语义（勿改，改了会算错收益）：**
- **按 1 股拆分（默认开启）**：买入/卖出 qty=N 的记录会拆成 N 条 `entry_count=1` 记录，`entry_money` 按 N 均分（round4），配对更细。因拆分后 `history_id` 与未拆分版不同，**切换拆分/不拆分口径须用 `--replace` 整表重导**（导入前自动清除本账户旧交易+配对，作用域仅此账户），否则新旧并存重复计数。嘉信数据可从 CSV 完整重导，可逆。`--no-split` 保留原始整笔数量。
- `entry_money` 写入 CSV 的 `Amount` 列——它**已含佣金扣费**（卖出=实收、买入=实付净额）。因此 `commission` 恒记 0、`transfer_fee` 恒记 0，`netMoneyOf` 得到的净额即真实现金流；**若把 `Fees & Comm` 列也映射成 commission 会重复扣费**。
- 只有 Buy/Sell（op=1/2）参与配对；Margin Interest、Credit Interest、MoneyLink Transfer 等无 `Symbol` 的非交易流水会被跳过并告警，属预期（不影响网格收益）。
- `market_code='US'`：`profit.js` 的「0 过户费脏数据」清理已按 `market_code='US'` 排除美股账户，不会误删嘉信配对记录。
- 幂等：`history_id` 由「账户|时间|代码|方向|数量|价格」SHA1 生成，同 CSV 重跑 INSERT OR REPLACE 覆盖；同日同参数重复成交自动追加序号防主键冲突。

### 场景：查询交易记录（DuckDB MCP）

**优先使用 DuckDB MCP 工具直接查询**，不要写 node 脚本。

**MCP工具调用方式：**
```
mcp_mcp_server_duckdb_query(query="SQL语句")
```

**常用查询模板：**

```sql
-- 查询个股交易记录
SELECT account_name, name, code, op, entry_price, entry_count, entry_money, entry_date, entry_time
FROM t_trade_record WHERE name LIKE '%股票名%' ORDER BY entry_date DESC, entry_time DESC LIMIT 20

-- 查询匹配记录
SELECT account_name, name, code, sell_entry_price, buy_entry_count, sell_entry_money, buy_entry_money, profit, sell_time, buy_time
FROM t_trade_matched_record WHERE name LIKE '%股票名%' ORDER BY sell_time DESC LIMIT 20

-- 查询今日交易
SELECT entry_date, entry_time, code, name, op, entry_price, entry_count, entry_money
FROM t_trade_record WHERE entry_date = current_date ORDER BY entry_time
```

**注意：** op='1' 买入，op='2' 卖出。始终用 `op` 字段，不要用 `op_name`。

## 输出格式（回复用户规范）

| 命令 | 输出格式 |
|------|----------|
| profit | 脚本原始输出为纯文本表格；**回复用户时必须转为 Markdown 表格**：个股明细表（账户/币种/代码/名称/交易次数/收益）+ 汇总表（账户/币种/月收益/年收益），金额千分位格式化；务必带币种列，提醒跨币种不可加总 |
| sync | `opencli stock sync`：成功：记录数+时间范围；失败：区分登录态失效（提示浏览器重新登录）与风控限流（降低频率重试） |
| match | 成功：匹配数量；部分未匹配：提示原因 |

## 数据速查

| 项目 | 值 |
|------|---|
| 交易记录表 | `t_trade_record` |
| 匹配记录表 | `t_trade_matched_record` |
| 数据库索引 | `idx_trade_op_date`(op,entry_date), `idx_trade_code`, `idx_matched_sell_history`, `idx_matched_sell_time` 等 |
| op 码 | `1`=买入、`2`=卖出（仅此两者参与配对）；`5`/`35`=逆回购买卖（代码 131810 R-001、204001 GC001）、`6`=派息、`95`=缴税、`18`/`86`=转入、`19`/`87`=转出、`222`=入账、`235`/`236`=0 成本入账类买卖（⚠️ 始终用 `op` 数字字段，`op_name` 不可靠） |
| 配对范围 | 仅同账户 + 同代码 + 同成交数量可互配，不做数量拆分；逆回购/派息等不参与配对 |

## 注意事项

- 账户超 1000 条自动分页拉取（根据 API 返回的 max_page）
- history_id 基于交易数据生成，确保幂等性
- 不支持手动删记录：无删除工具且禁止手写 SQL DELETE，修正数据靠幂等重跑 sync/match

## 🔴 红线速查

- **不要**手写 SQL DELETE / 手动 INSERT 修改数据；清除 CSV 账户旧数据用 `import-csv.js --replace`（内部按 account_id 精确清除并重导），A 股数据修正靠幂等重跑 `opencli stock sync`
- **不要**直接查匹配表当收益：未匹配记录不计入收益；`profit.js` 已在查询前自动重算配对，无需单独跑 `match.js`
- **不要**同时运行多个 sync/profit/match 进程（DuckDB 单写者锁会静默丢写入）

故障排查见 [README.md 故障排除](README.md#故障排除)；命令清单与口径以本文件「命令总览」「收益口径」「红线速查」为准。
