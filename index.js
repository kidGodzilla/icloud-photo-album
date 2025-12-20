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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Cache directory configuration
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');
const ALBUMS_CACHE_DIR = path.join(CACHE_DIR, 'albums');
const IMAGES_CACHE_DIR = path.join(CACHE_DIR, 'images');
const MAPPINGS_CACHE_DIR = path.join(CACHE_DIR, 'mappings');

// Ensure cache directories exist
async function ensureCacheDirs() {
  const dirs = [CACHE_DIR, ALBUMS_CACHE_DIR, IMAGES_CACHE_DIR, MAPPINGS_CACHE_DIR];
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

// Helper function to decrypt token if it's encrypted
function decryptToken(token) {
  if (token.startsWith('e-')) {
    try {
      const encrypted = token.substring(2); // Remove 'e-' prefix
      return encrypt.decrypt(encrypted);
    } catch (error) {
      throw new Error('Invalid encrypted token');
    }
  }
  return token;
}

// Cache configuration
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '7200000', 10); // Default: 2 hours in milliseconds

// In-memory reloading state (small, can stay in memory)
const reloadingState = new Map(); // token -> boolean

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
    
    // Check if cached image exists and is fresh
    try {
      const stats = await fs.stat(imageFile);
      const age = Date.now() - stats.mtimeMs;
      
      if (age < CACHE_TTL) {
        // Generate ETag
        const etag = `"${secureId}-${stats.mtimeMs}"`;
        res.set('ETag', etag);
        res.set('Last-Modified', stats.mtime.toUTCString());
        
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
    } catch (error) {
      // File doesn't exist or can't be read, continue to fetch
    }

    // Look up original URL from secure ID
    const originalUrl = await getImageUrl(secureId);
    if (!originalUrl) {
      return res.status(404).json({ error: 'Image not found or expired' });
    }

    // Strip EXIF and cache to disk
    const cleanedBuffer = await stripExifLocation(originalUrl);
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
        if (derivative.url.includes('.mp4') || derivative.url.includes('.MP4')) {
          // Keep video URLs as-is
          return;
        }
        // Store original URL securely and get opaque ID
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
    try {
      token = decryptToken(token);
    } catch (error) {
      return res.status(400).json({ 
        error: 'Invalid encrypted token', 
        message: error.message 
      });
    }

    // Use original token for cache key to avoid collisions
    const cacheKey = originalToken;

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
              const freshData = await getImages(token);
              const freshRewritten = await rewriteImageUrls(freshData, originalToken);
              await setCachedData(cacheKey, freshRewritten, false);
              console.log(`Background reload complete for album: ${originalToken}`);
            } catch (error) {
              console.error('Background reload failed:', error);
              setReloading(cacheKey, false);
            }
          })();
          return;
        } else {
          cachedData.reloading = false;
          return res.json(cachedData);
        }
      }
      
      // New cache format - rewrite URLs on read
      if (isStale && !reloadingState.get(cacheKey)) {
        // Stale cache - return immediately and reload in background
        console.log(`Stale cache hit for album: ${originalToken}, serving stale data and reloading in background...`);
        setReloading(cacheKey, true);
        
        // Return stale data immediately with reloading flag
        const rewritten = await rewriteImageUrls(cachedData, originalToken);
        rewritten.reloading = true;
        res.json(rewritten);
        
        // Reload in background (don't await)
        (async () => {
          try {
            const freshData = await getImages(token);
            const freshRewritten = await rewriteImageUrls(freshData, originalToken);
            await setCachedData(cacheKey, freshRewritten, false);
            console.log(`Background reload complete for album: ${originalToken}`);
          } catch (error) {
            console.error('Background reload failed:', error);
            setReloading(cacheKey, false);
          }
        })();
        return;
      } else if (!isStale) {
        // Fresh cache
        console.log(`Cache hit for album: ${originalToken}`);
        const rewritten = await rewriteImageUrls(cachedData, originalToken);
        rewritten.reloading = false;
        return res.json(rewritten);
      }
    }

    // Cache miss - fetch from iCloud
    console.log(`Cache miss for album: ${originalToken}, fetching from iCloud...`);
    const data = await getImages(token);
    
    // Store original data in cache (before rewriting URLs)
    await setCachedData(cacheKey, data, false);
    
    // Rewrite URLs to use proxy (strip EXIF) for response
    const rewritten = await rewriteImageUrls(data, originalToken);
    rewritten.reloading = false;
    
    res.json(rewritten);
  } catch (error) {
    console.error('Error fetching album:', error);
    res.status(500).json({ 
      error: 'Failed to fetch album', 
      message: error.message 
    });
  }
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


