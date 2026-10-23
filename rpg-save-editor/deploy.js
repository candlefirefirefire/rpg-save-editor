#!/usr/bin/env node
/* ============================================================================
   批量部署工具：扫描指定目录下的 RPG Maker 游戏，把 rpg_tool.js 复制进去
   用法:
     node deploy.js "D:\Games"
     node deploy.js "D:\Games\Game A" "D:\Games\Game B"
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const TOOL = path.join(__dirname, 'rpg_tool.js');
const VXLIB = path.join(__dirname, 'vxace_lib.js');
const BAT = '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nnode "%~dp0rpg_tool.js" %*\r\necho.\r\npause\r\n';

const SKIP = new Set(['img', 'audio', 'movies', 'effects', 'fonts', 'locales',
    'swiftshader', 'css', 'icon', 'bookshelf', 'dictionaries', 'node_modules',
    'graphics', 'ui', 'script', 'patches', 'tool', 'tools', 'loaders', 'content',
    'engine', 'binaries', 'paks', '_backup', '_backup_auto', '_backup_boost']);

function scan(root) {
    const games = new Map();
    const stack = [[root, 0]];
    let guard = 0;
    while (stack.length && guard++ < 300000) {
        const [dir, depth] = stack.pop();
        if (depth > 9) continue;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (SKIP.has(e.name.toLowerCase())) continue;
                stack.push([full, depth + 1]);
            } else {
                const nm = e.name;
                let engine = null;
                if (nm === 'rmmz_managers.js') engine = 'MZ';
                else if (nm === 'rpg_managers.js') engine = 'MV';
                else if (nm === 'System.rvdata2' || nm === 'System.rvdata' || nm === 'System.rxdata') engine = 'VX';
                if (!engine) continue;

                let deploy;
                if (engine === 'VX') {
                    deploy = path.dirname(path.dirname(full));
                } else {
                    deploy = path.dirname(path.dirname(full));
                    let cur = deploy;
                    for (let up = 0; up < 4; up++) {
                        if (fs.existsSync(path.join(cur, 'Game.exe'))) { deploy = cur; break; }
                        cur = path.dirname(cur);
                    }
                }
                if (engine === 'MZ') {
                    const hasData = ['data', 'www/data'].some(d => fs.existsSync(path.join(deploy, d, 'System.json')));
                    if (!hasData) continue;
                }
                if (!games.has(deploy)) games.set(deploy, { engine });
            }
        }
    }
    return games;
}

const roots = process.argv.slice(2);
if (!roots.length) {
    console.log('用法: node deploy.js "<游戏根目录>" ["<另一个目录>" ...]');
    process.exit(1);
}

let total = 0;
for (const root of roots) {
    if (!fs.existsSync(root)) { console.log('跳过（不存在）: ' + root); continue; }
    const games = scan(root);
    console.log('\n' + root + ' → 找到 ' + games.size + ' 个游戏');
    for (const [deploy, info] of games) {
        fs.copyFileSync(TOOL, path.join(deploy, 'rpg_tool.js'));
        if (info.engine === 'VX') fs.copyFileSync(VXLIB, path.join(deploy, 'vxace_lib.js'));
        const bat = path.join(deploy, '改数值(通用).bat');
        if (!fs.existsSync(bat)) fs.writeFileSync(bat, BAT, 'utf8');
        console.log('  [' + info.engine + '] ' + deploy);
        total++;
    }
}
console.log('\n完成，共部署 ' + total + ' 个游戏。');
