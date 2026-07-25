const fs = require('fs');
const path = require('path');

// Directories that need manifest files
const collections = ['nyheter', 'events', 'klubber', 'grener', 'dokumenter', 'lenker'];

collections.forEach(collection => {
  const dir = path.join(__dirname, 'public', 'content', collection);
  if (!fs.existsSync(dir)) {
    console.log(`Skipping ${collection}: directory not found`);
    return;
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .sort()
    .reverse(); // newest first (filenames start with date)

  const manifestPath = path.join(dir, 'index.json');
  fs.writeFileSync(manifestPath, JSON.stringify(files, null, 2));
  console.log(`${collection}/index.json: ${files.length} entries`);
});

console.log('Manifests generated successfully.');

// Inject hero content from home.json into index.html so there is no flash of the static stand-in
(() => {
  const homePath = path.join(__dirname, 'public', 'content', 'pages', 'home.json');
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(homePath) || !fs.existsSync(indexPath)) {
    console.log('Hero injection skipped: home.json or index.html not found');
    return;
  }
  const home = JSON.parse(fs.readFileSync(homePath, 'utf8'));
  let html = fs.readFileSync(indexPath, 'utf8');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sub = (re, val) => { if (val) html = html.replace(re, (m, p1, p2) => p1 + esc(val) + p2); };
  sub(/(<img id="hero-image"[^>]*\ssrc=")[^"]*(")/, home.hero_image);
  sub(/(<span id="hero-badge"[^>]*>)[\s\S]*?(<\/span>)/, home.hero_badge);
  sub(/(<h1 id="hero-title"[^>]*>)[\s\S]*?(<\/h1>)/, home.hero_title);
  sub(/(<p id="hero-subtitle"[^>]*>)[\s\S]*?(<\/p>)/, home.hero_subtitle);
  sub(/(<a id="hero-cta"[^>]*>)[\s\S]*?(<\/a>)/, home.hero_cta_text);
  sub(/(<a id="hero-secondary-cta"[^>]*>)[\s\S]*?(<\/a>)/, home.hero_secondary_cta);
  // CTA-lenkene kan overstyres fra home.json
  const href = (id, val) => {
    if (!val) return;
    html = html.replace(
      new RegExp(`(<a id="${id}"[^>]*\\shref=")[^"]*(")`),
      (m, p1, p2) => p1 + esc(val) + p2
    );
  };
  href('hero-cta', home.hero_cta_url);
  href('hero-secondary-cta', home.hero_secondary_cta_url);
  fs.writeFileSync(indexPath, html);
  console.log('Hero injected into index.html from home.json');
})();

// Inject legendekoppen content from legendekoppen.json
(() => {
  const lkPath = path.join(__dirname, 'public', 'content', 'pages', 'legendekoppen.json');
  const lkHtmlPath = path.join(__dirname, 'public', 'legendekoppen', 'index.html');
  if (!fs.existsSync(lkPath) || !fs.existsSync(lkHtmlPath)) {
    console.log('Legendekoppen injection skipped: files not found');
    return;
  }
  const lk = JSON.parse(fs.readFileSync(lkPath, 'utf8'));
  let html = fs.readFileSync(lkHtmlPath, 'utf8');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const subSpan = (id, val) => {
    if (!val) return;
    html = html.replace(
      new RegExp(`(<[^>]+id="${id}"[^>]*>)[\\s\\S]*?(<\/[^>]+>)`),
      (m, open, close) => open + esc(val) + close
    );
  };
  subSpan('lk-badge',        lk.badge);
  subSpan('lk-title',        lk.title);
  subSpan('lk-subtitle',     lk.subtitle);
  subSpan('lk-hero-title',   lk.hero_title);
  subSpan('lk-hero-accent',  lk.hero_title_accent);
  subSpan('lk-hero-eyebrow', lk.hero_eyebrow);
  subSpan('lk-hero-cta',     lk.hero_cta);
  subSpan('lk-hero-cta2',    lk.hero_cta_secondary);
  subSpan('lk-stat1-label',  lk.hero_stat1_label);
  subSpan('lk-stat2-label',  lk.hero_stat2_label);
  subSpan('lk-stat3-label',  lk.hero_stat3_label);
  subSpan('lk-why-label',    lk.why_label);
  subSpan('lk-why-title',    lk.why_title);
  subSpan('lk-why-subtitle', lk.why_subtitle);
  subSpan('lk-why-junior',   lk.why_junior_tekst);
  subSpan('lk-wall-title',   lk.wall_title);
  subSpan('lk-wall-subtitle',lk.wall_subtitle);
  // hero-tekst er i en span
  if (lk.hero_tekst) {
    html = html.replace(
      /(<span id="lk-hero-tekst">)[\s\S]*?(<\/span>)/,
      (m, o, cl) => o + esc(lk.hero_tekst) + cl
    );
  }
  fs.writeFileSync(lkHtmlPath, html);
  console.log('Legendekoppen content injected from legendekoppen.json');
})();
