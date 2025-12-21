// Service Worker for iCloud Photo Album PWA
// Handles badge notifications for new photos using navigator.setAppBadge
// Version: 2.1 - Updated to handle cache busting

const BADGE_CHECK_INTERVAL = 15 * 60 * 1000; // Check every 15 minutes
const DB_NAME = 'icloud-album-badges';
const DB_VERSION = 1;
const CACHE_VERSION = 'v2.1'; // Increment this when you want to bust the cache

// Install event
self.addEventListener('install', (event) => {
  // Delete old caches when updating
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.includes('icloud-photo-album') && !name.includes(CACHE_VERSION))
          .map((name) => {
            console.log('Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    })
  );
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete old caches when updating
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.includes('icloud-photo-album') && !name.includes(CACHE_VERSION))
          .map((name) => {
            console.log('Deleting old cache:', name);
            return caches.delete(name);
          })
      );
      
      // Don't claim clients immediately - let pages control their own navigation
      // This prevents the service worker from interfering with "Add to Homescreen"
      // Only claim clients after a delay to allow initial navigation
      setTimeout(async () => {
        await self.clients.claim();
      }, 1000);
      
      // Start periodic badge checks
      if (checkInterval) {
        clearInterval(checkInterval);
      }
      checkInterval = setInterval(checkForNewPhotos, BADGE_CHECK_INTERVAL);
      // Initial check after a delay
      setTimeout(() => {
        checkForNewPhotos();
      }, 2000);
    })()
  );
});

// Fetch event - don't cache HTML files, let them always be fresh
self.addEventListener('fetch', (event) => {
  // For HTML files, always fetch from network to avoid stale cache on iOS
  const url = new URL(event.request.url);
  const isHTML = event.request.destination === 'document' || 
                 url.pathname.endsWith('.html') ||
                 (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html'));
  
  if (isHTML) {
    event.respondWith(
      fetch(event.request, { 
        cache: 'no-store',
        headers: new Headers({
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        })
      }).catch(() => {
        // If fetch fails, return a basic response
        return new Response('Network error', { status: 408 });
      })
    );
    return;
  }
  
  // For JS/CSS files, use network-first with short cache for iOS
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      fetch(event.request, {
        cache: 'reload' // Force revalidation
      }).catch(() => {
        // Fallback to cache if network fails
        return caches.match(event.request);
      })
    );
    return;
  }
  
  // For all other requests, use default browser behavior (don't intercept)
  // This ensures API calls and images work normally
});

// Initialize IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('tokens')) {
        db.createObjectStore('tokens', { keyPath: 'token' });
      }
      if (!db.objectStoreNames.contains('counts')) {
        db.createObjectStore('counts', { keyPath: 'token' });
      }
    };
  });
}

// Get stored tokens from IndexedDB
async function getStoredTokens() {
  try {
    const db = await openDB();
    const transaction = db.transaction(['tokens'], 'readonly');
    const store = transaction.objectStore('tokens');
    const request = store.getAll();
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const tokens = request.result.map(item => item.token);
        resolve(tokens);
      };
      request.onerror = () => resolve([]);
    });
  } catch (error) {
    console.error('Error getting stored tokens:', error);
    return [];
  }
}

// Get last known photo count for a token
async function getLastPhotoCount(token) {
  try {
    const db = await openDB();
    const transaction = db.transaction(['counts'], 'readonly');
    const store = transaction.objectStore('counts');
    const request = store.get(token);
    
    return new Promise((resolve) => {
      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? result.count : 0);
      };
      request.onerror = () => resolve(0);
    });
  } catch (error) {
    console.error('Error getting last photo count:', error);
    return 0;
  }
}

// Set last known photo count for a token
async function setLastPhotoCount(token, count) {
  try {
    const db = await openDB();
    const transaction = db.transaction(['counts'], 'readwrite');
    const store = transaction.objectStore('counts');
    await store.put({ token, count, timestamp: Date.now() });
  } catch (error) {
    console.error('Error setting last photo count:', error);
  }
}

