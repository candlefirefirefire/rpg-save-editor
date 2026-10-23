/* ============================================================================
   RPG Maker VX Ace 存档读写（Ruby Marshal 4.8 的最小实现）
   ----------------------------------------------------------------------------
   · 只做「读取 + 精确字节替换」，未修改的字节原样保留，风险最小
   · 存档：SaveNN.rvdata2 / Data/System.rvdata2，格式 04 08 + Marshal 数据
   · 变量：存档 root[:variables]（Game_Variables）→ @data（Array）
   · 变量名：Data/System.rvdata2 里 RPG::System 的 @variables（Array<String>）
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- Marshal 基础 ---------- */
function readLong(buf, p) {
    const c = buf.readInt8(p);
    p++;
    if (c === 0) return { v: 0, p };
    if (c > 0) {
        if (c > 4) return { v: c - 5, p };
        let v = 0n;
        for (let i = 0; i < c; i++) v |= BigInt(buf[p++]) << BigInt(8 * i);
        return { v: Number(v), p };
    }
    if (c < -4) return { v: c + 5, p };
    const n = -c;
    let v = 0n;
    for (let i = 0; i < n; i++) v |= BigInt(buf[p++]) << BigInt(8 * i);
    return { v: Number(v - (1n << BigInt(8 * n))), p };
}

function encodeLong(v) {
    v = Number(v);
    if (v === 0) return Buffer.from([0]);
    if (v > 0) {
        if (v <= 122) return Buffer.from([v + 5]);
        const bytes = [];
        let x = BigInt(v);
        while (x > 0n) { bytes.push(Number(x & 0xffn)); x >>= 8n; }
        return Buffer.from([bytes.length, ...bytes]);
    }
    if (v >= -123) return Buffer.from([(v - 5) & 0xff]);
    const bytes = [];
    let x = BigInt(v);
    // 负数的多字节形式：取反加一的补码字节序列
    while (x < -1n) { bytes.unshift(Number(x & 0xffn)); x >>= 8n; }
    return Buffer.from([(256 - bytes.length) & 0xff, ...bytes]);
}

function utf8(b) { return Buffer.from(b).toString('utf8'); }

/* ---------- 解析 ---------- */
class MarshalReader {
    constructor(buf) {
        this.buf = buf;
        this.p = 0;
        this.symbols = [];
        this.objects = [];
    }

    parse() {
        const b = this.buf;
        if (b[0] !== 0x04 || b[1] !== 0x08) throw new Error('不是 Marshal 4.8 数据');
        this.p = 2;
        return this.readValue();
    }

