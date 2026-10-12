// ==UserScript==
// @name         Costco TW 分類頁/搜尋頁抓全部分頁合併顯示
// @namespace    costco-tw-merge-pages
// @version      1.2
// @description  在 Costco 台灣分類頁 (如 /c/whats-new) 或搜尋結果頁 (如 /search?text=xxx) 加一顆按鈕，自動抓取所有分頁的商品，合併成單一清單顯示，不用手動翻頁。
// @author       you
// @match        https://www.costco.com.tw/c/*
// @match        https://www.costco.com.tw/*/c/*
// @match        https://www.costco.com.tw/search*
// @icon         https://www.costco.com.tw/favicon.ico
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/charles0506/costco-tw-merge-pages/main/costco-whats-new-all-pages.user.js
// @downloadURL  https://raw.githubusercontent.com/charles0506/costco-tw-merge-pages/main/costco-whats-new-all-pages.user.js
// ==/UserScript==

(function () {
  'use strict';

  const PAGE_SIZE = 100;
  const MAX_ITEMS = 500; // 超過此數量就不抓，需要的話自行調大

  function getCategoryCode(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('c');
    if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
    return decodeURIComponent(parts[parts.length - 1] || '');
  }

  function buildApiUrl(categoryCode, query, currentPage) {
    const params = new URLSearchParams({
      fields: 'BASIC,products(images)',
      query: query || '',
      pageSize: String(PAGE_SIZE),
      currentPage: String(currentPage),
      lang: 'zh_TW',
      curr: 'TWD',
    });
    if (categoryCode) params.set('category', categoryCode);
    return 'https://www.costco.com.tw/rest/v2/taiwan/products/search?' + params.toString();
  }

  function getModeFromUrl(url) {
    if (url.pathname === '/search' || url.pathname.startsWith('/search/')) {
      return { categoryCode: null, query: url.searchParams.get('text') || '' };
    }
    return { categoryCode: getCategoryCode(url.pathname), query: url.searchParams.get('q') || '' };
  }

  function pickImage(images) {
    if (!images || !images.length) return '';
    // index 2 通常是 "results" 尺寸 (較清楚的縮圖)
    const img = images[2] || images[0];
    return 'https://www.costco.com.tw' + img.url;
  }

  async function fetchAllProducts(categoryCode, query, onProgress) {
    const first = await fetch(buildApiUrl(categoryCode, query, 0)).then((r) => r.json());
    const totalPages = first.pagination ? first.pagination.totalPages : 1;
    const totalResults = first.pagination ? first.pagination.totalResults : first.products.length;
    if (totalResults > MAX_ITEMS) return { tooMany: true, totalResults };
    let all = first.products.slice();
    onProgress(1, totalPages, all.length, totalResults);

    for (let p = 1; p < totalPages; p++) {
      const j = await fetch(buildApiUrl(categoryCode, query, p)).then((r) => r.json());
      all = all.concat(j.products);
      onProgress(p + 1, totalPages, all.length, totalResults);
    }
    return all;
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      #cmp-fab {
        position: fixed; right: 20px; bottom: 20px; z-index: 999999;
        background: #005dab; color: #fff; border: none; border-radius: 24px;
        padding: 12px 18px; font-size: 14px; font-weight: bold; cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,.3); font-family: sans-serif;
      }
      #cmp-fab:hover { background: #00457e; }
      #cmp-overlay {
        position: fixed; inset: 0; z-index: 1000000; background: #fff;
        display: none; flex-direction: column; font-family: sans-serif;
      }
      #cmp-overlay.open { display: flex; }
      #cmp-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 20px; border-bottom: 1px solid #ddd; background: #f7f7f7;
      }
      #cmp-header h2 { margin: 0; font-size: 16px; color: #222; }
      #cmp-close {
        background: none; border: none; font-size: 22px; cursor: pointer; color: #444;
      }
      #cmp-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
      #cmp-status { color: #666; font-size: 13px; margin-bottom: 12px; }
      #cmp-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 14px;
      }
      .cmp-card {
        border: 1px solid #eee; border-radius: 8px; padding: 10px; text-decoration: none;
        color: #222; display: flex; flex-direction: column; transition: box-shadow .15s;
      }
      .cmp-card:hover { box-shadow: 0 2px 10px rgba(0,0,0,.15); }
      .cmp-card img {
        width: 100%; aspect-ratio: 1 / 1; object-fit: contain; margin-bottom: 8px; background: #fafafa;
      }
      .cmp-name { font-size: 13px; line-height: 1.4; margin-bottom: 6px; flex: 1; }
      .cmp-price { font-size: 15px; font-weight: bold; color: #c00; }
      .cmp-code { font-size: 11px; color: #999; margin-top: 2px; }
    `;
    document.head.appendChild(style);
  }

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'cmp-overlay';
    overlay.innerHTML = `
      <div id="cmp-header">
        <h2 id="cmp-title">合併商品清單</h2>
        <button id="cmp-close">×</button>
      </div>
      <div id="cmp-body">
        <div id="cmp-status">載入中...</div>
        <div id="cmp-grid"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#cmp-close').addEventListener('click', () => {
      overlay.classList.remove('open');
    });
    return overlay;
  }

  function renderProducts(grid, products) {
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const p of products) {
      const a = document.createElement('a');
      a.className = 'cmp-card';
      a.href = 'https://www.costco.com.tw' + (p.url || '');
      a.target = '_blank';
      a.rel = 'noopener';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = pickImage(p.images);
      img.alt = p.name || '';

      const name = document.createElement('div');
      name.className = 'cmp-name';
      name.textContent = p.name || '';

      const price = document.createElement('div');
      price.className = 'cmp-price';
      price.textContent = p.price && p.price.formattedValue ? p.price.formattedValue : '';

      const code = document.createElement('div');
      code.className = 'cmp-code';
      code.textContent = p.code ? '#' + p.code : '';

      a.appendChild(img);
      a.appendChild(name);
      a.appendChild(price);
      a.appendChild(code);
      frag.appendChild(a);
    }
    grid.appendChild(frag);
  }

  function init() {
    injectStyle();

    const fab = document.createElement('button');
    fab.id = 'cmp-fab';
    fab.textContent = '📦 抓全部分頁';
    document.body.appendChild(fab);

    let overlay = null;
    let cache = null; // 快取本次 URL 的抓取結果

    fab.addEventListener('click', async () => {
      if (!overlay) overlay = buildOverlay();
      overlay.classList.add('open');

      const status = overlay.querySelector('#cmp-status');
      const grid = overlay.querySelector('#cmp-grid');
      const title = overlay.querySelector('#cmp-title');

      if (cache) {
        title.textContent = `合併商品清單（共 ${cache.length} 項）`;
        status.textContent = `已快取，共 ${cache.length} 項`;
        renderProducts(grid, cache);
        return;
      }

      const url = new URL(location.href);
      const { categoryCode, query } = getModeFromUrl(url);

      status.textContent = '載入中... (1 / ?)';
      grid.innerHTML = '';

      try {
        const products = await fetchAllProducts(categoryCode, query, (done, total, count, totalResults) => {
          status.textContent = `載入中... 第 ${done}/${total} 頁，已取得 ${count}/${totalResults} 項`;
          title.textContent = `合併商品清單（載入中）`;
        });
        if (products.tooMany) {
          title.textContent = '合併商品清單';
          status.textContent = `共 ${products.totalResults} 項，超過上限 ${MAX_ITEMS} 項，不抓取（可調整腳本內 MAX_ITEMS）`;
          return;
        }
        cache = products;
        title.textContent = `合併商品清單（共 ${products.length} 項）`;
        status.textContent = `完成，共 ${products.length} 項`;
        renderProducts(grid, products);
      } catch (e) {
        status.textContent = '載入失敗：' + (e && e.message ? e.message : String(e));
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
