# 股票交易技能 (stock-skill)

基于 `opencli stock` 插件复用浏览器登录态同步交易数据，本地用 DuckDB 做匹配与收益统计。

## 功能

- 🔄 **数据同步**：`opencli stock sync` 复用浏览器登录态，自动分页同步同花顺账户与交易记录（本地不落任何凭证，幂等）
- 📥 **CSV 导入**：`node import-csv.js` 导入嘉信(Schwab)美股交易 CSV，默认按 1 股拆分、支持整表重导
- 🔗 **交易匹配**：自动匹配买卖记录（最短持有优先，仅盈利配对）
- 💰 **收益统计**：查询网格收益（含币种列，美股/A 股分列不可跨币种加总）
- 🔍 **未匹配排查**：查询未配对的买卖记录

## 安装

### 前置条件

1. **Node.js** v20+（v24 已验证可用，2026-09）
2. **opencli** CLI 工具

### 安装 nvm 和 Node.js

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 重新加载 shell 配置
source ~/.bashrc  # 或 source ~/.zshrc

# 安装 Node.js LTS 版本
nvm install --lts

# 使用 LTS 版本
nvm use --lts

# 验证安装
node --version  # 应显示 LTS 版本号
npm --version
```

### 安装 opencli

```bash
# 使用 npm 安装
npm install -g @jackwener/opencli

# 或使用 bun 安装
bun install -g @jackwener/opencli
```

### 安装 stock 插件

```bash
# 克隆仓库
git clone https://github.com/fhn100/stock-skill.git ~/.agents/skills/stock-skill

# 复制插件到 opencli 插件目录
cp -r ~/.agents/skills/stock-skill/resources/stock ~/.opencli/plugins/stock

# 安装插件依赖
cd ~/.opencli/plugins/stock && npm install
```

### 安装脚本依赖

```bash
cd ~/.agents/skills/stock-skill/scripts && npm install
```

## 快速开始

### 首次使用

```bash
# 1. 在浏览器登录 https://tzzb.10jqka.com.cn/pc/index.html（sync 复用该登录态）

# 2. 建表 + 同步账户与交易记录（幂等，日期格式 YYYYMMDD）
opencli stock sync 20250101 20260627

# 3. 查看收益（profit 内部已自动匹配，无需先跑 match.js）
cd ~/.agents/skills/stock-skill/scripts && node profit.js
```

### 日常使用

```bash
# 同步当月数据（建表 + 账户字典 + 交易记录）
opencli stock sync

# 查看本月收益（profit 内部已自动匹配）
cd ~/.agents/skills/stock-skill/scripts
node profit.js

