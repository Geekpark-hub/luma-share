/**
 * Google Analytics 4 (gtag.js) — 注入到 HTML <head>
 * 留空 gaMeasurementId 则不输出任何脚本
 */
function buildGaHeadHtml(measurementId) {
  const id = String(measurementId || '').trim();
  if (!id || !/^G-[A-Z0-9]+$/i.test(id)) return '';
  return `<!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${id}');
  </script>`;
}

module.exports = { buildGaHeadHtml };
