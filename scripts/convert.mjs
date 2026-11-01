// スプレッドシートの「公開用」タブ（ウェブに公開したCSV）を取得し、boothfinder が使う出展者データ
// （map-data.txt の boothDataMap と同じ形）の exhibitors.json にして、出力先フォルダーに書く。
// 変換の決まりはマップエディタ（boothfinder の tools/map-editor-V5v5.html の parseCSV）と同じにしてある。
//
// 使い方: node scripts/convert.mjs <出力先フォルダー>
//   環境変数 SHEET_CSV_URL … 公開CSVのURL（GitHub の Secret）
//            SHEET_CSV_FILE … URLの代わりに手元のCSVファイルを読む（テスト用）
//            PAGES_URL      … 配信中のデータの置き場所（前回との比較に使う）
//            MAP_DATA_URL   … map-data.txt のURL（地図にないブース番号の確認に使う）。地図のデータは上げ直すたびに名前を変える
//                             （map-data-64a01.txt など）ので、ふだんは同じサイトのメディアライブラリから一番新しい map-data…txt を探して使い、
//                             見つからないときだけこの URL を使う
//            PHOTO_CACHE_DIR … 作った写真の控えを置くフォルダー（Actions のキャッシュで次の実行に引き継ぐ）。なければ .photo-cache
// 見出しが足りない・件数が前回の半分未満になったなどの異常があれば、何も書かずに失敗で終わる
// （その場合は配信されず、前回のデータがそのまま残る）。
//
// 写真（2026-11-01）：出展者の写真は DFGApp に上がった元の画像（1枚 平均 2.4MB）なので、詳細に出す小さな版（t/）を作って一緒に配る。
// ブラウザで見られない形式（PDF・PSD・RAW・動画など）は img から外す。HEIC は JPEG に直し、拡大表示用（l/）も作って img をそれに替える。
// 作った写真は、控えのフォルダー → 前回の配信 の順に探して使い回し、なければ元の画像から作る
import { mkdir, readFile, writeFile, appendFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

const outDir = process.argv[2];
if (!outDir) fail('出力先フォルダーを指定してください');

// エディタの CSV_FIELDS と同じ。見出しは完全一致（全角/半角・空白の違いは無視）
const CSV_FIELDS = [
  { key: 'booth',    names: ['ブース番号'], required: true },
  { key: 'name',     names: ['出展名'],     required: true },
  { key: 'yomi',     names: ['ふりがな'],   required: true },
  { key: 'day',      names: ['出展日'],     required: true },
  { key: 'genre',    names: ['ジャンル'],   required: true },
  { key: 'subgenre', names: ['サブジャンル'], required: true },
  { key: 'desc1',    names: ['私たちについて'], required: true },
  { key: 'desc2',    names: ['出展内容について'], required: true },
  { key: 'hpUrl',    names: ['HPアドレス'], required: true },
  { key: 'sns1',     names: ['SNS1(URL)'],  required: true },
  { key: 'sns2',     names: ['SNS2(URL)'],  required: true },
  { key: 'img1',     names: ['画像1リンク'], required: true },
  { key: 'img2',     names: ['画像2リンク'], required: true },
  { key: 'img3',     names: ['画像3リンク'], required: true },
  { key: 'img4',     names: ['画像4リンク'], required: true },
];
// 前回の件数からこれ未満の割合に減ったら、シートの事故とみなして配信しない
const MIN_RATIO = 0.5;
// 写真
const PAGES_BASE = process.env.PAGES_URL || 'https://designfesta-jp.github.io/boothfinder-data/';
const PHOTO_CACHE = process.env.PHOTO_CACHE_DIR || '.photo-cache';
const THUMB_SIZE = 264;          // 詳細の写真（132px の正方形）の2倍。正方形に切る（詳細と同じ見え方）
const LARGE_MAX = 960;           // HEIC の拡大表示用の長い辺
const PHOTO_QUALITY = 78;
const PHOTO_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);   // そのままブラウザで見られる形式（AVIF は下で別に見る）
const PHOTO_PARALLEL = 6;

const csvText = await loadCsv();
const { map, rejectedUrls, rows } = parseCSV(csvText);
const boothIds = Object.keys(map);
if (!boothIds.length) fail('ブース番号の入った行が1件もありません');

