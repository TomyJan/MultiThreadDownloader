#!/usr/bin/env node
/**
 * 多线程无限循环下载器（Node.js）
 * 显示：文件大小、下载次数、进度、当前速度、总流量
 * 运行示例：
 *   node downloader.js --url https://example.com/file.zip --threads 4 --out downloads
 *   node downloader.js --url https://example.com/file.zip --connect-only=true --threads 8
 * 默认带基础请求头，可用 --headers 覆盖
 * 参数说明：
 *   --connect-only=true  只刷连接数模式，收到响应后立即断开连接
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// -------- CLI 解析 --------
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return def;
  const v = args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1];
  return v === undefined ? true : v;
}

const TARGET = getArg('url', null);
const THREADS = parseInt(getArg('threads', '8'), 10);
const OUTDIR = getArg('out', 'downloads');
const SAVE = getArg('save', 'true') !== 'false'; // --save=false 可只统计不落盘
const QUIET = getArg('quiet', 'false') === 'true'; // --quiet=true 只打印关键事件
const CONNECT_ONLY = getArg('connect-only', 'false') === 'true'; // --connect-only=true 只刷连接数，收到响应就断开
const REQ_TIMEOUT_MS = parseInt(getArg('timeout', '300000'), 10); // 单次请求超时(默认5分钟)
const RETRY_DELAY_MS = parseInt(getArg('retryDelay', '1000'), 10); // 错误重试间隔
const HEADERS = parseHeaders(getArg('headers', '')); // 形如 "User-Agent=MyUA;Authorization=Bearer xxx"

if (!TARGET) {
  console.error('必须指定 --url，例如：node downloader.js --url https://example.com/file.zip');
  process.exit(1);
}
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

// -------- 工具函数 --------
function parseHeaders(s) {
  if (!s) return {};
  return s.split(';').reduce((acc, kv) => {
    const [k, ...rest] = kv.split('=');
    if (k && rest.length) acc[k.trim()] = rest.join('=').trim();
    return acc;
  }, {});
}
function humanBytes(n) {
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : 1)} ${units[i]}`;
}
function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -------- 默认请求头 --------
const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': '*/*',
  'Connection': 'keep-alive'
};

// -------- 全局统计 --------
let totalBytesAll = 0n;
let totalDownloads = 0; // 总下载次数
function addTotal(n) { totalBytesAll += BigInt(n); }
function addDownload() { totalDownloads++; }

function logLine(s) {
  if (!QUIET) console.log(s);
}

// -------- 单次下载 --------
function requestOnce(u, onData) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(u);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const mergedHeaders = { ...defaultHeaders, ...HEADERS };
    const req = lib.request(
      urlObj,
      {
        method: 'GET',
        headers: mergedHeaders,
        timeout: REQ_TIMEOUT_MS,
      },
      (res) => {
        // 处理 3xx 重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(requestOnce(new URL(res.headers.location, u).toString(), onData));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
          // let body = '';
          // res.setEncoding('utf8');
          // res.on('data', c => body += c);
          // res.on('end', () => reject(new Error(`HTTP ${res.statusCode} | ${body.slice(0,200)}`)));
          // return;
        }
        const len = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
        
        // 如果是只刷连接数模式，收到响应后立即断开
        if (CONNECT_ONLY) {
          res.destroy();
          return resolve({ stream: null, contentLength: len, connectOnly: true });
        }
        
        resolve({ stream: res, contentLength: len, connectOnly: false });
        res.on('data', (chunk) => onData(chunk.length));
      }
    );
    req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// -------- 下载循环（每个线程独立） --------
async function downloadLoop(threadId) {
  let attempt = 1;
  while (true) {
    const startTs = now();
    let received = 0;
    let lastTickBytes = 0;
    let lastTickTs = startTs;
    let contentLength = null;

    // 准备输出目标（可选写盘）
    const basename = `t${threadId}_#${attempt}_${startTs}`;
    const filePath = path.join(OUTDIR, `${basename}.bin`);
    const sink = SAVE ? fs.createWriteStream(filePath) : null;

    try {
      const { stream, contentLength: len, connectOnly } = await requestOnce(TARGET, (n) => {
        received += n;
        addTotal(n);
        if (sink) sink.write(Buffer.alloc(0)); // 触发 backpressure 计算（不实际写入空数据）
      });
      contentLength = len;

      // 如果是只刷连接数模式，直接跳过下载
      if (connectOnly) {
        addDownload();
        const dur = (now() - startTs) / 1000;
        console.log(
          `[T${threadId} #${attempt}] 连接完成 | 用时 ${dur.toFixed(3)}s | 响应大小 ${contentLength ? humanBytes(contentLength) : '未知'} | 总下载次数 ${totalDownloads} | 累计流量 ${humanBytes(Number(totalBytesAll))}`
        );
      } else {
        // 正常下载模式
        // 真正写入
        if (sink) stream.pipe(sink);
        const progressTimer = setInterval(() => {
          const t = now();
          const dt = Math.max(1, t - lastTickTs) / 1000;
          const dBytes = received - lastTickBytes;
          const speed = dBytes / dt;
          lastTickTs = t;
          lastTickBytes = received;

          const pct = contentLength ? ` ${(received / contentLength * 100).toFixed(1)}%` : '';
          const sizeStr = contentLength ? `${humanBytes(received)} / ${humanBytes(contentLength)}` : `${humanBytes(received)} / ?`;
          logLine(
            `[T${threadId} #${attempt}] 进度${pct} | ${sizeStr} | 速度 ${humanBytes(speed)}/s | 下载次数 ${totalDownloads} | 总流量 ${humanBytes(Number(totalBytesAll))}`
          );
        }, 1000);

        await new Promise((res, rej) => {
          stream.on('end', res);
          stream.on('error', rej);
          if (sink) sink.on('error', rej);
        });

        clearInterval(progressTimer);
        addDownload();
        const dur = (now() - startTs) / 1000;
        const avgSpeed = received / Math.max(dur, 0.001);
        console.log(
          `[T${threadId} #${attempt}] 完成 | 用时 ${dur.toFixed(2)}s | 大小 ${humanBytes(received)}${contentLength ? `（标称 ${humanBytes(contentLength)}）` : ''} | 平均速度 ${humanBytes(avgSpeed)}/s | 总下载次数 ${totalDownloads} | 累计 ${humanBytes(Number(totalBytesAll))}`
        );
      }
    } catch (err) {
      if (sink) try { sink.destroy(); } catch {}
      logLine(`[T${threadId} #${attempt}] 出错：${err.message}，${RETRY_DELAY_MS}ms 后重试`);
      await sleep(RETRY_DELAY_MS);
    } finally {
      attempt++;
    }
  }
}

// -------- 主程序：并发启动 --------
(async () => {
  console.log(`URL=${TARGET}`);
  console.log(`THREADS=${THREADS} | OUT=${OUTDIR} | SAVE=${SAVE} | CONNECT_ONLY=${CONNECT_ONLY} | TIMEOUT=${REQ_TIMEOUT_MS}ms`);
  for (let i = 0; i < THREADS; i++) {
    // 彼此错峰100ms，减少同时建连
    await sleep(100);
    // 不 await，直接并发
    downloadLoop(i).catch(e => console.error(`[T${i}] Fatal:`, e));
  }
})();
