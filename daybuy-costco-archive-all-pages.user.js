// ==UserScript==
// @name         Daybuy Costco專區 抓全部分頁/整理成圖片
// @namespace    costco-tw-merge-pages
// @version      1.1
// @description  在 daybuy.tw 的 Costco 分類列表頁 (如 /costco/hypermarket-news/) 加按鈕，用 WordPress REST API 抓該分類全部分頁文章合併顯示；在單篇文章頁 (如 /costco/267919/) 則解析文章內的「圖片+商品連結」清單，整理成圖片卡片牆。
// @author       you
// @match        https://www.daybuy.tw/costco/*
// @icon         https://www.daybuy.tw/favicon.ico
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/charles0506/costco-tw-merge-pages/main/daybuy-costco-archive-all-pages.user.js
// @downloadURL  https://raw.githubusercontent.com/charles0506/costco-tw-merge-pages/main/daybuy-costco-archive-all-pages.user.js
// ==/UserScript==

(function () {
  'use strict';

  const PER_PAGE = 100;

  function trimPageSuffix(parts) {
    if (parts.length >= 2 && parts[parts.length - 2] === 'page' && /^\d+$/.test(parts[parts.length - 1])) {
      return parts.slice(0, -2);
    }
    return parts;
  }

  function isArchivePage(pathname) {
    const parts = trimPageSuffix(pathname.split('/').filter(Boolean));
    if (parts[0] !== 'costco') return false;
    return !parts.some((p) => /^\d+$/.test(p));
  }

  function getCategorySlug(pathname) {
    const parts = trimPageSuffix(pathname.split('/').filter(Boolean));
    return parts[parts.length - 1] || 'costco';
  }

  function getSinglePostId(pathname) {
    const parts = trimPageSuffix(pathname.split('/').filter(Boolean));
    if (parts.length === 2 && parts[0] === 'costco' && /^\d+$/.test(parts[1])) return parts[1];
    return null;
  }

  function decodeHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    return (div.textContent || '').trim();
  }

  // ---- 分類列表頁：抓全部分頁 ----

  async function getCategoryId(slug) {
    const r = await fetch('https://www.daybuy.tw/wp-json/wp/v2/categories?slug=' + encodeURIComponent(slug));
    const j = await r.json();
    if (!j.length) return null;
    return j[0].id;
  }

  function buildListApiUrl(categoryId, page) {
    const params = new URLSearchParams({
      categories: String(categoryId),
      per_page: String(PER_PAGE),
      page: String(page),
      _embed: 'wp:featuredmedia',
      _fields: 'id,link,title,excerpt,date,_embedded',
    });
    return 'https://www.daybuy.tw/wp-json/wp/v2/posts?' + params.toString();
  }

  function pickFeaturedImage(post) {
    const media = post._embedded && post._embedded['wp:featuredmedia'] && post._embedded['wp:featuredmedia'][0];
    if (!media) return '';
    const sizes = media.media_details && media.media_details.sizes;
    if (sizes && sizes.medium) return sizes.medium.source_url;
    return media.source_url || '';
  }

  async function fetchAllPosts(categoryId, onProgress) {
    const firstRes = await fetch(buildListApiUrl(categoryId, 1));
    const first = await firstRes.json();
    const totalPages = parseInt(firstRes.headers.get('X-WP-TotalPages') || '1', 10);
    const totalResults = parseInt(firstRes.headers.get('X-WP-Total') || String(first.length), 10);
    let all = first.slice();
    onProgress(1, totalPages, all.length, totalResults);

    for (let p = 2; p <= totalPages; p++) {
      const res = await fetch(buildListApiUrl(categoryId, p));
      const j = await res.json();
      all = all.concat(j);
      onProgress(p, totalPages, all.length, totalResults);
    }
    return all;
  }

  function renderPostList(grid, posts) {
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const post of posts) {
      const a = document.createElement('a');
      a.className = 'cmp-card';
      a.href = post.link || '#';
      a.target = '_blank';
      a.rel = 'noopener';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = pickFeaturedImage(post);
      img.alt = decodeHtml(post.title && post.title.rendered);

      const title = document.createElement('div');
      title.className = 'cmp-title';
      title.textContent = decodeHtml(post.title && post.title.rendered);

      const date = document.createElement('div');
      date.className = 'cmp-date';
      date.textContent = (post.date || '').slice(0, 10);

      const excerpt = document.createElement('div');
      excerpt.className = 'cmp-excerpt';
      excerpt.textContent = decodeHtml(post.excerpt && post.excerpt.rendered);

      a.appendChild(img);
      a.appendChild(title);
      a.appendChild(date);
      a.appendChild(excerpt);
      frag.appendChild(a);
    }
    grid.appendChild(frag);
  }

  // ---- 單篇文章頁：解析「圖片+商品連結」整理成圖片牆 ----

  async function fetchPostContent(postId) {
    const r = await fetch('https://www.daybuy.tw/wp-json/wp/v2/posts/' + postId + '?_fields=id,link,title,content');
    if (!r.ok) throw new Error('文章讀取失敗 (' + r.status + ')');
    return r.json();
  }

  function parseArticleEntries(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ps = Array.from(doc.body.children).filter((el) => el.tagName === 'P');
    const entries = [];
    let pendingImg = null;

    for (const p of ps) {
      const img = p.querySelector('img');
      const a = p.querySelector('a');
      const onlyImg = img && !a && p.children.length === 1;
      const onlyA = a && !img && p.children.length === 1 && a.parentElement === p && p.textContent.trim() === a.textContent.trim();

      if (onlyImg) {
        pendingImg = img.getAttribute('src');
        continue;
      }
      if (onlyA) {
        entries.push({ type: 'item', img: pendingImg, name: a.textContent.trim(), href: a.href });
        pendingImg = null;
        continue;
      }
      const text = p.textContent.trim();
      const isSectionHeader = !img && !a && text.length > 0 && text.length < 30 && (p.querySelector('span[style]') || p.querySelector('strong'));
      if (isSectionHeader) {
        entries.push({ type: 'section', text: text.replace(/[—\-–]+/g, '').trim() });
        pendingImg = null;
        continue;
      }
      // 其他段落 (開頭說明、空白、社群宣傳等) 略過
    }
    return entries;
  }

  function renderArticleEntries(grid, entries) {
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      if (entry.type === 'section') {
        const h = document.createElement('div');
        h.className = 'cmp-section';
        h.textContent = entry.text;
        frag.appendChild(h);
        continue;
      }
      const a = document.createElement('a');
      a.className = 'cmp-card';
      a.href = entry.href || '#';
      a.target = '_blank';
      a.rel = 'noopener';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = entry.img || '';
      img.alt = entry.name || '';

      const name = document.createElement('div');
      name.className = 'cmp-title';
      name.textContent = entry.name || '';

      a.appendChild(img);
      a.appendChild(name);
      frag.appendChild(a);
    }
    grid.appendChild(frag);
  }

  // ---- 共用 UI ----

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      #cmp-fab { position: fixed; right: 20px; bottom: 20px; z-index: 999999; background: #d0021b; color: #fff; border: none; border-radius: 24px; padding: 12px 18px; font-size: 14px; font-weight: bold; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); font-family: sans-serif; }
      #cmp-fab:hover { background: #a10115; }
      #cmp-overlay { position: fixed; inset: 0; z-index: 1000000; background: #fff; display: none; flex-direction: column; font-family: sans-serif; }
      #cmp-overlay.open { display: flex; }
      #cmp-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid #ddd; background: #f7f7f7; }
      #cmp-header h2 { margin: 0; font-size: 16px; color: #222; }
      #cmp-close { background: none; border: none; font-size: 22px; cursor: pointer; color: #444; }
      #cmp-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
      #cmp-status { color: #666; font-size: 13px; margin-bottom: 12px; }
      #cmp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
      .cmp-card { border: 1px solid #eee; border-radius: 8px; padding: 10px; text-decoration: none; color: #222; display: flex; flex-direction: column; transition: box-shadow .15s; }
      .cmp-card:hover { box-shadow: 0 2px 10px rgba(0,0,0,.15); }
      .cmp-card img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; margin-bottom: 8px; background: #fafafa; border-radius: 4px; }
      .cmp-title { font-size: 13px; font-weight: bold; line-height: 1.4; margin-bottom: 6px; }
      .cmp-date { font-size: 11px; color: #999; margin-bottom: 6px; }
      .cmp-excerpt { font-size: 12px; color: #555; line-height: 1.5; flex: 1; }
      .cmp-section { grid-column: 1 / -1; font-size: 15px; font-weight: bold; color: #d0021b; border-bottom: 2px solid #d0021b; padding: 8px 2px; margin-top: 8px; }
    `;
    document.head.appendChild(style);
  }

  function buildOverlay(titleText) {
    const overlay = document.createElement('div');
    overlay.id = 'cmp-overlay';
    overlay.innerHTML = `
      <div id="cmp-header">
        <h2 id="cmp-title">${titleText}</h2>
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

  function init() {
    const pathname = location.pathname;
    const archive = isArchivePage(pathname);
    const postId = archive ? null : getSinglePostId(pathname);
    if (!archive && !postId) return;

    injectStyle();

    const fab = document.createElement('button');
    fab.id = 'cmp-fab';
    fab.textContent = archive ? '📰 抓全部分頁' : '🖼️ 整理成圖片';
    document.body.appendChild(fab);

    let overlay = null;
    let cache = null;

    fab.addEventListener('click', async () => {
      if (!overlay) overlay = buildOverlay(archive ? '合併文章清單' : '商品圖片整理');
      overlay.classList.add('open');

      const status = overlay.querySelector('#cmp-status');
      const grid = overlay.querySelector('#cmp-grid');
      const title = overlay.querySelector('#cmp-title');

      if (cache) {
        if (archive) {
          title.textContent = `合併文章清單（共 ${cache.length} 篇）`;
          status.textContent = `已快取，共 ${cache.length} 篇`;
          renderPostList(grid, cache);
        } else {
          const itemCount = cache.filter((e) => e.type === 'item').length;
          title.textContent = `商品圖片整理（共 ${itemCount} 項）`;
          status.textContent = `已快取，共 ${itemCount} 項`;
          renderArticleEntries(grid, cache);
        }
        return;
      }

      status.textContent = '載入中...';
      grid.innerHTML = '';

      try {
        if (archive) {
          const slug = getCategorySlug(pathname);
          const categoryId = await getCategoryId(slug);
          if (!categoryId) {
            status.textContent = `找不到分類「${slug}」，此頁可能不是分類列表頁`;
            return;
          }
          const posts = await fetchAllPosts(categoryId, (done, total, count, totalResults) => {
            status.textContent = `載入中... 第 ${done}/${total} 頁，已取得 ${count}/${totalResults} 篇`;
            title.textContent = `合併文章清單（載入中）`;
          });
          cache = posts;
          title.textContent = `合併文章清單（共 ${posts.length} 篇）`;
          status.textContent = `完成，共 ${posts.length} 篇`;
          renderPostList(grid, posts);
        } else {
          const post = await fetchPostContent(postId);
          const entries = parseArticleEntries(post.content.rendered);
          const itemCount = entries.filter((e) => e.type === 'item').length;
          if (!itemCount) {
            status.textContent = '這篇文章沒有偵測到「圖片+商品連結」清單格式，無法整理成圖片牆';
            return;
          }
          cache = entries;
          title.textContent = `${decodeHtml(post.title.rendered)}（共 ${itemCount} 項）`;
          status.textContent = `完成，共 ${itemCount} 項`;
          renderArticleEntries(grid, entries);
        }
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