const prev = await fetchJson(process.env.PAGES_URL && process.env.PAGES_URL + 'exhibitors.json?t=' + Date.now());
const prevCount = prev && prev.boothDataMap ? Object.keys(prev.boothDataMap).length : 0;
if (prevCount && boothIds.length < prevCount * MIN_RATIO) {
  fail(`ブースの件数が前回の ${prevCount} 件から ${boothIds.length} 件に減りました（${MIN_RATIO * 100}% 未満）。シートを確認してください。意図した減少なら、PAGES の前回データを消すか MIN_RATIO を見直してから手動で実行してください`);
}
// シートが前回と同じで、取れなかった写真もなければ、写真の処理もせずに終える（手動実行・手元では必ず作る）
const sourceHash = sha1(JSON.stringify(map));
const force = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || !process.env.GITHUB_ACTIONS;
if (!force && prev && prev.sourceHash === sourceHash && !prev.photoRetry) {
  await report([
    `## 出展者データ`,
    `- ブース: ${boothIds.length} 件（前回 ${prevCount}）`,
    `- 前回からの変更: なし（配信しない）`,
  ]);
  await output('changed', false);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
const photo = await processPhotos(map);
const changed = !prev || JSON.stringify(prev.boothDataMap) !== JSON.stringify(map);

// 地図にないブース番号（シートの入力ミスの可能性）。止めずに一覧だけ出す。
// map-data.txt は WordPress から約1.4MBあるので、データが変わったときと手動実行のときだけ取る
const checkMap = changed || force;
const mapInfo = checkMap ? await loadMapBoothIds() : null;
const mapBooths = mapInfo && mapInfo.ids;
const notOnMap = mapBooths ? boothIds.filter(id => !mapBooths.has(id)).sort() : null;

const generatedAt = new Date().toISOString();
await writeFile(join(outDir, 'exhibitors.json'),
  JSON.stringify({ generatedAt, sourceHash, photoRetry: photo.retry.length, boothCount: boothIds.length, boothDataMap: map }));
await writeFile(join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

const list = (a, n) => a.length ? '（' + a.slice(0, n).join(', ') + (a.length > n ? ' …' : '') + '）' : '';
await report([
  `## 出展者データ`,
  `- 行数（見出しを除く）: ${rows}`,
  `- ブース: ${boothIds.length} 件（前回 ${prevCount || 'なし'}）`,
  `- 前回からの変更: ${changed ? 'あり（配信する）' : 'なし（配信しない）'}`,
  `- http(s) 以外で外したURL: ${rejectedUrls} 件`,
  !checkMap ? `- 地図との照合: 変更がないので省略`
    : notOnMap === null ? `- 地図との照合: map-data.txt を取得できず未確認`
    : `- 地図にないブース番号（${mapInfo.url.split('/').pop()} と照合）: ${notOnMap.length} 件${list(notOnMap, 50)}`,
  `- 写真: ${photo.total} 枚（新しく作った ${photo.made}・控えから ${photo.cached}・前回の配信から ${photo.reused}）`,
  `- 写真の HEIC を JPEG に直した: ${photo.heic.length} 枚${list(photo.heic, 30)}`,
  `- 外した写真（ブラウザで見られない形式・消えた写真）: ${photo.bad.length} 枚${list(photo.bad, 30)}`,
  `- 取れなかった写真（元の画像のまま。次の実行でもう一度作る）: ${photo.retry.length} 枚${list(photo.retry, 30)}`,
]);
await output('changed', changed);

// ---------------------------------------------------------------------------

function fail(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}

async function report(lines) {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

// 写真：出展者ごとの img（元の画像の URL）を、見られるものだけにし、小さな版の URL を th に並べる（img と同じ順。作れなかった所は空）。
// 写真ごとの結果（ok・heic・bad）は photos.json に書き、次の実行で使う（bad は取り直さない）
async function processPhotos(map) {
  const stats = { total: 0, made: 0, cached: 0, reused: 0, heic: [], bad: [], retry: [] };
  const entries = [...new Set(Object.values(map).flat())].filter(e => e.img);
  const where = new Map();   // URL → そのURLを持つブース番号（報告用）
  for (const [id, list] of Object.entries(map)) for (const e of list) for (const u of e.img || []) if (!where.has(u)) where.set(u, id);
  const urls = [...where.keys()];
  stats.total = urls.length;

  await output('photos', true);   // ここから先で止まっても、作った分の控えを残す（ワークフローのキャッシュの保存）
  for (const d of ['t', 'l']) {
    await mkdir(join(outDir, d), { recursive: true });
    await mkdir(join(PHOTO_CACHE, d), { recursive: true });
  }
  const cacheManifest = await readJson(join(PHOTO_CACHE, 'photos.json')) || {};
  const pagesManifest = await fetchJson(process.env.PAGES_URL && process.env.PAGES_URL + 'photos.json?t=' + Date.now()) || {};
  const manifest = {}, result = new Map();
  sharp.cache(false);

  await runLimited(urls, PHOTO_PARALLEL, async (url) => {
    const key = sha1(url).slice(0, 16);
    const files = { t: 't/' + key + '.jpg', l: 'l/' + key + '.jpg' };
    const known = cacheManifest[url] || pagesManifest[url];
    const label = where.get(url);
    if (known === 'bad') { manifest[url] = 'bad'; result.set(url, 'bad'); stats.bad.push(label); return; }
    // 作り済みなら使い回す（控え → 前回の配信）
    if (known === 'ok' || known === 'heic') {
      const need = known === 'heic' ? ['t', 'l'] : ['t'];
      let from = 'cached';
      for (const d of need) {
        if (existsSync(join(PHOTO_CACHE, files[d]))) continue;
        const buf = await fetchBuffer(PAGES_BASE + files[d]);
        if (!buf) { from = null; break; }
        await writeFile(join(PHOTO_CACHE, files[d]), buf);
        from = 'reused';
      }
      if (from) {
        for (const d of need) await copyFile(join(PHOTO_CACHE, files[d]), join(outDir, files[d]));
        manifest[url] = known; result.set(url, known); stats[from]++;
        if (known === 'heic') stats.heic.push(label);
        return;
      }
    }
    // 元の画像から作る
    let buf, gone = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      gone = res.status >= 400 && res.status < 500;   // 消えた写真（404 など）は、取り直さず外す
      if (!res.ok) throw new Error('HTTP ' + res.status);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (gone) { manifest[url] = 'bad'; result.set(url, 'bad'); stats.bad.push(label); return; }
      result.set(url, 'retry'); stats.retry.push(label); return;
    }
    let kind = 'ok';
    try {
      let meta = null;
      try { meta = await sharp(buf).metadata(); } catch (e) { /* 下で HEIC か見る */ }
      const avif = meta && meta.format === 'heif' && meta.compression === 'av1';
      if (!avif && isHeic(buf)) {
        buf = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.92 }));
        kind = 'heic';
      } else if (!meta || (!PHOTO_FORMATS.has(meta.format) && !avif)) {
        throw new Error('形式 ' + (meta && meta.format));
      }
      const out = { t: await sharp(buf).rotate().resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
        .flatten({ background: '#ffffff' }).jpeg({ quality: PHOTO_QUALITY, mozjpeg: true }).toBuffer() };
      if (kind === 'heic') out.l = await sharp(buf).rotate()
        .resize({ width: LARGE_MAX, height: LARGE_MAX, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: PHOTO_QUALITY, mozjpeg: true }).toBuffer();
      for (const d of Object.keys(out)) {
        await writeFile(join(PHOTO_CACHE, files[d]), out[d]);
        await writeFile(join(outDir, files[d]), out[d]);
      }
    } catch (e) {
      // 画像として読めない（PDF・PSD・動画など）
      manifest[url] = 'bad'; result.set(url, 'bad'); stats.bad.push(label); return;
    }
    manifest[url] = kind; result.set(url, kind); stats.made++;
    if (kind === 'heic') stats.heic.push(label);
  });

  for (const e of entries) {
    const img = [], th = [];
    for (const url of e.img) {
      const r = result.get(url), key = sha1(url).slice(0, 16);
      if (r === 'bad') continue;
      img.push(r === 'heic' ? PAGES_BASE + 'l/' + key + '.jpg' : url);
      th.push(r === 'ok' || r === 'heic' ? PAGES_BASE + 't/' + key + '.jpg' : '');
    }
    if (img.length) e.img = img; else delete e.img;
    if (th.some(Boolean)) e.th = th; else delete e.th;
  }
  const json = JSON.stringify(manifest);
  await writeFile(join(outDir, 'photos.json'), json);
  await writeFile(join(PHOTO_CACHE, 'photos.json'), json);
  for (const k of ['heic', 'bad', 'retry']) stats[k].sort();
  return stats;
}

