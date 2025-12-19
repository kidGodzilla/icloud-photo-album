import 'dotenv/config';
import express from 'express';
import { getImages } from 'icloud-shared-album';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Cache configuration
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600000', 10); // Default: 1 hour in milliseconds
const cache = new Map(); // token -> { data, timestamp }

// Cache helper functions
function getCachedData(token) {
  const cached = cache.get(token);
  if (!cached) return null;
  
  const now = Date.now();
  const age = now - cached.timestamp;
  
  if (age > CACHE_TTL) {
    cache.delete(token);
    return null;
  }
  
  return cached.data;
}

function setCachedData(token, data) {
  cache.set(token, {
    data,
    timestamp: Date.now()
  });
}

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

// Route to get iCloud shared album by token
app.get('/api/album/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({ error: 'Album token is required' });
    }

    // Check cache first
    const cachedData = getCachedData(token);
    if (cachedData) {
      console.log(`Cache hit for album: ${token}`);
      return res.json(cachedData);
    }

    // Cache miss - fetch from iCloud
    console.log(`Cache miss for album: ${token}, fetching from iCloud...`);
    const data = await getImages(token);
    
    // Store in cache
    setCachedData(token, data);
    
    res.json(data);
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
app.use(express.static(path.join(__dirname, 'public')));

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
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