    readValue() {
        const start = this.p;
        const peek = this.buf[this.p];
        if (process.env.VXTRACE && this.p > 12400) {
            console.error('[trace] @' + this.p + ' type=0x' + (peek === undefined ? 'EOF' : peek.toString(16)));
        }
        const t = this.buf[this.p++];
        switch (t) {
            case 0x30: return { t: 'nil', start, end: this.p };
            case 0x54: return { t: 'bool', v: true, start, end: this.p };
            case 0x46: return { t: 'bool', v: false, start, end: this.p };
            case 0x69: {
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                return { t: 'int', v: r.v, start, end: this.p };
            }
            case 0x6c: { // Bignum：符号 + 长度 + 2 字节组
                const sign = this.buf.readInt8(this.p) > 0 ? 1 : -1;
                this.p++;
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                const words = r.v;
                let val = 0n;
                for (let i = 0; i < words; i++) {
                    const w = this.buf.readUInt16LE(this.p);
                    this.p += 2;
                    val |= BigInt(w) << BigInt(16 * i);
                }
                const node = { t: 'int', v: sign * Number(val), start, end: this.p };
                this.objects.push(node);
                return node;
            }
            case 0x66: { // Float
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                const s = this.buf.slice(this.p, this.p + r.v).toString('latin1');
                this.p += r.v;
                const node = { t: 'float', vStr: s, v: Number(s), start, end: this.p };
                this.objects.push(node);
                return node;
            }
            case 0x3a: { // Symbol
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                const s = this.buf.slice(this.p, this.p + r.v).toString('utf8');
                this.p += r.v;
                const node = { t: 'sym', s, start, end: this.p };
                this.symbols.push(s);
                return node;
            }
            case 0x3b: { // Symbol link
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                return { t: 'symref', idx: r.v, start, end: this.p };
            }
            case 0x40: { // Object link
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                return { t: 'link', idx: r.v, start, end: this.p };
            }
            case 0x22: { // String
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                const bytes = this.buf.slice(this.p, this.p + r.v);
                this.p += r.v;
                const node = { t: 'str', b: bytes, iv: [], start, end: this.p };
                this.objects.push(node);
                return node;
            }
            case 0x5b: { // Array
                const r = readLong(this.buf, this.p);
                if (process.env.VXTRACE && (start > 12000 || r.v > 200)) console.error('[arr] @' + start + ' count=' + r.v);
                this.p = r.p;
                const node = { t: 'arr', items: [], start, end: 0 };
                this.objects.push(node);
                for (let i = 0; i < r.v; i++) node.items.push(this.readValue());
                node.end = this.p;
                return node;
            }
            case 0x7b: { // Hash
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                const node = { t: 'hash', pairs: [], start, end: 0 };
                this.objects.push(node);
                for (let i = 0; i < r.v; i++) {
                    const k = this.readValue();
                    const v = this.readValue();
                    node.pairs.push([k, v]);
                }
                node.end = this.p;
                return node;
            }
            case 0x7d: { // Hash with default
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                const node = { t: 'hash', pairs: [], start, end: 0 };
                this.objects.push(node);
                for (let i = 0; i < r.v; i++) {
                    const k = this.readValue();
                    const v = this.readValue();
                    node.pairs.push([k, v]);
                }
                node.default = this.readValue();
                node.end = this.p;
                return node;
            }
            case 0x6f: { // Object
                const cls = this.readValue();           // Symbol
                const cnt = readLong(this.buf, this.p);
                this.p = cnt.p;
                const node = { t: 'obj', cls: cls.s || '', iv: [], start, end: 0 };
                this.objects.push(node);
                for (let i = 0; i < cnt.v; i++) {
                    const k = this.readValue();
                    const pv = this.p;
                    const v = this.readValue();
                    if (process.env.VXDEBUG) {
                        console.error('[obj ' + node.cls + '] ivar#' + i + ' ' + (k.s || k.idx || '?') +
                            ' type=' + v.t + ' @' + pv + '->' + this.p);
                    }
                    node.iv.push([k, v]);
                }
                node.end = this.p;
                return node;
            }
            case 0x75: { // UserDefined
                const cls = this.readValue();
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                const bytes = this.buf.slice(this.p, this.p + r.v);
                this.p += r.v;
                const node = { t: 'user', cls: cls.s || '', b: bytes, start, end: this.p };
                this.objects.push(node);
                return node;
            }
            case 0x55: { // UserMarshal
                const cls = this.readValue();
                const val = this.readValue();
                const node = { t: 'user', cls: cls.s || '', b: null, v: val, start, end: this.p };
                this.objects.push(node);
                node.end = this.p;
                return node;
            }
            case 0x49: { // IVAR wrapper
                const inner = this.readValue();
                const cnt = readLong(this.buf, this.p);
                this.p = cnt.p;
                const iv = [];
                for (let i = 0; i < cnt.v; i++) {
                    const k = this.readValue();
                    const v = this.readValue();
                    iv.push([k, v]);
                }
                if (inner.t === 'str' || inner.t === 'obj' || inner.t === 'user') {
                    inner.iv = (inner.iv || []).concat(iv);
                }
                inner.end = this.p;
                if (inner.start === undefined) inner.start = start;
                return inner;
            }
            case 0x53: { // Struct
                const cls = this.readValue();
                const cnt = readLong(this.buf, this.p);
                this.p = cnt.p;
                const node = { t: 'struct', cls: cls.s || '', items: [], start, end: 0 };
                this.objects.push(node);
                for (let i = 0; i < cnt.v; i++) {
                    const k = this.readValue();
                    const v = this.readValue();
                    node.items.push([k, v]);
                }
                node.end = this.p;
                return node;
            }
            case 0x63: case 0x6d: case 0x4d: { // Class / Module（含 RGSS 变体：类名不带 ':' 前缀）
                const next = this.buf[this.p];
                let name;
                if (next === 0x3a || next === 0x3b) {
                    const r = this.readValue();
                    name = r.s || '';
                } else {
                    const len = readLong(this.buf, this.p);
                    this.p = len.p;
                    name = this.buf.slice(this.p, this.p + len.v).toString('utf8');
                    this.p += len.v;
                }
                const node = { t: (t === 0x63 ? 'class' : 'module'), name, start, end: this.p };
                this.objects.push(node);
                return node;
            }
            case 0x43: { // UCLASS
                const r = this.readValue();
                const val = this.readValue();
                return { t: 'uclass', name: r.s || '', v: val, start, end: this.p };
            }
            case 0x65: { // extended
                const r = this.readValue();
                const val = this.readValue();
                return { t: 'extended', name: r.s || '', v: val, start, end: this.p };
            }
            case 0x64: { // Data
                const cls = this.readValue();
                const cnt = readLong(this.buf, this.p);
                this.p = cnt.p;
                const node = { t: 'data', cls: cls.s || '', items: [], start, end: 0 };
                this.objects.push(node);
                for (let i = 0; i < cnt.v; i++) {
                    const k = this.readValue();
                    const v = this.readValue();
                    node.items.push([k, v]);
                }
                node.end = this.p;
                return node;
            }
            case 0x2f: { // Regexp
                const r = readLong(this.buf, this.p);
                this.p = r.p;
                this.p += r.v;
                const flags = this.buf[this.p++];
                const node = { t: 'regexp', flags, start, end: this.p };
                this.objects.push(node);
                return node;
            }
            default: {
                const from = Math.max(0, this.p - 20);
                const to = Math.min(this.buf.length, this.p + 20);
                console.error('[marshal] 未知标记 0x' + (t === undefined ? 'EOF' : t.toString(16)) +
                    ' @' + (this.p - 1) + ' 上下文: ' + this.buf.slice(from, to).toString('hex'));
                throw new Error('未知 Marshal 标记 @' + (this.p - 1));
            }
        }
    }
}