function isHeic(buf) {
  const brand = buf.subarray(4, 12).toString('latin1');
  return brand.startsWith('ftyp') && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand.slice(4));
}

async function runLimited(list, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i !== list.length) await fn(list[i++]);
  });
  await Promise.all(workers);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { return null; }
}

async function fetchBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch (e) {
    return null;
  }
}

async function loadCsv() {
  if (process.env.SHEET_CSV_FILE) return readFile(process.env.SHEET_CSV_FILE, 'utf8');
  const url = process.env.SHEET_CSV_URL;
  if (!url) fail('SHEET_CSV_URL（公開CSVのURL）が設定されていません');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`公開CSVを取得できませんでした（HTTP ${res.status}）`);
  const type = res.headers.get('content-type') || '';
  // 公開をやめた・URLが違うときは Google のHTMLページが返る
  if (!type.includes('text/csv')) fail(`公開CSVの代わりに ${type} が返りました。「ウェブに公開」の設定を確認してください`);
  return res.text();
}

async function fetchJson(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

// メディアライブラリで一番新しい map-data…txt の URL（WordPress の REST API。検索結果は新しい順）
async function findLatestMapDataUrl() {
  const origin = process.env.MAP_DATA_URL ? new URL(process.env.MAP_DATA_URL).origin : 'https://designfestagallery.com';
  const list = await fetchJson(origin + '/wp-json/wp/v2/media?search=map-data&per_page=50&_fields=source_url');
  const hit = Array.isArray(list) && list.find(m => /\/map-data[^/]*\.txt$/i.test(String(m.source_url || '')));
  return hit ? hit.source_url : null;
}

async function loadMapBoothIds() {
  let url = await findLatestMapDataUrl();
  let data = url && await fetchJson(url);
  if (!data || !data.halls) { url = process.env.MAP_DATA_URL; data = await fetchJson(url); }
  if (!data || !data.halls) return null;
  const ids = new Set();
  for (const hall of Object.values(data.halls)) {
    for (const area of Object.values(hall.areas || {})) {
      for (const id of Object.keys(area.booths || {})) ids.add(normBoothId(id));
    }
  }
  return { ids, url };
}

// ---- ここから下はマップエディタと同じ処理 ----

// ブースIDを正規化（F-1→F-001）
function normBoothId(id) {
  let n = String(id || '').toUpperCase();
  const m = n.match(/^([A-Z]{1,3})-?(\d{1,4})$/);
  if (m) n = m[1] + '-' + m[2].padStart(3, '0');
  return n;
}

function isSafeUrl(u) {
  return /^https?:\/\//i.test((u || '').trim());
}

function normCsvHeader(h) {
  return String(h || '').replace(/^﻿/, '').normalize('NFKC').replace(/\s+/g, '');
}

// CSV全体を1文字ずつパースし、クォート内の改行・カンマに対応
function parseCSVFull(text) {
  const rows = [];
  let row = [], cur = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuote = false;
      } else cur += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\r') { /* CRLF対応のため無視 */ }
    else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function parseCSV(text) {
  const all = parseCSVFull(text);
  const headers = (all[0] || []).map(normCsvHeader);
  const idx = {}, missing = [];
  for (const f of CSV_FIELDS) {
    const i = f.names.map(normCsvHeader).map(n => headers.indexOf(n)).find(i => i >= 0);
    if (i === undefined) missing.push(f.names[0]); else idx[f.key] = i;
  }
  if (missing.length) {
    fail('見出しが見つかりません: ' + missing.join('、') + '\nCSVの見出し: ' + (all[0] || []).join(', ').slice(0, 500));
  }
  const get = (row, key) => (row[idx[key]] || '').trim();

  const map = {};
  let rejectedUrls = 0;
  for (const row of all.slice(1)) {
    const boothStr = get(row, 'booth');
    if (!boothStr) continue; // 空行・ブース未割当の行
    const url = {};
    for (const key of ['hpUrl', 'sns1', 'sns2', 'img1', 'img2', 'img3', 'img4']) {
      url[key] = get(row, key);
      // http(s)以外のURL（javascript: など）を弾く。空欄はそのまま通す
      if (url[key] && !isSafeUrl(url[key])) { rejectedUrls++; url[key] = ''; }
    }
    const entry = { n: get(row, 'name'), y: get(row, 'yomi'), d: get(row, 'day'), g: get(row, 'genre'), s: get(row, 'subgenre') };
    const desc1 = get(row, 'desc1'), desc2 = get(row, 'desc2');
    if (desc1) entry.desc1 = desc1;
    if (desc2) entry.desc2 = desc2;
    const snsList = [];
    if (url.hpUrl) snsList.push({ type: 'link', url: url.hpUrl });
    if (url.sns1) snsList.push({ url: url.sns1 }); // type未指定 → 表示時にURLから自動判定
    if (url.sns2) snsList.push({ url: url.sns2 });
    if (snsList.length) entry.sns = snsList;
    const imgList = [url.img1, url.img2, url.img3, url.img4].filter(Boolean);
    if (imgList.length) entry.img = imgList;

    // 複数ブース対応（カンマ区切り）
    for (const bid of boothStr.split(',').map(b => b.trim())) {
      if (!bid) continue;
      const id = normBoothId(bid);
      (map[id] ||= []).push(entry);
    }
  }
  return { map, rejectedUrls, rows: all.length - 1 };
}
