# 股票交易技能 (stock-skill)

基于 `opencli stock` 插件复用浏览器登录态同步交易数据，本地用 DuckDB 做匹配与收益统计。

## 功能

- 🔄 **数据同步**：复用浏览器登录态自动分页同步交易记录（本地不落任何凭证）
- 📊 **数据同步**：自动分页同步交易记录
- 🔗 **交易匹配**：自动匹配买卖记录（时间差最小优先，仅盈利配对）
- 💰 **收益统计**：查询网格收益
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

# 3. 匹配交易记录
cd ~/.agents/skills/stock-skill/scripts && node match.js

# 4. 查看收益
node profit.js
```

### 日常使用

```bash
# 同步当月数据（建表 + 账户字典 + 交易记录）
opencli stock sync

# 本地匹配 + 查看本月收益
cd ~/.agents/skills/stock-skill/scripts
node match.js
node profit.js

# 排查未匹配记录
node unmatched.js
```

## 命令参考

| 命令 | 参数 | 说明 |
|------|------|------|
| `opencli stock init-db` | 无 | 只初始化本地 DuckDB 表结构（sync 已自动执行） |
| `opencli stock sync` | `[startDate] [endDate]` | 复用浏览器登录态同步账户与交易记录，日期格式 YYYYMMDD，默认当月；需先登录同花顺投资决策页 |
| `node match.js` | 无 | 匹配本地库中未配对的买卖记录（纯本地） |
| `node profit.js` | `[startMonth] [endMonth]` | 查询收益，月份格式 `YYYY-MM`；先按查询月份范围清理 0 过户费的匹配记录，再全库重算未匹配配对；交易记录只统计提示（需 `opencli stock sync` 重拉修复）；纯本地 |
| `node unmatched.js` | `[--code] [--name] [--op] [--start] [--end] [--account] [--all]` | 查询未配对记录，默认与配对口径一致（op=1/2 且数量>0）；`--all` 含逆回购/派息等非买卖流水 |
| `node --test selftest.js` | 无 | 纯函数自测：匹配算法、净额口径、日期与表格工具 |

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
| history_id | VARCHAR | 主键，基于交易数据生成 |
| account_id | VARCHAR | 账户 ID |
| account_name | VARCHAR | 账户名称 |
| code | VARCHAR | 股票代码 |
| name | VARCHAR | 股票名称 |
| op | VARCHAR | 操作类型（'1'买入，'2'卖出；'5'/'35' 逆回购、'6' 派息、'95' 缴税等不参与配对） |
| entry_price | DECIMAL | 成交价格 |
| entry_count | VARCHAR | 成交数量 |
| entry_money | DECIMAL | 成交金额 |
| entry_date | VARCHAR | 成交日期 |
| entry_time | VARCHAR | 成交时间 |

### t_trade_matched_record（匹配记录表）

| 字段 | 类型 | 说明 |
|------|------|------|
| sell_history_id | VARCHAR | 卖出记录 ID |
| buy_history_id | VARCHAR | 买入记录 ID |
| code | VARCHAR | 股票代码 |
| name | VARCHAR | 股票名称 |
| profit | DECIMAL | 盈亏金额 |
| sell_time | TIMESTAMP | 卖出时间 |
| buy_time | TIMESTAMP | 买入时间 |

## 故障排除

### 浏览器登录态失效

**症状**：`opencli stock sync` 报 `AuthRequiredError`，或接口返回 HTTP 401 / 403（含 "Nginx forbidden"）

**解决**：在浏览器打开并登录 `https://tzzb.10jqka.com.cn/pc/index.html`，然后重跑 sync。sync 复用浏览器登录态发起请求，本地不落 Cookie 文件，因此没有「更新 Cookie」这一步。

> 403 也可能是 Nginx 风控限流而非登录态问题：降低请求频率、缩小同步区间后重试。

### 数据异常 / 需要重算

**症状**：收益数字可疑、匹配结果与预期不符

**解决**（sync/match 均为幂等操作，直接重跑即可，**禁止手写 SQL DELETE 修复数据**）：
```bash
# 重拉交易记录（INSERT OR REPLACE，按 history_id 幂等覆盖）
opencli stock sync 20250101 $(date +%Y%m%d)

# 重跑匹配（只配对未匹配记录；费用字段以交易表最新数据为准）
# 注：已存在的旧配对不会自动重算；0 过户费的旧配对由 profit.js 查询时自动清理重建
cd ~/.agents/skills/stock-skill/scripts && node match.js

# 重查收益（自动清理查询范围内 0 过户费脏数据）
node profit.js 2026-01 $(date +%Y-%m)
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
    ├── db.js          # 数据库连接
    ├── utils.js       # 工具函数
    ├── constants.js   # 常量定义
    ├── sql-match.js   # 匹配 SQL
    ├── sql-profit.js  # 收益 SQL
    ├── selftest.js    # 纯函数自测（node --test）
    ├── match.js       # 交易匹配入口
    ├── profit.js      # 收益查询入口
    └── unmatched.js   # 未匹配记录查询
```

### 运行测试

```bash
# 测试同步
opencli stock sync 20260901 20260930

# 测试匹配
cd ~/.agents/skills/stock-skill/scripts && node match.js

# 测试收益查询
node profit.js 2026-09

# 测试未匹配查询
node unmatched.js --start 20260901 --end 20260930
```

## 许可证

MIT License
