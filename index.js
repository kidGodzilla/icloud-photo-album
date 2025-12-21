import 'dotenv/config';
import express from 'express';
import { getImages } from 'icloud-shared-album';
import path from 'path';
import { fileURLToPath } from 'url';
import encryptor from 'simple-encryptor';
import sharp from 'sharp';
import crypto from 'crypto';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import schedule from 'node-schedule';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import { installWhisperCpp, downloadWhisperModel } from '@remotion/install-whisper-cpp';
import { OpenAI } from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Cache directory configuration
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');
const ALBUMS_CACHE_DIR = path.join(CACHE_DIR, 'albums');
const IMAGES_CACHE_DIR = path.join(CACHE_DIR, 'images');
const MAPPINGS_CACHE_DIR = path.join(CACHE_DIR, 'mappings');
const VIDEO_AUGMENTATIONS_CACHE_DIR = path.join(CACHE_DIR, 'video-augmentations');
const TMP_DIR = path.join(__dirname, 'tmp');

// Ensure cache directories exist
async function ensureCacheDirs() {
  const dirs = [CACHE_DIR, ALBUMS_CACHE_DIR, IMAGES_CACHE_DIR, MAPPINGS_CACHE_DIR, VIDEO_AUGMENTATIONS_CACHE_DIR, TMP_DIR];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Created cache directory: ${dir}`);
    }
  }
}

// Initialize cache directories on startup
ensureCacheDirs().catch(err => {
  console.error('Error creating cache directories:', err);
});

// Encryption configuration
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'test-secret-key-change-in-production';
const encrypt = encryptor(ENCRYPTION_SECRET);

// OpenAI configuration
const OPENAI_API_KEY = process.env.OPEN_AI_API_KEY;
let openai;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// FFmpeg configuration (optional, will use system ffmpeg if available)
// Note: This is set up asynchronously on startup
let ffmpegPath = null;
let ffprobePath = null;

(async function setupFFmpeg() {
  try {
    const pathToFfmpeg = await import('ffmpeg-static');
    const pathToFfprobe = await import('ffprobe-static');
    ffmpegPath = pathToFfmpeg.default;
    // ffprobe-static exports differently - check both possibilities and ensure we get a string
    const ffprobeRaw = pathToFfprobe.default?.ffprobePath || pathToFfprobe.ffprobePath || pathToFfprobe.default;
    // If it's still an object, try to extract the path string
    if (typeof ffprobeRaw === 'object' && ffprobeRaw !== null) {
      ffprobePath = ffprobeRaw.ffprobePath || ffprobeRaw.default || null;
    } else {
      ffprobePath = ffprobeRaw;
    }
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
    console.log('FFmpeg paths configured', { ffmpeg: ffmpegPath, ffprobe: ffprobePath });
  } catch(e) {
    console.warn('FFmpeg static binaries not found, using system ffmpeg:', e.message);
  }
})();

// Whisper.cpp configuration
// Allow custom whisper path via environment variable (e.g., if already installed)
const WHISPER_DIR = process.env.WHISPER_DIR || path.join(__dirname, 'whisper.cpp');
const WHISPER_MODEL = 'tiny.en';
const WHISPER_EXE = path.join(WHISPER_DIR, 'main');
const WHISPER_MODEL_PATH = path.join(WHISPER_DIR, `ggml-${WHISPER_MODEL}.bin`);
let whisperInstalled = false;

// Initialize Whisper.cpp (async, non-blocking) - following example pattern
(async function() {
  // If custom WHISPER_DIR is set, skip installation and just verify it exists
  if (process.env.WHISPER_DIR) {
    if (existsSync(WHISPER_EXE) && existsSync(WHISPER_MODEL_PATH)) {
      whisperInstalled = true;
      console.log(`Using Whisper.cpp from: ${WHISPER_DIR}`);
      return;
    } else {
      console.warn(`WHISPER_DIR set to ${WHISPER_DIR} but executable or model not found`);
      return;
    }
  }

  try {
    // Check if whisper.cpp already exists - if so, just download model
    if (existsSync(WHISPER_EXE)) {
      console.log('Whisper.cpp executable found, downloading model only...');
      await downloadWhisperModel({
        model: WHISPER_MODEL,
        folder: WHISPER_DIR,
      });
    } else {
      // Install from source
      await installWhisperCpp({ to: WHISPER_DIR, version: '1.7.1' });
      await downloadWhisperModel({
        model: WHISPER_MODEL,
        folder: WHISPER_DIR,
      });
    }
    
    // Verify installation
    if (existsSync(WHISPER_EXE) && existsSync(WHISPER_MODEL_PATH)) {
      whisperInstalled = true;
      console.log('whisper.cpp installed locally at', WHISPER_DIR);
    }
  } catch(e) {
    // If executable exists despite error, we can still use it
    if (existsSync(WHISPER_EXE) && existsSync(WHISPER_MODEL_PATH)) {
      whisperInstalled = true;
      console.log('Whisper.cpp available (using existing installation)');
    } else {
      console.log('Whisper.cpp installation error (video transcription will be unavailable):', e.message);
    }
  }
})();

// Helper function to decrypt token if it's encrypted
function decryptToken(token) {
  if (!token) {
    throw new Error('Token is required');
  }
  if (token.startsWith('e-')) {
    try {
      const encrypted = token.substring(2); // Remove 'e-' prefix
      const decrypted = encrypt.decrypt(encrypted);
      if (!decrypted) {
        throw new Error('Decryption returned null');
      }
      return decrypted;
    } catch (error) {
      // Log the actual error for debugging
      console.error('Decryption error details:', error.message || error);
      throw new Error(`Invalid encrypted token: ${error.message || 'Decryption failed'}`);
    }
  }
  return token;
}

// Cache configuration
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600000', 10); // Default: 1 hour in milliseconds

// In-memory reloading state (small, can stay in memory)
const reloadingState = new Map(); // token -> boolean

// Track recently accessed tokens for background refresh
// Maps decryptedToken -> { lastAccessed: timestamp, decryptedToken: string }
const recentlyAccessedTokens = new Map();
const MAX_TRACKED_TOKENS = parseInt(process.env.MAX_TRACKED_TOKENS || '100', 10);
const TOKEN_ACCESS_TTL = parseInt(process.env.TOKEN_ACCESS_TTL || '86400000', 10); // Default: 24 hours in milliseconds

// Sanitize token for use as filename
function sanitizeToken(token) {
  // Replace any characters that aren't safe for filenames
  return token.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// File-based cache helper functions for album JSON
async function getCachedData(token) {
  const safeToken = sanitizeToken(token);
  const cacheFile = path.join(ALBUMS_CACHE_DIR, `${safeToken}.json`);
  
  try {
    const fileContent = await fs.readFile(cacheFile, 'utf-8');
    const cached = JSON.parse(fileContent);
    
    const now = Date.now();
    const age = now - cached.timestamp;
    
    // Always return cached data (even if stale) for stale-while-revalidate
    return {
      data: cached.data,
      isStale: age > CACHE_TTL,
      timestamp: cached.timestamp
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    console.error('Error reading cache file:', error);
    return null;
  }
}

async function setCachedData(token, data, isReloading = false) {
  const safeToken = sanitizeToken(token);
  const cacheFile = path.join(ALBUMS_CACHE_DIR, `${safeToken}.json`);
  
  try {
    const existing = await getCachedData(token);
    const cacheData = {
      data,
      timestamp: Date.now(),
      reloading: isReloading || (existing?.data ? reloadingState.get(token) || false : false)
    };
    
    await fs.writeFile(cacheFile, JSON.stringify(cacheData, null, 2), 'utf-8');
    reloadingState.set(token, cacheData.reloading);
  } catch (error) {
    console.error('Error writing cache file:', error);
  }
}

function setReloading(token, reloading) {
  reloadingState.set(token, reloading);
}

// Enable JSON body parsing
app.use(express.json());

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Add cache headers for static assets (images, etc.)
app.use((req, res, next) => {
  // Only add cache headers for image requests
  if (req.path.startsWith('/api/image/')) {
    // Cache headers will be set in the route handler
    return next();
  }
  // For other static files, add cache headers
  if (req.path.match(/\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff|woff2|ttf|eot)$/i)) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

// Secure image URL mapping (opaque ID -> original URL) - stored on disk
const IMAGE_URL_MAP_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Image optimization configuration
const MAX_IMAGE_WIDTH = parseInt(process.env.MAX_IMAGE_WIDTH || '1920', 10);
const MAX_IMAGE_HEIGHT = parseInt(process.env.MAX_IMAGE_HEIGHT || '1920', 10);
const IMAGE_QUALITY = parseInt(process.env.IMAGE_QUALITY || '85', 10); // 0-100, default 85

// Generate secure random ID for image URLs
function generateSecureId() {
  return crypto.randomBytes(16).toString('hex');
}

// Store image URL securely and return opaque ID
// Use a hash of the URL as a lookup key to ensure same URL = same secure ID
async function storeImageUrl(originalUrl) {
  // Create a deterministic hash of the URL to use as lookup key
  const urlHash = crypto.createHash('sha256').update(originalUrl).digest('hex').substring(0, 16);
  const lookupFile = path.join(MAPPINGS_CACHE_DIR, `_lookup_${urlHash}.json`);
  
  // Check if we already have a secure ID for this URL
  try {
    const lookupData = await fs.readFile(lookupFile, 'utf-8');
    const lookup = JSON.parse(lookupData);
    
    // Verify the URL matches (in case of hash collision)
    if (lookup.url === originalUrl && lookup.secureId) {
      // Check if the mapping file still exists
      const mappingFile = path.join(MAPPINGS_CACHE_DIR, `${lookup.secureId}.json`);
      if (existsSync(mappingFile)) {
        // Mapping exists, return existing secure ID
        return lookup.secureId;
      }
      // Mapping file doesn't exist, will create new one below
    }
  } catch (error) {
    // Lookup file doesn't exist, will create new mapping below
  }
  
  // Generate new secure ID only if we don't have one
  const secureId = generateSecureId();
  const mappingFile = path.join(MAPPINGS_CACHE_DIR, `${secureId}.json`);
  
  try {
    // Store the mapping (secure ID -> original URL)
    const mapping = {
      url: originalUrl,
      timestamp: Date.now()
    };
    await fs.writeFile(mappingFile, JSON.stringify(mapping, null, 2), 'utf-8');
    
    // Store lookup mapping (URL hash -> secure ID) for fast lookup
    const lookup = {
      url: originalUrl,
      secureId: secureId,
      timestamp: Date.now()
    };
    await fs.writeFile(lookupFile, JSON.stringify(lookup, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error storing image URL mapping:', error);
  }
  
  return secureId;
}

// Retrieve original URL from secure ID
async function getImageUrl(secureId) {
  const mappingFile = path.join(MAPPINGS_CACHE_DIR, `${secureId}.json`);
  
  try {
    const fileContent = await fs.readFile(mappingFile, 'utf-8');
    const mapping = JSON.parse(fileContent);
    
    // Clean up old mappings
    const age = Date.now() - mapping.timestamp;
    if (age > IMAGE_URL_MAP_TTL) {
      await fs.unlink(mappingFile).catch(() => {}); // Ignore errors if file doesn't exist
      return null;
    }
    
    return mapping.url;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    console.error('Error reading image URL mapping:', error);
    return null;
  }
}

// Cleanup old mappings and images periodically
setInterval(async () => {
  const now = Date.now();
  
  try {
    // Clean up old mappings
    const mappingFiles = await fs.readdir(MAPPINGS_CACHE_DIR);
    for (const file of mappingFiles) {
      if (file.endsWith('.json')) {
        const mappingFile = path.join(MAPPINGS_CACHE_DIR, file);
        try {
          const fileContent = await fs.readFile(mappingFile, 'utf-8');
          const mapping = JSON.parse(fileContent);
          if (now - mapping.timestamp > IMAGE_URL_MAP_TTL) {
            await fs.unlink(mappingFile);
            // Also delete corresponding image cache
            const secureId = path.basename(file, '.json');
            const imageFile = path.join(IMAGES_CACHE_DIR, `${secureId}.jpg`);
            await fs.unlink(imageFile).catch(() => {}); // Ignore if doesn't exist
          }
        } catch (err) {
          // Skip files that can't be read
        }
      }
    }
  } catch (error) {
    console.error('Error during cache cleanup:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Helper function to strip EXIF location data and optimize image
async function stripExifLocation(imageUrl) {
  try {
    // Fetch the image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());
    
    // Load image and get metadata
    let image = sharp(imageBuffer);
    const metadata = await image.metadata();
    
    // Calculate resize dimensions (maintain aspect ratio)
    let width = metadata.width;
    let height = metadata.height;
    const needsResize = width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT;
    
    if (needsResize) {
      // Resize to fit within max dimensions while maintaining aspect ratio
      if (width > height) {
        if (width > MAX_IMAGE_WIDTH) {
          height = Math.round((height * MAX_IMAGE_WIDTH) / width);
          width = MAX_IMAGE_WIDTH;
        }
      } else {
        if (height > MAX_IMAGE_HEIGHT) {
          width = Math.round((width * MAX_IMAGE_HEIGHT) / height);
          height = MAX_IMAGE_HEIGHT;
        }
      }
    }
    
    // Process image: rotate, resize, strip EXIF GPS, and optimize
    const processedBuffer = await image
      .rotate() // Auto-rotate based on EXIF
      .resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true // Don't upscale smaller images
      })
      .jpeg({ 
        quality: IMAGE_QUALITY,
        mozjpeg: true, // Use mozjpeg for better compression
        progressive: true // Progressive JPEG for better perceived performance
      })
      .toBuffer();
    
    return processedBuffer;
  } catch (error) {
    console.error('Error processing image:', error);
    // Fallback: return original if processing fails
    try {
      const response = await fetch(imageUrl);
      return Buffer.from(await response.arrayBuffer());
    } catch (fetchError) {
      throw new Error('Failed to fetch or process image');
    }
  }
}

// Route to proxy images with EXIF stripping (using secure ID with .jpg extension)
app.get('/api/image/:secureId.jpg', async (req, res) => {
  try {
    const { secureId } = req.params;
    
    if (!secureId) {
      return res.status(400).json({ error: 'Image ID is required' });
    }

    const imageFile = path.join(IMAGES_CACHE_DIR, `${secureId}.jpg`);
    
    // Check if cached image exists
    let cachedImageExists = false;
    let cachedStats = null;
    try {
      cachedStats = await fs.stat(imageFile);
      cachedImageExists = true;
      const age = Date.now() - cachedStats.mtimeMs;
      
      // If cached image is fresh, serve it directly
      if (age < CACHE_TTL) {
        // Generate ETag
        const etag = `"${secureId}-${cachedStats.mtimeMs}"`;
        res.set('ETag', etag);
        res.set('Last-Modified', cachedStats.mtime.toUTCString());
        
        // Check if client has cached version (If-None-Match header)
        const ifNoneMatch = req.get('If-None-Match');
        if (ifNoneMatch === etag) {
          // Client has cached version, return 304 Not Modified
          res.removeHeader('Cache-Control');
          res.removeHeader('Pragma');
          res.removeHeader('Expires');
          res.set('Cache-Control', 'public, max-age=31536000, immutable');
          return res.status(304).end();
        }
        
        // Serve cached image with proper cache headers
        const imageBuffer = await fs.readFile(imageFile);
        // Remove any default no-cache headers Express might set
        res.removeHeader('Cache-Control');
        res.removeHeader('Pragma');
        res.removeHeader('Expires');
        // Set proper cache headers
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=31536000, immutable'); // Cache for 1 year
        return res.send(imageBuffer);
      }
      // If cached image exists but is stale, we'll try to refresh it below
      // but will fall back to serving stale cache if refresh fails
    } catch (error) {
      // File doesn't exist or can't be read, continue to fetch
      cachedImageExists = false;
    }

    // Look up original URL from secure ID
    const originalUrl = await getImageUrl(secureId);
    if (!originalUrl) {
      // Check if we have a cached image file even if mapping is expired
      if (cachedImageExists && cachedStats) {
        try {
          const cachedBuffer = await fs.readFile(imageFile);
          console.log(`Serving expired mapping for ${secureId}, but cached image exists`);
          // Remove any default no-cache headers Express might set
          res.removeHeader('Cache-Control');
          res.removeHeader('Pragma');
          res.removeHeader('Expires');
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'public, max-age=31536000, immutable');
          res.set('ETag', `"${secureId}-${cachedStats.mtimeMs}"`);
          res.set('Last-Modified', cachedStats.mtime.toUTCString());
          return res.send(cachedBuffer);
        } catch (error) {
          // Error reading cached file, return 404
          return res.status(404).json({ error: 'Image not found or expired' });
        }
      }
      // No cached file either, return 404
      return res.status(404).json({ error: 'Image not found or expired' });
    }

    // Strip EXIF and cache to disk
    let cleanedBuffer;
    try {
      cleanedBuffer = await stripExifLocation(originalUrl);
    } catch (error) {
      // If fetching fails (e.g., URL expired), try to serve cached image if available
      console.error(`Failed to fetch image from iCloud for ${secureId}, trying cached version:`, error.message);
      if (cachedImageExists && cachedStats) {
        try {
          const cachedBuffer = await fs.readFile(imageFile);
          console.log(`Serving cached image for ${secureId} due to fetch error`);
          // Remove any default no-cache headers Express might set
          res.removeHeader('Cache-Control');
          res.removeHeader('Pragma');
          res.removeHeader('Expires');
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'public, max-age=31536000, immutable');
          res.set('ETag', `"${secureId}-${cachedStats.mtimeMs}"`);
          res.set('Last-Modified', cachedStats.mtime.toUTCString());
          return res.send(cachedBuffer);
        } catch (cacheError) {
          // Error reading cached file, continue to throw original error
        }
      }
      // No cached file or error reading it, return error
      throw error; // Throw original fetch error
    }
    
    await fs.writeFile(imageFile, cleanedBuffer);

    // Remove any default no-cache headers Express might set
    res.removeHeader('Cache-Control');
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    // Set cache headers for newly processed image
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // Cache for 1 year
    const stats = await fs.stat(imageFile);
    res.set('ETag', `"${secureId}-${stats.mtimeMs}"`);
    res.set('Last-Modified', stats.mtime.toUTCString());
    res.send(cleanedBuffer);
  } catch (error) {
    console.error('Error proxying image:', error);
    res.status(500).json({ 
      error: 'Failed to proxy image', 
      message: error.message 
    });
  }
});

// Helper function to rewrite image URLs to use proxy
async function rewriteImageUrls(data, originalToken) {
  if (!data || !data.photos || !Array.isArray(data.photos)) {
    console.warn('Invalid data structure in rewriteImageUrls:', data);
    return data;
  }
  
  const rewritten = JSON.parse(JSON.stringify(data)); // Deep clone
  
  // Process all image URLs in parallel
  const urlPromises = [];
  const urlIndices = [];
  
  rewritten.photos.forEach((photo, photoIndex) => {
    if (!photo || !photo.derivatives || typeof photo.derivatives !== 'object') {
      console.warn(`Photo at index ${photoIndex} missing derivatives:`, photo);
      return;
    }
    
    Object.keys(photo.derivatives).forEach(size => {
      const derivative = photo.derivatives[size];
      // Check if derivative exists and has a url property
      if (!derivative || typeof derivative !== 'object') {
        return;
      }
      
      if (derivative.url && typeof derivative.url === 'string') {
        // Skip if already rewritten (starts with /api/image/)
        if (derivative.url.startsWith('/api/image/')) {
          return;
        }
        // Only proxy images, not videos (videos don't have EXIF data)
        // Check case-insensitively for video files
        const urlLower = derivative.url.toLowerCase();
        if (urlLower.includes('.mp4')) {
          // Keep video file URLs as-is (but video thumbnail JPGs should still be proxied)
          return;
        }
        // Store original URL securely and get opaque ID
        // This includes all image URLs (photos and video thumbnail JPGs)
        // Video thumbnail JPGs will be processed the same as photo JPGs
        urlPromises.push(storeImageUrl(derivative.url));
        urlIndices.push({ photoIndex, size });
      }
    });
  });
  
  // Wait for all secure IDs to be generated
  if (urlPromises.length > 0) {
    try {
      const secureIds = await Promise.all(urlPromises);
      
          // Apply secure IDs to derivatives (with .jpg extension for better caching)
          secureIds.forEach((secureId, index) => {
            const { photoIndex, size } = urlIndices[index];
            if (rewritten.photos[photoIndex] && 
                rewritten.photos[photoIndex].derivatives && 
                rewritten.photos[photoIndex].derivatives[size]) {
              rewritten.photos[photoIndex].derivatives[size].url = `/api/image/${secureId}.jpg`;
            }
          });
    } catch (error) {
      console.error('Error generating secure IDs:', error);
      // Return data without rewriting if there's an error
    }
  }

  // Remove location data from metadata if present
  if (rewritten.metadata && rewritten.metadata.locations) {
    rewritten.metadata.locations = {};
  }

  return rewritten;
}

// Route to encrypt an album token
app.post('/api/encrypt-token', (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Album token is required' });
    }

    const encrypted = encrypt.encrypt(token);
    const encryptedToken = `e-${encrypted}`;
    
    res.json({ encryptedToken });
  } catch (error) {
    console.error('Error encrypting token:', error);
    res.status(500).json({ 
      error: 'Failed to encrypt token', 
      message: error.message 
    });
  }
});

// Route to get iCloud shared album by token
app.get('/api/album/:token', async (req, res) => {
  try {
    let { token } = req.params;
    
    if (!token) {
      return res.status(400).json({ error: 'Album token is required' });
    }

    // Decrypt token if it's encrypted (starts with 'e-')
    const originalToken = token;
    let decryptedToken;
    try {
      decryptedToken = decryptToken(token);
    } catch (error) {
      console.error('Token decryption error:', error.message, 'Token:', token);
      return res.status(400).json({ 
        error: 'Invalid encrypted token', 
        message: error.message 
      });
    }

    // Ensure we have a valid token
    if (!decryptedToken) {
      console.error('Decrypted token is null/undefined. Original token:', originalToken);
      return res.status(400).json({ error: 'Invalid token - decryption returned null' });
    }

    // Capture decrypted token in const for async closures
    const finalDecryptedToken = decryptedToken;

    // Use decrypted token as cache key so encrypted and unencrypted tokens share the same cache
    const cacheKey = finalDecryptedToken;

    // Check cache first (stale-while-revalidate)
    const cached = await getCachedData(cacheKey);
    if (cached) {
      const isStale = cached.isStale;
      const cachedData = cached.data;
      
      // Check if cached data already has rewritten URLs (old cache format)
      const hasRewrittenUrls = cachedData.photos && cachedData.photos.some(photo => 
        photo.derivatives && Object.values(photo.derivatives).some(d => 
          d.url && d.url.startsWith('/api/image/')
        )
      );
      
      if (hasRewrittenUrls) {
        // Old cache format - URLs already rewritten, just return as-is
        if (isStale && !reloadingState.get(cacheKey)) {
          cachedData.reloading = true;
          res.json(cachedData);
          
          // Reload in background
          (async () => {
            try {
              const freshData = await getImages(finalDecryptedToken);
              
              // Trigger video augmentation processing for all videos in background
              if (freshData.photos && Array.isArray(freshData.photos)) {
                freshData.photos.forEach(photo => {
                  if (isVideo(photo)) {
                    const videoUrl = getVideoUrl(photo);
                    if (videoUrl) {
                      // Process in background (don't await)
                      processVideoAugmentation(finalDecryptedToken, photo.photoGuid, videoUrl)
                        .then(augmentation => {
                          if (augmentation) {
                            console.log(`Background video augmentation complete for ${photo.photoGuid}`);
                          }
                        })
                        .catch(err => {
                          console.error(`Background video augmentation failed for ${photo.photoGuid}:`, err);
                        });
                    }
                  }
                });
              }
              
              const freshRewritten = await rewriteImageUrls(freshData, finalDecryptedToken);
              await setCachedData(cacheKey, freshRewritten, false);
              console.log(`Background reload complete for album: ${finalDecryptedToken}`);
            } catch (error) {
              console.error('Background reload failed:', error);
              setReloading(cacheKey, false);
            }
          })();
          return;
        } else {
          cachedData.reloading = false;
          
          // Track this token for background refresh
          trackTokenForRefresh(finalDecryptedToken);
          
          return res.json(cachedData);
        }
      }
      
      // New cache format - rewrite URLs on read
      if (isStale && !reloadingState.get(cacheKey)) {
        // Stale cache - return immediately and reload in background
        console.log(`Stale cache hit for album: ${finalDecryptedToken}, serving stale data and reloading in background...`);
        setReloading(cacheKey, true);
        
        // Return stale data immediately with reloading flag
        const rewritten = await rewriteImageUrls(cachedData, finalDecryptedToken);
        rewritten.reloading = true;
        
        // Track this token for background refresh
        trackTokenForRefresh(finalDecryptedToken);
        
        res.json(rewritten);
        
        // Reload in background (don't await)
        (async () => {
          try {
            console.log('Decrypted token:', finalDecryptedToken);
            const freshData = await getImages(finalDecryptedToken);
            
            // Trigger video augmentation processing for all videos in background
            if (freshData.photos && Array.isArray(freshData.photos)) {
              freshData.photos.forEach(photo => {
                if (isVideo(photo)) {
                  const videoUrl = getVideoUrl(photo);
                  if (videoUrl) {
                    // Process in background (don't await)
                    processVideoAugmentation(finalDecryptedToken, photo.photoGuid, videoUrl)
                      .then(augmentation => {
                        if (augmentation) {
                          console.log(`Background video augmentation complete for ${photo.photoGuid}`);
                        }
                      })
                      .catch(err => {
                        console.error(`Background video augmentation failed for ${photo.photoGuid}:`, err);
                      });
                  }
                }
              });
            }
            
            const freshRewritten = await rewriteImageUrls(freshData, finalDecryptedToken);
            await setCachedData(cacheKey, freshRewritten, false);
            console.log(`Background reload complete for album: ${finalDecryptedToken}`);
          } catch (error) {
            console.error('Background reload failed:', error);
            setReloading(cacheKey, false);
          }
        })();
        return;
      } else if (!isStale) {
        // Fresh cache
        console.log(`Cache hit for album: ${finalDecryptedToken}`);
        const rewritten = await rewriteImageUrls(cachedData, finalDecryptedToken);
        rewritten.reloading = false;
        
        // Track this token for background refresh
        trackTokenForRefresh(finalDecryptedToken);
        
        return res.json(rewritten);
      }
    }

    // Cache miss - fetch from iCloud
    console.log(`Cache miss for album: ${finalDecryptedToken}, fetching from iCloud...`);
    const data = await getImages(finalDecryptedToken);
    
    // Store original data in cache (before rewriting URLs)
    await setCachedData(cacheKey, data, false);
    
    // Trigger video augmentation processing for all videos in background
    if (data.photos && Array.isArray(data.photos)) {
      data.photos.forEach(photo => {
        if (isVideo(photo)) {
          const videoUrl = getVideoUrl(photo);
          if (videoUrl) {
            // Process in background (don't await)
            processVideoAugmentation(finalDecryptedToken, photo.photoGuid, videoUrl)
              .then(augmentation => {
                if (augmentation) {
                  console.log(`Background video augmentation complete for ${photo.photoGuid}`);
                }
              })
              .catch(err => {
                console.error(`Background video augmentation failed for ${photo.photoGuid}:`, err);
              });
          }
        }
      });
    }
    
    // Rewrite URLs to use proxy (strip EXIF) for response
    const rewritten = await rewriteImageUrls(data, finalDecryptedToken);
    rewritten.reloading = false;
    
    // Track this token for background refresh
    trackTokenForRefresh(finalDecryptedToken);
    
    res.json(rewritten);
  } catch (error) {
    console.error('Error fetching album:', error);
    res.status(500).json({ 
      error: 'Failed to fetch album', 
      message: error.message 
    });
  }
});

// Track token for background refresh (uses decrypted token as key)
function trackTokenForRefresh(decryptedToken) {
  // Update or add token to tracking map (use decrypted token as key)
  recentlyAccessedTokens.set(decryptedToken, {
    lastAccessed: Date.now(),
    decryptedToken: decryptedToken
  });
  
  // Clean up old tokens if we exceed max
  if (recentlyAccessedTokens.size > MAX_TRACKED_TOKENS) {
    const now = Date.now();
    const entries = Array.from(recentlyAccessedTokens.entries());
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    // Remove oldest tokens until we're under the limit
    const toRemove = entries.slice(0, entries.length - MAX_TRACKED_TOKENS);
    toRemove.forEach(([token]) => recentlyAccessedTokens.delete(token));
  }
}

// Background refresh function for a single token
async function refreshTokenInBackground(decryptedToken) {
  try {
    const freshData = await getImages(decryptedToken);
    
    // Trigger video augmentation processing for all videos in background
    if (freshData.photos && Array.isArray(freshData.photos)) {
      freshData.photos.forEach(photo => {
        if (isVideo(photo)) {
          const videoUrl = getVideoUrl(photo);
          if (videoUrl) {
            // Process in background (don't await)
            processVideoAugmentation(decryptedToken, photo.photoGuid, videoUrl)
              .then(augmentation => {
                if (augmentation) {
                  console.log(`Background video augmentation complete for ${photo.photoGuid}`);
                }
              })
              .catch(err => {
                console.error(`Background video augmentation failed for ${photo.photoGuid}:`, err);
              });
          }
        }
      });
    }
    
    const freshRewritten = await rewriteImageUrls(freshData, decryptedToken);
    await setCachedData(decryptedToken, freshRewritten, false);
    console.log(`Background refresh complete for album: ${decryptedToken}`);
    return true;
  } catch (error) {
    console.error(`Background refresh failed for album ${decryptedToken}:`, error.message);
    return false;
  }
}

// Scheduled job to refresh recently accessed tokens
schedule.scheduleJob('*/30 * * * *', async () => {
  // Run every 30 minutes
  const now = Date.now();
  const tokensToRefresh = [];
  
  // Collect tokens that should be refreshed (recently accessed and not too old)
  for (const [decryptedToken, info] of recentlyAccessedTokens.entries()) {
    const age = now - info.lastAccessed;
    if (age < TOKEN_ACCESS_TTL) {
      tokensToRefresh.push(decryptedToken);
    } else {
      // Remove old tokens
      recentlyAccessedTokens.delete(decryptedToken);
    }
  }
  
  if (tokensToRefresh.length === 0) {
    console.log('No tokens to refresh');
    return;
  }
  
  console.log(`Starting background refresh for ${tokensToRefresh.length} token(s)...`);
  
  // Refresh tokens in parallel (but limit concurrency to avoid overwhelming iCloud)
  const BATCH_SIZE = 5;
  for (let i = 0; i < tokensToRefresh.length; i += BATCH_SIZE) {
    const batch = tokensToRefresh.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(decryptedToken =>
        refreshTokenInBackground(decryptedToken)
      )
    );
    
    // Small delay between batches to be respectful to iCloud API
    if (i + BATCH_SIZE < tokensToRefresh.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`Background refresh completed for ${tokensToRefresh.length} token(s)`);
});

// Serve landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Serve static files from public directory (before dynamic routes)
// Configure static middleware to set proper cache headers
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path) => {
    // Don't cache HTML files (they should always be fresh)
    if (path.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    } else {
      // Cache other static assets (JS, CSS, etc.) aggressively
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// ============================================
// VIDEO AUGMENTATION PIPELINE
// ============================================

// Helper function to check if a photo is a video
function isVideo(photo) {
  return photo.mediaAssetType === 'video' || 
         (photo.derivatives && Object.values(photo.derivatives).some(d => 
           d && d.url && d.url.toLowerCase().includes('.mp4')));
}

// Helper function to get video URL from photo
function getVideoUrl(photo) {
  if (!photo || !photo.derivatives) return null;
  
  // Get the largest available video
  const videoSizes = Object.keys(photo.derivatives)
    .filter(size => {
      const derivative = photo.derivatives[size];
      return derivative && derivative.url && derivative.url.toLowerCase().includes('.mp4');
    })
    .map(Number)
    .sort((a, b) => b - a);
  
  if (videoSizes.length > 0) {
    return photo.derivatives[videoSizes[0].toString()].url;
  }
  return null;
}

// Helper function to get video duration using ffprobe
async function getVideoDuration(videoUrl) {
  if (!ffprobePath) {
    console.warn('ffprobe not available, cannot get video duration');
    return null;
  }
  
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // Ensure ffprobePath is a string (handle object exports)
    let ffprobeExecutable = ffprobePath;
    if (typeof ffprobePath === 'object' && ffprobePath.ffprobePath) {
      ffprobeExecutable = ffprobePath.ffprobePath;
    } else if (typeof ffprobePath === 'object' && ffprobePath.default) {
      ffprobeExecutable = typeof ffprobePath.default === 'string' ? ffprobePath.default : ffprobePath.default.ffprobePath;
    }
    
    if (!ffprobeExecutable || typeof ffprobeExecutable !== 'string') {
      console.warn('ffprobe path is not a valid string:', ffprobePath);
      return null;
    }
    
    // Use ffprobe to get duration
    const { stdout } = await execAsync(`"${ffprobeExecutable}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoUrl}"`);
    const duration = parseFloat(stdout.trim());
    
    if (isNaN(duration) || duration <= 0) {
      console.warn(`Invalid duration from ffprobe for ${videoUrl}: ${stdout.trim()}`);
      return null;
    }
    
    return Math.floor(duration); // Return duration in seconds as integer
  } catch (e) {
    console.warn(`Could not get video duration using ffprobe for ${videoUrl}:`, e.message);
    return null;
  }
}

// Extract audio from video using ffmpeg
async function extractAudioFromVideo(videoUrl, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoUrl)
      .noVideo()
      .audioCodec('pcm_s16le')
      .audioFrequency(16000) // Whisper requires 16kHz
      .audioChannels(1) // Mono
      .format('wav')
      .on('start', (cmd) => {
        console.log('Extracting audio with ffmpeg:', cmd);
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        reject(err);
      })
      .on('end', () => {
        console.log('Audio extraction complete');
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

// Transcribe audio using whisper.cpp
async function transcribeAudio(audioPath) {
  if (!whisperInstalled) {
    throw new Error('Whisper.cpp is not installed');
  }

  return new Promise((resolve, reject) => {
    let transcription = '';
    let timestamps = [];
    let currentLength = 0;
    let points = [];

    // Use absolute paths for whisper executable and model
    if (!existsSync(WHISPER_EXE)) {
      throw new Error(`Whisper executable not found at ${WHISPER_EXE}`);
    }
    if (!existsSync(WHISPER_MODEL_PATH)) {
      throw new Error(`Whisper model not found at ${WHISPER_MODEL_PATH}`);
    }
    
    const whisper = spawn(WHISPER_EXE, [
      '-m', WHISPER_MODEL_PATH,
      '-f', audioPath,
      '--output-txt',
      '--output-words'
    ], { 
      shell: false,
      cwd: __dirname 
    });

    whisper.stdout.on('data', (data) => {
      let lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line.includes('[')) {
          let parts = line.split(']');
          if (parts.length >= 2) {
            if (parts.length > 2) {
              parts = [parts[0], parts.slice(1).join(']')];
            }

            let timeRaw = parts[0].replace('[', '').split('-->')[0].trim();
            let word = parts[1]?.trim();
            if (!word) return;

            let [hrs, mins, secs] = timeRaw.split(':');
            hrs = parseInt(hrs) || 0;
            mins = parseInt(mins) || 0;
            secs = parseFloat(secs) || 0;

            let ms = Math.floor((hrs * 3600 + mins * 60 + secs) * 1000);

            transcription += word + ' ';
            timestamps.push(ms);
            points.push(currentLength);
            currentLength = transcription.length;
          }
        }
      });
    });

    whisper.on('close', (code) => {
      if (code === 0) {
        transcription = transcription.trim();
        resolve({ transcription, timestamps, points });
      } else {
        reject(new Error(`Whisper process exited with code ${code}`));
      }
    });

    whisper.on('error', (err) => {
      reject(err);
    });
  });
}

// Blogify transcription using OpenAI GPT-4o
async function blogifyTranscription(transcription) {
  if (!openai) {
    throw new Error('OpenAI API key not configured');
  }

  const prompt = `I have an audio blog post transcript. Format it as a Markdown blog post with headlines and rich formatting. Use the provided similarity percentage as a guide for how closely to stick to the original text.

Assume medium quality transcription, you're allowed to correct obvious errors. It may have been run through a rudimentary punctuator.

- At 75% similarity, prioritize clarity, structure, and readability, allowing significant rephrasing and reorganization.
- At 90% similarity, retain most of the original phrasing and structure, making only moderate adjustments for flow and readability.
- At 95% similarity, keep very close to the original text, making only minor edits to fix glaring issues while focusing primarily on formatting.

Respond only the final markdown. No ticks surrounding it or any commentary about the task. This will be fed straight into a markdown parser and will throw an error if you deviate from this instruction.

Please use the following similarity value for this request: 89.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.888,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `transcript: ${transcription}` }
      ]
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('OpenAI blogify error:', error);
    throw error;
  }
}

