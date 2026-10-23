/* ============================================================================
   RPG Maker 全引擎存档修改器（统一版）
   ----------------------------------------------------------------------------
   自动识别：
     · MZ  → save\file*.rmmzsave        pako.deflate(json)
     · MV  → www\save\file*.rpgsave     LZString.compressToBase64(JsonEx)
     · VX Ace / VX / XP → Save*.rvdata2/.rvdata/.rxdata   Ruby Marshal
   能力：
     变量（全量）、开关、金币；MZ/MV 额外支持物品数量、角色等级
   用法：
     node rpg_tool.js                 交互菜单
     node rpg_tool.js --show          查看全部
     node rpg_tool.js --var 24 9999   改变量（编号或名字）
     node rpg_tool.js --switch 1 on   改开关
     node rpg_tool.js --gold 99999    改金币
     node rpg_tool.js --quick         执行 quick.json 快捷项
   VX 系列需要同目录的 vxace_lib.js
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIR = new Set(['img', 'audio', 'movies', 'effects', 'fonts', 'locales',
    'swiftshader', 'css', 'icon', 'bookshelf', 'dictionaries', 'node_modules',
    'graphics', 'ui', 'script', 'patches', 'tool', 'tools', 'loaders',
    '_backup', '_backup_auto', '_backup_boost']);

/* ============================ 1. 扫描与识别 ============================ */
function scanTree(start) {
    const hit = {
        mzManagers: null, mvManagers: null,
        pako: null, lz: null, systemJson: null,
        mzSaves: [], mvSaves: [],
        vxSystem: null, vxSaves: [], rm2k: null
    };
    const stack = [start];
    let guard = 0;
    while (stack.length && guard++ < 80000) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                const n = e.name.toLowerCase();
                if (SKIP_DIR.has(n)) continue;
                stack.push(full);
            } else {
                const nm = e.name;
                if (nm === 'rmmz_managers.js') hit.mzManagers = hit.mzManagers || full;
                else if (nm === 'rpg_managers.js') hit.mvManagers = hit.mvManagers || full;
                else if (nm === 'pako.min.js') hit.pako = hit.pako || full;
                else if (nm === 'lz-string.js') hit.lz = hit.lz || full;
                else if (nm === 'System.json') hit.systemJson = hit.systemJson || full;
                else if (/^file\d+\.rmmzsave$/.test(nm)) hit.mzSaves.push(full);
                else if (/^file\d+\.rpgsave$/.test(nm)) hit.mvSaves.push(full);
                else if (nm === 'System.rvdata2' || nm === 'System.rvdata' || nm === 'System.rxdata') hit.vxSystem = hit.vxSystem || full;
                else if (/^Save\d+\.(rvdata2|rvdata|rxdata)$/i.test(nm)) hit.vxSaves.push(full);
                else if (nm === 'RPG_RT.exe' || /^Save\d+\.lsd$/i.test(nm)) hit.rm2k = hit.rm2k || full;
            }
        }
    }
    return hit;
}

const HIT = scanTree(__dirname);

let MODE = null;
let SAVE_DIR = null;
let EXT = null;

if (HIT.mzSaves.length) { MODE = 'MZ'; SAVE_DIR = path.dirname(HIT.mzSaves[0]); EXT = '.rmmzsave'; }
else if (HIT.mvSaves.length) { MODE = 'MV'; SAVE_DIR = path.dirname(HIT.mvSaves[0]); EXT = '.rpgsave'; }
else if (HIT.vxSaves.length) { MODE = 'VX'; SAVE_DIR = path.dirname(HIT.vxSaves[0]); }
else if (HIT.mzManagers) {
    MODE = 'MZ';
    SAVE_DIR = path.join(path.dirname(path.dirname(HIT.mzManagers)), 'save');
    EXT = '.rmmzsave';
} else if (HIT.mvManagers) {
    MODE = 'MV';
    SAVE_DIR = path.join(path.dirname(path.dirname(HIT.mvManagers)), 'save');
    EXT = '.rpgsave';
} else if (HIT.vxSystem) {
    MODE = 'VX';
    SAVE_DIR = path.dirname(path.dirname(HIT.vxSystem));
} else if (HIT.rm2k) {
    console.log('检测到 RPG Maker 2000/2003（' + HIT.rm2k + '）');
    console.log('这个引擎是 .lsd 二进制存档，本工具暂不覆盖；建议用 Cheat Engine 直接改内存。');
    process.exit(0);
} else {
    console.error('没认出引擎：目录里既没有 rmmz_managers.js / rpg_managers.js，也没有 Data\\System.rvdata2');
    console.error('当前目录：' + __dirname);
    process.exit(1);
}

