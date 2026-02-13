
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock configuration matching index.js
const CACHE_DIR = path.join(__dirname, 'cache_test');
const MAPPINGS_CACHE_DIR = path.join(CACHE_DIR, 'mappings');
const IMAGES_CACHE_DIR = path.join(CACHE_DIR, 'images');

const IMAGE_URL_MAP_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const IMAGE_RETENTION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

async function setup() {
    await fs.mkdir(MAPPINGS_CACHE_DIR, { recursive: true });
    await fs.mkdir(IMAGES_CACHE_DIR, { recursive: true });
}

async function cleanup() {
    await fs.rm(CACHE_DIR, { recursive: true, force: true });
}

async function runCleanupLogic() {
    console.log('Running cleanup logic...');
    const now = Date.now();

    // 1. Clean up old mappings
    try {
        const mappingFiles = await fs.readdir(MAPPINGS_CACHE_DIR);
        for (const file of mappingFiles) {
            if (file.endsWith('.json')) {
                const mappingFile = path.join(MAPPINGS_CACHE_DIR, file);
                try {
                    const fileContent = await fs.readFile(mappingFile, 'utf-8');
                    const mapping = JSON.parse(fileContent);

                    if (now - mapping.timestamp > IMAGE_URL_MAP_TTL) {
                        await fs.unlink(mappingFile);
                        console.log(`Deleted expired mapping: ${file}`);
                    }
                } catch (err) {
                    console.error(err);
                }
            }
        }
    } catch (e) { console.error(e); }

    // 2. Clean up old images
    try {
        const imageFiles = await fs.readdir(IMAGES_CACHE_DIR);
        for (const file of imageFiles) {
            if (file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                const imageFile = path.join(IMAGES_CACHE_DIR, file);
                try {
                    const stats = await fs.stat(imageFile);
                    const lastAccess = Math.max(stats.atimeMs, stats.mtimeMs);

                    if (now - lastAccess > IMAGE_RETENTION_TTL) {
                        await fs.unlink(imageFile);
                        console.log(`Deleted expired image: ${file}`);
                    }
                } catch (err) { console.error(err); }
            }
        }
    } catch (e) { console.error(e); }
}

async function test() {
    await setup();

    const secureId = 'test-id';
    const mappingFile = path.join(MAPPINGS_CACHE_DIR, `${secureId}.json`);
    const imageFile = path.join(IMAGES_CACHE_DIR, `${secureId}.jpg`);

    // Create dummy files
    const now = Date.now();

    // Scenario 1: Mapping expired (8 days old), Image active (20 days old)
    // Expectation: Mapping deleted, Image kept
    console.log('\n--- Scenario 1: Mapping expired, Image active ---');
    const oldMappingTime = now - (8 * 24 * 60 * 60 * 1000);
    const activeImageTime = now - (20 * 24 * 60 * 60 * 1000); // < 30 days

    await fs.writeFile(mappingFile, JSON.stringify({ url: 'http://foo.com', timestamp: oldMappingTime }));
    await fs.writeFile(imageFile, 'dummy image content');

    // Manually set mtime/atime
    const oldDate = new Date(activeImageTime);
    await fs.utimes(imageFile, oldDate, oldDate);

    await runCleanupLogic();

    try {
        await fs.access(mappingFile);
        console.error('FAIL: Mapping file should have been deleted');
    } catch {
        console.log('PASS: Mapping file deleted');
    }

    try {
        await fs.access(imageFile);
        console.log('PASS: Image file preserved');
    } catch {
        console.error('FAIL: Image file should NOT have been deleted');
    }

    // Scenario 2: Image expired (31 days old)
    // Expectation: Image deleted
    console.log('\n--- Scenario 2: Image expired ---');
    const expiredImageTime = now - (31 * 24 * 60 * 60 * 1000);
    const expiredDate = new Date(expiredImageTime);

    await fs.writeFile(imageFile, 'dummy image content'); // Recreate if needed or update
    await fs.utimes(imageFile, expiredDate, expiredDate);

    await runCleanupLogic();

    try {
        await fs.access(imageFile);
        console.error('FAIL: Image file should have been deleted');
    } catch {
        console.log('PASS: Image file deleted');
    }

    await cleanup();
}

test().catch(console.error);
