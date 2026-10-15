/* 单屏页按 1:1 还原，画面里没有左栏菜单，用户从书签/链接直接进来就出不去了。
   所以这类地址一律换成外壳的对应那一屏；要单独看一屏出图像素基线时带 ?solo=1。 */
(function () {
  'use strict';
  var PAGES = ['screen1', 'screen2', 'screen3b', 'screen4a', 'screen4b'];
  var name = (location.pathname.match(/\/(screen[0-9a-b]*)\.html?$/) || [])[1];
  var i = PAGES.indexOf(name);
  if (i < 0) return;
  if (window.top !== window) return;
  if (/[?&]solo\b/.test(location.search)) return;
  location.replace('index.html' + location.search + '#' + i);
})();