/* ============================ 2. 通用工具 ============================ */
const backed = new Set();
function backup(file) {
    if (backed.has(file)) return;
    const dir = path.join(path.dirname(file), '_backup_auto');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, path.basename(file) + '.' + Date.now()));
    backed.add(file);
}

function readJsonSafe(p) {
    let t = fs.readFileSync(p, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
}

function pad(s, n) {
    s = String(s);
    let w = 0;
    for (const ch of s) w += /[\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1;
    return s + ' '.repeat(Math.max(0, n - w));
}

/* ---------- JsonEx：兼容标准 MV 与魔改 @c/@a/@r ---------- */
const CLASS_NAME = new WeakMap();

function jxDecode(str) {
    const root = JSON.parse(str);
    const reg = {};
    const circ = [];
    const out = jxDec(root, reg, circ);
    for (const [parent, key, id] of circ) parent[key] = reg[id];
    return out;
}
function jxDec(v, reg, circ) {
    const t = Object.prototype.toString.call(v);
    if (t !== '[object Object]' && t !== '[object Array]') return v;
    if (v['@c'] !== undefined) reg[v['@c']] = v;
    if (v['@'] !== undefined && t === '[object Object]') CLASS_NAME.set(v, v['@']);
    for (const key of Object.keys(v)) {
        if (key.startsWith('@')) continue;
        let child = v[key];
        if (child && typeof child === 'object' && child['@a'] !== undefined) {
            const body = child['@a'];
            if (child['@c'] !== undefined) body['@c'] = child['@c'];
            v[key] = body;
            child = body;
        }
        if (child && typeof child === 'object' && child['@r'] !== undefined) {
            circ.push([v, key, child['@r']]);
        }
        v[key] = jxDec(v[key], reg, circ);
    }
    return v;
}
function jxEncode(root) {
    const seen = new Map();
    let nextId = 1;
    function enc(v) {
        if (v === null || typeof v !== 'object') return v;
        if (seen.has(v)) return { '@r': seen.get(v) };
        const id = nextId++;
        seen.set(v, id);
        if (Array.isArray(v)) return { '@c': id, '@a': v.map(enc) };
        const out = {};
        const cls = CLASS_NAME.get(v);
        if (cls) out['@'] = cls;
        out['@c'] = id;
        for (const k of Object.keys(v)) { if (k.startsWith('@')) continue; out[k] = enc(v[k]); }
        return out;
    }
    return JSON.stringify(enc(root));
}

/* ============================ 3. MV / MZ ============================ */
function buildJsonEngine() {
    const pako = MODE === 'MZ' ? require(HIT.pako) : null;
    const LZ = MODE === 'MV' ? require(HIT.lz) : null;
    const dataDir = HIT.systemJson ? path.dirname(HIT.systemJson) : null;

    let VAR_NAMES = [];
    let SW_NAMES = [];
    const ITEM_NAMES = {};
    if (dataDir) {
        try {
            const sys = readJsonSafe(path.join(dataDir, 'System.json'));
            VAR_NAMES = sys.variables || [];
            SW_NAMES = sys.switches || [];
        } catch { }
        try {
            const items = readJsonSafe(path.join(dataDir, 'Items.json'));
            for (const it of items) if (it && it.name) ITEM_NAMES[it.id] = it.name;
        } catch { }
    }

    function decode(file) {
        if (MODE === 'MZ') {
            const raw = fs.readFileSync(file, 'utf8');
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) {
                const c = raw.charCodeAt(i);
                if (c > 0xff) throw new Error('非法字符 @' + i);
                bytes[i] = c;
            }
            return JSON.parse(pako.inflate(bytes, { to: 'string' }));
        }
        const text = fs.readFileSync(file, 'utf8').trim();
        const json = LZ.decompressFromBase64(text);
        if (!json) throw new Error('LZString 解压失败');
        return jxDecode(json);
    }

    function encode(data, file) {
        if (MODE === 'MZ') {
            const zip = pako.deflate(JSON.stringify(data), { to: 'string', level: 1 });
            fs.writeFileSync(file, zip, 'utf8');
        } else {
            fs.writeFileSync(file, LZ.compressToBase64(jxEncode(data)), 'utf8');
        }
    }

    const files = () => fs.readdirSync(SAVE_DIR)
        .filter(f => new RegExp('^file\\d+\\' + EXT + '$').test(f))
        .sort((a, b) => Number((a.match(/\d+/) || [0])[0]) - Number((b.match(/\d+/) || [0])[0]))
        .map(f => path.join(SAVE_DIR, f));

    function snapshots() {
        return files().map(f => {
            try { return { file: f, data: decode(f), dirty: false }; }
            catch (e) { return { file: f, data: null, error: e.message, dirty: false }; }
        });
    }

    const vs = s => { if (!s.data) return []; if (!s.data.variables) s.data.variables = {}; return s.data.variables._data || (s.data.variables._data = []); };
    const sw = s => { if (!s.data) return []; if (!s.data.switches) s.data.switches = {}; return s.data.switches._data || (s.data.switches._data = []); };

    function commit(snap) {
        let n = 0;
        for (const s of snap) {
            if (!s.dirty || !s.data) continue;
            backup(s.file);
            encode(s.data, s.file);
            s.dirty = false;
            n++;
        }
        return n;
    }

    return {
        mode: MODE,
        label: MODE === 'MZ' ? 'RPG Maker MZ' : 'RPG Maker MV',
        supportsItems: true,
        files, snapshots, commit,
        varName: id => (VAR_NAMES[id] && String(VAR_NAMES[id]).trim()) ? String(VAR_NAMES[id]).trim() : '变量' + id,
        swName: id => (SW_NAMES[id] && String(SW_NAMES[id]).trim()) ? String(SW_NAMES[id]).trim() : '开关' + id,
        varIds(snap) {
            const set = new Set();
            for (let i = 1; i < VAR_NAMES.length; i++) if (VAR_NAMES[i] && String(VAR_NAMES[i]).trim()) set.add(i);
            for (const s of snap) {
                if (!s.data) continue;
                const arr = vs(s);
                for (let i = 1; i < arr.length; i++) if (arr[i] !== null && arr[i] !== undefined && arr[i] !== '' && arr[i] !== 0) set.add(i);
            }
            return [...set].sort((a, b) => a - b);
        },
        swIds(snap) {
            const set = new Set();
            for (let i = 1; i < SW_NAMES.length; i++) if (SW_NAMES[i] && String(SW_NAMES[i]).trim()) set.add(i);
            for (const s of snap) {
                if (!s.data) continue;
                const arr = sw(s);
                for (let i = 1; i < arr.length; i++) if (arr[i]) set.add(i);
            }
            return [...set].sort((a, b) => a - b);
        },
        getVar: (s, id) => vs(s)[id],
        setVar(s, id, v) {
            const arr = vs(s);
            arr[id] = v;
            const nm = this.varName(id);
            if (/积分|点数/.test(nm) && Number.isFinite(Number(v))) {
                for (let i = 1; i < VAR_NAMES.length; i++) {
                    const ln = VAR_NAMES[i];
                    if (!ln || !/上限/.test(ln)) continue;
                    const core = String(ln).replace(/上限/, '');
                    if (core && nm.includes(core)) {
                        if ((Number(arr[i]) || 0) < Number(v)) arr[i] = Number(v);
                    }
                }
            }
            s.dirty = true;
        },
        getSwitch: (s, id) => !!sw(s)[id],
        setSwitch(s, id, v) { sw(s)[id] = v; s.dirty = true; },
        getGold: s => (s.data.party || {})._gold,
        setGold(s, v) { if (!s.data.party) s.data.party = {}; s.data.party._gold = v; s.dirty = true; },
        itemNames: ITEM_NAMES,
        items: s => (s.data.party || {})._items || {},
        setItem(s, id, n) {
            const p = s.data.party || (s.data.party = {});
            const it = p._items || (p._items = {});
            if (n <= 0) delete it[id]; else it[id] = n;
            s.dirty = true;
        },
        actors(s) {
            const list = (s.data.actors && s.data.actors._data) || [];
            return list.filter(Boolean).map(a => ({
                id: a._actorId, name: a._name, level: a._level, hp: a._hp,
                raw: a
            }));
        },
        setActorLevel(s, actorId, lv) {
            const list = (s.data.actors && s.data.actors._data) || [];
            const a = list.find(x => x && x._actorId === actorId);
            if (!a) return false;
            a._level = lv; a._cache = {};
            s.dirty = true;
            return true;
        }
    };
}

/* ============================ 4. VX Ace / VX / XP ============================ */
function buildVxEngine() {
    let LIB;
    try {
        LIB = require(path.join(__dirname, 'vxace_lib.js'));
    } catch (e) {
        console.error('VX 模式需要同目录的 vxace_lib.js（复制一份过来即可）');
        process.exit(1);
    }
    let VAR_NAMES = [];
    try { if (HIT.vxSystem) VAR_NAMES = LIB.readVarNames(HIT.vxSystem); } catch { }

    const files = () => fs.readdirSync(SAVE_DIR)
        .filter(f => /^Save\d+\.(rvdata2|rvdata|rxdata)$/i.test(f))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
        .map(f => path.join(SAVE_DIR, f));

    function applyEdits(buf, edits) {
        edits.sort((a, b) => a.start - b.start);
        const parts = [];
        let cur = 0;
        for (const e of edits) {
            if (e.start < cur) continue;
            parts.push(buf.slice(cur, e.start), e.bytes);
            cur = e.end;
        }
        parts.push(buf.slice(cur));
        return Buffer.concat(parts);
    }

    function snapshots() {
        return files().map(f => {
            try {
                const { buf, root, reader } = LIB.parseFile(f);
                const loc = LIB.locateSave(root, reader);
                return { file: f, buf, root, reader, ...loc, dirty: false };
            } catch (e) {
                return { file: f, buf: null, error: e.message, dirty: false };
            }
        });
    }

    function commit(snap) {
        let n = 0;
        for (const s of snap) {
            if (!s.dirty || !s.buf) continue;
            const edits = s._edits || [];
            if (!edits.length) { s.dirty = false; continue; }
            backup(s.file);
            fs.writeFileSync(s.file, applyEdits(s.buf, edits));
            s.dirty = false;
            s._edits = [];
            n++;
        }
        return n;
    }

    return {
        mode: 'VX',
        label: 'RPG Maker VX / VX Ace / XP',
        supportsItems: false,
        files, snapshots, commit,
        varName: id => (VAR_NAMES[id] && String(VAR_NAMES[id]).trim()) ? String(VAR_NAMES[id]).trim() : '变量' + id,
        swName: id => '开关' + id,
        varIds(snap) {
            const set = new Set();
            for (let i = 1; i < VAR_NAMES.length; i++) if (VAR_NAMES[i] && String(VAR_NAMES[i]).trim()) set.add(i);
            for (const s of snap) {
                if (!s.variables) continue;
                s.variables.items.forEach((n, i) => { if (i > 0 && n && n.v) set.add(i); });
            }
            return [...set].sort((a, b) => a - b);
        },
        swIds(snap) {
            const set = new Set();
            const s0 = snap[0];
            if (s0 && s0.switches) s0.switches.items.forEach((n, i) => { if (i > 0) set.add(i); });
            return [...set].sort((a, b) => a - b);
        },
        getVar: (s, id) => (s.variables && s.variables.items[id] ? s.variables.items[id].v : undefined),
        setVar(s, id, v) {
            const node = s.variables && s.variables.items[id];
            if (!node) throw new Error('变量 ' + id + ' 不存在');
            if (node.t !== 'int' && node.t !== 'float') throw new Error('变量 ' + id + ' 当前类型为 ' + node.t + '，跳过');
            s._edits = s._edits || [];
            s._edits.push({ start: node.start, end: node.end, bytes: Buffer.concat([Buffer.from([0x69]), LIB.encodeLong(Number(v))]) });
            s.dirty = true;
        },
        getSwitch: (s, id) => !!(s.switches && s.switches.items[id] && s.switches.items[id].v),
        setSwitch(s, id, v) {
            const node = s.switches && s.switches.items[id];
            if (!node || node.t !== 'bool') throw new Error('开关 ' + id + ' 不是布尔值');
            s._edits = s._edits || [];
            s._edits.push({ start: node.start, end: node.end, bytes: Buffer.from([v ? 0x54 : 0x46]) });
            s.dirty = true;
        },
        getGold: s => (s.gold ? s.gold.v : undefined),
        setGold(s, v) {
            if (!s.gold) throw new Error('找不到金币字段');
            s._edits = s._edits || [];
            s._edits.push({ start: s.gold.start, end: s.gold.end, bytes: Buffer.concat([Buffer.from([0x69]), LIB.encodeLong(Number(v))]) });
            s.dirty = true;
        },
        itemNames: {},
        items: () => ({}),
        setItem() { throw new Error('VX 版暂不支持改物品'); },
        actors: () => [],
        setActorLevel() { return false; }
    };
}

const ENG = MODE === 'VX' ? buildVxEngine() : buildJsonEngine();

/* ============================ 5. 展示 ============================ */
function showAll(snap) {
    console.log('引擎: ' + ENG.label + '    存档目录: ' + SAVE_DIR);
    console.log('存档: ' + (snap.length ? snap.map(s => path.basename(s.file)).join('  ') : '(无)'));
    for (const s of snap) if (s.error) console.log('  [!] ' + path.basename(s.file) + ': ' + s.error);
    const ok = snap.filter(s => !s.error);
    if (!ok.length) return;

    const ids = ENG.varIds(ok);
    console.log('\n================ 变量（' + ids.length + ' 项） ================');
    console.log('  ' + pad('编号', 6) + pad('名称', 26) + ok.map(s => pad(path.basename(s.file).split('.')[0], 11)).join(''));
    for (const id of ids) {
        const line = ['  ' + pad(id, 6) + pad(ENG.varName(id), 26)];
        for (const s of ok) line.push(pad(String(ENG.getVar(s, id)), 11));
        console.log(line.join(''));
    }

    const sids = ENG.swIds(ok);
    if (sids.length && sids.length < 60) {
        console.log('\n================ 开关（' + sids.length + ' 项） ================');
        for (const id of sids) {
            console.log('  ' + pad(id, 6) + pad(ENG.swName(id), 26) + ok.map(s => ENG.getSwitch(s, id) ? 'ON' : 'OFF').join(' / '));
        }
    } else if (sids.length) {
        console.log('\n开关共 ' + sids.length + ' 项（已开启: ' + sids.filter(id => ENG.getSwitch(ok[0], id)).join(',') + '）');
    }

    console.log('\n================ 其它 ================');
    for (const s of ok) {
        console.log('  ' + path.basename(s.file) + '   金币=' + ENG.getGold(s));
        if (ENG.supportsItems) {
            const items = Object.entries(ENG.items(s)).map(([k, v]) => (ENG.itemNames[k] || '物品' + k) + 'x' + v).join(', ');
            console.log('    物品: ' + (items || '(空)'));
            const acts = ENG.actors(s).map(a => a.id + '「' + a.name + '」Lv' + a.level).join(' | ');
            console.log('    角色: ' + (acts || '(空)'));
        }
    }
}

/* ============================ 6. 执行修改 ============================ */
function run(fn) {
    const snap = ENG.snapshots();
    const ok = snap.filter(s => !s.error);
    if (!ok.length) { console.log('没有可读的存档'); return 0; }
    let changed = 0;
    for (const s of ok) {
        try { fn(s); changed++; }
        catch (e) { console.log('  [!] ' + path.basename(s.file) + ': ' + e.message); }
    }
    const n = ENG.commit(ok);
    return n;
}

function parseVal(v) {
    const t = String(v).trim();
    if (t === '') return '';
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d*\.\d+$/.test(t)) return Number(t);
    if (t === 'true') return 1;
    if (t === 'false') return 0;
    return t;
}

