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
  fs.writeFileSync(indexPath, html);
  console.log('Hero injected into index.html from home.json');
})();