// Process video augmentation: extract audio, transcribe, blogify
async function processVideoAugmentation(albumToken, photoGuid, videoUrl) {
  const cacheKey = `${albumToken}_${photoGuid}`;
  const cacheFile = path.join(VIDEO_AUGMENTATIONS_CACHE_DIR, `${cacheKey}.json`);

  // Check if already cached
  if (existsSync(cacheFile)) {
    try {
      const cached = await fs.readFile(cacheFile, 'utf-8');
      return JSON.parse(cached);
    } catch (e) {
      console.warn('Error reading cached augmentation, reprocessing...', e);
    }
  }

  // Check video duration and skip if too short (< 10 seconds)
  const duration = await getVideoDuration(videoUrl);
  if (duration !== null && duration < 10) {
    console.log(`Skipping video ${photoGuid}: too short (${duration}s)`);
    // Cache the skipped state so we don't try again
    const skippedAugmentation = {
      photoGuid,
      albumToken,
      skipped: true,
      reason: 'too_short',
      duration,
      processedAt: new Date().toISOString()
    };
    await fs.writeFile(cacheFile, JSON.stringify(skippedAugmentation, null, 2), 'utf-8');
    return skippedAugmentation;
  }

  try {
    // Step 1: Extract audio
    const audioFilename = `${cacheKey}.wav`;
    const audioPath = path.join(TMP_DIR, audioFilename);
    
    console.log(`Extracting audio from video: ${photoGuid}`);
    await extractAudioFromVideo(videoUrl, audioPath);

    // Step 2: Transcribe
    console.log(`Transcribing audio: ${photoGuid}`);
    const { transcription, timestamps, points } = await transcribeAudio(audioPath);

    // Skip if transcription is too short or empty
    if (!transcription || transcription.trim().length < 50) {
      console.log(`Skipping video ${photoGuid}: transcription too short (${transcription?.length || 0} chars)`);
      // Clean up
      await fs.unlink(audioPath).catch(() => {});
      // Cache the skipped state
      const skippedAugmentation = {
        photoGuid,
        albumToken,
        skipped: true,
        reason: 'transcription_too_short',
        transcriptionLength: transcription?.length || 0,
        processedAt: new Date().toISOString()
      };
      await fs.writeFile(cacheFile, JSON.stringify(skippedAugmentation, null, 2), 'utf-8');
      return skippedAugmentation;
    }

    // Step 3: Blogify
    console.log(`Blogifying transcription: ${photoGuid}`);
    const blog = await blogifyTranscription(transcription);

    // Create augmentation object
    const augmentation = {
      photoGuid,
      albumToken,
      transcription,
      blog,
      timestamps,
      points,
      processedAt: new Date().toISOString()
    };

    // Save to cache
    await fs.writeFile(cacheFile, JSON.stringify(augmentation, null, 2), 'utf-8');

    // Clean up temporary audio file
    await fs.unlink(audioPath).catch(() => {});

    console.log(`Video augmentation complete for ${photoGuid}`);
    return augmentation;

  } catch (error) {
    console.error(`Error processing video augmentation for ${photoGuid}:`, error);
    throw error;
  }
}

