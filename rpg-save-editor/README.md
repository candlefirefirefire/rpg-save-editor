# RPG Maker 存档修改器 / RPG Maker Save Editor

一个脚本，通吃 **RPG Maker MZ / MV / VX Ace / VX / XP** 的存档。
放一个或两个 `.js` 文件到游戏目录，双击 `.bat` 就能改变量、开关、金币、物品、角色等级。

只需要 **Node.js**（建议 16+），没有其他依赖。

---

## 支持范围

| 引擎 | 存档位置 | 存档格式 | 状态 |
|---|---|---|---|
| RPG Maker MZ | `save/file*.rmmzsave` | `pako.deflate` + 伪 UTF-8 双层编码 | ✅ |
| RPG Maker MV | `www/save/file*.rpgsave` | `LZString.compressToBase64(JsonEx)` | ✅ |
| RPG Maker VX Ace | `Save*.rvdata2` | Ruby Marshal 4.8 | ✅ |
| RPG Maker VX | `Save*.rvdata` | Ruby Marshal 4.8 | ✅ |
| RPG Maker XP | `Save*.rxdata` | Ruby Marshal 4.8 | ✅ |
| RPG Maker 2000/2003 | `Save*.lsd` | 定长二进制 | ❌ 仅识别提示 |
| RPG Maker Unite | Unity 序列化 | — | ❌ 不支持 |

### 能力

| 功能 | MZ / MV | VX Ace / VX / XP |
|---|---|---|
| 全部变量（编号 / 中文名） | ✅ | ✅ |
| 开关 | ✅ | ✅ |
| 金币 | ✅ | ✅ |
| 物品数量 | ✅ | — |
| 角色等级 | ✅ | — |
| `quick.json` 一键快捷 | ✅ | ✅ |

---

## 快速开始

1. 安装 [Node.js](https://nodejs.org/)
2. 把 `rpg_tool.js` 复制到**游戏根目录**（和 `Game.exe` 同级）
   - VX / VX Ace / XP 游戏还需要一起复制 `vxace_lib.js`
3. 在该目录打开命令行：

```bash
node rpg_tool.js
```

会进入交互菜单：

```
  1) 变量   2) 开关   3) 金币   4) 查看   5) 快捷   0) 退出
```

### 命令行模式

```bash
node rpg_tool.js                # 交互菜单
node rpg_tool.js --show         # 查看全部变量 / 开关 / 金币 / 物品 / 角色
node rpg_tool.js --var 24 9999  # 改变量（编号或中文名）
node rpg_tool.js --var 游戏点数 9999
node rpg_tool.js --switch 1 on  # 开关
node rpg_tool.js --gold 999999  # 金币
node rpg_tool.js --quick        # 执行 quick.json 里的快捷项
```

### Windows 双击运行

同目录新建 `改数值.bat`：

```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0rpg_tool.js" %*
echo.
pause
```

---

## quick.json（可选）

在游戏目录放一个 `quick.json`，菜单 `5) 快捷` 就会按它执行：

```json
{
  "notes": ["体力越高越好；饥饿/口渴是「饿的程度」，0 才是满"],
  "items": [
    { "name": "贡献积分", "value": 9999 },
    { "name": "体力", "value": "max", "limit": "最大体力" },
    { "name": "饥饿", "value": 0 }
  ]
}
```

- `value` 是数字 → 直接赋值
- `value: "max"` + `limit: "某个变量名"` → 取那个变量的当前值（适合「体力 = 最大体力」这类）

---

## 工作原理

三种引擎的存档完全不是一回事，工具会自动识别：

- **MZ**：`pako.deflate(json, {level:1})`，且 NW.js 按 utf8 写字符串，磁盘上实际是「伪 UTF-8」双重编码的 zlib 流；读出时先逐字节还原再 inflate。
- **MV**：`LZString.compressToBase64(JsonEx.stringify(save))`。部分游戏魔改过 `JsonEx`，用 `@c / @a / @r` 表示对象 ID、数组包装和循环引用，工具内置了对应的 decode / encode。
- **VX Ace / VX / XP**：Ruby `Marshal.dump`（4.8）。工具只做**精确字节替换**——只改数值字段的 4 字节，其余字节原样保留，因此不会破坏数据结构。部分 RGSS 版本写类名时省略了 `:` 前缀，也做了兼容。

所有写入都会先在 `_backup_auto/` 里留一份原文件。

---

## 已知限制

- **改存档前必须完全退出游戏**。游戏退出时会把内存里的状态写回，开着改会被覆盖。
- 多存档槽位会**一起修改**（工具默认对所有 `file*` 生效）。
- VX 系列只做数值替换：如果某个变量原本是字符串或对象，工具会拒绝修改而不是强行覆盖。
- 极少数变体 Marshal 存档仍可能解析失败——此时工具会报错并**跳过该文件**，不会写入。
- 只支持单机游戏。存档格式与游戏版本绑定，游戏更新后可能需要重新适配。

---

## 免责声明

本项目仅供**个人学习与单机游戏本地修改**使用。
请自行备份存档；因使用本工具造成的存档损坏、进度丢失或违反游戏用户协议等后果，由使用者自行承担。
请勿用于联机游戏、商业用途或任何侵犯他人权益的场景。

---

## License

MIT
