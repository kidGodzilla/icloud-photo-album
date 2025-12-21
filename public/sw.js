// Service Worker for iCloud Photo Album PWA
// Handles badge notifications for new photos using navigator.setAppBadge

const BADGE_CHECK_INTERVAL = 15 * 60 * 1000; // Check every 15 minutes
const DB_NAME = 'icloud-album-badges';
const DB_VERSION = 1;

// Install event
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Don't claim clients immediately - let pages control their own navigation
      // This prevents the service worker from interfering with "Add to Homescreen"
      // Only claim clients after a delay to allow initial navigation
      setTimeout(async () => {
        await self.clients.claim();
      }, 1000);
    })()
  );
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
    // Check if Badge API is supported
    if (!('setAppBadge' in self.registration)) {
      console.log('Badge API not supported');
      return;
    }

    const tokens = await getStoredTokens();
    
    if (tokens.length === 0) {
      await self.registration.setAppBadge(0);
      return;
    }

    let totalNewPhotos = 0;

    for (const token of tokens) {
      try {
        // Use a lightweight endpoint that just returns photo count
        const response = await fetch(`/api/badge-check/${token}`, {
          cache: 'no-cache',
          headers: {
            'Accept': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          const currentCount = data.photoCount || 0;
          const lastCount = await getLastPhotoCount(token);
          
          if (currentCount > lastCount) {
            const newPhotos = currentCount - lastCount;
            totalNewPhotos += newPhotos;
            await setLastPhotoCount(token, currentCount);
          } else if (currentCount !== lastCount) {
            // Album was updated (count changed), reset count
            await setLastPhotoCount(token, currentCount);
          }
        }
      } catch (error) {
        console.error(`Error checking album ${token}:`, error);
      }
    }

    // Update badge
    if (totalNewPhotos > 0) {
      await self.registration.setAppBadge(totalNewPhotos);
    } else {
      await self.registration.setAppBadge(0);
    }
  } catch (error) {
    console.error('Error checking for new photos:', error);
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
      
      // Trigger immediate check
      await checkForNewPhotos();
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
    if ('setAppBadge' in self.registration) {
      await self.registration.setAppBadge(0);
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
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      // Start periodic checks
      if (checkInterval) {
        clearInterval(checkInterval);
      }
      checkInterval = setInterval(checkForNewPhotos, BADGE_CHECK_INTERVAL);
      // Initial check
      await checkForNewPhotos();
    })()
  );
});