# 排查未匹配记录
node unmatched.js
```

### 导入嘉信美股 CSV

```bash
cd ~/.agents/skills/stock-skill/scripts
node import-csv.js "<file.csv>" --dry-run   # 先预览解析结果
node import-csv.js "<file.csv>"             # 默认账户 嘉信-冯、按 1 股拆分导入
node profit.js                              # 配对 + 收益（美股与 A 股同一套）
```

## 命令参考

| 命令 | 参数 | 说明 |
|------|------|------|
| `opencli stock init-db` | 无 | 只初始化本地 DuckDB 表结构（sync 已自动执行） |
| `opencli stock sync` | `[startDate] [endDate]` | 复用浏览器登录态同步账户与交易记录，日期格式 YYYYMMDD，默认当月；需先登录同花顺投资决策页 |
| `node import-csv.js` | `<file.csv> [--account] [--no-split] [--replace] [--dry-run] [--db] [--verbose]` | 导入嘉信(Schwab)美股 CSV 到 `t_trade_record`（纯本地）；**默认按 1 股拆分**（`--no-split` 关闭）；`--replace` 清除本账户旧交易+配对后整表重导；表头自动识别，`market_code='US'` |
| `node match.js` | `[--db <path>]` | 匹配本地库中未配对的买卖记录（纯本地，`profit.js` 已内置此步，无需单独跑） |
| `node profit.js` | `[startMonth] [endMonth] [--db <path>]` | 查询收益，月份格式 `YYYY-MM`；一个事务内先清理查询范围内 0 过户费的匹配记录，再全库重算配对（崩溃整体回滚）；输出含**币种列**（US→USD，其余 CNY，跨币种不可加总）；交易记录 0 过户费只统计提示（需 `opencli stock sync` 重拉修复）；纯本地 |
| `node unmatched.js` | `[--code] [--name] [--op] [--start] [--end] [--account] [--all] [--db <path>]` | 查询未配对记录，默认与配对口径一致（op=1/2 且数量>0）；`--all` 含逆回购/派息等非买卖流水 |
| `node --test selftest.js` | 无 | 纯函数自测：匹配算法、净额口径、CSV 导入、日期与表格工具、schema 漂移守卫（不碰数据库） |
| `node --test inttest.js` | 无 | 钱路集成测试：临时 DuckDB 库上跑通 `tradeMatch` 落库 + `gridProfit` 三层聚合，校验收益金额、币种派生与 SQL 位置参数绑定 |

> `--db <path>` 是所有本地脚本 `STOCK_DB_OVERRIDE` 环境变量的命令行糖：二者都指向同一覆盖路径，用于隔离测试不写正式库。

## 收益口径

网格收益 = 现货买卖（op=1/2）的净额价差之和：买入净成本含佣金与过户费，卖出净所得扣同一费用。配对要求同账户、同代码、同成交数量，不做数量拆分。

因此收益**不含**国债逆回购收益（op=5/35，代码 131810 / 204001）、现金分红（op=6）与缴税、转入转出等流水，与券商账户总收益对账会有差额，属预期口径而非丢数据。

## 数据存储

| 项目 | 路径 |
|------|------|
| 数据库 | `~/.duckdb/stock/stock.db` |
| 脚本目录 | `~/.agents/skills/stock-skill/scripts/` |

## 数据库表结构

### t_trade_record（交易记录表）

| 字段 | 类型 | 说明 |
|------|------|------|
| history_id | VARCHAR | 主键；sync 由「账户+时间戳+代码+方向+数量」生成，CSV 导入由「账户\|时间\|代码\|方向\|数量\|价格」SHA1 生成 |
| account_id | VARCHAR | 账户 ID |
| account_name | VARCHAR | 账户名称 |
| account_type | VARCHAR | 账户类型（CSV 导入固定 `US`） |
| code | VARCHAR | 股票代码 |
| name | VARCHAR | 股票名称 |
| market_code | VARCHAR | 市场（`US`=美股，其余 A 股/港股）；用于币种判定与「0 过户费」清理排除美股 |
| op | VARCHAR | 操作类型（'1'买入，'2'卖出；'5'/'35' 逆回购、'6' 派息、'95' 缴税、CSV 非交易流水 '99' 等不参与配对） |
| op_name | VARCHAR | 操作名称（仅参考，不可靠，判断方向一律用 `op`） |
| entry_price | DECIMAL(10,4) | 成交价格 |
| entry_count | INTEGER | 成交数量（CSV 默认拆分为 1） |
| entry_money | DECIMAL(10,4) | 成交金额（买卖均为含费净额） |
| entry_cost | DECIMAL(10,4) | 成本 |
| fee_total | DECIMAL(10,4) | 费用合计 |
| commission | DECIMAL(10,4) | 佣金（CSV 导入恒 0，防与 entry_money 重复扣费） |
| transfer_fee | DECIMAL(10,4) | 过户费（美股恒 0） |
| entry_date | VARCHAR | 成交日期 |
| entry_time | VARCHAR | 成交时间 |
| entry_date_time | VARCHAR | 成交日期时间 |
| manual_id | VARCHAR | 手工 ID |
| oid | INTEGER | 序号 |

### t_trade_matched_record（匹配记录表）

| 字段 | 类型 | 说明 |
|------|------|------|
| sell_history_id, buy_history_id | VARCHAR | 复合主键：卖/买双方记录 ID |
| account_id, account_name | VARCHAR | 账户 |
| trans_year, trans_month | VARCHAR | 卖出所在年/月（收益按月聚合） |
| code, name | VARCHAR | 股票代码/名称 |
| sell_entry_price, buy_entry_price | DECIMAL(10,4) | 卖/买成交价 |
| sell_entry_count, buy_entry_count | INTEGER | 卖/买成交数量 |
| sell_entry_money, buy_entry_money | DECIMAL(10,4) | 卖/买成交金额 |
| sell_transfer_fee, buy_transfer_fee | DECIMAL(10,4) | 卖/买过户费 |
| profit | DECIMAL(12,4) | 该配对盈亏（卖出净额 − 买入净额） |
| sell_time, buy_time | TIMESTAMP | 卖/买成交时间 |

> 表结构以 `scripts/schema.js` 为单一来源（本地脚本建表用）；opencli 插件 `resources/stock/sync.js` 自带一份等价 DDL，由 `selftest.js` 的「schema 漂移守卫」测试保证两侧列一致。

## 故障排除

### 浏览器登录态失效

**症状**：`opencli stock sync` 报 `AuthRequiredError`，或接口返回 HTTP 401 / 403（含 "Nginx forbidden"）

**解决**：在浏览器打开并登录 `https://tzzb.10jqka.com.cn/pc/index.html`，然后重跑 sync。sync 复用浏览器登录态发起请求，本地不落 Cookie 文件，因此没有「更新 Cookie」这一步。