function resolveVar(name, snap) {
    const t = String(name).trim();
    if (/^\d+$/.test(t)) return Number(t);
    const ids = ENG.varIds(snap.filter(s => !s.error));
    const exact = ids.filter(i => ENG.varName(i) === t);
    if (exact.length === 1) return exact[0];
    const fuzzy = ids.filter(i => ENG.varName(i).includes(t));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) throw new Error('名称不唯一: ' + fuzzy.slice(0, 8).map(i => i + '=' + ENG.varName(i)).join(' / '));
    throw new Error('找不到变量: ' + t);
}

const QUICK_FILE = path.join(__dirname, 'quick.json');
function loadQuick() {
    if (!fs.existsSync(QUICK_FILE)) return [];
    try {
        const r = readJsonSafe(QUICK_FILE);
        return Array.isArray(r) ? r : (r.items || []);
    } catch { return []; }
}

/* ============================ 7. 菜单 ============================ */
function ask(rl, q) { return new Promise(r => rl.question(q, r)); }

async function menu() {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    console.log('================ RPG Maker 存档修改器 ================');
    console.log('引擎: ' + ENG.label);
    console.log('存档: ' + (ENG.files().length ? ENG.files().map(f => path.basename(f)).join('  ') : '(还没存档)'));
    if (!ENG.files().length) { rl.close(); console.log('先启动游戏存一个档。'); return; }
    let run_ = true;
    while (run_) {
        console.log('\n  1) 变量   2) 开关   3) 金币   4) 查看   5) 快捷   0) 退出');
        const p = (await ask(rl, '选择: ')).trim();
        const snap = ENG.snapshots();
        const ok = snap.filter(s => !s.error);
        try {
            if (p === '0') break;
            if (p === '4') { showAll(snap); continue; }
            if (p === '5') {
                const items = loadQuick();
                if (!items.length) { console.log('本游戏没有 quick.json'); continue; }
                for (const it of items) {
                    const id = resolveVar(it.name, snap);
                    const val = it.value === 'max' && it.limit ? ENG.getVar(ok[0], resolveVar(it.limit, snap)) : it.value;
                    for (const s of ok) ENG.setVar(s, id, parseVal(val));
                    console.log('  ' + id + '「' + ENG.varName(id) + '」 -> ' + val);
                }
                console.log('写入 ' + ENG.commit(ok) + ' 个存档');
                continue;
            }
            if (p === '1') {
                for (const id of ENG.varIds(ok)) console.log('  ' + pad(id, 5) + pad(ENG.varName(id), 26) + ok.map(s => ENG.getVar(s, id)).join(' / '));
                const t = (await ask(rl, '变量编号/名称: ')).trim();
                if (!t) continue;
                const v = parseVal(await ask(rl, '新值: '));
                const id = resolveVar(t, snap);
                for (const s of ok) ENG.setVar(s, id, v);
                console.log('写入 ' + ENG.commit(ok) + ' 个存档');
                continue;
            }
            if (p === '2') {
                const t = (await ask(rl, '开关编号: ')).trim();
                const on = /^(on|1|true|开|是)$/i.test((await ask(rl, 'on/off: ')).trim());
                for (const s of ok) ENG.setSwitch(s, Number(t), on);
                console.log('写入 ' + ENG.commit(ok) + ' 个存档');
                continue;
            }
            if (p === '3') {
                const v = Number((await ask(rl, '金币: ')).trim());
                for (const s of ok) ENG.setGold(s, v);
                console.log('写入 ' + ENG.commit(ok) + ' 个存档');
                continue;
            }
        } catch (e) { console.log('[!] ' + e.message); }
    }
    rl.close();
}

