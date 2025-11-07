import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePlaceholderIcons } from '../assets/placeholder-icons.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const assetsDir = path.join(projectRoot, 'assets');

const written = ensurePlaceholderIcons({ targetDir: assetsDir, force: true });

for (const [name, location] of Object.entries(written)) {
  console.log(`wrote ${name} to ${location}`);
}