// Route to get video augmentation (with optional processing)
app.get('/api/video-augmentation/:albumToken/:photoGuid', async (req, res) => {
  try {
    const { albumToken, photoGuid } = req.params;
    const { process } = req.query; // Optional: ?process=true to trigger processing

    // Decrypt token if needed
    let decryptedToken;
    try {
      decryptedToken = decryptToken(albumToken);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    const cacheKey = `${decryptedToken}_${photoGuid}`;
    const cacheFile = path.join(VIDEO_AUGMENTATIONS_CACHE_DIR, `${cacheKey}.json`);

    // Check cache first
    if (existsSync(cacheFile)) {
      try {
        const cached = await fs.readFile(cacheFile, 'utf-8');
        const cachedData = JSON.parse(cached);
        // Return cached data (including skipped state)
        return res.json(cachedData);
      } catch (e) {
        console.error('Error reading cached augmentation:', e);
      }
    }

    // If not cached, automatically trigger processing in background
    // (Don't require ?process=true - just do it automatically)
    try {
      // Get album data to find the video
      const albumData = await getImages(decryptedToken);
      const photo = albumData.photos?.find(p => p.photoGuid === photoGuid);

      if (!photo || !isVideo(photo)) {
        return res.status(404).json({ error: 'Video not found' });
      }

      const videoUrl = getVideoUrl(photo);
      if (!videoUrl) {
        return res.status(404).json({ error: 'Video URL not found' });
      }

      // Process in background (don't await)
      processVideoAugmentation(decryptedToken, photoGuid, videoUrl)
        .then(augmentation => {
          if (augmentation) {
            console.log(`Background processing complete for ${photoGuid}`);
          }
        })
        .catch(err => {
          console.error(`Background processing failed for ${photoGuid}:`, err);
        });

      // Return processing status immediately
      return res.json({ 
        status: 'processing', 
        message: 'Video augmentation is being processed in the background. Check back in a few moments.' 
      });
    } catch (error) {
      console.error(`Error starting video augmentation processing for ${photoGuid}:`, error);
      // Return processing status even on error (processing will retry on next request)
      return res.json({ 
        status: 'processing', 
        message: 'Video augmentation processing will start shortly.' 
      });
    }

  } catch (error) {
    console.error('Error in video augmentation endpoint:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Serve feed.html for feed routes (/feed/:token)
app.get('/feed/:token', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  
  // Serve feed.html - frontend will handle encrypted tokens via API
  res.sendFile(path.join(__dirname, 'public', 'feed.html'));
});

// Serve index.html for album routes (/:albumId)
// Exclude /api paths and file extensions to avoid conflicts
app.get('/:albumId', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  
  // Exclude paths with file extensions (let static middleware handle them)
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(req.path);
  if (hasExtension) {
    return next();
  }
  
  // Serve index.html - frontend will handle encrypted tokens via API
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