/* ============================ 8. CLI ============================ */
const argv = process.argv.slice(2);
(async () => {
    if (!argv.length) return menu();
    const cmd = argv[0];
    if (cmd === '--show') { showAll(ENG.snapshots()); return; }
    if (cmd === '--var') {
        const snap = ENG.snapshots();
        const id = resolveVar(argv[1], snap);
        const v = parseVal(argv[2]);
        const n = run(s => ENG.setVar(s, id, v));
        console.log('变量 ' + id + '「' + ENG.varName(id) + '」= ' + v + '，写入 ' + n + ' 个存档');
        return;
    }
    if (cmd === '--switch') {
        const id = Number(argv[1]);
        const on = /^(on|1|true|开|是)$/i.test(argv[2] === undefined ? 'on' : argv[2]);
        console.log('开关 ' + id + '=' + (on ? 'ON' : 'OFF') + '，写入 ' + run(s => ENG.setSwitch(s, id, on)) + ' 个存档');
        return;
    }
    if (cmd === '--gold') {
        const v = Number(argv[1]);
        console.log('金币 -> ' + v + '，写入 ' + run(s => ENG.setGold(s, v)) + ' 个存档');
        return;
    }
    if (cmd === '--quick') {
        const items = loadQuick();
        const snap = ENG.snapshots();
        const ok = snap.filter(s => !s.error);
        for (const it of items) {
            const id = resolveVar(it.name, snap);
            const val = it.value === 'max' && it.limit ? ENG.getVar(ok[0], resolveVar(it.limit, snap)) : it.value;
            for (const s of ok) ENG.setVar(s, id, parseVal(val));
            console.log('  ' + id + '「' + ENG.varName(id) + '」 -> ' + val);
        }
        console.log('写入 ' + ENG.commit(ok) + ' 个存档');
        return;
    }
    console.log('用法: (无参数)菜单 | --show | --var 编号|名称 值 | --switch 编号 on/off | --gold 数值 | --quick');
})();
