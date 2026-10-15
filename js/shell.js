/* 工作台之间的外壳通信。四个 AI 工作台页各是一个 iframe，跨页跳转和共享输入必须经过外壳，
   所以这里只放传输协议，不放任何业务数据。 */
(function () {
  'use strict';

  const embedded = typeof top !== 'undefined' && top !== window;
  const post = msg => { if (embedded) parent.postMessage(msg, '*'); };

  /* 视图名 = 文件名后缀（'3b' → screen3b.html），下标只在外壳里维护 */
  function goto(view, open) {
    if (embedded) { post({ goto: view, open: open }); return; }
    /* 能走到这里的只有 ?solo=1 的对稿视图：跳转后留在单屏模式，别一跳就掉回外壳 */
    const p = new URLSearchParams(location.search);
    p.set('solo', '1');
    if (open && open.tab) p.set('tab', open.tab);
    location.href = 'screen' + view + '.html?' + p;
  }

  function saveCtx(key, obj) {
    try { sessionStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* 隐私模式：不共享输入，功能照常 */ }
  }
  function loadCtx(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function onMessage(fn) {
    addEventListener('message', e => { const d = e.data; if (d && typeof d === 'object') fn(d); });
  }

  window.SHELL = { embedded, post, goto, saveCtx, loadCtx, onMessage };
})();
