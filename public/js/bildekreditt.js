/* NBK bildekreditt — sentralt register, filnavn -> fotograf.
   Krediteringen følger BILDET, ikke plasseringen: brukes samme bilde flere
   steder, krediteres det riktig alle steder uten at noen må huske det.
   Register: /content/bildekreditt.json (redigerbart i Decap CMS). */
(function () {
  let reg = null;

  async function hentRegister() {
    if (reg) return reg;
    try {
      const r = await fetch('/content/bildekreditt.json');
      const d = r.ok ? await r.json() : {};
      reg = {};
      (d.bilder || []).forEach(function (b) { if (b && b.fil) reg[b.fil] = b; });
    } catch (e) { reg = {}; }
    return reg;
  }

  function kredittFor(src) {
    if (!src || !reg) return null;
    let sti = src;
    try { sti = new URL(src, location.origin).pathname; } catch (e) {}
    const t = reg[sti] || reg[sti.replace(/^\//, '')] || null;
    return t && t.kreditt ? t.kreditt : null;
  }

  function merk(img) {
    if (img.dataset.kredittSatt) return;
    const tekst = kredittFor(img.getAttribute('src'));
    if (!tekst) return;
    img.dataset.kredittSatt = '1';
    img.title = tekst;

    const vert = img.parentElement;
    if (!vert) return;
    const pos = getComputedStyle(vert).position;
    if (pos === 'static') vert.style.position = 'relative';

    const merke = document.createElement('span');
    merke.className = 'nbk-bildekreditt';
    merke.textContent = tekst;
    vert.appendChild(merke);
  }

  function merkBakgrunn(el) {
    if (el.dataset.kredittSatt) return;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return;
    // et element kan ha flere lag (gradient + bilde) — sjekk alle
    let tekst = null;
    const url = /url\((['"]?)([^'")]+)\1\)/g;
    let m;
    while ((m = url.exec(bg)) !== null) {
      tekst = kredittFor(m[2]);
      if (tekst) break;
    }
    if (!tekst) return;
    el.dataset.kredittSatt = '1';

    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const merke = document.createElement('span');
    merke.className = 'nbk-bildekreditt nbk-bildekreditt--bg';
    merke.textContent = tekst;
    el.appendChild(merke);
  }

  function skannAlt() {
    document.querySelectorAll('img[src*="/img/uploads/"]').forEach(merk);
    // bakgrunnsbilder: kun elementer som plausibelt bærer et hero-bilde
    document.querySelectorAll('section, header, div[class*="hero"], .hero, figure')
      .forEach(merkBakgrunn);
  }

  async function kjor() {
    await hentRegister();
    skannAlt();
  }

  const stil = document.createElement('style');
  stil.textContent =
    '.nbk-bildekreditt{position:absolute;right:.5rem;bottom:.4rem;z-index:20;' +
    'font-size:10px;line-height:1.3;letter-spacing:.02em;color:rgba(255,255,255,.85);' +
    'background:rgba(0,0,0,.42);padding:2px 7px;border-radius:3px;pointer-events:none;' +
    'font-family:ui-sans-serif,system-ui,sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.4)}' +
    '.nbk-bildekreditt--bg{bottom:auto;top:.6rem;right:.6rem;z-index:30}' +
    '@media print{.nbk-bildekreditt{color:#333;background:none;text-shadow:none}}';
  document.head.appendChild(stil);

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', kjor);
  else kjor();

  // bilder settes inn av JS etter innlasting — fang dem opp
  new MutationObserver(function (muts) {
    let nye = false;
    muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) nye = true; }));
    if (nye && reg) skannAlt();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