> 403 也可能是 Nginx 风控限流而非登录态问题：降低请求频率、缩小同步区间后重试。

### 数据异常 / 需要重算

**症状**：收益数字可疑、匹配结果与预期不符

**解决**（sync/profit 均为幂等操作，直接重跑即可，**禁止手写 SQL DELETE 修复数据**）：
```bash
# 重拉交易记录（INSERT OR REPLACE，按 history_id 幂等覆盖）
opencli stock sync 20250101 $(date +%Y%m%d)

# 重查收益（profit 一个事务内自动清理 0 过户费脏数据并重算配对，无需单独跑 match.js）
# 注：已存在的旧配对不会自动重算；0 过户费的旧配对由 profit.js 查询时自动清理重建
cd ~/.agents/skills/stock-skill/scripts
node profit.js 2026-01 $(date +%Y-%m)

# CSV 账户要换拆分口径 / 整表重导，用 --replace（仅此账户，免手删）
node import-csv.js "<file.csv>" --replace --no-split
```

### 同步失败

**检查顺序**：
1. 浏览器是否已登录同花顺投资决策页（报 `AuthRequiredError` / 401 时重新登录）
2. 网络是否正常
3. 日期格式是否正确
4. 是否 API 限流（等待 30 秒重试）

### 匹配失败

**检查顺序**：
1. 是否已同步数据
2. 时间范围是否匹配
3. 数据库是否有数据

## 开发

### 项目结构

```
stock-skill/
├── SKILL.md           # 技能定义（agent 入口文档）
├── README.md          # 本文档
├── test-prompts.json  # 触发测试用例
├── resources/
│   └── stock/         # opencli 插件（~/.opencli/plugins/stock 指向此目录的软链）
│       └── sync.js    # 浏览器登录态复用 + 账户与交易记录同步（幂等）+ init-db 建表
└── scripts/           # 本地脚本（全部不联网，只读写本地 DuckDB）
    ├── business.js    # 业务逻辑（匹配/收益）
    ├── schema.js      # 建表 DDL 单一来源（列顺序/约束），本地脚本 ensureSchema 用
    ├── db.js          # 数据库连接 + --db/STOCK_DB_OVERRIDE 处理
    ├── utils.js       # 工具函数（日期/表格/脱敏/pad2/round4）
    ├── constants.js   # 常量定义（表名、op 码、opLabel）
    ├── sql-match.js   # 匹配 SQL
    ├── sql-profit.js  # 收益 SQL
    ├── selftest.js    # 纯函数自测 + schema 漂移守卫（node --test，不碰库）
    ├── inttest.js     # 钱路集成测试（临时 DuckDB 库，校验 tradeMatch+gridProfit）
    ├── match.js       # 交易匹配入口
    ├── profit.js      # 收益查询入口
    ├── unmatched.js   # 未匹配记录查询
    └── import-csv.js  # 嘉信美股 CSV 导入入口
```

### 运行测试

```bash
# 纯函数自测 + schema 漂移守卫（不碰数据库）
cd ~/.agents/skills/stock-skill/scripts && node --test selftest.js

# 钱路集成测试（临时库，校验匹配落库与收益聚合）
node --test inttest.js

# 测试同步
opencli stock sync 20260901 20260930

# 测试收益查询（内部已自动匹配）
node profit.js 2026-09

# 测试未匹配查询
node unmatched.js --start 20260901 --end 20260930

# 测试 CSV 导入（隔离到临时库，不写正式库）
node import-csv.js "<file.csv>" --dry-run
node profit.js 2026-10 --db /tmp/test_stock.db
```

## 许可证

MIT License
