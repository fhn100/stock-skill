import { cli, Strategy } from "@jackwener/opencli/registry";
import fs from "fs";
import { join } from "path";

// ============================ 内联工具函数 ============================

function getConfigPath() {
  const dir = join(process.env.HOME, ".duckdb", "stock");
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, "config");
  if (!fs.existsSync(path)) fs.writeFileSync(path, "", "utf8");
  return path;
}

function writeConfig(config) {
  const path = getConfigPath();
  fs.writeFileSync(path, config, 'utf8');
}

// ============================ 主逻辑 ============================

cli({
  site: "stock",
  name: "init",
  access: 'write',
  description: "初始化 Cookie 配置",
  strategy: Strategy.COOKIE,
  browser: true,
  func: async (page) => {
    try {
      console.log("配置文件路径：" + getConfigPath());
      await page.goto(
        "https://s.hexin.cn/",
      );
      await new Promise((r) => setTimeout(r, 1500));
      const cookies = await page.getCookies({ domain: ".10jqka.com.cn" });
      const config = cookies.map(item => `${item.name}=${item.value}`).join('; ');
      console.log(config);
      await writeConfig(config);
      console.log("配置文件初始化完成");
    } catch (e) {
      console.error("初始化失败:", e);
    }
  },
});
