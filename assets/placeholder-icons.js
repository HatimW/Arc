import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ICON_DATA_PATH = path.join(__dirname, 'placeholder-icon-data.json');

function readIconData() {
  const raw = fs.readFileSync(ICON_DATA_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return Object.fromEntries(
    Object.entries(parsed).map(([name, segments]) => [
      name,
      Array.isArray(segments) ? segments.join('') : segments
    ])
  );
}

export function ensurePlaceholderIcons(options = {}) {
  const {
    targetDir = __dirname,
    force = false
  } = options;

  const iconData = readIconData();
  fs.mkdirSync(targetDir, { recursive: true });

  const written = {};
  for (const [filename, base64] of Object.entries(iconData)) {
    const destination = path.join(targetDir, filename);
    if (force || !fs.existsSync(destination)) {
      const buffer = Buffer.from(base64, 'base64');
      fs.writeFileSync(destination, buffer);
    }
    written[filename] = destination;
  }

  return written;
}

export function getPlaceholderIconData() {
  return readIconData();
}
