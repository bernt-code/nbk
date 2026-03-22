const fs = require('fs');
const path = require('path');

// Directories that need manifest files
const collections = ['nyheter', 'events', 'klubber'];

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
