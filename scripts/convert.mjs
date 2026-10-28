// スプレッドシートの「公開用」タブ（ウェブに公開したCSV）を取得し、boothfinder が使う出展者データ
// （map-data.txt の boothDataMap と同じ形）の exhibitors.json にして、出力先フォルダーに書く。
// 変換の決まりはマップエディタ（boothfinder の tools/map-editor-V5v5.html の parseCSV）と同じにしてある。
//
// 使い方: node scripts/convert.mjs <出力先フォルダー>
//   環境変数 SHEET_CSV_URL … 公開CSVのURL（GitHub の Secret）
//            SHEET_CSV_FILE … URLの代わりに手元のCSVファイルを読む（テスト用）
//            PAGES_URL      … 配信中のデータの置き場所（前回との比較に使う）
//            MAP_DATA_URL   … map-data.txt のURL（地図にないブース番号の確認に使う）
// 見出しが足りない・件数が前回の半分未満になったなどの異常があれば、何も書かずに失敗で終わる
// （その場合は配信されず、前回のデータがそのまま残る）。
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

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

const csvText = await loadCsv();
const { map, rejectedUrls, rows } = parseCSV(csvText);
const boothIds = Object.keys(map);
if (!boothIds.length) fail('ブース番号の入った行が1件もありません');

const prev = await fetchJson(process.env.PAGES_URL && process.env.PAGES_URL + 'exhibitors.json?t=' + Date.now());
const prevCount = prev && prev.boothDataMap ? Object.keys(prev.boothDataMap).length : 0;
if (prevCount && boothIds.length < prevCount * MIN_RATIO) {
  fail(`ブースの件数が前回の ${prevCount} 件から ${boothIds.length} 件に減りました（${MIN_RATIO * 100}% 未満）。シートを確認してください。意図した減少なら、PAGES の前回データを消すか MIN_RATIO を見直してから手動で実行してください`);
}
const changed = !prev || JSON.stringify(prev.boothDataMap) !== JSON.stringify(map);

// 地図にないブース番号（シートの入力ミスの可能性）。止めずに一覧だけ出す。
// map-data.txt は WordPress から約1.4MBあるので、データが変わったときと手動実行のときだけ取る
const checkMap = changed || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || !process.env.GITHUB_ACTIONS;
const mapBooths = checkMap ? await loadMapBoothIds() : null;
const notOnMap = mapBooths ? boothIds.filter(id => !mapBooths.has(id)).sort() : null;

const generatedAt = new Date().toISOString();
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'exhibitors.json'),
  JSON.stringify({ generatedAt, boothCount: boothIds.length, boothDataMap: map }));
await writeFile(join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

const lines = [
  `## 出展者データ`,
  `- 行数（見出しを除く）: ${rows}`,
  `- ブース: ${boothIds.length} 件（前回 ${prevCount || 'なし'}）`,
  `- 前回からの変更: ${changed ? 'あり（配信する）' : 'なし（配信しない）'}`,
  `- http(s) 以外で外したURL: ${rejectedUrls} 件`,
  !checkMap ? `- 地図との照合: 変更がないので省略`
    : notOnMap === null ? `- 地図との照合: map-data.txt を取得できず未確認`
    : `- 地図にないブース番号: ${notOnMap.length} 件${notOnMap.length ? '（' + notOnMap.slice(0, 50).join(', ') + (notOnMap.length > 50 ? ' …' : '') + '）' : ''}`,
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);

// ---------------------------------------------------------------------------

function fail(msg) {
  console.error('::error::' + msg);
  process.exit(1);
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

async function loadMapBoothIds() {
  const data = await fetchJson(process.env.MAP_DATA_URL);
  if (!data || !data.halls) return null;
  const ids = new Set();
  for (const hall of Object.values(data.halls)) {
    for (const area of Object.values(hall.areas || {})) {
      for (const id of Object.keys(area.booths || {})) ids.add(normBoothId(id));
    }
  }
  return ids;
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
