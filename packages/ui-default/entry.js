import './polyfill';

import $ from 'jquery';

window.Ejunz = {
  extraPages: [],
  components: {},
  utils: {},
  node_modules: {},
  version: process.env.VERSION,
};
window.externalModules = {};
window.lazyModuleResolver = {};

console.log(
  '%c%s%c%s',
  'color:red;font-size:24px;',
  '   Welcome to\n',
  'color:blue;font-weight:bold;',
  `\
 ███████╗     ██╗██╗   ██╗███╗   ██╗███████╗
 ██╔════╝     ██║██║   ██║████╗  ██║╚══███╔╝
 █████╗       ██║██║   ██║██╔██╗ ██║  ███╔╝ 
 ██╔══╝  ██   ██║██║   ██║██║╚██╗██║ ███╔╝  
 ███████╗╚█████╔╝╚██████╔╝██║ ╚████║███████╗
 ╚══════╝ ╚════╝  ╚═════╝ ╚═╝  ╚═══╝╚══════╝


`
);


window.UiContext = JSON.parse(window.UiContext);
window.UserContext = JSON.parse(window.UserContext);
try { __webpack_public_path__ = UiContext.cdn_prefix; } catch (e) { }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').then((registration) => {
    console.log('SW registered: ', registration);
    fetch('/service-worker-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(UiContext.SWConfig),
    });
  }).catch((registrationError) => {
    console.log('SW registration failed: ', registrationError);
  });
}

const PageLoader = '<div class="page-loader nojs--hide" style="display:none;"><div class="loader"></div></div>';
$('body').prepend(PageLoader);
$('.page-loader').fadeIn(500);
if (process.env.NODE_ENV === 'production' && UiContext.sentry_dsn) {
  window._sentryEvents = [];
  window.captureException = (e) => {
    if (!e.isUserFacingError) window._sentryEvents.push(e);
  };
  const script = document.createElement('script');
  script.src = '/sentry.js';
  document.body.appendChild(script);
}

console.log("Script started");
window.onload = async () => {
  try {
    Object.assign(window.UiContext, JSON.parse(window.UiContextNew || '{}'));
    Object.assign(window.UserContext, JSON.parse(window.UserContextNew || '{}'));
    window.EjunzExports = await import('./api');
    console.log("EjunzExports:", window.EjunzExports);  // 验证导入内容
    // await window._ejunzLoad();
    await window.EjunzExports.initPageLoader();
  } catch (e) {
    console.error("加载出现问题:", e);
  }
};