/* ---------- 辅助：遍历 ---------- */
function symText(node, reader) {
    if (!node) return null;
    if (node.t === 'sym') return node.s;
    if (node.t === 'symref' && reader && reader.symbols[node.idx] !== undefined) return reader.symbols[node.idx];
    return null;
}

function findHashValue(hashNode, keyName, reader) {
    for (const [k, v] of hashNode.pairs || []) {
        if (symText(k, reader) === keyName) return v;
    }
    return null;
}

function ivarValue(objNode, name, reader) {
    for (const [k, v] of objNode.iv || []) {
        if (symText(k, reader) === name) return v;
    }
    return null;
}

function deref(node, reader) {
    let cur = node, guard = 0;
    while (cur && cur.t === 'link' && reader && reader.objects[cur.idx] && guard++ < 10) {
        cur = reader.objects[cur.idx];
    }
    return cur;
}

/* ---------- 对外 API ---------- */
function parseFile(file) {
    const buf = fs.readFileSync(file);
    const r = new MarshalReader(buf);
    const root = r.parse();
    return { buf, root, reader: r };
}

/* 读取变量名表（来自 Data/System.rvdata2） */
function readVarNames(systemFile) {
    const { root, reader } = parseFile(systemFile);
    // root 是 RPG::System 对象，@variables 是 Array<String>
    let arr = root.t === 'obj' ? ivarValue(root, '@variables', reader) : null;
    arr = deref(arr, reader);
    if (!arr || arr.t !== 'arr') return [];
    return arr.items.map(it => {
        const n = deref(it, reader);
        if (n && n.t === 'str') return utf8(n.b);
        return '';
    });
}

/* 从存档里取出 变量/开关/金币 节点 */
function locateSave(root, reader) {
    const out = { variables: null, switches: null, gold: null, party: null };
    if (root.t !== 'hash') return out;
    const vars = deref(findHashValue(root, 'variables', reader), reader);
    if (vars) {
        if (vars.t === 'obj') out.variables = deref(ivarValue(vars, '@data', reader), reader);
        else if (vars.t === 'arr') out.variables = vars;
    }
    const sw = deref(findHashValue(root, 'switches', reader), reader);
    if (sw) {
        if (sw.t === 'obj') out.switches = deref(ivarValue(sw, '@data', reader), reader);
        else if (sw.t === 'arr') out.switches = sw;
    }
    const party = deref(findHashValue(root, 'party', reader), reader);
    if (party && party.t === 'obj') {
        out.party = party;
        out.gold = ivarValue(party, '@gold');
    }
    return out;
}

module.exports = { parseFile, readVarNames, locateSave, encodeLong, utf8, ivarValue, findHashValue, MarshalReader };