// Check for new photos and update badge
async function checkForNewPhotos() {
  try {
    // Check if Badge API is supported - try both service worker and navigator APIs
    let badgeAPI = null;
    if ('setAppBadge' in self.registration) {
      badgeAPI = self.registration;
    } else if ('setAppBadge' in navigator) {
      badgeAPI = navigator;
    } else {
      console.log('[SW] Badge API not supported');
      return;
    }

    console.log('[SW] Checking for new photos...');
    const tokens = await getStoredTokens();
    console.log(`[SW] Found ${tokens.length} tracked token(s)`);
    
    if (tokens.length === 0) {
      console.log('[SW] No tokens tracked, clearing badge');
      await badgeAPI.setAppBadge(0);
      return;
    }

    let totalNewPhotos = 0;

    for (const token of tokens) {
      try {
        // Use a lightweight endpoint that just returns photo count
        const url = new URL(`/api/badge-check/${token}`, self.location.origin);
        console.log(`[SW] Checking token: ${token.substring(0, 20)}...`);
        
        const response = await fetch(url.toString(), {
          cache: 'no-cache',
          headers: {
            'Accept': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          const currentCount = data.photoCount || 0;
          const lastCount = await getLastPhotoCount(token);
          
          console.log(`[SW] Token ${token.substring(0, 20)}... - Current: ${currentCount}, Last: ${lastCount}`);
          
          if (currentCount > lastCount) {
            const newPhotos = currentCount - lastCount;
            totalNewPhotos += newPhotos;
            console.log(`[SW] Found ${newPhotos} new photo(s) for token ${token.substring(0, 20)}...`);
            await setLastPhotoCount(token, currentCount);
          } else if (currentCount !== lastCount) {
            // Album was updated (count changed), reset count
            console.log(`[SW] Count changed (decreased), resetting for token ${token.substring(0, 20)}...`);
            await setLastPhotoCount(token, currentCount);
          } else {
            console.log(`[SW] No new photos for token ${token.substring(0, 20)}...`);
          }
        } else {
          console.error(`[SW] Bad response for token ${token.substring(0, 20)}...: ${response.status}`);
        }
      } catch (error) {
        console.error(`[SW] Error checking album ${token.substring(0, 20)}...:`, error);
      }
    }

    // Update badge
    console.log(`[SW] Total new photos: ${totalNewPhotos}`);
    if (totalNewPhotos > 0) {
      try {
        await badgeAPI.setAppBadge(totalNewPhotos);
        console.log(`[SW] Badge set to ${totalNewPhotos}`);
      } catch (badgeError) {
        console.error('[SW] Error setting badge:', badgeError);
      }
    } else {
      try {
        await badgeAPI.setAppBadge(0);
        console.log('[SW] Badge cleared');
      } catch (badgeError) {
        console.error('[SW] Error clearing badge:', badgeError);
      }
    }
  } catch (error) {
    console.error('[SW] Error checking for new photos:', error);
  }
}

// Message handler - receive tokens from main app
self.addEventListener('message', async (event) => {
  const message = event.data;
  
  if (message.type === 'UPDATE_TRACKED_TOKENS') {
    const tokens = message.tokens || [];
    
    try {
      const db = await openDB();
      const transaction = db.transaction(['tokens'], 'readwrite');
      const store = transaction.objectStore('tokens');
      
      // Clear existing tokens
      await store.clear();
      
      // Add new tokens
      for (const token of tokens) {
        await store.put({ token, timestamp: Date.now() });
      }
      
      // Notify client
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ success: true });
      }
      
      // Trigger immediate check after storing tokens
      console.log(`[SW] Stored ${tokens.length} token(s), triggering check...`);
      setTimeout(() => {
        checkForNewPhotos();
      }, 1000);
    } catch (error) {
      console.error('Error updating tracked tokens:', error);
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ success: false, error: error.message });
      }
    }
  } else if (message.type === 'CHECK_NOW') {
    await checkForNewPhotos();
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ success: true });
    }
  } else if (message.type === 'CLEAR_BADGE') {
    let badgeAPI = null;
    if ('setAppBadge' in self.registration) {
      badgeAPI = self.registration;
    } else if ('setAppBadge' in navigator) {
      badgeAPI = navigator;
    }
    
    if (badgeAPI) {
      try {
        await badgeAPI.setAppBadge(0);
        console.log('[SW] Badge cleared via CLEAR_BADGE message');
      } catch (error) {
        console.error('[SW] Error clearing badge:', error);
      }
    }
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ success: true });
    }
  }
});

// Periodic background sync (if supported)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-new-photos') {
    event.waitUntil(checkForNewPhotos());
  }
});

// Check for new photos periodically
let checkInterval;

